---
status: current
---
# Relay Phase 2: GitHub App + GraphQL API + Webhooks

> **Status**: Planned
> **Phase**: 2 of 3 (Relay product evolution)
> **Parent design**: `~/.gstack/projects/donovan-yohan-claude-remote-cli/ceo-plans/2026-03-23-relay-product-evolution.md`
> **Depends on**: Phase 1 (DataTable component)
> **Reviews**: Design review (8/10), CEO review (CLEAR), Eng review (CLEAR)

## Goal

Replace the `gh` CLI search API with GitHub GraphQL API for rich PR data (isDraft, reviewDecision, CI status, review requests). Register a GitHub App for OAuth authentication and webhook delivery. Enable real-time PR updates via smee.io webhooks with polling fallback.

## Problem

The current GitHub integration uses `gh api search/issues` which has documented limitations:
- **L-20260321-github-search-reviewers**: `requested_reviewers` not returned — reviewer detection is best-effort
- **L-20260321-github-search-review-decision**: `reviewDecision` not returned — every open PR dot defaults to green (lies)
- **L-20260321-github-search-open-only**: "All" filter operates on `is:open` backend data — can't show closed/merged
- No `isDraft` on the `PullRequest` type used by dashboards
- No CI status per PR row
- Polling with 60s stale window — no real-time updates for remote changes

## Approach

### Authentication: GitHub App OAuth

Single authentication mechanism replacing `gh` CLI dependency for GitHub data.

**User flow:**
1. User clicks "Connect GitHub" in Relay settings
2. Relay opens browser to GitHub App OAuth authorization URL
3. User authorizes the Relay GitHub App
4. GitHub redirects to `http://localhost:{port}/auth/github/callback` with auth code
5. Relay exchanges code for access token via GitHub API
6. Token stored in `~/.config/claude-remote-cli/config.json`
7. All subsequent GraphQL queries use this token

**Token storage:**
```typescript
// In config.json
{
  github: {
    accessToken: string;      // OAuth user access token
    username: string;          // Cached from initial auth
    webhookSecret?: string;    // For webhook signature verification
    smeeUrl?: string;          // smee.io channel URL
  }
}
```

**Token refresh:** GitHub OAuth tokens don't expire by default. If a 401 is received, prompt re-auth.

**Identity resolution:** The OAuth token is a user token, so GraphQL `viewer` field returns the authenticated user's data. This enables accurate "my PRs" vs "PRs awaiting my review" detection — solving L-20260321-github-search-reviewers.

### GraphQL Queries

Replace `gh api search/issues` with GitHub GraphQL API.

**Primary query — PR list:**
```graphql
query {
  viewer {
    login
  }
  search(query: "is:pr is:open involves:@me", type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        title
        state
        isDraft
        url
        updatedAt
        createdAt
        author { login }
        repository { nameWithOwner }
        reviewDecision
        reviewRequests(first: 10) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 10) {
                  nodes {
                    ... on CheckRun { name, conclusion, status }
                    ... on StatusContext { context, state }
                  }
                }
              }
            }
          }
        }
        mergeable
        mergeStateStatus
      }
    }
  }
}
```

This single query returns everything Phase 1's DataTable needs: isDraft, reviewDecision, review requests, CI status, mergeability — solving L-20260321-github-search-reviewers, L-20260321-github-search-review-decision, and L-20260321-github-search-open-only in one call.

**Caching:** svelte-query manages caching (60s stale). Webhook events trigger `queryClient.invalidateQueries()` for instant refresh.

### "What Should I Do Next?" Priority Algorithm (upgrade)

With real data from GraphQL, the full priority sort activates:
1. PRs with `reviewDecision: CHANGES_REQUESTED` on YOUR PRs (red — fix these first)
2. PRs where YOU are in `reviewRequests` (amber — unblock teammates)
3. Your open PRs with `reviewDecision: null` (green — waiting for review)
4. Your open PRs with `reviewDecision: APPROVED` + CI passing (blue — ready to merge)
5. Other open PRs (alphabetical by repo)

### CI Status Per PR Row

Derived from `statusCheckRollup.state`:
- `SUCCESS` → green checkmark
- `FAILURE` / `ERROR` → red X
- `PENDING` → yellow spinner
- `null` (no checks configured) → no icon

Multiple workflows: use the rollup state (GitHub's own aggregation). Individual check details available on hover/expand if needed later.

### Webhook Delivery via smee.io

**Architecture:**
```
GitHub ──webhook──▶ smee.io ──SSE──▶ smee-client (in Relay process) ──HTTP──▶ localhost:{port}/webhooks
```

**Setup flow:**
1. On first "Connect GitHub", Relay generates a smee.io channel URL
2. Stores it in config
3. Registers it as the GitHub App's webhook URL
4. Starts a smee-client instance within the Relay process (not shelled out — use `smee-client` npm package as library)

**Webhook endpoint:** `POST /webhooks`
- Verify `X-Hub-Signature-256` header (HMAC-SHA256 with webhook secret)
- Reject invalid signatures with 401 + log
- Route events:
  - `pull_request` (opened, closed, reopened, synchronize, review_requested, converted_to_draft) → broadcast `pr-updated`
  - `pull_request_review` (submitted) → broadcast `pr-updated`
  - `check_suite` (completed) → broadcast `ci-updated`
  - Unknown events → ignore silently
- Dedupe: ignore events for repos not in user's workspace list

**Frontend handling:**
```typescript
// In App.svelte event socket handler:
} else if (msg.type === 'pr-updated' || msg.type === 'ci-updated') {
  queryClient.invalidateQueries({ queryKey: ['org-prs'] });
  queryClient.invalidateQueries({ queryKey: ['pr'] });
  queryClient.invalidateQueries({ queryKey: ['ci-status'] });
  // Row flash animation handled by DataTable via row key comparison
}
```

**Row flash:** DataTable compares row keys before/after query refresh. Changed rows get `background-color` transition from `var(--surface-hover)` to transparent over 600ms.

**Polling fallback:** If smee-client fails to connect (3 consecutive errors), fall back to GraphQL polling every 30s. Switch back when smee reconnects. The smee-client library exposes connection state events.

### Sidebar PR Enrichment

When a worktree has an open PR (matched by branch name to PR data), show PR status + CI status inline in the sidebar row:
- PR review status icon (matches StatusDot vocabulary)
- CI status icon (checkmark/X/spinner)

Data source: the same GraphQL PR data already fetched for the org dashboard. No additional API calls.

### Relationship to RefWatcher (just shipped)

RefWatcher handles **local** git events (push, fetch) → triggers PR data refresh.
Webhooks handle **remote** events (teammate pushes, CI completion, reviews) → triggers PR data refresh.
Both use the same mechanism: broadcast event → svelte-query cache invalidation.
They are complementary, not competing.

## Files to Create

| File | Purpose |
|------|---------|
| `server/github-app.ts` | GitHub App OAuth flow, token management, smee-client lifecycle |
| `server/github-graphql.ts` | GraphQL client, query construction, response mapping |
| `server/webhooks.ts` | Webhook endpoint, signature verification, event routing |

## Files to Modify

| File | Change |
|------|--------|
| `server/index.ts` | Mount webhook endpoint, GitHub App routes, start smee-client |
| `server/types.ts` | Add `isDraft`, `reviewDecision`, `ciStatus` to PullRequest type |
| `server/integration-github.ts` | Replace search API calls with GraphQL (or create new module) |
| `frontend/src/App.svelte` | Handle `pr-updated` / `ci-updated` WebSocket events |
| `frontend/src/components/WorkspaceItem.svelte` | Add PR/CI status icons to sidebar rows |
| `frontend/src/components/OrgDashboard.svelte` | Update sort algorithm for full priority |
| `frontend/src/components/StatusDot.svelte` | Wire draft/approved/changes-req states to real data |
| `frontend/src/components/dialogs/SettingsDialog.svelte` | Add "Connect GitHub" button + OAuth status |

## Tests

- GraphQL client: query construction, pagination, error handling (rate limit, timeout, malformed)
- OAuth flow: callback endpoint, token storage, token refresh/expiry, user denies permissions
- Webhook endpoint: signature verification, valid/invalid signatures, event routing, unknown events, dedupe
- smee-client: connection, reconnection, fallback to polling
- Priority sort: all 5 tiers with mock PR data
- Sidebar enrichment: PR matching by branch, CI icon rendering

## Security

- OAuth tokens stored in config file (same security model as PIN hash)
- Webhook secret stored in config file, used for HMAC-SHA256 verification
- All webhook payloads verified before processing
- smee.io channel URL treated as secret (not logged, not exposed in UI)
