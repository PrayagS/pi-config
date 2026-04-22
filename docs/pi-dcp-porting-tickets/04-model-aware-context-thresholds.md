# Ticket 04 — model-aware context thresholds

## Goal
Replace `pi-dcp`'s single hardcoded context threshold with configurable min/max thresholds that can vary by model and support percentage-of-window values.

## Why
A fixed threshold like `120_000` is too high for some models and too low for others.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/hooks.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/messages/inject/utils.ts`

Focus on:
- `compress.minContextLimit`
- `compress.maxContextLimit`
- `compress.modelMinLimits`
- `compress.modelMaxLimits`
- `resolveContextTokenLimit(...)`
- `isContextOverLimits(...)`

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tokens.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/config.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/types.ts`

## Proposed scope
Add config shape similar to:

```ts
contextLimits?: {
  min: number | `${number}%`
  max: number | `${number}%`
  modelMin?: Record<string, number | `${number}%`>
  modelMax?: Record<string, number | `${number}%`>
}
```

Implementation:
- resolve actual limit using model metadata when available
- `min` drives softer compression nudges
- `max` drives stronger/urgent compression nudges
- preserve sane fallback if model window unknown

## Deliverables
- config types + defaults + validation
- helper to resolve effective threshold for current model
- updated context-nudge path in `src/events/context.ts`
- tests for absolute + percentage + model-specific overrides

## Acceptance criteria
- thresholds configurable globally and per model
- percentage values resolve correctly
- nudges scale with actual model context window
