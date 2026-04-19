# sandbox

OS-level sandbox for Pi bash commands.

Uses `@carderne/sandbox-runtime` to wrap bash execution with filesystem and network restrictions.

## Config

Merged in this order:

1. built-in defaults
2. `~/.pi/agent/extensions/sandbox.json`
3. `<cwd>/.pi/sandbox.json`

Project config wins.

## Features

- allow/deny network domains
- allow/deny filesystem read and write paths
- session-aware bash tool replacement
- `--no-sandbox` flag to disable
- `/sandbox` command to inspect current state

## Dependency

This extension has its own `package.json` and depends on `@carderne/sandbox-runtime`.
On Linux, code comments note extra runtime requirements: `bubblewrap`, `socat`, `ripgrep`.
