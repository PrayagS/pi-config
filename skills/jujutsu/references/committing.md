# Commit Descriptions in jj

Write commit descriptions using [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) format.

## Format

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

Short noun in parentheses — e.g. `feat(api):`, `fix(parser):`. Check recent history for commonly used scopes: `jj log -n 50 --no-graph -T 'description.first_line() ++ "\n"'`

### Description (required)

- Short imperative summary — e.g. "add Polish language", not "added Polish language"
- No trailing period
- Lowercase first word

### Body (strongly encouraged)

Include unless the change is trivially obvious. Explain **what** changed, **why**, and the approach taken. A reader of `jj log` should understand the change without looking at the diff.

### Footers (optional)

`token: value` or `token #value` format. Common footers:
- `Refs: #123` — related issue/PR numbers
- `Co-authored-by: Name <email>`

## Steps

1. Review `jj status` and `jj diff` to understand current changes.
2. Check commonly used types and scopes: `jj log -n 50 --no-graph -T 'description.first_line() ++ "\n"'`
3. Compose the description following the format above.
4. Apply with `jj describe -m "<message>"`.
5. If this description starts a new unit of work, immediately run `jj new` so new edits land in fresh working-copy commit.

## Rules

- Do NOT push after describing.
- Do NOT add sign-offs (no `Signed-off-by`).
