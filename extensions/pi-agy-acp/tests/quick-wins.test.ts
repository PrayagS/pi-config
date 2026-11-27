import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ModelCatalog,
  resolveAcpModelSelection,
} from '../src/catalog.ts'
import { toTokenUsage } from '../src/conversation.ts'
import { HARDCODED_MODELS, modelSpecFor } from '../src/models.ts'
import {
  replayPrompt,
  toolResultsPrompt,
} from '../src/history.ts'
import {
  compactBridgeTool,
  MAX_EAGER_BRIDGE_TOOL_BYTES,
  type BridgeTool,
} from '../src/mcp-bridge.ts'
import {
  formatValidationError,
  validateToolArguments,
} from '../src/schema-validate.ts'
import type { RequestMessage } from '../src/protocol.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('MAX_EAGER_BRIDGE_TOOL_BYTES compaction', () => {
  it('uses a 1200-byte eager ceiling', () => {
    assert.equal(MAX_EAGER_BRIDGE_TOOL_BYTES, 1_200)
  })

  it('compacts tools in the 1200-1350 byte danger window while keeping schema structure', () => {
    const tool: BridgeTool = {
      name: 'delegate_task',
      description:
        'Delegate a task to a specialized worker agent with full context and constraints. '.repeat(
          9,
        ),
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['fast', 'deep'],
            description:
              'Execution strategy to use when running the delegated task in the background worker.',
          },
          prompt: {
            type: 'string',
            description:
              'Complete self-contained prompt instructions passed verbatim to the delegated worker agent.',
          },
          title: {
            type: 'string',
            title: 'Task Title',
            examples: ['Audit API routes'],
            default: 'Task',
            description:
              'Short human-readable summary label shown in the status bar and logs.',
          },
        },
        required: ['mode', 'prompt'],
      },
    }
    const rawBytes = Buffer.byteLength(JSON.stringify(tool), 'utf8')
    assert.ok(rawBytes > 1_200, `expected rawBytes (${rawBytes}) > 1200`)

    const compacted = compactBridgeTool(tool)
    const compactedBytes = Buffer.byteLength(JSON.stringify(compacted), 'utf8')
    assert.ok(
      compactedBytes <= MAX_EAGER_BRIDGE_TOOL_BYTES,
      `expected compactedBytes (${compactedBytes}) <= ${MAX_EAGER_BRIDGE_TOOL_BYTES}`,
    )
    const props = compacted.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >
    assert.deepEqual(compacted.inputSchema.required, ['mode', 'prompt'])
    assert.deepEqual(props.mode?.enum, ['fast', 'deep'])
    assert.equal(props.prompt?.type, 'string')
  })
})

describe('MCP JSON Schema argument validation', () => {
  const editSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      line: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['replace', 'append'] },
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string' },
            newText: { type: 'string' },
          },
          required: ['oldText', 'newText'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  }

  it('accepts valid arguments', () => {
    const res = validateToolArguments(editSchema, {
      path: 'src/index.ts',
      line: 10,
      mode: 'replace',
      edits: [{ oldText: 'a', newText: 'b' }],
    })
    assert.deepEqual(res, { valid: true })
  })

  it('reports path-level errors for missing required, bad types, enums, and nested items', () => {
    const res = validateToolArguments(editSchema, {
      path: '',
      line: 1.5,
      mode: 'overwrite',
      extra: true,
      edits: [{ oldText: 'a', bogus: 123 }],
    })
    assert.equal(res.valid, false)
    if (res.valid) return
    const text = formatValidationError('edit', res.errors)
    assert.match(text, /\$\.path: string length 0 is less than minimum 1/)
    assert.match(text, /\$\.line: expected integer, got number/)
    assert.match(text, /\$\.mode: must be one of "replace", "append"/)
    assert.match(text, /\$\.extra: unexpected additional property/)
    assert.match(text, /\$\.edits\[0\]\.newText: missing required property/)
    assert.match(text, /\$\.edits\[0\]\.bogus: unexpected additional property/)
  })

  it('supports $ref and anyOf unions', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      $defs: {
        id: { type: 'string', pattern: '^[a-z0-9]{3}$' },
      },
      properties: {
        dependsOn: {
          anyOf: [
            { $ref: '#/$defs/id' },
            { type: 'array', items: { $ref: '#/$defs/id' } },
          ],
        },
      },
      required: ['dependsOn'],
    }
    assert.deepEqual(validateToolArguments(schema, { dependsOn: 'k7q' }), {
      valid: true,
    })
    assert.deepEqual(
      validateToolArguments(schema, { dependsOn: ['k7q', 'ab1'] }),
      { valid: true },
    )
    const bad = validateToolArguments(schema, { dependsOn: 'INVALID' })
    assert.equal(bad.valid, false)
  })
})

describe('Dynamic effort-suffixed model mapping', () => {
  it('resolves effort-suffixed model options and skips thought_level', () => {
    const configOptions = [
      {
        id: 'model',
        category: 'model',
        currentValue: 'gemini-4-hydrogen-high',
        options: [
          { value: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
          { value: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
          { value: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
          { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B Medium' },
        ],
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        currentValue: 'high',
        options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    ]

    const dir = mkdtempSync(join(tmpdir(), 'pi-agy-cat-'))
    try {
      const catalog = new ModelCatalog(join(dir, 'catalog.json'))
      catalog.observe(configOptions)
      const list = catalog.list()
      assert.deepEqual(
        list.map((m) => m.id),
        ['gemini-4-hydrogen', 'gpt-oss-120b-medium'],
      )
      assert.deepEqual(catalog.effortsFor('gemini-4-hydrogen'), [
        'low',
        'medium',
        'high',
      ])
      assert.deepEqual(catalog.effortsFor('gpt-oss-120b-medium'), [])

      const sel = resolveAcpModelSelection(
        'gemini-4-hydrogen',
        'xhigh',
        configOptions,
      )
      assert.ok(sel)
      assert.equal(sel.acpModelValue, 'gemini-4-hydrogen-high')
      assert.equal(sel.targetEffort, 'high')
      assert.equal(sel.usesSuffixedModel, true)

      const selMed = resolveAcpModelSelection(
        'gemini-4-hydrogen',
        'medium',
        configOptions,
      )
      assert.ok(selMed)
      assert.equal(selMed.acpModelValue, 'gemini-4-hydrogen-medium')
      assert.equal(selMed.usesSuffixedModel, true)

      const missing = resolveAcpModelSelection(
        'does-not-exist',
        'high',
        configOptions,
      )
      assert.equal(missing, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps bare model + thought_level path when bare model is directly offered', () => {
    const configOptions = [
      {
        id: 'model',
        category: 'model',
        currentValue: 'gemini-4-neon',
        options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        currentValue: 'high',
        options: [{ value: 'low' }, { value: 'high' }],
      },
    ]
    const sel = resolveAcpModelSelection('gemini-4-neon', 'low', configOptions)
    assert.ok(sel)
    assert.equal(sel.acpModelValue, 'gemini-4-neon')
    assert.equal(sel.targetEffort, 'low')
    assert.equal(sel.usesSuffixedModel, false)
  })
})

describe('Historical image preservation on fallback replay', () => {
  const history: RequestMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: [
        { type: 'text', text: 'First screenshot' },
        { type: 'image', data: 'IMG_OLD_1', mimeType: 'image/png' },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      source: { kind: 'model', provider: 'antigravity-acp' },
      content: [{ type: 'text', text: 'Saw first.' }],
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: 'Rendered chart' },
        { type: 'image', data: 'IMG_MID_2', mimeType: 'image/png' },
      ],
    },
    {
      id: 'u2',
      role: 'user',
      content: [
        { type: 'text', text: 'Latest screenshot' },
        { type: 'image', data: 'IMG_NEW_3', mimeType: 'image/jpeg' },
      ],
    },
  ]

  const input: RequestMessage[] = [
    {
      id: 'u3',
      role: 'user',
      content: [{ type: 'text', text: 'Compare them' }],
    },
  ]

  it('preserves the newest N historical images as native image blocks', () => {
    const blocks = replayPrompt(history, input, {
      maxHistoricalImages: 2,
      preserveImages: true,
    })
    const images = blocks.filter((b) => b.type === 'image')
    assert.equal(images.length, 2)
    assert.deepEqual(
      images.map((i) => i.data),
      ['IMG_MID_2', 'IMG_NEW_3'],
    )
    const historyBlock = blocks.find(
      (b) => b.type === 'text' && b.text.includes('<pi_history>'),
    )
    assert.ok(historyBlock && historyBlock.type === 'text')
    assert.match(historyBlock.text, /\[image\]/)
    assert.match(historyBlock.text, /\[historical image #1 attached below\]/)
    assert.match(historyBlock.text, /\[historical image #2 attached below\]/)
  })

  it('flattens all historical images when preserveImages is false', () => {
    const blocks = replayPrompt(history, input, { preserveImages: false })
    assert.equal(blocks.filter((b) => b.type === 'image').length, 0)
  })

  it('preserves tool-result and steer images in toolResultsPrompt', () => {
    const blocks = toolResultsPrompt(
      [
        {
          id: 't1',
          role: 'tool',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: 'Chart ready' },
            { type: 'image', data: 'TOOL_IMG', mimeType: 'image/png' },
          ],
        },
      ],
      {
        extras: [
          {
            id: 'steer1',
            role: 'user',
            content: [
              { type: 'text', text: 'Focus on the top right' },
              { type: 'image', data: 'STEER_IMG', mimeType: 'image/webp' },
            ],
          },
        ],
      },
    )
    const images = blocks.filter((b) => b.type === 'image')
    assert.deepEqual(
      images.map((i) => i.data),
      ['TOOL_IMG', 'STEER_IMG'],
    )
  })
})

describe('Hardcoded model configuration and 1M context window', () => {
  it('seeds cold-start ModelCatalog from HARDCODED_MODELS with hasFreshCache() === false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-agy-models-'))
    try {
      const catalog = new ModelCatalog(join(dir, 'catalog.json'))
      assert.equal(catalog.hasFreshCache(), false)
      assert.equal(catalog.isCurrent(), false)
      assert.deepEqual(
        catalog.list().map((m) => m.id),
        HARDCODED_MODELS.map((m) => m.id),
      )
      assert.equal(catalog.contextWindowFor('gemini-4-neon'), 1_000_000)
      assert.equal(catalog.maxTokensFor('gemini-4-neon'), 65_536)
      assert.equal(catalog.contextWindowFor('claude-opus-5-5'), 1_000_000)
      assert.equal(catalog.maxTokensFor('claude-opus-5-5'), 128_000)
      assert.equal(catalog.contextWindowFor('gpt-oss-120b-medium'), 131_072)
      assert.deepEqual(catalog.effortsFor('gemini-4-neon'), [
        'low',
        'medium',
        'high',
        'xhigh',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores legacy 512K contextWindows in catalog.json and resolves family defaults for new models', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-agy-legacy-'))
    try {
      const cachePath = join(dir, 'catalog.json')
      writeFileSync(
        cachePath,
        JSON.stringify({
          models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
          efforts: ['low', 'medium', 'high', 'xhigh'],
          byModel: { 'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'] },
          contextWindows: { 'gemini-4-neon': 512000 },
        }),
      )
      const catalog = new ModelCatalog(cachePath)
      assert.equal(catalog.hasFreshCache(), true)
      assert.equal(catalog.contextWindowFor('gemini-4-neon'), 1_000_000)
      assert.deepEqual(modelSpecFor('gemini-4-neon-high'), {
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      })
      assert.deepEqual(modelSpecFor('gemini-5-preview'), {
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      })
      assert.deepEqual(modelSpecFor('claude-opus-6-0'), {
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('toTokenUsage prompt-bucket normalization', () => {
  it('scales cumulative multi-step prompt buckets to totalTokens so Pi does not falsely trigger silent overflow', () => {
    const result = toTokenUsage(
      {
        inputTokens: 39_427,
        cachedReadTokens: 977_776,
        outputTokens: 12_715,
        thoughtTokens: 4_385,
      },
      27,
      { contextTokens: 94_936 },
    )
    assert.ok(result)
    assert.equal(result.totalTokens, 94_936)
    assert.equal(result.outputTokens, 12_715)
    assert.equal(result.reasoningTokens, 4_385)
    const promptSum = result.inputTokens + (result.cacheReadTokens ?? 0)
    assert.equal(promptSum, 94_936)
    assert.ok(
      promptSum < 1_000_000,
      'input + cacheRead must stay below 1M context window',
    )
    // Cache hit ratio (~96.12%) is preserved.
    const ratio = (result.cacheReadTokens ?? 0) / promptSum
    assert.ok(ratio > 0.96 && ratio < 0.965, `unexpected cache ratio: ${ratio}`)
  })

  it('leaves single-step prompt buckets untouched when already within totalTokens', () => {
    const result = toTokenUsage(
      {
        inputTokens: 12_000,
        cachedReadTokens: 80_000,
        cachedWriteTokens: 1_500,
        outputTokens: 3_000,
      },
      1,
    )
    assert.deepEqual(result, {
      inputTokens: 12_000,
      outputTokens: 3_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 1_500,
      totalTokens: 96_500,
    })
  })

  it('still exceeds contextWindow when single-call occupancy genuinely overflows', () => {
    const result = toTokenUsage(
      {
        inputTokens: 100_000,
        cachedReadTokens: 2_400_000,
        outputTokens: 1_000,
      },
      5,
      { contextTokens: 1_050_000 },
    )
    assert.ok(result)
    assert.equal(result.totalTokens, 1_050_000)
    assert.equal(result.inputTokens + (result.cacheReadTokens ?? 0), 1_050_000)
  })

  it('bounds prompt buckets to fallback totalTokens when usage_update is absent', () => {
    const result = toTokenUsage(
      {
        inputTokens: 50_000,
        cachedReadTokens: 1_200_000,
        outputTokens: 5_000,
      },
      10,
    )
    assert.ok(result)
    assert.equal(result.totalTokens, 130_000)
    assert.equal(result.inputTokens + (result.cacheReadTokens ?? 0), 130_000)
  })
})
