# Architecture

Implementation invariants, transport boundaries, and subsystem contracts for
contributors working on `pi-agy-acp`. For setup and verification, start with
[development](development.md).

## Request, history, and tool routing

### ACP spawn and RPC timeouts

The runtime launches `agy` with:

```text
agy acp --gemini-dir <PI_AGY_HOME> --app-data-dir agy --agent pi-bridge \
  --process-per-session --disable-telemetry --log-file <PI_AGY_HOME>/acp.log
```

Working directory is `<PI_AGY_HOME>/workspace`. ACP JSON-RPC timeouts:

| Method | Timeout |
| --- | --- |
| `initialize` | 120 s |
| `session/new` | 120 s |
| `session/resume` / `session/load` | 120 s |
| `session/set_config_option` | 60 s |
| `session/close` | 15 s |
| `session/prompt` | None (bounded by turn/abort lifecycle) |

### Opening prompt, replay budget, and native session persistence

- `session/new` attaches only a static MCP routing preamble
  (`bridgeSystemPrompt()`). Live sessions register the local `pi` MCP server;
  discovery (`warmup`) sessions pass `mcpServers: []`.
- Clean turn completions record verified SQLite high-water marks
  `(steps, generations, executions)` and a SHA-256 prefix fingerprint in
  `<PI_AGY_HOME>/session-index.json` (`src/session-store.ts`). On Pi restart,
  idle wake, or tree rewind/branch:
  - Exact checkpoint matches reconnect directly via `session/resume` (falling
    back to `session/load`), preserving native conversation state and prompt
    cache without replaying `<pi_history>`.
  - Rewind/branch matches where the source SQLite DB has advanced past the
    checkpoint perform a WAL-safe `VACUUM INTO` copy-on-rewind fork, verify the
    prefix fingerprint, truncate rows past the checkpoint, mint a fresh
    `cascade_id` / `trajectory_id`, and resume the fork via `session/resume`.
  - If the DB is missing, corrupt, or uncheckpointed, the runtime falls back
    transparently to `session/new` + `<pi_history>` replay.
- On fallback replay, Pi's system prompt (`<system_instructions>`),
  supplemental tool schemas (`<harness_tool_instructions>`), and trailing live
  input are always emitted complete. `<pi_history>` fills the remaining bytes
  of the 160,000-byte replay budget (`REPLAY_BUDGET_BYTES`, kept under `agy`'s
  192,000-byte single `USER_INPUT` limit) newest-first.
- If the single newest history item is an oversized tool result and remaining
  budget exceeds 1,024 bytes, it is head-truncated on UTF-8 code-point
  boundaries. When `promptCapabilities.image` is supported, fallback replay
  preserves up to 4 most recent historical `user`/`tool` images (within 4 MiB)
  as native image blocks; older or overflow images render as `[image]`.

### Tool schemas, validation, and dynamic deltas

- `tools/list` always includes `pi_call_tool` (no `pi_await_result` polling tool).
- Tool schemas larger than `1,200` UTF-8 bytes (`MAX_EAGER_BRIDGE_TOOL_BYTES`,
  below `agy`'s ~1,240-byte eager cutoff) are compacted in up to three passes
  (shortening descriptions and stripping non-essential metadata while preserving
  parameter names, types, `required`, and `enum`), with full schemas emitted in
  `<harness_tool_instructions>`.
- Incoming `tools/call` arguments (including `pi_call_tool` targets) are
  validated at the MCP boundary (`src/schema-validate.ts`) against the full
  uncompacted Pi JSON Schema; invalid calls return path-level diagnostics
  directly over MCP (`isError: true`) without interrupting Pi.
- Subsequent turns compare 24-hex SHA-256 tool digests and emit
  `<harness_tool_update>` lines (restored, updated, added, disabled) prepended
  to the prompt or attached to deferred tool-result suffixes. Newly added or
  updated tools route through `pi_call_tool`.

### Parked tool calls, cancel-and-drain detach, and mid-turn steering

- Parallel tool calls batch over `parkSettleMs` (250 ms). Resuming a parked
  turn requires an intact history prefix plus matching model and clamped effort
  (supporting both bare `<model>` + `thought_level` and effort-suffixed
  `<model>-<effort>` model options); otherwise the session rebuilds cleanly.
- Long-running tools approaching `agy`'s 180 s MCP deadline detach after
  `detachAfterMs` (140 s): the turn proactively sends `session/cancel`, drains
  `session/prompt` (bounded by `cancelTimeoutMs`, 15 s), and lets Pi finish the
  tool normally. When Pi returns the real tool result(s), they are delivered
  (including any native image blocks) in a fresh continuation `session/prompt`
  on the same ACP session.
- On `agy >= 1.5.0`, trailing user steer messages arriving alongside parked
  tool results use native mid-turn steering (`steersWithPrompt`): a new
  `session/prompt` with the steer blocks is sent while the previous prompt
  settles, then parked tool calls resolve cleanly onto the steered turn.
- If `session/prompt` settles while Pi is running tools, delivering tool results
  abandons the old turn, clears `reportedToolCalls`, and opens a continuation
  prompt without executing zombie queued calls.
- `max_tokens` auto-continues up to `longDecodeContinuations` (3), resetting
  per-segment usage counters. Transient `agy` retry and output-limit notices are
  suppressed and counted in `retryNotices`, while terminal `Retries remaining: 0`
  passes through.

## Model discovery and catalog caching

- Cold startup without `catalog.json` seeds the catalog from hardcoded defaults
  in `src/models.ts` (`HARDCODED_MODELS`, with 1M context windows for Gemini and
  Claude families and 128K for GPT-OSS) and launches no processes, sockets, or
  timers. `contextWindow` and `maxTokens` always resolve from `modelSpecFor()`
  rather than `agy`'s SQLite `max_context_tokens`, so Pi's context gauge and
  compaction thresholds always reflect the true model limits from startup.
  `catalog.json` is written atomically and stores models, per-model efforts,
  `supportsImage` (defaults optimistically to `['text', 'image']` until
  `promptCapabilities.image === false` is observed), `tier`, and the
  subprocess-free binary fingerprint
  (`${realpath}:${dev}:${ino}:${size}:${mtimeNs}`).
- Both `agy --version` (30 s timeout) and ACP `initialize` (`agentInfo.version`)
  enforce `MIN_AGY_VERSION` (`1.5.10`).
- Non-forced refreshes reuse `catalog.json` without spawning `agy` whenever
  cached models match the current binary fingerprint. Loading a cache with a
  mismatched fingerprint keeps models visible until re-probed without advancing
  the persisted fingerprint.
- `reconcileBinaryFingerprint()` runs during `warmup()` and `runPreflight()`:
  when an ACP front is idle with a stale binary fingerprint, it detaches the
  stale process, closes the bridge, removes stale session artifacts, and marks
  idle conversations dirty before probing the new binary. (If an ACP process is
  already alive when `stream()` runs, `ensureReady()` reuses it without
  re-checking the fingerprint until a refresh or process restart.)
- Concurrent refreshes share a single discovery session; `/agy-acp refresh`
  (`force: true`) bypasses the cache. Standalone discovery tears down an
  ephemeral front process, bridge, and sweeper afterward unless a concurrent
  `stream()` adopted them. Provider re-registration is suppressed during refresh
  so refresh cannot cancel itself.

## Session and process lifecycle

- **Capacity and ephemeral sessions:** `capacityMutex` enforces
  `maxLiveSessions` (16), evicting the oldest idle non-opening conversation
  first and failing fast with `CAPACITY_EXCEEDED` (`RATE_LIMIT`) to avoid
  parent/subagent deadlocks. Requests without a `sessionId` use ephemeral
  `anon-*` keys torn down immediately after each idle step.
- **Idle sweeper:** Runs every 60 s (`.unref()`) with a monotonic delta capped
  at 120 s per tick for sleep resilience. Idle conversations expire after
  `idleSessionTtlMs` (30 min); once no live sessions or in-flight streams remain
  and the front has been idle past `idleSessionTtlMs`, the sweeper stops the
  ACP process, MCP bridge, and itself (waiting for evicted sessions to close
  first).
- **Pi lifecycle resets:** Compaction, tree navigation, and `session_start`
  (`new`, `resume`, `fork`) perform a light reset (closing conversation sessions
  and artifacts while keeping the ACP process, bridge, and caches).
  `session_shutdown` and `/agy-acp reset` dispose the full runtime.
- **Turn ownership and disposal:** Disposal is idempotent, drains in-flight
  startup/bridge binding, cancels waiters, and rolls back late session replies
  from obsolete processes or conversations. A turn owns cancellation through
  streaming and parked execution until drained, `agent_settled` runs, or the
  process exits (aborted/undrained turns wait up to 5 s for `promptSettled`);
  only a fully drained `tool-calls` handoff preserves parked calls. First
  interruption wins (`abandon` vs `fail`), and cancellation takes precedence
  over buffered output.
- **Subprocess hardening (`src/host.ts`, `src/preflight.ts`):**
  - Unix spawns `agy` in detached process groups (`-pid` `SIGTERM` → `SIGKILL`
    after 5 s for ACP or 1 s for helper commands); Windows terminates process
    trees via `taskkill /T /F /PID`. Helper commands wait up to 250 ms
    (`EXIT_DRAIN_MS`) after exit to avoid hangs from inherited stdio handles.
  - Subprocess environments strip `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
    `GEMINI_HOME`, `ELECTRON_RUN_AS_NODE`, and `CHROME_CRASHPAD_PIPE_NAME`, and
    force `AGY_CLI_DISABLE_AUTO_UPDATE=1` and `PYTHONUNBUFFERED=1`.
  - Binary auto-discovery checks `~/.local/bin/agy` and `PATH` on Unix, and
    `%LOCALAPPDATA%\agy\bin\agy.exe`, `~/.local/bin/agy.exe`, then `PATH`
    (`.exe` prioritized ahead of `PATHEXT` wrappers) on Windows.
  - Captured stderr tails (capped at 64 KiB) redact Google OAuth URL queries,
    `Bearer` tokens, `ya29.*`, `AIza*`, and secret query parameters.

## Transport, MCP bridge, and permissions

### MCP HTTP/SSE bridge (`src/mcp-bridge.ts`)

- Binds `127.0.0.1` on an ephemeral port with per-session bearer credentials
  checked in constant time (`timingSafeEqual`).
- Enforces Node HTTP parser deadlines of 10 s for headers and 30 s for
  whole-request reception (checked every 1 s); reception deadlines do not cap
  completed SSE tool streams. SSE streams emit `: keepalive` (and optional
  `notifications/progress`) every 15 s.
- Caps authenticated POST bodies at 8 MiB (`8,388,608` bytes) across both
  `Content-Length` and chunked streams, closing the connection on rejection.
- Status behavior: `400` invalid URL (or JSON-RPC `-32700` parse error), `401`
  missing/invalid tenant auth, `404` wrong path, `405` non-`POST`/`DELETE`,
  `413` oversized body, `202` notifications-only, `200` JSON or
  `text/event-stream`, `500` unexpected pre-header failure (or socket destroy if
  headers were already sent). `close()` immediately destroys all open responses
  and sockets without waiting on tool promises. Bridge listener errors route to
  `host.log.info` (discarded in the Pi extension to protect TUI rendering).

### JSON-RPC framing (`src/jsonrpc.ts`)

- Newline-delimited JSON-RPC 2.0 over UTF-8 stdio streams.
- Frames (or unterminated buffers) exceeding 16 MiB chars (`MAX_LINE_CHARS`)
  close the peer with `JsonRpcClosedError`, triggering child termination.
- Partial remainders are re-materialized via UTF-16LE buffer copy to detach V8
  `SlicedString` backing memory.
- Malformed/non-object lines are dropped via `onProtocolError` without closing
  the link; malformed `message.error` objects reject the pending request with
  `-32603`; unknown incoming agent requests return `-32601`.

### Fail-closed permission policy

- Isolated `<PI_AGY_HOME>/agy/settings.json` sets
  `toolPermission: 'request-review'` and `agentMode: ''`.
- `session/request_permission` is fail-closed: `cancelled` before `session/new`
  completes (or on owner/tenant mismatch), and `reject_once` whenever no active
  turn owns the session.
- Active-turn grants issue `allow_once` (never `allow_always`) only after
  verifying non-conflicting structured tool metadata (`mcpServerName` /
  `mcpToolName`, `_meta.*`, flat `name` — never `title` or `rawInput`) against
  `reportedToolCalls`, `serverName === 'pi'`, and an advertised tool name (or
  `pi_await_result`/`pi_call_tool`). A narrow exception allows an identity-less
  `kind === 'other'` probe with empty input only after an MCP handshake on that
  tenant.

## Session SQLite telemetry and usage

### Read-only SQLite inspection (`src/session-db.ts`)

- Uses `node:sqlite` (`DatabaseSync`, `readOnly: true`, `timeout: 50`).
- Validates `sessionId` (`[A-Za-z0-9._-]+`), verifies `realpath` containment
  within `<PI_AGY_HOME>/agy/conversations`, and rejects symlinks or non-regular
  files across `.db`, `.db-wal`, `.db-shm`, and `.db-journal`.
- Gates streaming reads with cached context window / positive `usage_update`
  checks and `(mtimeNs, size)` stamps across `.db`, `.db-wal`, and
  `.db-journal`. `gen_metadata` scans are bounded (`LIMIT 64`) and advance
  `metaFloorIdx` on mid-session model switches so prior context windows cannot
  bleed across models.
- On `end_turn` and `refusal`, inspects the newest terminal `steps` row
  (`step_type = 17`, cross-checked against `step_type = 15` model reachability)
  to surface hidden API errors while preserving pure safety refusals:
  - `QUOTA_EXHAUSTED` → `QUOTA` (extracts reset timestamp/delay)
  - Thinking signature validation errors (`thinking.signature: Field required`
    or `Invalid \`signature\` in \`thinking\` block`) → `PROVIDER_ERROR` and
    marks the session dirty for rebuild
  - `429` / `RESOURCE_EXHAUSTED` → `RATE_LIMIT`
  - `404` / `NOT_FOUND` → `SERVER` if the model was reached, else
    `UNKNOWN_MODEL`
- Scoped artifact cleanup removes `conversations/<id>.db*`, `brain/<id>`, and
  `annotations/<id>.pbtxt` without traversing symlinks.

### Usage and `totalTokens` priority

`toTokenUsage()` emits usage only when `session/prompt` includes a `usage`
object. Output and reasoning buckets sum across `max_tokens` continuations;
`totalTokens` resolves in priority order:

1. Positive `usage_update.used` from the current continuation segment.
2. Positive `estimated_tokens_used` from `gen_metadata` in the current segment.
3. Final-segment average fallback:
   `round((input + cacheRead + cacheWrite) / max(1, segmentCalls)) + round(output)`.

When cumulative multi-step prompt buckets (`inputTokens + cacheReadTokens +
cacheWriteTokens`) exceed `totalTokens`, they are proportionally scaled down to
fit `totalTokens` (preserving cache hit ratios) so Pi's `isContextOverflow()`
(`usage.input + usage.cacheRead > contextWindow`) does not falsely compact long
tool-calling turns.

## Quota reader and Pi stream contracts

- **Quota reader (`src/quota.ts`):** Runs `agy -p /usage --output-format json`
  with closed `stdin`, a 1 MiB `stdout` cap, a 45 s timeout, and early abort if
  `stderr` matches `Authentication required`. Uses a monotonic clock
  (`performance.now()`) for its 2-minute TTL, filters `disabled === true`
  buckets, and shares concurrent in-flight queries.
- **Account email scan (`src/quota.ts`):** Checks `cli.log` plus the newest 10
  contained `log/cli-*.log` and `log/acp-server-*.log` files (newest-first,
  realpath-deduplicated), reading the tail 64 KiB first and falling back to the
  head 64 KiB when larger, cached for 10 s by path stat signatures.
- **Warning keys and UI freshness (`index.ts`):** UI generation checks discard
  stale background results; `model_select` retargets an in-flight settled check
  when switching between `antigravity-acp` models. Low-quota warning keys
  include group, bucket ID, window label, reset time, and threshold (`20` or
  `5`).
- **Pi stream hooks (`src/pi-stream.ts`):**
  - `onPayload` can replace the request (strictly validated; invalid shapes
    throw `INVALID_PAYLOAD`; `sessionId` and `signal` are always preserved;
    omitted `tools` inherits original while `tools: []` disables tools).
  - `onResponse` receives synthetic `{ status: 200, headers: {} }` once on the
    first stream chunk (skipped on startup failure or an immediate aborted
    finish), before `onProviderStreamEvent` and Pi event normalization.
  - `CONTEXT_WINDOW_EXCEEDED` and `QUOTA` errors receive
    `context_length_exceeded:` and `quota exceeded:` prefixes for Pi's
    compaction and retry heuristics; transport timeouts remain distinct.
  - `streamPi` drains the runtime generator in `finally` before emitting the
    terminal Pi event.
