# pi-dcp porting tickets

Breakout tickets derived from:
- `docs/pi-dcp-porting-guide-from-opencode-dcp.md`

Each ticket is scoped for implementation planning/execution in:
- **pi-dcp**: `/Users/prayagmatic/dev/pi-extensions/edmundmiller-dotfiles/pi-packages/pi-dcp`

Reference repo for behavior/examples:
- **opencode-dcp**: `/Users/prayagmatic/dev/opencode-dynamic-context-pruning`

## Tickets

1. `01-conversation-span-compression.md`
2. `02-decompress-recompress-workflow.md`
3. `03-turn-protection-consistency.md`
4. `04-model-aware-context-thresholds.md`
5. `05-summary-buffer-logic.md`
6. `06-configurable-protected-tools.md`
7. `07-protected-file-patterns.md`
8. `08-stale-state-and-compaction-cleanup.md`
9. `09-richer-permission-surface.md`
10. `10-prompt-overrides.md`
11. `11-better-token-pressure-policy.md`
12. `12-hybrid-deduplication.md`

## Recommended implementation order

1. `08-stale-state-and-compaction-cleanup.md`
2. `06-configurable-protected-tools.md`
3. `07-protected-file-patterns.md`
4. `04-model-aware-context-thresholds.md`
5. `11-better-token-pressure-policy.md`
6. `02-decompress-recompress-workflow.md`
7. `12-hybrid-deduplication.md`
8. `05-summary-buffer-logic.md`
9. `03-turn-protection-consistency.md`
10. `10-prompt-overrides.md`
11. `01-conversation-span-compression.md`

## Cross-cutting constraints

Before implementing any ticket, re-read:
- `pi-dcp/AGENTS.md`
- `pi-dcp/src/events/context.ts`
- `pi-dcp/src/rules/tool-pairing.ts`
- `pi-dcp/src/workflow.ts`
- `pi-dcp/tests/thinking-blocks.test.ts`
- `pi-dcp/tests/tool-pairing.test.ts`

Invariant:
- no invalid tool-call/result orphaning
- no unsafe mutation of thinking/redacted-thinking blocks
- persisted DCP state must remain deterministic across session restore/compaction
