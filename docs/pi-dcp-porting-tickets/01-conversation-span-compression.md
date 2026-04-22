# Ticket 01 — conversation-span compression

## Goal
Add compression in `pi-dcp` for completed **message spans / conversation phases**, not only numeric ranges of tool-call IDs.

## Why
Current `pi-dcp` compression in `src/tools/compress.ts` works only on tool-call ranges from `<prunable-tools>`. Long planning/debugging phases with few tools still bloat context.

## Reference behavior in opencode-dcp
Read:
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/README.md`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/config.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/hooks.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/compress/range.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/compress/message.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/compress/range-utils.ts`
- `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/lib/compress/state.ts`
- tests:
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/compress-range.test.ts`
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/compress-message.test.ts`
  - `/Users/prayagmatic/dev/opencode-dynamic-context-pruning/tests/compress-range-placeholders.test.ts`

Important ideas:
- range-based compression over contiguous message spans
- message-based compression mode exists too
- summary placeholders replace old context in outbound projection
- compression state persists and can be targeted later

## Current pi-dcp files
Read:
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tools/compress.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/events/context.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/tool-cache.ts`
- `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/src/types.ts`
- tests:
  - `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/tests/llm-tools.test.ts`
  - `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/tests/thinking-blocks.test.ts`
  - `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp/tests/tool-pairing.test.ts`

## Proposed scope
Stage 1:
- keep existing tool-range compression untouched
- add second compression mode for message spans
- represent compressed span in state with explicit anchor + covered message IDs
- inject one summary placeholder into outbound context

Stage 2:
- choose API shape for LLM/user targeting spans
- maybe support message IDs or synthetic compression block IDs

## Constraints
Must preserve:
- Pi thinking/redacted-thinking invariants
- tool_call/tool_result pairing
- deterministic restore from persisted state

## Suggested implementation notes
- likely need new message indexing/cache, not only tool-call indexing
- compression summary should anchor to stable message/block identity, not array index alone
- if a span includes unsafe messages, either split around them or reject compression with clear error

## Deliverables
- state model for message-span compression
- compression application path in `src/events/context.ts`
- tests for mixed text/tool spans
- tests for unsafe thinking block rejection
- tests for no orphaned tool pairs

## Acceptance criteria
- can compress a completed conversational phase with few/no tools
- no invalid tool pair breakage
- no mutation of forbidden thinking blocks
- summary placement deterministic across restores
