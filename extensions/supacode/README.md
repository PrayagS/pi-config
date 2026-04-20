# supacode

Pi extension that reports Pi activity to [Supacode](https://supacode.sh/) through Supacode's Unix socket hook protocol.

## What it does

- sends `busy=1` on `agent_start`
- sends `busy=0` on `agent_end` and `session_shutdown`
- sends Stop notification payload on `agent_end`

This powers Supacode's running indicator and completion notifications for Pi sessions.

## Requirements

Supacode must inject these env vars into terminal:

- `SUPACODE_SOCKET_PATH`
- `SUPACODE_WORKTREE_ID`
- `SUPACODE_TAB_ID`
- `SUPACODE_SURFACE_ID`

If missing, extension becomes no-op.

## Command

- `/supacode-hook-status` — show whether Supacode hook env vars are present
