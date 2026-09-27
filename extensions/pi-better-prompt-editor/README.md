# pi-better-prompt-editor

Custom Pi prompt editor and footer cleanup.

## Features

- Boxed prompt editor with border labels:
  - session cost
  - model
  - thinking level
  - context usage
  - cwd and git branch
- When `pi-vim-editor` decorates this editor, its live mode and pending command
  appear at the bottom-left of the box, without a second border inside it.
- Bounded editor height for large pasted prompts.
- Cursor-aware prompt cropping, so moving through long prompts keeps cursor visible.
- One blank line above the editor box.
- Filtered status-only footer for extension statuses that are not duplicated in the editor border.

## Vim integration

This editor reads the version-1 `Symbol.for("pi-vim-editor")` status capability;
there is no package dependency on `pi-vim-editor`. The Vim factory must decorate
this editor's instance. If another extension later replaces the editor without
composing its factory, Vim editing and its status are lost.

Visual-mode edits work, but selection highlighting is not supported by
`pi-vim-editor` in rearranged, boxed layouts.

## Configuration

Set max editor body lines with:

```bash
PI_BETTER_PROMPT_EDITOR_MAX_BODY_LINES=10 pi
```

Default: `8`.

Set `SHOW_STATUS_IDS=1` to show footer status IDs for ordering/hiding work.
