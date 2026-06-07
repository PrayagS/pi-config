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
- `extensions/commit/` — `/commit` command that prefetches VCS context and asks the agent to commit
- `extensions/custom-provider-bedrock-inference-profiles/` — Bedrock inference profile support
- `extensions/pi-web-tools/` — `web_search` (Kagi) and `web_fetch` (URL → Markdown)
- `extensions/interactive-shell/` — interactive shell integration
- `extensions/notify/` — notifications
- `extensions/qmd-sessions-indexer/` — refresh qmd session search indexes on Pi session lifecycle events
- `extensions/pi-co-authored-by/` — append AI trailers to git/jj commits
- `extensions/pi-dcp/` — dynamic context pruning (automatic rules + LLM tools)
- `extensions/pi-footer/` — footer/status UI tweaks
- `extensions/pi-better-prompt-editor/` — boxed editor with border status labels, bounded prompt height, and a filtered status-only footer
- `extensions/prompt-history/` — recall prompts from all saved sessions with Ctrl+K/Ctrl+J and fuzzy-search them with Ctrl+R
- `extensions/questionnaire/` — structured question UI tool
- `extensions/sandbox/` — command sandboxing
- `extensions/tools/` — tooling controls
- `extensions/working-indicator/` — phase-aware working spinner (thinking/tool/streaming/working)
- `extensions/pi-images/` — image attachments with kitty graphics preview ([credits](extensions/pi-images/README.md#credits))
- `extensions/pi-spawn-claude-code/` — `claude` tool for spawning Claude Code CLI in background or interactive tmux mode
- `extensions/zzz-system-prompt-filter/` — system prompt filtering

## Skills

- `skills/vcs/` — unified git/jj version-control workflow with shared commit-message guidance
- `skills/skill-creator/` — scaffold Pi skills
- `skills/yaml-reader/` — query and validate YAML with `yq`

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
