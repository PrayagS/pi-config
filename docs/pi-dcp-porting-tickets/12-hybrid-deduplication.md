# Ticket 12 — hybrid deduplication

## Goal
Improve `pi-dcp` deduplication by combining whole-message hash detection with semantic tool-signature deduplication.

## Why
Exact message hashing catches exact repeats, but repeated tool invocations may differ slightly in formatting while still being semantically duplicate.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/strategies/deduplication.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/protected-patterns.ts`

Focus on:
- `createToolSignature(...)`
- parameter normalization and key sorting
- keep-most-recent policy

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/rules/deduplication.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/metadata.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tool-cache.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/workflow.ts`

## Proposed scope
- keep current content-hash logic for exact duplicates
- add semantic dedup path for same tool name + normalized args
- decide and document whether to keep earliest or latest occurrence

Recommendation:
- align with `opencode-dcp` and keep the most recent tool output when semantically duplicate

## Deliverables
- helper for normalized tool signature
- updated rule or second rule for semantic tool dedup
- tests for exact-hash duplicate, semantically same tool call, and keep-policy edge cases

## Acceptance criteria
- repeated identical tool calls deduped even when formatting differs
- keep-policy documented and covered by tests
