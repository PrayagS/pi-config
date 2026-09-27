# Anthropic stall probe

Shows and logs Anthropic Messages requests that return response headers but never send `message_start`.

Pi's provider events drop SSE `ping` frames, and each ping resets `httpIdleTimeoutMs`. When the server sends `200` plus pings and no content, Pi shows "Working..." with no error and no retry. This extension watches raw undici traffic to `api.anthropic.com/v1/messages` through `node:diagnostics_channel`. It does not patch fetch or log request bodies or auth headers.

## What it does

- Appends one JSON line per request to `~/.pi/agent/anthropic-stall-probe.jsonl`. Each line has the status, time to headers, time to first non-ping event, pings before that event, bytes, largest chunk gap, `request-id`, `cf-ray`, and the `anthropic-ratelimit-*` headers.
- Writes a `stall-warning` line and shows a footer status plus a notification when a request has no `message_start` after `PI_STALL_PROBE_WARN_MS`.
- Aborts a stream with no non-ping event for `PI_STALL_PROBE_EVENT_IDLE_MS`, which mirrors Claude Code's event-level watchdog. Records now include `events`, `pings`, and `maxEventGapMs`, so you can see real thinking pauses before you lower it.
- When `PI_STALL_PROBE_ABORT_MS` > 0, aborts a request that has headers but no `message_start` for that long. The error text includes `terminated` and `timed out`, so Pi's normal retry handles it (`retry.enabled`).

## Claude Code watchdog equivalents

Claude Code documents four streaming watchdogs ([network-config](https://code.claude.com/docs/en/network-config#streaming-idle-watchdogs)). In Pi:

| Claude Code | Pi |
|---|---|
| First-byte deadline (no response headers; 180s) | Built in: undici `headersTimeout` = `httpIdleTimeoutMs` |
| Byte-level watchdog (no bytes, pings count; 180s) | Built in: undici `bodyTimeout` = `httpIdleTimeoutMs` |
| Body idle timeout (no bytes; 5 min, non-Anthropic providers) | Same `bodyTimeout` (Pi does not distinguish it from the byte-level watchdog) |
| Event-level watchdog (no parsed event; 300s) | This extension: `PI_STALL_PROBE_EVENT_IDLE_MS`; pings do not count |

`PI_STALL_PROBE_ABORT_MS` has no Claude Code equivalent. It is a stricter limit for the gap between headers and `message_start`.

## Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PI_STALL_PROBE_WARN_MS` | `30000` | Warn after this long from request start without `message_start`. |
| `PI_STALL_PROBE_ABORT_MS` | `0` (off) | Abort and let Pi retry after this long from headers without `message_start`. |
| `PI_STALL_PROBE_EVENT_IDLE_MS` | `300000` | Abort and let Pi retry when no non-ping SSE event arrives for this long. It also applies before `message_start` when `PI_STALL_PROBE_ABORT_MS` is off. `0` disables it. |
| `PI_STALL_PROBE_HOSTS` | `api.anthropic.com` | Comma-separated hosts to watch. |
| `PI_STALL_PROBE_LOG` | `~/.pi/agent/anthropic-stall-probe.jsonl` | Log path. |

## Reading the log

```sh
# Stalls, with the overage headers on each one
jq -c 'select(.kind!="request" or .firstEventMs==null) | {kind,start,secsPastHalfHour,status,headersMs,pingsBeforeFirstEvent,durationMs,outcome,rid:.headers["request-id"],overage:.headers["anthropic-ratelimit-unified-overage-in-use"]}' ~/.pi/agent/anthropic-stall-probe.jsonl
```

## Test

```sh
node --test extensions/anthropic-stall-probe/probe.test.ts
```
