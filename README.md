# Git History Reword

A deliberately small VS Code extension for staging and applying Git commit metadata edits from a compact history list.

## Requirements

- Git 2.54 or newer
- VS Code built-in Git extension
- Linear history for rewritten ranges (`git history` does not yet support merge histories)

## Usage

1. Open Source Control.
2. Click the **Git History Reword** pencil button.
3. Edit a commit message and/or its time directly in the list.
4. Edited rows change to the Git modified color.
5. Press **Sync** to apply all staged changes.

## Rewrite behavior

- Commit message changes are delegated to `git history reword <commit> --update-refs=head`.
- A message body is preserved when only its subject is edited.
- The Time field changes both the Author Date and Committer Date to the selected time.
- Timestamp-only rewriting preserves each commit's tree, message, author/committer identity, and unchanged timestamps while rebuilding the affected linear suffix with Git `commit-tree`.
- Sync creates a backup ref under `refs/git-history-reword/backup-*` before rewriting.
- The extension never requires a remote, GitHub account, or interactive rebase.

`git history` is still experimental in current Git releases.
