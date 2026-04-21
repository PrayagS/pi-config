# working-indicator

Phase-aware working indicator that swaps the spinner based on what the agent is doing.

## Phases

| Phase | Spinner | Speed | When |
|-------|---------|-------|------|
| **thinking** | `▓ ▒ ░ ▒` noise/static | 120ms | Extended thinking active |
| **tool** | `▁▂▃▄▅▆▇█▇▆▅▄▃▂` vertical pulse | 40ms | Tool executing (bash, read, edit, etc.) |
| **streaming** | `▓ ▒ ░ ▒` noise/static | 120ms | Text tokens streaming |
| **working** | `▁▂▃▄▅▆▇█▇▆▅▄▃▂` vertical pulse | 40ms | Default/fallback |

Priority: **thinking > tool > streaming > working**

All frames are colored with the theme's accent color at runtime.

## Commands

- `/working-indicator` — show current phase and status
- `/working-indicator on` — enable phase-aware indicators
- `/working-indicator off` — disable, restore pi default spinner

## How it works

Uses the `setWorkingIndicator()` API to swap spinner frames on phase transitions. Phase is tracked via extension events (`agent_start/end`, `message_update`, `tool_execution_start/end`). Frames are pre-colored with `ctx.ui.theme.fg("accent", ...)` on `session_start` since the Loader renders custom indicators verbatim (without applying `spinnerColorFn`).
