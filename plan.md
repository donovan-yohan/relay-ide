# Fix #118: Diff for modified files incorrectly renders as all new lines

## Problem
Regression from React migration. Modified files render as entirely new additions in "working tree" and "staged" tabs. Diff header shows `@@ -0,0 +X,Y @@` and every line prefixed with `+`.

## Investigation Notes
- `frontend/src/components/DiffViewer.tsx` uses `diff2html.parse(diff)` to parse the diff string
- `server/git.ts:getFileDiff()` generates the diff via `git diff -- filePath` (working tree) or `git diff --cached -- filePath` (staged)
- If `stdout.trim()` is empty, it falls back to `git diff --no-index -- /dev/null filePath` which ALWAYS produces an all-new-lines diff
- The fallback is meant for untracked files, but it's being triggered for modified files
- `server/workspaces.ts:/file-diff` route also has a suspicious path: if `expandedFile` is absolute, it returns raw file CONTENT instead of a diff string
- `server/git.ts:getChangedFiles()` has a potential bug in numstat args: when `base === 'cached'`, `numstatArgs` becomes `['diff', '--numstat', '--find-renames', 'cached...HEAD']` which is invalid git syntax

## Fix Approach
1. First, verify whether the issue is in the backend diff generation or frontend diff parsing
2. Check if `git diff -- filePath` returns empty for modified files when fetched through the API
3. Most likely causes:
   - `getFileDiff` fallback `--no-index` is too aggressive and fires even for tracked modified files (maybe because the file path is wrong or cwd is wrong)
   - OR the backend `/file-diff` route returns raw file content when it shouldn't (absolute path branch)
   - OR `getChangedFiles` returns wrong paths that cause `getFileDiff` to miss the file
4. Fix the root cause. If it's the `--no-index` fallback, make it only trigger for untracked files (check git status first). If it's the absolute path branch, fix path handling.

## Files to Investigate
- `server/git.ts` — `getFileDiff`, `getChangedFiles`, `buildNumstatMap`
- `server/workspaces.ts` — `/file-diff` route
- `frontend/src/components/DiffViewer.tsx` — `parseDiff`
- `frontend/src/components/ChangedFiles.tsx` — how diff is fetched

## Acceptance Criteria
- [ ] Modified files in working tree show actual diff with `+` and `-` lines
- [ ] Modified files in staged show actual diff with `+` and `-` lines
- [ ] Untracked files still show all-new-lines diff correctly
- [ ] Branch comparison diffs still work
