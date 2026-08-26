# vent

Pi extension that adds an agent-callable `vent` tool plus slash commands for reviewing accumulated friction.

Upstream: forked from [`@howaboua/pi-vent`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-vent) (deprecated), with a reworked storage model.

## Storage

All entries go to a single shared JSONL file:

- `~/.pi/agent/vent.jsonl` — active entries
- `~/.pi/agent/vent-archive.jsonl` — reviewed entries (append-only archive)

Each entry is one JSON line and records the project context it belongs to:

```json
{
  "timestamp": "2026-02-08T10:42:00.000Z",
  "project": "pi-config",
  "cwd": "/Users/you/dev/pi-config",
  "trigger": "tool_error",
  "thought": "..."
}
```

## Tool

```ts
vent({
  thought: string,
  trigger?: string
})
```

Use it for recurring tool failures, repeated manual workarounds, noisy output that forces the same retries, or project instructions/docs/tooling that cause avoidable backtracking. Do not use it for one-off lint/type errors or ordinary coding mistakes. The project context is captured automatically from the working directory.

## Commands

- `/vent-export [path]` — export all active JSONL entries to a markdown file for human review, grouped by project. Defaults to `VENT.md` in the current directory.
- `/vent-review [instructions]` — prompt template that asks the agent to review all active vent entries, derive insights, add relevant instructions to the right context files (project `AGENTS.md` for project-specific friction, `~/.pi/agent/AGENTS.md` or skills for cross-project friction), and then archive the reviewed entries.
- `/vent-archive` — move all active entries to `~/.pi/agent/vent-archive.jsonl`. Run by `/vent-review` after the review completes; can also be run manually.

## Credits

Original `vent` tool and VENT.md format by [Igor Warzocha](https://github.com/IgorWarzocha) (`@howaboua/pi-vent`), MIT licensed.
