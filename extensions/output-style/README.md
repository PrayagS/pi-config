# output-style

Pi extension for switching between system-prompt-based output styles.

## Usage

```text
/output-style
/output-style off
/output-style attention-control
/output-style caveman
/output-style i-have-adhd
```

The selected style persists globally in `~/.pi/agent/output-style.json` and
becomes the default for all projects and new sessions. It appears in the footer
while active. Run `/reload` in other open sessions to apply a changed style.
The default is `off` until you select a style.

## Adding a style

Add a non-empty `<name>.prompt.md` file beside `index.ts`, then run `/reload`.
The filename becomes the value accepted by `/output-style`.

Style prompts are appended to Pi's system prompt before each agent run. They
should contain only output instructions, with no skill frontmatter or references
to separate activation commands.

## Included styles

- `attention-control` — action-first output with controlled technical language,
  adapted from <https://github.com/aaddrick/attention-control> (MIT)
- `caveman` — terse technical communication based on
  <https://github.com/JuliusBrussee/caveman>
- `i-have-adhd` — action-oriented output structure based on
  <https://github.com/ayghri/i-have-adhd> (MIT)
