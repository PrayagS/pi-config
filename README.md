# pi-config

Opinionated [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) package with extensions, skills, and agents I use in my own setup.

Personal workflow repo. Expect sharp edges and occasional breaking changes.

## Install

Install package from git:

```bash
pi install git:github.com/PrayagS/pi-config
pi config
```

Or try it for one run:

```bash
pi -e git:github.com/PrayagS/pi-config
```

## Extensions

- `extensions/caveman/` — response-style control with `/caveman`
- `extensions/custom-provider-bedrock-inference-profiles/` — Bedrock inference profile support
- `extensions/fetch-url/` — fetch URL content as clean Markdown
- `extensions/interactive-shell/` — interactive shell integration
- `extensions/notify/` — notifications
- `extensions/pi-co-authored-by/` — append AI trailers to git/jj commits
- `extensions/pi-footer/` — footer/status UI tweaks
- `extensions/questionnaire/` — structured question UI tool
- `extensions/sandbox/` — command sandboxing
- `extensions/supacode/` — Supacode busy state + completion notification hooks
- `extensions/tools/` — tooling controls
- `extensions/web-search/` — web search tool
- `extensions/zzz-system-prompt-filter/` — system prompt filtering

## Skills

- `skills/git-commit/` — conventional git commit workflow
- `skills/jujutsu/` — jj workflow guidance
- `skills/skill-creator/` — scaffold Pi skills
- `skills/yaml-reader/` — query and validate YAML with `yq`
- `extensions/caveman/caveman-compress/` — compress memory files into caveman format

## AGENTS.md

- `GLOBAL_AGENTS.md` — symlinked to `~/.pi/agent/AGENTS.md`, based on <https://github.com/HazAT/pi-config/blob/main/AGENTS.md>

## Subagent definitions

These definitions are meant to be used with the [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) extension.

- `agents/` — subagent definitions adapted from <https://github.com/HazAT/pi-interactive-subagents/tree/main/agents>
  - `agents/spec.md`
  - `agents/planner.md`
  - `agents/scout.md`
  - `agents/worker.md`
  - `agents/reviewer.md`
  - `agents/researcher.md`
  - `agents/claude-code.md`

## Notes

- `pi install` exports only extensions and skills listed in `package.json`.
