# pi-dcp porting guide from opencode-dcp

Purpose: implementation doc for features in `opencode-dcp` that may be worth adding to `pi-dcp`.

Repo roots used below:

- **opencode-dcp**: `/Users/prayagmatic/dev/opencode-dynamic-context-pruning`
- **pi-dcp**: `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp`

This doc is intentionally implementation-oriented. Each feature lists:

- what `opencode-dcp` already does
- what `pi-dcp` currently does
- files to read in both repos
- suggested port shape for `pi-dcp`
- minimum acceptance criteria

---

## 1. Better compression model: conversation-span compression, not only tool-range compression

### Why
`pi-dcp` can currently compress only a numeric range of tool IDs, then anchor the summary at the last compressed tool result. That works for tool-heavy sessions, but misses large non-tool phases like planning, debugging discussion, or long reasoning loops.

### opencode-dcp references
Read first:

- `README.md`
  - sections: **Compress**, **Configuration**, **Commands**
- `lib/config.ts`
  - `CompressMode = "range" | "message"`
  - `CompressConfig`
- `lib/hooks.ts`
  - `createChatMessageTransformHandler(...)`
- `lib/compress/`
  - `range.ts`
  - `message.ts`
  - `range-utils.ts`
  - `state.ts`
  - `types.ts`
- `lib/messages/`
  - compression/nudge injection helpers
- tests:
  - `tests/compress-range.test.ts`
  - `tests/compress-message.test.ts`
  - `tests/compress-range-placeholders.test.ts`
  - `tests/compression-targets.test.ts`

### pi-dcp references
Read first:

- `src/tools/compress.ts`
- `src/events/context.ts`
  - `applyLlmDrivenPruning(...)`
- `src/tool-cache.ts`
- `index.ts`
- tests:
  - `tests/llm-tools.test.ts`
  - `tests/tool-pairing.test.ts`
  - `tests/thinking-blocks.test.ts`

### Current gap
- `opencode-dcp`: compresses contiguous message spans or individual messages.
- `pi-dcp`: compresses only tool-call ranges from `<prunable-tools>` numeric IDs.

### Port direction for pi-dcp
Add a second compression mode that works over **message spans** instead of only tool IDs.

Suggested staged design:

1. Keep current tool-range compression as `mode: "tools"`.
2. Add `mode: "messages"` or `mode: "range"` that accepts message anchors/indices/IDs.
3. Replace selected messages with one summary placeholder while preserving Pi/Anthropic message invariants:
   - do not mutate unsafe thinking blocks
   - do not create orphaned tool pairs
4. Later, consider per-message compression mode if span compression proves stable.

### Files likely to change in pi-dcp
- `src/tools/compress.ts`
- `src/events/context.ts`
- `src/types.ts`
- `src/tool-cache.ts` or new message-cache module
- new tests around message-span compression and tool-pair safety

### Acceptance criteria
- can compress a completed conversational phase even if few/no tools involved
- no invalid `toolCall` / `toolResult` separation
- no mutation of forbidden thinking/redacted-thinking content
- summary appears deterministically in outbound context

---

## 2. Decompress / recompress workflow

### Why
Once summaries exist, agents and users need a safe way to temporarily restore original content when detail is needed.

### opencode-dcp references
Read first:

- `README.md`
  - commands: `/dcp decompress`, `/dcp recompress`
- `lib/hooks.ts`
  - `handleDecompressCommand`, `handleRecompressCommand`
- `lib/commands/decompress.ts`
- `lib/commands/recompress.ts`
- `lib/commands/compression-targets.ts`
- `lib/messages/` and `lib/compress/state.ts`
- `lib/state/state.ts`

### pi-dcp references
Read first:

- `src/tools/compress.ts`
- `src/events/context.ts`
- `index.ts`
- `src/cmds/`
  - existing command patterns: `stats.ts`, `recent.ts`, `toggle.ts`, `tools-expanded.ts`

### Current gap
- `opencode-dcp` supports reversible compression state.
- `pi-dcp` persists compress summaries, but has no command or tool to restore original projected content.

### Port direction for pi-dcp
Add commands first, not tools:

- `/dcp-decompress <id>`
- `/dcp-recompress <id>`
- maybe `/dcp-compressions` if listing becomes verbose

Implementation shape:
- store enough metadata for each compression block to reconstruct whether it is active/deactivated
- distinguish user-decompressed vs naturally inactive/superseded
- forbid recompress if anchor/origin messages no longer exist

### Files likely to change in pi-dcp
- new command files under `src/cmds/`
- `src/tools/compress.ts`
- `src/events/context.ts`
- state persistence in `index.ts`
- tests for reversible compression lifecycle

### Acceptance criteria
- user can list current compressions
- user can temporarily restore one compression target
- user can re-apply that same target later
- invalid or stale restore attempts fail clearly

---

## 3. Turn-based protection beyond raw recency count

### Why
Message-count recency is crude. A single turn can emit many tool/result messages, so “keep last 10 messages” can still expose very fresh tool outputs to pruning.

### Important note
`pi-dcp` already has a **partial** version of this feature.

### opencode-dcp references
Read first:

- `README.md`
  - `turnProtection`
- `lib/config.ts`
  - `TurnProtection`
- `lib/messages/inject/utils.ts`
  - context-limit/nudge eligibility
- `lib/strategies/deduplication.ts`
- `lib/commands/sweep.ts`

### pi-dcp references
Read first:

- `src/types.ts`
  - `TurnProtection`
- `src/config.ts`
  - default `turnProtection`
- `src/tool-cache.ts`
  - `turn` tracking and `getPrunableEntries(...)`
- `src/events/context.ts`
  - `getPrunableEntries(state, protectedTools, 5, config.turnProtection)`
- `src/rules/recency.ts`

### Current state in pi-dcp
Already present for `<prunable-tools>` visibility:
- tool entries record `turn`
- recent turns can be excluded from prunable list

Missing pieces compared with broader opencode intent:
- turn protection is not consistently applied across all automatic pruning decisions
- docs/tests around semantics are thin
- interaction with recency and rule-based pruning is not fully spelled out

### Port direction for pi-dcp
Treat turn protection as first-class policy across both layers:

1. keep current message-count recency rule
2. keep current `<prunable-tools>` turn protection
3. add turn-based protection checks to automatic pruning rules where appropriate
4. document precedence:
   - hard safety constraints
   - turn protection
   - recency
   - normal prune rules

### Files likely to change in pi-dcp
- `src/rules/deduplication.ts`
- `src/rules/error-purging.ts`
- `src/rules/superseded-writes.ts`
- `src/workflow.ts`
- tests for mixed recency/turn-protection cases

### Acceptance criteria
- very recent turns are protected even when many message blocks exist
- automatic rules respect turn protection consistently
- behavior is deterministic when recency and turn protection overlap

---

## 4. Model-aware context thresholds

### Why
A fixed token threshold is wrong across models with different context windows.

### opencode-dcp references
Read first:

- `README.md`
  - `compress.minContextLimit`
  - `compress.maxContextLimit`
  - `compress.modelMaxLimits`
  - `compress.modelMinLimits`
- `lib/config.ts`
  - config validation + defaults
- `lib/hooks.ts`
  - caches model context limit from hook input
- `lib/messages/inject/utils.ts`
  - `resolveContextTokenLimit(...)`
  - `isContextOverLimits(...)`

### pi-dcp references
Read first:

- `index.ts`
  - hardcoded `contextLimit = 120_000`
- `src/events/context.ts`
  - `estimateContextTokens(...)`
  - compress nudge decision
- `src/tokens.ts`
- `src/config.ts`
- `src/types.ts`

### Current gap
- `opencode-dcp`: min/max thresholds, percentages, model-specific overrides.
- `pi-dcp`: one global hardcoded threshold.

### Port direction for pi-dcp
Add config like:

```ts
contextLimits: {
  min: number | `${number}%`
  max: number | `${number}%`
  modelMin?: Record<string, number | `${number}%`>
  modelMax?: Record<string, number | `${number}%`>
}
```

Then:
- resolve limits against model context window when available
- use `min` for soft nudges
- use `max` for strong compress nudges

### Files likely to change in pi-dcp
- `src/types.ts`
- `src/config.ts`
- `index.ts`
- `src/events/context.ts`
- maybe a new `src/context-limits.ts`

### Acceptance criteria
- thresholds can be configured globally and per model
- percentage limits resolve correctly from actual model window
- small-context models nudge earlier than large-context models

---

## 5. Summary buffer logic

### Why
Compressed summary tokens are not as harmful as equivalent raw history. Counting them exactly like raw history can cause over-eager repeated compression.

### opencode-dcp references
Read first:

- `README.md`
  - `compress.summaryBuffer`
- `lib/config.ts`
  - `summaryBuffer`
- `lib/messages/inject/utils.ts`
  - `isContextOverLimits(...)`
  - summary-token extension logic
- tests:
  - `tests/token-usage.test.ts`

### pi-dcp references
Read first:

- `src/events/context.ts`
  - uses `estimateContextTokens(messages)` directly
- `src/tokens.ts`
- `src/tools/compress.ts`
- `index.ts`

### Current gap
`pi-dcp` has no distinction between:
- raw message tokens
- compressed-summary tokens

### Port direction for pi-dcp
Track active compression-summary token counts separately, then extend effective `max` threshold by some or all active summary tokens.

Simple version:
- when a compression summary is active, count its token estimate separately
- compute `effectiveMax = configuredMax + activeSummaryTokens`

### Files likely to change in pi-dcp
- `src/tools/compress.ts`
- `src/events/context.ts`
- `src/tokens.ts`
- state persistence in `index.ts`

### Acceptance criteria
- heavy use of existing summaries does not constantly trigger more compression nudges
- system still nudges when raw history grows too large

---

## 6. More conservative / configurable protected-tool strategy

### Why
Some tool outputs are durable workflow state, not disposable clutter.

### opencode-dcp references
Read first:

- `README.md`
  - **Protected Tools**
  - config `commands.protectedTools`, `strategies.*.protectedTools`, `compress.protectedTools`
- `lib/config.ts`
  - `DEFAULT_PROTECTED_TOOLS`
  - `COMPRESS_DEFAULT_PROTECTED_TOOLS`
- `lib/protected-patterns.ts`
- `lib/commands/sweep.ts`
- `lib/strategies/deduplication.ts`

### pi-dcp references
Read first:

- `index.ts`
  - `DEFAULT_PROTECTED_TOOLS = ["dcp_prune", "dcp_distill", "dcp_compress"]`
- `src/tool-cache.ts`
  - `getPrunableEntries(...)`
- `src/tools/prune.ts`
- `src/tools/distill.ts`
- `src/tools/compress.ts`
- `src/events/context.ts`

### Current gap
- `pi-dcp` protects only DCP tools by default.
- `opencode-dcp` protects many workflow-critical tools and lets protection vary by subsystem.

### Port direction for pi-dcp
Add config-driven protected tools with at least 2 scopes:

- global protected tools
- compression-specific protected tools

Possible future scopes:
- automatic-rule protected tools
- prune/distill protected tools

Suggested initial candidates for Pi:
- todo tools
- subagent tools/results
- skill-related tools
- maybe write/edit as configurable, not hardcoded either way

### Files likely to change in pi-dcp
- `src/types.ts`
- `src/config.ts`
- `index.ts`
- `src/tool-cache.ts`
- `src/tools/*.ts`
- `src/events/context.ts`

### Acceptance criteria
- protected tool names are configurable
- same protection policy applies consistently to automatic and LLM-driven pruning
- default policy is conservative enough to avoid deleting core workflow memory

---

## 7. Protected file patterns

### Why
Some files should be “sticky” in context even if normal file ops are otherwise prunable.

### opencode-dcp references
Read first:

- `README.md`
  - `protectedFilePatterns`
- `lib/config.ts`
  - `protectedFilePatterns`
- `lib/protected-patterns.ts`
- `lib/strategies/deduplication.ts`
- `lib/commands/sweep.ts`

### pi-dcp references
Read first:

- `src/tool-cache.ts`
  - tool param extraction logic exists, but only for display and pruning list logic
- `src/rules/superseded-writes.ts`
- `src/tools/prune.ts`
- `src/tools/distill.ts`
- `src/tools/compress.ts`
- `src/events/context.ts`
- `src/metadata.ts`

### Current gap
`pi-dcp` has no file-pattern-level protection layer.

### Port direction for pi-dcp
Add config like:

```ts
protectedFilePatterns?: string[]
```

Then create a shared helper, similar in spirit to `opencode-dcp/lib/protected-patterns.ts`, that:
- extracts file paths from tool calls/results
- matches glob patterns
- prevents pruning/distillation/compression of matching file-related entries

Typical sticky paths:
- specs/plans/todos
- config files
- prompt files
- migration files

### Files likely to change in pi-dcp
- `src/types.ts`
- `src/config.ts`
- new helper file, likely `src/protected-patterns.ts`
- `src/tool-cache.ts`
- `src/tools/*.ts`
- `src/rules/superseded-writes.ts`

### Acceptance criteria
- glob patterns can protect file-related entries from both automatic and manual pruning
- behavior is test-covered for write/edit/read/search tools as applicable

---

## 8. Better host/session compaction handling and stale-state cleanup

### Why
Pruning state becomes dangerous if session history changes underneath it and cached IDs/summaries drift.

### opencode-dcp references
Read first:

- `lib/state/state.ts`
  - `checkSession(...)`
  - `ensureSessionInitialized(...)`
  - compaction reset logic
- `lib/state/utils.ts`
- `lib/state/persistence.ts`
- `lib/hooks.ts`
  - state sync path
- tests:
  - `tests/message-ids.test.ts`
  - `tests/token-usage.test.ts`
  - `tests/compress-range.test.ts`

### pi-dcp references
Read first:

- `index.ts`
  - `session_start` restore
  - `session_compact` reset
- `src/events/context.ts`
- `src/tool-cache.ts`
- `src/workflow.ts`

### Current gap
`pi-dcp` resets state on `session_compact`, which is good, but it does less incremental validation than `opencode-dcp`.

Potential stale-state risks in `pi-dcp`:
- cached pruned IDs that no longer map to visible context
- compress summaries whose anchors disappeared
- distillations surviving after transcript shape changes

### Port direction for pi-dcp
Add validation on each `context` event:

1. rebuild visible tool/message ID index
2. drop stale `prunedIds` not present anymore
3. drop stale distillations for missing call IDs
4. drop or deactivate compression summaries whose anchors vanished
5. emit debug log when cleanup occurs

### Files likely to change in pi-dcp
- `src/events/context.ts`
- `src/tool-cache.ts`
- `index.ts`
- maybe new `src/state.ts`

### Acceptance criteria
- session compaction/reload does not leave broken DCP state behind
- stale IDs are cleaned automatically
- no summary references dead anchors

---

## 9. Richer permission/config surface for autonomous pruning

### Why
Users need to control whether DCP is automatic, advisory, or strictly manual.

### opencode-dcp references
Read first:

- `README.md`
  - `compress.permission`
  - `manualMode`
  - `commands.enabled`
  - `strategies.*`
- `lib/config.ts`
- `index.ts`
  - tool registration and command registration
- `lib/hooks.ts`
  - permission handling
- `lib/host-permissions.ts`
- `lib/compress-permission.ts`

### pi-dcp references
Read first:

- `index.ts`
- `src/config.ts`
- `src/types.ts`
- `src/events/context.ts`
- commands in `src/cmds/`

### Current gap
`pi-dcp` has a master enabled flag, but less separation between:
- automatic rules
- nudge injection
- command availability
- LLM-callable tool registration
- compress permission mode

### Port direction for pi-dcp
Add distinct switches, for example:

```ts
automaticRules?: boolean
nudges?: boolean
tools?: boolean
commands?: boolean
compressPermission?: "allow" | "ask" | "deny"
manualMode?: {
  enabled: boolean
  automaticStrategies: boolean
}
```

`ask` may require host support or a Pi-native confirmation pattern.

### Files likely to change in pi-dcp
- `src/types.ts`
- `src/config.ts`
- `index.ts`
- `src/events/context.ts`
- `src/prompts.ts`

### Acceptance criteria
- user can independently disable tools, nudges, or automatic rules
- “manual mode” behaves predictably
- compression can be denied without disabling all DCP features

---

## 10. Prompt override system

### Why
Prompt tuning should not require code edits for every behavior change.

### opencode-dcp references
Read first:

- `README.md`
  - **Prompt Overrides**
- `lib/prompts/store.ts`
- `lib/prompts/index.ts`
- `lib/prompts/extensions/`
- `lib/hooks.ts`
  - prompt reload path
- config flag:
  - `lib/config.ts` → `experimental.customPrompts`

### pi-dcp references
Read first:

- `src/prompts.ts`
- `index.ts`
  - `before_agent_start` system prompt injection
- `src/events/context.ts`
  - nudge injection
- `src/config.ts`

### Current gap
`pi-dcp` hardcodes all prompt text in source.

### Port direction for pi-dcp
Introduce optional prompt loading from disk:

- bundled defaults remain in code or generated files
- override directories can shadow defaults
- prompt names likely include:
  - `system`
  - `nudge`
  - `compress-nudge`
  - `dumb-zone-nudge`
  - `cooldown`
  - maybe `prunable-tools-header`

Start simple: one loader with override precedence and runtime caching.

### Files likely to change in pi-dcp
- `src/prompts.ts`
- `src/config.ts`
- `index.ts`
- maybe new `src/prompt-store.ts`

### Acceptance criteria
- prompts can be overridden without code changes
- invalid/empty override files fail safely back to defaults
- prompts reload on new turn or on session start

---

## 11. Better token-pressure policy: min/max thresholds + iteration nudges

### Why
Periodic nudges alone are blunt. Long autonomous loops need stronger pressure when many assistant iterations happen without fresh user input.

### opencode-dcp references
Read first:

- `README.md`
  - `nudgeFrequency`
  - `iterationNudgeThreshold`
  - `nudgeForce`
  - `minContextLimit`, `maxContextLimit`
- `lib/messages/inject/utils.ts`
- `lib/hooks.ts`
- tests:
  - `tests/message-priority.test.ts`
  - `tests/token-usage.test.ts`

### pi-dcp references
Read first:

- `index.ts`
  - `nudgeFrequency`
  - `contextLimit`
- `src/events/context.ts`
- `src/prompts.ts`
- `src/tokens.ts`

### Current gap
`pi-dcp` currently uses:
- periodic nudge counter
- one hard limit for compress nudges
- optional dumb-zone signal

It lacks a dedicated notion of “too many internal iterations since last real user turn.”

### Port direction for pi-dcp
Add separate pressure channels:

1. soft nudge after `nudgeFrequency`
2. stronger nudge after `iterationNudgeThreshold` assistant/tool cycles since last user message
3. stronger still when over max context threshold
4. optional target-role control if Pi message model needs it

### Files likely to change in pi-dcp
- `src/events/context.ts`
- `src/types.ts`
- `src/config.ts`
- `src/prompts.ts`

### Acceptance criteria
- long agent-only loops produce stronger DCP reminders than ordinary short exchanges
- user-turn boundaries reset iteration pressure correctly

---

## 12. More nuanced duplicate detection

### Why
Hashing full message text catches exact repeats, but semantically duplicated tool calls may differ slightly in formatting while still being duplicates.

### opencode-dcp references
Read first:

- `README.md`
  - deduplication described as same tool + same args
- `lib/strategies/deduplication.ts`
  - `createToolSignature(...)`
  - parameter normalization + key sorting
- `lib/protected-patterns.ts`

### pi-dcp references
Read first:

- `src/rules/deduplication.ts`
- `src/metadata.ts`
- `src/tool-cache.ts`
- `src/workflow.ts`

### Current gap
- `opencode-dcp`: semantic tool-signature dedup.
- `pi-dcp`: whole-message hash dedup.

### Port direction for pi-dcp
Keep content-hash dedup, but add a second rule or hybrid rule for tool-signature dedup:

- dedup candidate if same tool name + normalized args
- ignore protected tools / protected file paths
- optionally keep most recent result, not first occurrence

Question to decide explicitly:
- keep earliest occurrence or latest occurrence?

`opencode-dcp` keeps the most recent tool output by pruning older ones. `pi-dcp` current hash-based rule effectively prunes later duplicates when an earlier hash already exists. Aligning these policies would simplify reasoning.

### Files likely to change in pi-dcp
- `src/rules/deduplication.ts`
- `src/metadata.ts`
- `src/tool-cache.ts`
- `src/types.ts`
- tests for exact-hash vs same-tool-same-args cases

### Acceptance criteria
- repeated identical tool calls are deduped even when formatting differs
- chosen keep-policy (latest vs earliest) is documented and test-covered

---

# Suggested implementation order

If implementing in stages, this order gives high value with moderate risk:

1. **Feature 8** — stale-state cleanup / compaction handling
2. **Feature 6** — configurable protected tools
3. **Feature 7** — protected file patterns
4. **Feature 4** — model-aware thresholds
5. **Feature 11** — better token-pressure policy
6. **Feature 2** — decompress / recompress
7. **Feature 12** — nuanced deduplication
8. **Feature 5** — summary buffer logic
9. **Feature 3** — broaden turn-protection semantics
10. **Feature 10** — prompt overrides
11. **Feature 1** — conversation-span compression
12. Revisit rule interactions and trim API surface

Rationale:
- first 5 improve safety/config without changing compression semantics too much
- decompression should land before very aggressive new compression modes
- full message-span compression is highest complexity and most likely to interact with Anthropic/Pi message constraints

---

# Cross-cutting Pi constraints to keep in mind

These constraints are already documented in `pi-dcp` and should govern every port:

- `AGENTS.md`
  - thinking/redacted_thinking blocks are special
- `src/events/context.ts`
  - `hasThinkingBlocks(...)`
  - `repairOrphanedToolPairsPostPruning(...)`
- `src/rules/tool-pairing.ts`
- `src/workflow.ts`
  - post-rule orphan repair
- tests:
  - `tests/thinking-blocks.test.ts`
  - `tests/tool-pairing.test.ts`

Any feature port that mutates assistant or tool messages must preserve:
- tool pairing invariants
- latest-assistant thinking block invariants
- deterministic replay from persisted state

---

# Recommended reading order before implementation

## From opencode-dcp
1. `README.md`
2. `lib/config.ts`
3. `index.ts`
4. `lib/hooks.ts`
5. `lib/messages/inject/utils.ts`
6. `lib/strategies/deduplication.ts`
7. `lib/protected-patterns.ts`
8. `lib/state/state.ts`
9. `lib/commands/decompress.ts`
10. `lib/commands/recompress.ts`
11. `lib/compress/`
12. relevant tests under `tests/`

## From pi-dcp
1. `README.md`
2. `AGENTS.md`
3. `index.ts`
4. `src/events/context.ts`
5. `src/workflow.ts`
6. `src/tool-cache.ts`
7. `src/tools/`
8. `src/rules/`
9. `src/config.ts`
10. `src/types.ts`
11. tests under `tests/` and `src/__tests__/`

---

# Open design questions for pi-dcp

Before implementation, decide these explicitly:

1. Should `pi-dcp` remain primarily **LLM-steered** with tools, or move toward more **autonomous** compression?
2. For deduplication, should the system keep the **latest** duplicate or the **first** duplicate?
3. Should `write` / `edit` remain aggressively prunable by default, or become configurable protected tools?
4. For decompression, should restored content re-enter `<prunable-tools>` immediately or be temporarily protected?
5. For conversation-span compression, what is the canonical anchor model in Pi: message ID, tool call ID, or synthetic block ID?
6. How should prompt overrides be discovered: project-local only, or also user-global?

These decisions affect multiple features, so settle them before large refactors.
