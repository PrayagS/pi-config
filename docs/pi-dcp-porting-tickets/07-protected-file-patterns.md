# Ticket 07 — protected file patterns

## Goal
Add file-pattern-aware protection so file-related tool outputs touching important paths are excluded from pruning/distillation/compression.

## Why
Some files act like high-value memory artifacts during a session: plans, prompts, specs, todos, migrations, config files.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/protected-patterns.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/commands/sweep.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/strategies/deduplication.ts`

Focus on:
- `protectedFilePatterns`
- file-path extraction from tool parameters
- glob matching helpers

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tool-cache.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/metadata.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/rules/superseded-writes.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/prune.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/distill.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/compress.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`

## Proposed scope
Add:

```ts
protectedFilePatterns?: string[]
```

Implementation:
- central helper for extracting file paths from relevant tools
- glob matcher for protection patterns
- shared check used by automatic rules and LLM-driven tools

## Deliverables
- new helper module, likely `src/protected-patterns.ts`
- config support
- tests for pattern matching and tool-path extraction
- integration tests showing protected paths do not appear in prunable list / do not get pruned

## Acceptance criteria
- file-related tool outputs for protected paths are excluded from both automatic and manual pruning flows
- glob behavior documented and test-covered
