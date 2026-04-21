---
name: jujutsu
description: >
  Jujutsu (jj) version control. Use for any version control operation —
  committing, pushing, branching, rebasing, undoing, splitting commits, or
  resolving conflicts — when a `.jj/` directory exists. Activate FIRST, even
  when the user says "git commit", "git push", or "git status", since jj
  repos require jj commands. Also covers history editing, bookmarks, and
  colocated git repo workflows.
---


# Jujutsu (jj) Version Control

Git-compatible VCS with mutable commits, automatic rebasing, and no staging area.

## Step 1: Detect VCS

Before any VCS command, confirm this is a jj repo:

```bash
if jj root &>/dev/null; then echo "jj"
elif git rev-parse --show-toplevel &>/dev/null; then echo "git"
else echo "none"
fi
```

If `jj` — use this skill. If `git` — use standard git commands. If both `.jj/` and `.git/` exist, this is a **colocated** repo — prefer jj for all commands.

## Step 2: Understand Core Concepts

> ⚠️ **Not Git!** Jujutsu syntax and model differ significantly from Git.

### Key Differences from Git

1. **No staging area** — every file change is automatically part of the working copy commit
2. **Working copy is a commit** — `@` represents your current working copy commit; changes are snapshotted on every jj command
3. **Commits are mutable** — modify any commit freely; descendants auto-rebase
4. **Conflicts are values** — conflicts don't block operations; they're tracked and can be resolved later
5. **Bookmarks, not branches** — use "bookmarks" as publication pointers, not a current-branch model

### Terminology Mapping

| Git | jj |
|-----|-----|
| `branch` | `bookmark` |
| `HEAD` | `@` (working copy) |
| `checkout` | `edit` or `new` |
| `stash` | Not needed (just create new commits) |
| `staging/index` | Not applicable |
| `commit --amend` | Just edit files — changes auto-apply to `@` |
| `reflog` | `jj evolog` (change-level) or `jj op log` (operation-level) |

### Change IDs vs Commit IDs

- **Change ID** (e.g. `tqpwlqmp`): stable identifier that persists across rewrites
- **Commit ID** (e.g. `3ccf7581`): content hash that changes when commit content changes

Prefer change IDs in commands — they survive rebases and squashes.

## Step 3: Agent-Specific Rules

1. **Always pass `-m "message"`** to avoid opening an interactive editor (which hangs in agent environments):
   ```bash
   jj desc -m "message"     # NOT: jj desc
   jj squash -m "message"   # NOT: jj squash
   jj new -m "message"      # NOT: jj new (without -m when describing)
   ```

2. **Avoid interactive commands** — these open editors/TUIs and will hang:

   | Blocked Command | Use Instead |
   |-----------------|-------------|
   | `jj describe` (no `-m`) | `jj describe -m "message"` |
   | `jj squash -i` | `jj squash -m "message"` |
   | `jj split` (no filesets) | `jj split -m "msg" <files>` |
   | `jj restore -i` | `jj restore <files>` |
   | `jj resolve` | Edit conflict markers directly |
   | `jj diffedit` | `jj restore` or `jj squash` |
   | Any command with `--tool` | Use non-interactive alternatives |

3. **Verify after mutations** — run `jj st` after `squash`, `abandon`, `rebase`, or `restore` to confirm success.

4. **Always run `jj new` after `jj desc -m` when starting work**:
   - Check `jj st` — if `@` already has changes, run `jj new` first
   - Describe intent with `jj desc -m "feat: add feature"`
   - Immediately run `jj new` so described commit becomes parent and new work lands in fresh working-copy commit
   - Make changes — they auto-apply to new `@`
   - When finishing task, leave current working-copy commit ready for next `jj desc -m` → `jj new` cycle

## Step 4: Common Operations

### Viewing State

Use plain-text flags for agent-readable output. Verified from help pages:
- `jj`: `--color=never`, `--no-pager`; for log also `--no-graph`
- `git`: `--no-color`, `--no-pager`; for log also `--no-decorate`; for diff also `--no-ext-diff`

```bash
jj st                                       # Working copy status
jj --color=never --no-pager log --no-graph # Plain-text log
jj --color=never --no-pager log -r 'all()' --no-graph
jj --color=never --no-pager diff           # Plain-text working copy diff
jj --color=never --no-pager diff --git     # Plain-text diff in git format
jj --color=never --no-pager diff --git -r <change>   # Diff of specific commit
jj show <change>                            # Full commit details
jj evolog                                   # Previous states of a change (like git reflog)
jj op log                                   # Operation history

git --no-pager log --no-color --no-decorate -n 20 --oneline
git --no-pager diff --no-color --no-ext-diff
```

### Creating and Navigating Commits

```bash
jj new                      # New empty commit on top of current
jj new -m "feat: new work"  # New commit with message
jj new main -m "feat: ..."  # New commit based on main
jj new x y -m "merge: ..."  # Merge multiple changes
jj edit <change-id>         # Switch working copy to a specific change
jj edit @-                  # Switch to parent
jj next --edit              # Move to next child
jj prev --edit              # Move to previous parent
jj new --before @ -m "msg"  # Insert a commit before current
```

### Editing History

```bash
jj desc -m "new message"                        # Update current commit description
jj desc -r <change> -m "new message"             # Update any commit's description
jj squash -m "combined"                          # Squash current into parent
jj squash -r <change> -m "combined"              # Squash specific commit into its parent
jj squash --into <target> -m "msg"               # Squash current into specific target
jj squash --from <src> --into <target> -m "msg"  # Squash source into target
jj squash --from <old>::<new> --into <target> -m "msg"  # Squash range into target
jj absorb                              # Auto-distribute changes to relevant ancestor commits
jj rebase -r <change> -d <dest>        # Rebase single commit
jj rebase -s <change> -d <dest>        # Rebase commit and descendants
jj rebase -b <change> -d <dest>        # Rebase whole branch
jj abandon <change-id>                 # Remove commit (descendants rebase to parent)
jj restore                             # Discard all working copy changes
jj restore path/to/file.txt            # Discard changes to specific files
jj restore --from <change> path/file   # Restore files from a specific revision
jj metaedit -r @ -m "new message"      # Edit metadata without changing content
jj duplicate <change>                  # Create safe copy before destructive operations
jj cat -r <change> path/file           # Print file contents at a specific revision
jj interdiff --from <a> --to <b>       # Diff between two changesets (empty = identical)
```

### Undo and Recovery

```bash
jj undo                     # Reverse last operation
jj op log                   # See operation history
jj op undo                  # Undo last operation (same as jj undo)
jj op restore <operation>   # Restore to specific operation state
```

Nothing is ever truly lost — `jj op log` is the recovery source of truth.

## Splitting Changesets

Read `references/splitting.md` when splitting changesets, reorganizing history, or creating stacked commits from a single change.

## Committing

Read `references/committing.md` when writing commit descriptions or messages.