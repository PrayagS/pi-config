# Ticket 11 — better token-pressure policy

## Goal
Upgrade `pi-dcp` nudging from periodic-only + one hard limit to a richer pressure model using min/max thresholds and iteration-aware nudges.

## Why
Long agent loops need stronger DCP pressure than short user-driven exchanges, even before absolute context maximum is reached.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/messages/inject/utils.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/hooks.ts`
- tests:
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/message-priority.test.ts`
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/token-usage.test.ts`

Focus on:
- `nudgeFrequency`
- `iterationNudgeThreshold`
- `nudgeForce`
- min/max threshold interplay

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/prompts.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tokens.ts`

## Proposed scope
Support multiple independent nudge triggers:
1. periodic reminder after `nudgeFrequency`
2. stronger reminder after `iterationNudgeThreshold` assistant/tool cycles without user input
3. urgent compress nudge once over `max` context threshold
4. preserve existing dumb-zone urgency path if available

## Deliverables
- config/types for iteration threshold and maybe force level
- iteration tracking in runtime state
- updated nudge selection logic
- tests for resets after user turns and escalation during long loops

## Acceptance criteria
- long agent-only loops create stronger DCP reminders than ordinary conversations
- user input resets iteration pressure
- dumb-zone path still works if installed
