# Fix #115: Merge button in PR header closes session instead of merging

## Problem
In `frontend/src/components/PrTopBar.tsx`, clicking the Merge button calls `handleActionClick()`, which calls `getActionPrompt(action, ctx)` for the `merge-pr` action. `getActionPrompt` returns `null` for `merge-pr` (intentionally, since merge was meant as a GitHub UI action). However, `handleActionClick` treats `null` as "archive the session" and calls `onArchive?.()`.

## Fix
Change `handleActionClick` in `PrTopBar.tsx` to handle `merge-pr` explicitly by opening the PR URL in a new browser tab instead of archiving the session. If `merge-pr` action is clicked and a PR URL exists, use `window.open(pr.url, '_blank')`.

## Files
- `frontend/src/components/PrTopBar.tsx` — modify `handleActionClick` to check for `merge-pr` before falling through to `onArchive`

## Acceptance Criteria
- [ ] Clicking Merge on an open, mergeable PR opens the PR in a new tab instead of closing the session
- [ ] Archive still works correctly for merged/closed PRs
