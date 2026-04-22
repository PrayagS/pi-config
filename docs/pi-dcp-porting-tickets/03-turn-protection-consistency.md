# Ticket 03 — turn-protection consistency

## Goal
Make turn-based protection a consistent policy across `pi-dcp`, not only a filter for the `<prunable-tools>` list.

## Why
`pi-dcp` already tracks turn freshness for tool entries, but automatic rules can still prune content from very recent turns depending on message count and rule order.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/messages/inject/utils.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/strategies/deduplication.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/commands/sweep.ts`

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/types.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/config.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tool-cache.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/rules/recency.ts`
- rules to update:
  - `src/rules/deduplication.ts`
  - `src/rules/error-purging.ts`
  - `src/rules/superseded-writes.ts`

## Current state
Already exists partially:
- `turnProtection` in config/types
- `tool-cache.ts` can exclude entries from last N turns in `<prunable-tools>`

Missing:
- shared precedence model for automatic pruning
- tests that combine recency + turn freshness + tool pairing

## Proposed scope
- define explicit precedence order
- add helper like `isTurnProtected(msg, ctx)` or equivalent metadata
- ensure automatic rules skip/prioritize protected recent turns
- document how recency rule and turn protection interact

## Deliverables
- shared turn-protection helper
- automatic rules updated
- tests for recent multi-message tool bursts
- docs update in README/config comments if needed

## Acceptance criteria
- recent turns protected consistently even when many tool/result messages exist
- interaction with recency is deterministic and test-covered
