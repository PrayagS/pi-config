# output-style

Pi extension for switching between system-prompt-based output styles.

## Usage

```text
/output-style
/output-style off
/output-style caveman
/output-style i-have-adhd
```

New sessions default to `off`. The selected style persists in session state and
appears in the footer while active.

## Adding a style

Add a non-empty `<name>.prompt.md` file beside `index.ts`, then run `/reload`.
The filename becomes the value accepted by `/output-style`.

Style prompts are appended to Pi's system prompt before each agent run. They
should contain only output instructions, with no skill frontmatter or references
to separate activation commands.

## Included styles

- `caveman` — terse technical communication based on
  <https://github.com/JuliusBrussee/caveman>
- `i-have-adhd` — action-oriented output structure based on
  <https://github.com/ayghri/i-have-adhd> (MIT)
