# Splitting Changesets with jj-hunk

Split a large changeset into smaller, focused units — separate refactors from features from tests.

Use `jj-hunk` for programmatic hunk selection without interactive UI. It handles both file-level and hunk-level splitting.

## Workflow

1. **Inspect** the changeset:
   ```bash
   jj diff -r <revset> --stat
   jj diff -r <revset>
   ```

2. **List hunks** to see what's available:
   ```bash
   jj-hunk list                  # Hunks in working copy
   jj-hunk list --rev <revset>   # Hunks for specific revision
   jj-hunk list --files          # File summary with hunk counts
   ```

3. **Split** iteratively — extract one logical group at a time, remainder stays for the next split.

4. **Verify** the split:
   ```bash
   jj interdiff --from <original> --to <last-split-changeset>
   # Empty output = nothing lost or duplicated
   ```

## Spec Format

Build a JSON spec to select which changes go into the first commit:

```json
{
  "files": {
    "src/foo.rs": {"hunks": [0, 2]},
    "src/bar.rs": {"action": "keep"},
    "src/baz.rs": {"action": "reset"}
  },
  "default": "reset"
}
```
| Spec | Effect |
|------|--------|
| `{"hunks": [0, 2]}` | Include only hunks 0 and 2 |
| `{"ids": ["hunk-..."]}` | Include hunks by stable ID |
| `{"action": "keep"}` | Include all changes in file |
| `{"action": "reset"}` | Discard all changes in file |
| `"default": "reset"` | Unlisted files are discarded |
| `"default": "keep"` | Unlisted files are kept |

## Commands

```bash
# Split: selected hunks → first commit, rest → second
jj-hunk split '<spec>' "commit message"
jj-hunk split -r <rev> '<spec>' "commit message"

# Commit: selected hunks committed, rest stays in working copy
jj-hunk commit '<spec>' "commit message"

# Squash: selected hunks squashed into parent
jj-hunk squash '<spec>'
jj-hunk squash -r <rev> '<spec>'

# Read spec from file or stdin
jj-hunk split --spec-file spec.json "commit message"
cat spec.json | jj-hunk commit - "commit message"
```

## Example: Split Mixed Changes

```bash
# 1. Inspect
jj-hunk list

# 2. Infrastructure first (whole file)
jj-hunk split '{"files": {"src/db/schema.ts": {"action": "keep"}}, "default": "reset"}' \
  "feat: add database schema"

# 3. Refactoring (specific hunks from a mixed file)
jj-hunk split '{"files": {"src/lib/utils.ts": {"hunks": [0, 2]}}, "default": "reset"}' \
  "refactor: clean up utils"

# 4. Remaining changes become last described commit
jj describe -m "feat: add new endpoint"

# 5. Open fresh working-copy commit after describing
jj new

# 6. Verify
jj log -r 'trunk()..@'
```

Order splits by dependency — if features depend on refactors, extract refactors first so they become the parent.
