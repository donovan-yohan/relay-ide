# /publish — Release from feature branch to production

You are executing an interactive release workflow. Follow each step in order. At every gate or destructive action, ask the user to confirm before proceeding. If the user says "abort" at any point, stop immediately and report what has already been done so the user knows the current state.

## Overview

This command orchestrates:

1. Pre-flight checks
2. Code review gate
3. Documentation review
4. Commit pending changes
5. Merge to master
6. Version bump (analyze → suggest → confirm)
7. Tag and push
8. Branch cleanup

Report each step as **"Step N/8: {name}"** before starting it.

---

## Step 1/8: Pre-flight checks

Run these checks in order. If any fail, report the failure and stop.

1. **Verify branch:** Run `git branch --show-current`. If the result is `master`, refuse to continue — tell the user: "You're already on master. Use `npm version <type>` directly for versioning." and stop.

2. **Save the branch name** for use in later steps. Refer to it as `<branch>` throughout.

3. **Check working tree:** Run `git status --porcelain`. If there are uncommitted changes, tell the user what's dirty and ask: "Commit these changes now, or abort?" Act on their choice.

4. **Run tests:** Run `npm test`. If tests fail, show the output and stop. Do not proceed with a failing test suite.

5. **Fetch remote:** Run `git fetch origin` to ensure refs are current.

Report: "Pre-flight checks passed. On branch `<branch>`."

---

## Step 2/8: Code review gate

Check for evidence that this branch's changes have been reviewed:

1. **Check GitHub PR:** Run `gh pr view --json reviews,state` for the current branch.
   - If a PR exists with at least one `APPROVED` review, report "PR approved by {reviewer}" and proceed.
   - If `gh` fails or no PR exists, continue to step 2.

2. **Check commit messages:** Run `git log master..<branch> --oneline` and scan for messages containing "code review", "review findings", or "address review" (case-insensitive).
   - If found, report "Review evidence found in commit history" and proceed.

3. **No review found:** Warn the user:

   > No code review approval or review evidence found for this branch.
   > Proceed without review? (yes/abort)

   If the user says "abort", stop and report current state. Only proceed on explicit "yes".

---

## Step 3/8: Documentation review

1. **Run reflect:** Execute `/doc-review` to check tier 2/3 documentation against recent changes. Report any findings to the user.

2. **Check README:** Run `git diff master..<branch> -- README.md` to see if README was already updated.
   - Then review the branch changes (`git diff master..<branch> --stat`) for new CLI flags, config changes, or user-facing features.
   - If the branch adds user-facing changes that README doesn't mention, propose specific README updates and ask the user to approve or skip.
   - If approved, apply the changes.

3. **Commit doc changes:** If any documentation was updated in this step, commit them:
   ```
   git add -A
   git commit -m "docs: update documentation for release"
   ```

Report what was reviewed and any changes made.

---

## Step 4/8: Commit stragglers

Check for any remaining uncommitted changes:

1. Run `git status --porcelain`.
2. If there are unstaged or uncommitted changes, show them to the user and ask: "Commit these remaining changes before merge? (yes/abort)"
3. If yes, stage and commit:
   ```
   git add -A
   git commit -m "chore: pre-release cleanup"
   ```
4. If no changes, report "Working tree clean, ready to merge."

---

## Step 5/8: Merge to master

This is a destructive operation. Confirm before proceeding.

1. Show the user what will be merged:

   ```
   git log master..<branch> --oneline
   ```

   Ask: "Merge these commits to master? (yes/abort)"

2. If confirmed, switch to master and pull:

   ```
   git checkout master
   git pull origin master
   ```

3. Attempt fast-forward merge first:

   ```
   git merge --ff-only <branch>
   ```

4. If fast-forward fails, fall back to merge commit:

   ```
   git merge <branch>
   ```

5. If merge conflicts occur, abort the merge and stop:
   ```
   git merge --abort
   ```
   Report: "Merge conflicts detected. Resolve manually, then re-run /publish."
   Stop here — do not continue to Step 6.

Report: "Branch `<branch>` merged to master."

---

## Step 6/8: Version bump

1. **Find the last version tag:**

   ```
   git describe --tags --abbrev=0 --match "v*" 2>/dev/null
   ```

   If no tags exist, note "No previous version tags found — this will be the first tagged release." Default suggestion will be `patch`.

2. **Analyze commits since last tag** (or all commits if no tag):

   ```
   git log <last-tag>..HEAD --oneline
   ```

3. **Suggest version type** based on conventional commit prefixes:
   - Any commit containing `BREAKING CHANGE` (in message body or footer) → suggest **major**
   - Any commit starting with `feat:` or `feat(` → suggest **minor**
   - Otherwise → suggest **patch**

4. **Present to user:**

   > Commits since last release:
   > {commit list}
   >
   > Suggested version bump: **{type}** ({current} → {next})
   >
   > Accept suggested version type, or specify: major / minor / patch?

5. Wait for user confirmation or override. Use whatever type the user confirms.

---

## Step 7/8: Tag and push

This is a destructive operation. Confirm before proceeding.

1. Bump version, create commit and tag:

   ```
   npm version <type>
   ```

   This updates `package.json`, creates a commit, and creates a `v{version}` tag.

2. Ask the user: "Push to origin (master + tags)? (yes/abort)"

3. If confirmed:
   ```
   git push origin master
   git push origin --tags
   ```

Report: "Published v{version}. CI will handle npm publish."

---

## Step 8/8: Branch cleanup

1. Ask the user: "Delete the feature branch `<branch>` locally and on remote? (yes/skip)"

2. If yes:

   ```
   git branch -d <branch>
   git push origin --delete <branch>
   ```

   If the remote delete fails (branch doesn't exist on remote), that's fine — just report it.

3. If skipped, report "Branch `<branch>` kept."

---

## Done

Report a summary:

- Version published: v{version}
- Branch merged: `<branch>` → `master`
- Branch cleanup: deleted / kept
- Next: CI will publish to npm when the tag push triggers the workflow
