# tools

Pi extension that adds `/tools` for interactively enabling and disabling tools.

Only disabled tools are stored. Anything not listed stays enabled.

## Storage

Global state lives in:

`~/.pi/agent/tools-disabled.json`

That means tool toggles persist across sessions and projects.

## Behavior

- refreshes tool list from `pi.getAllTools()`
- applies active tools with `pi.setActiveTools(...)`
- reloads state on session start, tree navigation, and fork

## Credits

Adapted from Pi example extension:
https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/tools.ts
