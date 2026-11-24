# pi-agy-acp

Use Google Antigravity in Pi through the official, locally installed `agy` CLI.
This extension registers the `antigravity-acp` provider and lets Pi execute the
model's tool calls directly, supporting streaming text and reasoning, images,
mid-turn steering, parallel tool calls, and session persistence across restarts
and `/tree` rewinds.

Local fork (v0.3.0) of [`fdkevin0/pi-agy-acp`](https://github.com/fdkevin0/pi-agy-acp)
(v0.2.3), maintained in-tree in `pi-config`. See [NOTICE](NOTICE) and
[LICENSE](LICENSE) for upstream attribution.

## Prerequisites

- Node.js >= 22.19.0 (uses built-in `node:sqlite`).
- Pi (`@earendil-works/pi-coding-agent`) >= 1.5.x.
- The official `agy` CLI >= 1.5.10, signed in with your Google account.
  Run `agy` in your terminal to complete sign-in before using the extension.

## Installation in `pi-config`

This extension is registered directly in the repository's root `package.json`
under `pi.extensions` (`./extensions/pi-agy-acp/index.ts`). If you previously
installed the upstream `npm:pi-agy-acp` or `git:github.com/fdkevin0/pi-agy-acp`
package in `~/.pi/agent/settings.json`, remove or disable it to avoid duplicate
`antigravity-acp` provider registration.

## Fork highlights (v0.3.0)

- **Hardcoded 1M model specs & cold-start catalog (`src/models.ts`, `src/catalog.ts`):**
  Seeds the cold-start catalog with known Antigravity models and resolves
  `contextWindow` (`1M` for Gemini and Claude families, `128K` for GPT-OSS) and
  `maxTokens` statically rather than adopting `agy`'s tier-clamped 512K
  `max_context_tokens`. Live ACP discovery still refreshes the available model
  list and reasoning efforts. Standard Pi compaction runs normally according to
  your Pi settings.
- **Persistent sessions & copy-on-rewind forks (`src/session-store.ts`, `src/session-db.ts`):**
  Saves ACP session checkpoints in `session-index.json` for `session/resume`
  across restarts and forks SQLite session databases cleanly via `VACUUM INTO`
  when rewinding with `/tree`.
- **Cancel-and-drain tool detach (`src/conversation.ts`, `src/runtime.ts`):**
  Detaches long-running parked tool calls at 140 s (before `agy`'s 180 s MCP
  deadline) via cancel-and-drain and delivers the completed result (including
  images) in a fresh turn, replacing the legacy `pi_await_result` relay.
- **MCP boundary validation & schema compaction (`src/schema-validate.ts`, `src/mcp-bridge.ts`):**
  Validates tool arguments against JSON Schema at the MCP bridge boundary and
  compacts tool schemas over 1,200 bytes (`MAX_EAGER_BRIDGE_TOOL_BYTES`).
- **`codemode` tool filtering & preamble budgeting (`index.ts`, `src/pi-stream.ts`, `src/history.ts`):**
  Excludes Pi tools marked `exposure: "codemode"` from top-level model tool
  schemas and caps `<harness_tool_instructions>` at 50 KB during history replay
  so large tool sets do not trigger `agy`'s 192 KB single-input truncation limit.
- **Effort-suffixed models, mid-turn steering, and historical images:**
  Supports effort-suffixed ACP model IDs directly, native mid-turn steering
  while tools are parked, and native preservation of recent historical images on
  fallback replay.

## Usage

Start `pi`, then use `/model` to select a model under `antigravity-acp` (or run
`/agy-acp refresh` to force a live catalog refresh).

| Command | Purpose |
| --- | --- |
| `/agy-acp` or `/agy-acp status` | Show runtime state, account details, models, sessions, and the last turn. |
| `/agy-acp quota [used\|remaining]` | Show account details, grouped quota bars, and reset countdowns (remembers the last selected mode). |
| `/agy-acp refresh` | Force a live model catalog refresh from `agy` without starting a conversation. |
| `/agy-acp reset` | Dispose the ACP runtime and clear sessions, quota cache, and warning history; the next request rebuilds from Pi's history. |

After an Antigravity turn settles, the status bar shows quota usage (for example,
`AGY 20%`, or `AGY 80%` in `remaining` mode) and warns when quota is low; see
[quota status](docs/reference.md#quota-status-and-warnings).

Default prices are zero, not a promise of free calls. Pi pricing overrides are
used when configured.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_AGY_COMMAND` | Absolute path to the `agy` executable. | Auto-discovered |
| `PI_AGY_HOME` | Isolated directory for ACP state, logs, and caches. | `~/.pi/agent/cache/antigravity-acp` |
| `PI_AGY_QUOTA_DISPLAY` | Startup quota display mode (`used` or `remaining`). | `settings.json`, then `used` |
| `PI_AGY_DEBUG` | Set to `1` to print runtime warnings on `stderr`. | Unset (silent) |

## Tests

```sh
npm run test:pi-agy-acp
```

## More information

- [Reference](docs/reference.md): commands, quota UI, configuration, stored data, model discovery, and limits.
- [Development](docs/development.md): local setup, source layout, verification, and CI.
- [Architecture](docs/architecture.md): runtime, transport, security boundaries, and SQLite persistence/telemetry internals.
- [Attribution](NOTICE) and [MIT license](LICENSE).
