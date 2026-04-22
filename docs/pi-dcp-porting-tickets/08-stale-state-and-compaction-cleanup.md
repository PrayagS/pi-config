# Ticket 08 — stale state and compaction cleanup

## Goal
Harden `pi-dcp` against session compaction/reload/history drift by validating and cleaning DCP state on each context pass.

## Why
Pruned IDs, distillations, and compression summaries become risky if the underlying visible transcript changes and cached references go stale.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/state/state.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/state/persistence.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/hooks.ts`
- tests:
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/message-ids.test.ts`
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/token-usage.test.ts`
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/compress-range.test.ts`

Focus on:
- session initialization / reset checks
- compaction detection
- stale state cleanup before transforms apply

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tool-cache.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/workflow.ts`

## Current state
- `session_compact` resets state
- context path syncs cache

Missing:
- aggressive validation that existing cached references still exist
- cleanup of stale pruned IDs/distillations/compression anchors on every context event

## Proposed scope
On each context pass:
1. rebuild visible ID index
2. remove `prunedIds` that no longer exist
3. remove distillations for missing call IDs
4. deactivate or drop compression summaries whose anchors disappeared
5. log cleanup in debug mode

## Deliverables
- stale-state cleanup function
- integration into context hook before pruning/projection
- tests for restore after compaction and missing-anchor cases

## Acceptance criteria
- no broken references after session compaction/reload
- stale cached state cleaned automatically
- compression summaries do not reference missing anchors
