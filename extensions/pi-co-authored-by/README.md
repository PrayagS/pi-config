# pi-co-authored-by

A [Pi](https://github.com/badlogic/pi) extension that automatically appends a `Co-Authored-By` trailer to commit messages when the agent runs `git commit`, `jj commit`, `jj-hunk commit`, `jj describe`, or `jj new`, recording which model helped write the code.

## Features

**Co-Authored-By trailer** — Credits the model that helped write the code:
```
Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>
```

**Example commit:**
```
fix: resolve null pointer

Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>
```

## Supported commands

| Command | Example |
|---------|---------|
| `git commit` | `git commit -m "fix: typo"`, `git commit --amend --no-edit` |
| `jj commit -m` | `jj commit -m "fix: typo"` |
| `jj-hunk commit` | `jj-hunk commit <spec> "fix: typo"` |
| `jj describe -m` | `jj describe -m "fix: typo"` |
| `jj new -m` | `jj new -m "start: next change"` |

The built-in aliases `jj ci` and `jj desc` are also recognized.

**Every** `git commit` gets the trailer — including editor-driven, `-F`,
`--amend --no-edit`, and `--fixup`/`--squash` commits — via git's native
`--trailer` flag. jj commands are only rewritten when they carry an explicit
`-m`/`--message`, so editor-driven jj descriptions are untouched.

Commands reached through indirect execution (`xargs`, `bash -c '…'`, `watch`,
and similar) are not rewritten. Direct wrappers such as `env`, `sudo`,
`timeout`, `nohup`, `exec`, and `command` are supported.

## Requirements

- [Pi](https://github.com/badlogic/pi) coding agent
- Git >= 2.32 (for `git commit --trailer`)
- [`unbash`](https://www.npmjs.com/package/unbash), installed automatically as a `pi-config` dependency

## Install

This version is distributed as part of [`pi-config`](https://github.com/PrayagS/pi-config):

```bash
pi install git:github.com/PrayagS/pi-config
```

Or try it without installing:

```bash
pi -e git:github.com/PrayagS/pi-config
```

## How it works

The extension hooks into Pi's `tool_call` event and parses Bash commands into a source-positioned AST. It rewrites only actual Git, jj, and jj-hunk command nodes, leaving heredocs, comments, redirects, and unrelated argument text untouched.

For `git commit`, it inserts git's native `--trailer` flag (plus `-c trailer.ifexists=addIfDifferent` so re-runs and `--amend` never duplicate the trailer). For jj commands, it appends a safely quoted extra `-m` flag, which jj joins as a trailing paragraph. Because `jj-hunk commit` takes a positional message, the extension appends the safely quoted trailer directly to that argument.

| What | Value |
|------|-------|
| `Co-Authored-By` | Model name (e.g., `Claude Sonnet 4`) |

## Development

The test suite requires [Bun](https://bun.sh/).

```bash
npm install
npm run test:co-authored-by
```

## License

MIT
