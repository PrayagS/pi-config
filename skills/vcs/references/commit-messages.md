# Commit Messages

Use [Scoped Commits](https://scopedcommits.com/) for normal git commits and jj descriptions. Put the affected area first so contributors can scan history by subsystem. This keeps the commit log focused on its developer audience rather than treating it as a generated changelog. Explicit repository-specific commit rules take precedence.

## Format

```
<scope>: <description>

[optional body]

[optional trailer(s)]
```

Treat type labels such as `feat`, `fix`, `docs`, and `refactor` as redundant with the description. Omit them unless one is the repository's actual scope or its required format.

## Scope

Use the subsystem, area, module, package path, service, or other project-relevant subject touched by the change.

Before choosing a scope, check repository guidance and recent history for established names:

```bash
# jj
jj log -n 50 --no-graph -T 'description.first_line() ++ "\n"'

# git
git log -n 50 --pretty=format:%s
```

Examples:

- `auth: reject expired sessions`
- `net/http/cookiejar: add documentation links`
- `vcs: document commit message rules`

For a commit spanning multiple scopes, use the first applicable option:

1. A broader scope that contains all affected areas.
2. Multiple scopes separated by commas, such as `api,cli: rename output field`.
3. `treewide`, `all`, or `global` for a repository-wide change, following local history.

When no useful scope exists, treat the change as a special commit and write a clear unscoped description.

## Description

- Required.
- Summarize the change briefly in the imperative mood: `add Polish language`, not `added Polish language`.
- Start with a lowercase word unless it is a proper noun or identifier.
- Omit the trailing period.

## Body

Strongly encouraged unless the change is trivially obvious. Explain what changed, why, and any non-obvious approach or trade-off. A reader should understand the change without opening the diff.

## Trailers

Optional. Use the repository's established trailer format.

Common trailers:

- `Refs: #123`
- `Co-authored-by: Name <email>`

## Special Commits

Reverts, merges, and other special commits may use their tool-generated or repository-defined format.

## Rules

- Do not add sign-offs (`Signed-off-by`) unless explicitly asked.
- Do not push after committing unless explicitly asked.
