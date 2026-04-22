# Ticket 06 — configurable protected tools

## Goal
Expand `pi-dcp` from a tiny hardcoded protected-tool list to a configurable protection system with sane defaults.

## Why
Some tool outputs are durable workflow memory and should not be casually pruned or compressed.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/protected-patterns.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/commands/sweep.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/strategies/deduplication.ts`

Focus on:
- `DEFAULT_PROTECTED_TOOLS`
- command/strategy/compress protected-tool scopes

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/config.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/types.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tool-cache.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/prune.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/distill.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/compress.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`

## Proposed scope
Add config-driven protected-tool support, ideally with at least:
- global protected tools
- compression-specific protected tools

Possible default candidates in Pi:
- todo tools
- subagent tools/results
- skill-loading tools
- optionally write/edit as configurable protected tools

## Constraints
- same protection policy should apply to both automatic and LLM-driven pruning
- if write/edit stay prunable by default, document why and make override easy

## Deliverables
- config schema/defaults
- shared `isToolProtected(...)` helper
- consistent checks in tool cache visibility + actual pruning tools + auto rules
- tests for protected and unprotected tool names

## Acceptance criteria
- protected tools configurable from config
- core workflow memory not pruned unexpectedly
- behavior consistent across automatic and tool-driven pruning
