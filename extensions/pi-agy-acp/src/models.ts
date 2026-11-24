/**
 * Hardcoded model specifications and cold-start catalog for Antigravity ACP.
 *
 * `agy` reports a clamped `max_context_tokens` (512K) in its local session DB
 * for some subscription tiers even though the underlying models support a full
 * 1M context window. Hardcoding the model specs here keeps Pi's context gauge
 * and compaction threshold aligned with the true model limits from startup,
 * while live ACP discovery still updates the available model list and efforts.
 * @module pi-agy-acp/models
 */

import { EFFORTS, type Effort } from './config.ts'

/** Effort suffixes ordered longest-first so `-<effort>-effort` beats `-<effort>`. */
const EFFORT_SUFFIXES: readonly { suffix: string; effort: Effort }[] =
  EFFORTS.flatMap((effort) => [
    { suffix: `-${effort}-effort`, effort },
    { suffix: `-${effort}`, effort },
  ]).sort((a, b) => b.suffix.length - a.suffix.length)

/** Split a recognized effort suffix from a model id. */
export function splitEffortSuffix(
  id: string,
): { base: string; effort: Effort } | undefined {
  for (const { suffix, effort } of EFFORT_SUFFIXES) {
    if (id.length > suffix.length && id.endsWith(suffix)) {
      return { base: id.slice(0, -suffix.length), effort }
    }
  }
  return undefined
}

/** Static context and output token limits for one model family. */
export interface ModelSpec {
  readonly contextWindow: number
  readonly maxTokens: number
}

/** Hardcoded cold-start model entry with effort tiers and token limits. */
export interface HardcodedModel extends ModelSpec {
  readonly id: string
  readonly name: string
  readonly efforts: readonly Effort[]
}

export const DEFAULT_MODEL_SPEC: ModelSpec = {
  contextWindow: 1_000_000,
  maxTokens: 65_536,
}

/**
 * Known Antigravity ACP model families used both for static token limits and as
 * the cold-start catalog before live ACP discovery populates `catalog.json`.
 */
export const HARDCODED_MODELS: readonly HardcodedModel[] = [
  {
    id: 'gemini-4-neon',
    name: 'Gemini 4 Neon',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    efforts: ['low', 'medium', 'high'],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    efforts: ['low', 'medium', 'high'],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-pro-orchestrator-neon',
    name: 'Orchestrator (Neon)',
    efforts: [],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-pro-orchestrator',
    name: 'Orchestrator (Carbon)',
    efforts: [],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-pro-orchestrator-argon',
    name: 'Orchestrator (Argon)',
    efforts: [],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    efforts: ['low', 'medium', 'high'],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    efforts: ['low', 'medium', 'high'],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    efforts: ['low', 'medium', 'high'],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B (Medium)',
    efforts: [],
    contextWindow: 131_072,
    maxTokens: 65_536,
  },
]

const SPECS_BY_ID = new Map<string, ModelSpec>(
  HARDCODED_MODELS.map((m) => [
    m.id,
    { contextWindow: m.contextWindow, maxTokens: m.maxTokens },
  ]),
)

/**
 * Resolve hardcoded `contextWindow` and `maxTokens` for any Antigravity model id.
 * Matches exact ids first, then effort-stripped base ids, then model-family
 * defaults so newly introduced models still receive accurate 1M limits.
 */
export function modelSpecFor(modelId: string): ModelSpec {
  const exact = SPECS_BY_ID.get(modelId)
  if (exact !== undefined) return exact
  const split = splitEffortSuffix(modelId)
  if (split !== undefined) {
    const base = SPECS_BY_ID.get(split.base)
    if (base !== undefined) return base
  }
  if (/^claude-/i.test(modelId)) {
    return { contextWindow: 1_000_000, maxTokens: 128_000 }
  }
  if (/^gpt-oss-/i.test(modelId)) {
    return { contextWindow: 131_072, maxTokens: 65_536 }
  }
  if (/^gemini-/i.test(modelId)) {
    return { contextWindow: 1_000_000, maxTokens: 65_536 }
  }
  return DEFAULT_MODEL_SPEC
}
