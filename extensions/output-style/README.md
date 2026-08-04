# output-style

Pi extension for switching between system-prompt-based output styles.

## Usage

```text
/output-style
/output-style off
/output-style attention-control
/output-style attention-control caveman
/output-style caveman
/output-style i-have-adhd
```

The selected styles persist globally in `~/.pi/agent/output-style.json` and
become the default for all projects and new sessions. They appear in the footer
while active. List multiple style names to replace the active set. Run `/reload`
in other open sessions to apply changed styles. The default is `off` until you
select a style.

## Adding a style

Add a non-empty `<name>.prompt.md` file beside `index.ts`, then run `/reload`.
The filename becomes the value accepted by `/output-style`.

Active style prompts are appended to Pi's system prompt in filename order before
each agent run. They should contain only output instructions, with no skill
frontmatter or references to separate activation commands.

## Included styles

- `attention-control` — action-first output with controlled technical language,
  adapted from <https://github.com/aaddrick/attention-control> (MIT)
- `caveman` — terse technical communication based on
  <https://github.com/JuliusBrussee/caveman>
- `i-have-adhd` — action-oriented output structure based on
  <https://github.com/ayghri/i-have-adhd> (MIT)
