# prompt-history

Pi extension that recalls prompts from all saved sessions with keyboard shortcuts.

## Usage

- `Ctrl+K` — recall older prompt
- `Ctrl+J` — recall newer prompt

Type a prefix before pressing `Ctrl+K` to filter history to matching prompts. Pressing `Ctrl+J` past the newest match restores the original typed text.

## Behavior

- scans `~/.pi/agent/sessions/**/*.jsonl`
- reads session files as streams to avoid loading full session history into memory
- returns only the last 50 unique user prompts
- caches results for 5 seconds
- resets history navigation after submitting input

## Notes

This intentionally does not use `SessionManager.listAll()` because session summaries include `allMessagesText`, which can load large session stores into memory.
