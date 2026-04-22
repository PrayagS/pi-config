# Ticket 09 — richer permission/config surface

## Goal
Split `pi-dcp` control surface so users can independently enable/disable automatic rules, nudges, commands, LLM tools, and compression permission mode.

## Why
A single master `enabled` flag is too coarse for experimentation and safe rollout.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/index.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/hooks.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/host-permissions.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/compress-permission.ts`

Focus on:
- `compress.permission`
- `manualMode`
- `commands.enabled`
- automatic strategies vs manual mode

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/config.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/types.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/prompts.ts`
- command files under `src/cmds/`

## Proposed scope
Add config flags such as:
- `automaticRules`
- `nudges`
- `commands`
- `tools`
- `compressPermission: "allow" | "ask" | "deny"`
- optional `manualMode` struct

## Constraints
- `ask` may need Pi-specific UX pattern if host does not have native permission hooks
- disabling compression should not necessarily disable stats/debug commands

## Deliverables
- config schema + defaults
- registration logic in `index.ts`
- runtime enforcement in context hook and LLM tools
- tests for each config combination that matters

## Acceptance criteria
- user can disable tools without disabling automatic rules
- user can disable nudges but keep commands
- compression can be denied while leaving other DCP behavior intact
