---
name: commit
description: "Read this skill before making git commits or jj commits/describes. Follows Conventional Commits 1.0.0 for structured, descriptive commit messages."
---

Create a commit for the current changes using [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) format with a **polished, highly descriptive** message. This applies to `git commit`, `jj commit`, and `jj describe`.

## Commit Message Structure

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Type (REQUIRED)

A noun describing the category of change. Must be **lowercase**.

| Type       | When to use                                          | SemVer impact |
|------------|------------------------------------------------------|---------------|
| `feat`     | New feature or capability                            | MINOR         |
| `fix`      | Bug fix                                              | PATCH         |
| `docs`     | Documentation only (README, comments, docstrings)    | —             |
| `style`    | Formatting, whitespace, semicolons (no logic change) | —             |
| `refactor` | Code restructuring (no new feature, no bug fix)      | —             |
| `perf`     | Performance improvement                              | —             |
| `test`     | Adding or updating tests                             | —             |
| `build`    | Build system or external dependencies                | —             |
| `ci`       | CI configuration and scripts                         | —             |
| `chore`    | Maintenance tasks, tooling, misc                     | —             |
| `revert`   | Reverting a previous commit                          | —             |

### Scope (OPTIONAL)

A short noun in parentheses describing the affected area — e.g. `feat(api):`, `fix(parser):`, `docs(readme):`. Look at recent commit history for commonly used scopes.

### Description (REQUIRED)
- Short imperative summary — e.g. "add Polish language", not "added Polish language"
- No trailing period
- Lowercase first word

### Body (STRONGLY ENCOURAGED)

Always include a body unless the change is trivially obvious (e.g. fixing a typo). The body should explain:

- **What** changed
- **Why** it changed
- The approach taken and any notable decisions

A reader of `git log` should understand the change without looking at the diff. Separate the body from the description with a blank line. Free-form; may contain multiple paragraphs.

### Footers (OPTIONAL)

Each footer follows `token: value` or `token #value` format (inspired by git trailer convention). Use `-` in place of spaces in tokens (e.g. `Reviewed-by`, `Acked-by`).

Common footers:
- `Refs: #123` — related issue/PR numbers
- `Co-authored-by: Name <email>` — credit co-authors

## Rules

- Do NOT add sign-offs (no `Signed-off-by`).
- Only commit/describe; do NOT push.
- If it is unclear whether a file should be included, ask the user which files to commit.
- Treat any caller-provided arguments as additional commit guidance:
  - Freeform instructions should influence scope, summary, and body.
  - File paths or globs should limit which files to commit. If files are specified, only stage/commit those unless the user explicitly asks otherwise.
  - If arguments combine files and instructions, honor both.

## Steps (git)

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Review `git status` and `git diff` (staged + unstaged) to understand the current changes (limit to argument-specified files if provided).
3. Run `git log -n 50 --pretty=format:%s` to check commonly used types and scopes.
4. If there are ambiguous extra files, ask the user for clarification before committing.
5. Stage only the intended files (all changes if no files specified).
6. Compose the commit message:
   - Choose the most accurate `type` from the table above.
   - Pick a `scope` if one fits naturally (don't force it).
   - Write a concise imperative `description`.
   - Write a `body` explaining what/why/how (skip only for trivially obvious changes).
   - Add footers if relevant (issue refs).
7. Run `git commit` with the composed message. Use multiple `-m` flags or a temp file for multi-paragraph messages.

## Steps (jj)

When the project uses [Jujutsu (jj)](https://martinvonz.github.io/jj/) instead of (or alongside) git:

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Review `jj status` and `jj diff` to understand the current changes (limit to argument-specified files if provided).
3. Run `jj log -n 50 --no-graph -T 'description.first_line() ++ "\n"'` to check commonly used types and scopes.
4. If there are ambiguous extra files, ask the user for clarification before committing.
5. Compose the commit message following the same format rules as above.
6. **Scope the commit to the right files using `jj split` with filesets.** Unlike git, `jj commit` does not accept path arguments — it always commits the entire working copy. When you need to commit only a subset of files:
   - Use `jj split '<fileset expression>' -m "<message>"` to move matching files into a new commit, leaving the rest in the working copy.
   - Fileset examples: `glob:"src/**"`, `glob:"clusters/**" | glob:".beans/**"`, `file:"path/to/file.txt"`.
   - Combine filesets with `|` (union), `&` (intersection), or `~` (difference).
   - **Never use `--interactive`** — it opens a diff editor that cannot be driven non-interactively.
   - If ALL changed files should be committed (nothing to exclude), use `jj commit -m "<message>"` directly.
7. Choose the right command:
   - **`jj commit -m "<message>"`** — finalize the working-copy commit and start a new empty one (equivalent to `git commit`). Use when committing all changes.
   - **`jj split '<fileset>' -m "<message>"`** — commit only matching files, leave the rest in working copy. Use when excluding files (e.g. `.pi/` artifacts).
   - **`jj describe -m "<message>"`** — update the description of the current working-copy change without finalizing it.
   - Use whichever the user requested. If neither was specified, default to `jj commit` (or `jj split` if files need excluding).
