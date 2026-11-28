# pi-config

Opinionated [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) package with extensions, skills, and agents I use in my own setup.

Personal workflow repo. Expect sharp edges and occasional breaking changes.

## Bootstrap my Pi profile

With Pi and mise installed, clone this repo to `~/dev/pi-config` and run:

```sh
mise -C ~/dev/pi-config bootstrap
```

This fills missing keys in `~/.pi/agent/settings.json` from `profile/settings.json`.
Existing values and arrays, including the `packages` list, are not overwritten.
Pi's changes to `settings.json` stay in the live file; the npm watcher below
can capture package changes selectively. The other tracked profile files, patch
script, and `AGENTS.md` are symlinks.

Bootstrap then runs `pi update --extensions` for the user profile, followed by
the repo's `patch-minimal-subagents.mjs` if the update succeeds. Keep credentials
and runtime state out of `profile/`.

The shipped settings load this checkout as a local Pi package. Use the checkout
path above, or adjust the package path in your live settings. Local package
runtime dependencies are managed separately with `aube install`.

### Watch Pi's npm packages

After bootstrapping the merge-based profile, start a report-only watcher:

```sh
mise -C ~/dev/pi-config -E package-watch run pi:packages:watch
```

The first run records a local baseline; it does not treat packages already
absent on this machine as deletions. Later runs report npm additions, removals,
and declaration edits. To capture the reported changes, run
`mise -C ~/dev/pi-config run pi:packages:capture`. For continuous capture in a
foreground watcher, set `PI_PACKAGE_SYNC_APPLY=1` when starting it.

The task writes only the observed npm changes to `profile/settings.json`. It
doesn't copy other settings, local checkout paths, or state, and never commits
or pushes. If the repo's npm list was edited independently, review both lists
before running `mise -C ~/dev/pi-config run pi:packages:reset-baseline` to accept
them as the new baseline without copying either. The watcher refuses to read
live settings through a symlink; migrate the profile first.

The optional login service captures changes automatically. It updates the
working copy only; review and commit the changes with your normal work. With
mise installed at `~/.local/bin/mise`, opt in on this machine with:

```sh
mise -C ~/dev/pi-config -E package-watch bootstrap --only tools,services
```

Its log is under `${XDG_STATE_HOME:-$HOME/.local/state}/pi-config/package-watch.log`.

## Install just the package

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

- `extensions/output-style/` — switch system-prompt output styles with `/output-style`
- `extensions/caffeinate/` — prevent macOS idle sleep while Pi is working
- `extensions/commit/` — `/commit` command that prefetches VCS context and asks the agent to commit
- `extensions/custom-provider-bedrock-inference-profiles/` — Bedrock inference profile support
- `extensions/pi-web-tools/` — `web_search`, `web_fetch`, `web_extract`, and `/web-tools usage` provider usage summary
- `extensions/interactive-shell/` — interactive shell integration
- `extensions/notify/` — notifications
- `extensions/pi-co-authored-by/` — append AI trailers to git/jj commits
- `extensions/pi-dcp/` — dynamic context pruning (automatic rules + LLM tools)
- `extensions/pi-footer/` — footer/status UI tweaks
- `extensions/pi-better-prompt-editor/` — boxed editor with border status labels, bounded prompt height, and a filtered status-only footer
- `extensions/prompt-history/` — recall prompts from all saved sessions with Ctrl+K/Ctrl+J and fuzzy-search them with Ctrl+R
- `extensions/questionnaire/` — structured question UI tool
- `extensions/sandbox/` — command sandboxing
- `extensions/tools/` — tooling controls
- `extensions/vent/` — `vent` tool logging workflow friction to a shared JSONL log at `~/.pi/agent/vent.jsonl`, with `/vent-export`, `/vent-review`, and `/vent-archive` commands
- `extensions/working-indicator/` — phase-aware working spinner (thinking/tool/streaming/working)
- `extensions/pi-images/` — image attachments with kitty graphics preview ([credits](extensions/pi-images/README.md#credits))
- `extensions/zzz-system-prompt-filter/` — system prompt filtering
- `extensions/mpl/` — codemode-only `mpl_render` tool for matplotlib-style PNG/SVG charts ([credits](extensions/mpl/README.md))
- `extensions/pi-agy-acp/` — `antigravity-acp` provider via the local `agy` CLI with Pi-owned tool execution, session persistence, and hardcoded 1M model specs ([README](extensions/pi-agy-acp/README.md))

### Experimental

- `extensions/prewalk/` — plan on a strong model, then hand implementation to a fast model with `/prewalk`

### Archive

Retained in the repository but not registered by the package.

- `extensions/qmd-sessions-indexer/` — refresh qmd session search indexes on Pi session lifecycle events

## Skills

- `skills/vcs/` — unified git/jj version-control workflow with shared commit-message guidance
- `skills/yaml-reader/` — query and validate YAML with `yq`

## AGENTS.md

- `GLOBAL_AGENTS.md` — symlinked to `~/.pi/agent/AGENTS.md`, based on <https://github.com/HazAT/pi-config/blob/main/AGENTS.md>

## Subagent definitions

These definitions are meant to be used with the [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) extension.

- `agents/` — subagent definitions adapted from <https://github.com/HazAT/pi-interactive-subagents/tree/main/agents>
  - `agents/planner.md`
  - `agents/scout.md`
  - `agents/worker.md`
  - `agents/researcher.md`

## Development

- Dependencies are managed with [aube](https://aube.sh). Run `aube install`, or `aubr <script>`, which installs first when dependencies are stale. `aube-lock.yaml` is the committed lockfile.
- Keep `.npmrc` and `pnpm-workspace.yaml`. `pi install` uses npm (or pnpm/Bun) for git sources, and those files let it fetch and build the `mpl` git dependency.
- Run [fallow](https://fallow.tools) (`fallow`, `fallow dead-code`) to find unused code, duplication, and complexity hotspots. Config is in `.fallowrc.jsonc`.

## Notes

- `pi install` exports only extensions and skills listed in `package.json`.
