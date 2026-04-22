# Ticket 10 — prompt overrides

## Goal
Allow `pi-dcp` prompts to be overridden from disk instead of requiring source edits for every prompt experiment.

## Why
Behavior tuning is prompt-heavy. Hardcoded prompt strings slow iteration and make local/user-specific tuning awkward.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/prompts/store.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/prompts/index.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/hooks.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`

Focus on:
- override directory precedence
- safe fallback to bundled defaults
- invalid/empty override handling

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/prompts.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/config.ts`

## Proposed scope
Start with optional override loading for these prompt types:
- system
- nudge
- compress-nudge
- cooldown
- dumb-zone-nudge

Possible shape:
- bundled defaults in code
- override files in project/user location
- one prompt loader with precedence and caching

## Deliverables
- prompt override config toggle/path discovery
- loader/store module
- safe fallback rules
- tests for missing, empty, and valid overrides

## Acceptance criteria
- prompt text can be customized without code edits
- invalid overrides fail safely back to defaults
- prompt selection deterministic and documented
