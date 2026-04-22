# Ticket 05 — summary buffer logic

## Goal
Treat active compression-summary tokens differently from raw history tokens when deciding whether to nudge for more compression.

## Why
Without this, a session with many already-compressed summaries can keep triggering new compression nudges even though much of the visible context is already compact.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/messages/inject/utils.ts`
- tests:
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/token-usage.test.ts`

Focus on:
- `compress.summaryBuffer`
- active summary token extension in `isContextOverLimits(...)`

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tokens.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/compress.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`

## Proposed scope
- track active summary token counts separately
- extend effective `max` threshold by active summary token count when enabled
- keep raw-history pressure as primary signal

Simple formula idea:
- `effectiveMax = configuredMax + activeSummaryTokens`

## Deliverables
- summary token accounting in state
- config flag for enabling/disabling summary buffer behavior
- updated context pressure calculation
- tests for repeated-compression sessions

## Acceptance criteria
- already-compressed summaries reduce over-triggering of new compression nudges
- raw history growth still causes nudges when appropriate
