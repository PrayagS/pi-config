# Ticket 02 — decompress / recompress workflow

## Goal
Add reversible compression lifecycle to `pi-dcp`: list active compressions, temporarily restore one, then re-apply it later.

## Why
Aggressive compression is safer if users/agents can recover lost detail on demand.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/hooks.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/commands/decompress.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/commands/recompress.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/commands/compression-targets.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/compress/state.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/state/state.ts`

Important ideas:
- compression targets have stable IDs
- user can inspect available compressions
- user-decompressed blocks tracked separately from inactive/superseded blocks
- recompress validates origin still exists

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/compress.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/index.ts`
- command patterns in:
  - `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/cmds/stats.ts`
  - `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/cmds/recent.ts`
  - `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/cmds/toggle.ts`

## Proposed scope
Add commands first:
- `/dcp-decompress <id>`
- `/dcp-recompress <id>`
- optional `/dcp-compressions`

State changes:
- every compression summary stores source IDs, anchor ID, active flag
- user-decompressed flag distinct from stale/invalid state

## Constraints
- recompress must fail if anchor/origin content gone
- restored content must still respect thinking-block and tool-pair invariants
- command output should clearly explain why a target cannot be restored

## Deliverables
- command(s) under `src/cmds/`
- persisted compression metadata
- restore/reapply logic in context projection path
- tests for happy path + stale target failures

## Acceptance criteria
- user can list current compressions
- user can restore one compression target
- user can re-apply same target
- stale/nonexistent targets fail clearly
