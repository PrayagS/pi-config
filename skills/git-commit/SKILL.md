---
name: git-commit
description: "Create git commits with Conventional Commits 1.0.0 format. Use when making git commits or writing commit messages in git repositories (not jj — see jujutsu skill)."
---

Create a commit for the current changes using [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) format with a polished, descriptive message.

## Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Type (required)

| Type       | When to use                                          |
|------------|------------------------------------------------------|
| `feat`     | New feature or capability                            |
| `fix`      | Bug fix                                              |
| `docs`     | Documentation only (README, comments, docstrings)    |
| `style`    | Formatting, whitespace, semicolons (no logic change) |
| `refactor` | Code restructuring (no new feature, no bug fix)      |
| `perf`     | Performance improvement                              |
| `test`     | Adding or updating tests                             |
| `build`    | Build system or external dependencies                |
| `ci`       | CI configuration and scripts                         |
| `chore`    | Maintenance tasks, tooling, misc                     |
| `revert`   | Reverting a previous commit                          |

### Scope (optional)

Short noun in parentheses — e.g. `feat(api):`, `fix(parser):`. Check recent history for commonly used scopes: `git log -n 50 --pretty=format:%s`

### Description (required)

- Short imperative summary — e.g. "add Polish language", not "added Polish language"
- No trailing period
- Lowercase first word

### Body (strongly encouraged)

Include unless the change is trivially obvious. Explain **what** changed, **why**, and the approach taken. A reader of `git log` should understand the change without looking at the diff.

### Footers (optional)

`token: value` or `token #value` format. Common footers:
- `Refs: #123` — related issue/PR numbers
- `Co-authored-by: Name <email>`

## Steps

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Review `git status` and `git diff` (staged + unstaged) to understand current changes (limit to argument-specified files if provided).
3. Check commonly used types and scopes: `git log -n 50 --pretty=format:%s`
4. If ambiguous extra files exist, ask the user which to include.
5. Stage only the intended files (all changes if none specified).
6. Compose the commit message following the format above.
7. Run `git commit` with the composed message. Use multiple `-m` flags or a temp file for multi-paragraph messages.

## Rules

- Do NOT push after committing.
- Do NOT add sign-offs (no `Signed-off-by`).
- If caller provides file paths, only stage/commit those files.
- If caller provides freeform instructions, use them to influence scope, summary, and body.
