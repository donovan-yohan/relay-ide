---
name: ticket
description: >
  Create GitHub Issues for relay-ide. Routes ideas to backlog, scoped tickets to
  todo with epic/blocking relationships. Applies appropriate type, priority, and
  project labels. Use when the user mentions "ticket", "issue", "track this",
  "add to backlog", "file a bug", "create an issue", or describes work that
  should be tracked.
---

# /ticket — Create relay-ide GitHub Issues

You are creating a GitHub Issue for the `donovan-yohan/relay-ide` repository. Follow the routing logic below.

## Label scheme

| Category  | Labels                                                                                                                                                          | Notes                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| State     | `backlog`, `todo`, `in-progress`                                                                                                                                | Done = closed issue            |
| Type      | `bug`, `feature`, `improvement`, `spike`                                                                                                                        | Exactly one per issue          |
| Priority  | `p1-urgent`, `p2-high`, `p3-normal`, `p4-low`                                                                                                                   | Omit if unclear                |
| Project   | `project:sidebar-nav`, `project:code-file-tools`, `project:verification-testing`, `project:command-center`, `project:agent-platform`, `project:true-workspaces` | Omit if none fit               |
| Structure | `epic`                                                                                                                                                          | Only on parent/umbrella issues |

## Input

The user provides a description of work. It may be:

- A rough idea, bug report, or one-liner → **Backlog**
- A fully scoped ticket with acceptance criteria or design doc → **Todo**

If ambiguous, ask: "Is this a rough idea for the backlog, or a scoped ticket ready for todo?"

## Step 1: Classify type

- **bug** — something is broken or behaving incorrectly
- **feature** — net-new functionality
- **improvement** — enhancement to existing functionality
- **spike** — research, investigation, or proof-of-concept

## Step 2: Determine priority

If specified, use it. Otherwise infer:

- Blocking other work or production issue → `p1-urgent` or `p2-high`
- Normal feature/improvement → `p3-normal`
- Nice-to-have or low-impact → `p4-low`
- If genuinely unclear, omit the priority label entirely

## Step 3: Match project

Match to one of the relay-ide projects if applicable:

- **Sidebar & Navigation UX** → `project:sidebar-nav` — sidenav, status indicators, session states, navigation
- **Code & File Tools** → `project:code-file-tools` — file browser, diffs, changed files, LLM summaries
- **Verification & Testing** → `project:verification-testing` — sandbox mode, Playwright e2e, CI gates
- **Command Center** → `project:command-center` — command palette, keyboard shortcuts, discoverability
- **Agent Platform** → `project:agent-platform` — Codex, Gemini, multi-agent, spawning UX
- **True Workspaces** → `project:true-workspaces` — multi-repo workspace groupings

If it doesn't fit any project, omit the project label.

## Step 4: Route by fidelity

### Path A: Backlog (rough idea)

Create the issue with state label `backlog`. No conflict checking or dependency handling needed.

### Path B: Todo (fully scoped)

This path requires extra validation before creation.

**B1: Check for conflicts.** List existing open issues and check for duplicates or overlap:

```bash
gh issue list --repo donovan-yohan/relay-ide --state open --label todo --limit 100 --json number,title,body
```

- **Duplicate** — tell the user, ask whether to update existing or create new
- **Overlap** — note it, suggest split/merge/proceed
- **No conflict** — proceed

**B2: Identify epic (parent).** If this is a sub-task, find the parent epic:

```bash
gh issue list --repo donovan-yohan/relay-ide --state open --label epic --json number,title
```

**B3: Identify dependencies.** If blocking or blocked-by relationships exist, note the issue numbers. These will be wired up via GraphQL after creation.

## Step 5: Create the issue

Write the issue body to a temp file, then create with `gh issue create --body-file`:

```bash
# Write body to temp file (avoids heredoc shell escaping issues)
cat > /tmp/gh-issue-body.md <<'BODY'
<issue body here>
BODY

gh issue create \
  --repo donovan-yohan/relay-ide \
  --title "<title>" \
  --label "<comma-separated labels>" \
  --body-file /tmp/gh-issue-body.md
```

**IMPORTANT:** Always use `--body-file` instead of `--body` with heredoc. Heredoc inside `$(...)` command substitution breaks on unescaped parentheses in the body text.

## Step 6: Wire up relationships via GraphQL

The `gh` CLI has no flags for sub-issues or blocking. Use `gh api graphql` instead.

### 6a: Get node IDs

All GraphQL mutations require node IDs, not issue numbers. Batch-fetch them:

```bash
gh api graphql -f query='query { repository(owner: "donovan-yohan", name: "relay-ide") {
  parent: issue(number: PARENT_NUM) { id }
  child: issue(number: CHILD_NUM) { id }
} }'
```

### 6b: Add sub-issue (parent-child / epic relationship)

```bash
gh api graphql -f query='mutation {
  addSubIssue(input: {
    issueId: "<PARENT_NODE_ID>",
    subIssueId: "<CHILD_NODE_ID>"
  }) { issue { title } subIssue { title } }
}'
```

**Mutation:** `addSubIssue`
**Input fields:**

- `issueId` (required) — node ID of the **parent** issue
- `subIssueId` — node ID of the **child** issue (use this OR `subIssueUrl`)
- `subIssueUrl` — URL of the child issue (alternative to `subIssueId`, useful for cross-repo)
- `replaceParent` — boolean, reparent if child already has a parent

**To remove:** `removeSubIssue(input: {issueId: "<parent>", subIssueId: "<child>"})`
**To reorder:** `reprioritizeSubIssue(input: {issueId: "<parent>", subIssueId: "<child>", afterId: "<sibling>"})`

### 6c: Add blocking/dependency relationship

```bash
gh api graphql -f query='mutation {
  addBlockedBy(input: {
    issueId: "<BLOCKED_ISSUE_NODE_ID>",
    blockingIssueId: "<BLOCKER_NODE_ID>"
  }) { issue { title } blockingIssue { title } }
}'
```

**Mutation:** `addBlockedBy`
**Input fields:**

- `issueId` (required) — node ID of the issue that **is blocked**
- `blockingIssueId` (required) — node ID of the issue that **does the blocking**

**To remove:** `removeBlockedBy(input: {issueId: "<blocked>", blockingIssueId: "<blocker>"})`

**Semantics:** `addBlockedBy(issueId: A, blockingIssueId: B)` means "A is blocked by B" / "B blocks A".

### 6d: Example — full workflow

```bash
# 1. Create the issue
gh issue create --repo donovan-yohan/relay-ide \
  --title "My new feature" \
  --label "feature,backlog,p3-normal" \
  --body-file /tmp/gh-issue-body.md
# Returns: https://github.com/donovan-yohan/relay-ide/issues/162

# 2. Get node IDs (parent epic #100, new issue #162, blocker #106)
gh api graphql -f query='query { repository(owner: "donovan-yohan", name: "relay-ide") {
  epic: issue(number: 100) { id }
  newIssue: issue(number: 162) { id }
  blocker: issue(number: 106) { id }
} }'

# 3. Add as sub-issue of epic
gh api graphql -f query='mutation {
  addSubIssue(input: {issueId: "<EPIC_NODE_ID>", subIssueId: "<NEW_ISSUE_NODE_ID>"}) {
    subIssue { title }
  }
}'

# 4. Mark as blocked by another issue
gh api graphql -f query='mutation {
  addBlockedBy(input: {issueId: "<NEW_ISSUE_NODE_ID>", blockingIssueId: "<BLOCKER_NODE_ID>"}) {
    issue { title }
  }
}'
```

## Step 7: Report

After creating, report:

- Issue number and URL
- Title
- State label (backlog / todo)
- All labels applied
- Parent epic (if linked)
- Blocking relationships (if linked)
- Any conflicts found

## Pitfalls and lessons learned

1. **Always use `--body-file`** — never `--body` with `$(cat <<'EOF' ... EOF)`. Parentheses in markdown break shell command substitution.
2. **GraphQL requires node IDs** — issue numbers don't work. Always fetch with `gh api graphql` query first. Batch multiple issues in one query to minimize API calls.
3. **`addBlockedBy` semantics** — `issueId` is the blocked issue, `blockingIssueId` is the blocker. Easy to mix up.
4. **`addBlockedBy` return type** — returns `issue` and `blockingIssue`, NOT `blockedIssue`. The field that failed our first attempt.
5. **`addSubIssue` supports URL** — you can use `subIssueUrl` instead of `subIssueId`, useful for cross-repo sub-issues.
6. **Rate limiting** — add `sleep 1` between issue creation calls. GraphQL mutations seem more tolerant but still pace them for bulk operations.
7. **Labels must exist first** — all labels above are created on the repo. If adding a new project or label, create it first with `gh label create`.
8. **No `gh` CLI native support** — the CLI has open feature requests for `--blocked-by`/`--blocking` (cli/cli#11757) and `--parent` (cli/cli#10298) but neither shipped as of April 2026.
