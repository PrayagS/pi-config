# pi-config

Opinionated [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) package with extensions and skills I use in my own setup.

Personal workflow repo. Expect sharp edges and occasional breaking changes.

## Install

Install from git:

```bash
pi install git:github.com/PrayagS/pi-config
pi config
```

Or try it for one run:

```bash
pi -e git:github.com/PrayagS/pi-config
```

## Included

### Extensions

- `caveman/` — response-style control with `/caveman`
- `custom-provider-bedrock-inference-profiles/` — Bedrock inference profile support
- `fetch-url.ts` — fetch URL content as clean Markdown
- `interactive-shell.ts` — interactive shell integration
- `notify.ts` — notifications
- `pi-co-authored-by/` — append AI trailers to git/jj commits
- `pi-footer/` — footer/status UI tweaks
- `questionnaire.ts` — structured question UI tool
- `sandbox/` — command sandboxing
- `tools.ts` — tooling controls
- `web-search/` — web search tool
- `zzz-system-prompt-filter/` — system prompt filtering

### Skills

- `git-commit/` — conventional git commit workflow
- `jujutsu/` — jj workflow guidance
- `skill-creator/` — scaffold Pi skills
- `yaml-reader/` — query and validate YAML with `yq`
- `caveman-compress/` — compress memory files into caveman format

## Notes

- Package exports extensions and skills defined in `package.json`.
- Repo meant for Pi package install, not full `~/.pi/agent` replacement.
