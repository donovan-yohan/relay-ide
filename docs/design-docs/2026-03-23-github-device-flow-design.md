---
status: current
created: 2026-03-23
branch: master
supersedes:
implemented-by:
consulted-learnings: []
---

# GitHub Device Flow Authentication

Replace the GitHub OAuth Authorization Code Flow with the Device Authorization Grant (RFC 8628) so that any user can connect to GitHub with zero configuration — no client secret, no callback URL, no env vars required.

## Problem

The current OAuth web flow requires every user to:
1. Create their own GitHub OAuth App
2. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` env vars
3. Configure a callback URL matching their server host/port

This is a developer-level setup task that blocks non-technical users from using GitHub features (PR dashboard, CI status, etc.).

## Solution

Ship a hardcoded GitHub App client ID in the source code. Use GitHub's device flow, which:
- Requires no client secret (safe to embed in open-source code)
- Requires no callback URL (no redirect-based flow)
- Works for any user: they see a code, enter it at github.com/login/device, done

Users who fork or run in enterprise environments can override with `GITHUB_CLIENT_ID` env var.

## Device Flow Sequence

```
Frontend                    Server                      GitHub
   |                          |                           |
   |-- GET /auth/github ----->|                           |
   |                          |-- POST /login/device/code -->
   |                          |<-- device_code, user_code --|
   |                          |   (start poll timer)       |
   |<-- { userCode,           |                           |
   |      verificationUri } --|                           |
   |                          |                           |
   | (user enters code at github.com/login/device)        |
   |                          |                           |
   |                          |-- POST /login/oauth/      |
   |                          |   access_token (poll) ---->|
   |                          |<-- authorization_pending --|
   |                          |       ... (repeat) ...     |
   |                          |<-- access_token -----------|
   |                          |                           |
   |                          |-- POST /graphql ---------->|
   |                          |<-- { viewer.login } -------|
   |                          |   (save token + username)  |
   |                          |                           |
   |-- GET /auth/github/status ->                         |
   |<-- { connected: true } --|                           |
```

## Backend Changes

### `server/github-app.ts` — Rewrite

**Remove:**
- `clientSecret` from `GitHubAppDeps`
- CSRF state store (`csrfStateStore`, `pruneExpiredStates()`)
- `GET /callback` route (entire handler)

**Modify `GET /`:**

Before: returns `{ url }` (OAuth authorize URL).
After: initiates device flow and returns `{ userCode, verificationUri, expiresIn }`.

Implementation:
1. POST to `https://github.com/login/device/code` with `client_id` and `scope=repo`, header `Accept: application/json`
2. If the POST fails (network error, non-2xx), return `500 { error: "Failed to initiate device flow" }` to the frontend. The `initiateGitHubDevice()` call will throw, and the frontend shows an error state.
3. GitHub returns `{ device_code, user_code, verification_uri, expires_in, interval }`
4. Store `device_code` and a generation counter in module-level state (only one active flow at a time — starting a new one increments the generation and cancels the previous timer via `clearInterval`)
5. Start a `setInterval` polling `https://github.com/login/oauth/access_token` with:
   - `client_id`
   - `device_code`
   - `grant_type=urn:ietf:params:oauth:grant-type:device_code`
6. Return `{ userCode, verificationUri, expiresIn }` to the frontend

**Poll response handling:**

Each poll callback checks that its captured generation counter matches the current one before acting. If a newer flow has started, the stale callback is a no-op (the timer was already cleared by the new flow).

- `error: "authorization_pending"` — continue polling
- `error: "slow_down"` — clear current timer, restart with interval increased by 5 seconds (per spec). Does NOT increment the generation counter — this is an internal timer restart for the same flow, not a new flow.
- `error: "expired_token"` — clear timer, set `flowStatus = 'expired'`
- `error: "access_denied"` — clear timer, set `flowStatus = 'denied'`
- `access_token` present — save token to config immediately, then attempt to fetch username via GraphQL as best-effort. If GraphQL fails, save `username: null` (user is still connected — token works). Clear timer, call `onConnected()`
- Network error on poll — log and continue (next poll will retry)

**Flow status tracking:**

Add a module-level `flowStatus` field (`'polling' | 'denied' | 'expired' | null`). Set to `'polling'` when the device flow starts, updated to `'denied'` or `'expired'` on those terminal errors, and reset to `null` when connected or on disconnect. Extend `GET /status` response to include `deviceFlowStatus` when a flow is active or recently completed. This allows the frontend to detect denial/expiry without waiting for the full timeout:

```ts
// GET /status response
{ connected: boolean; username: string | null; deviceFlowStatus?: 'polling' | 'denied' | 'expired' }
```

**Modified:**
- `POST /disconnect` — fix pre-existing bug: only delete `accessToken` and `username` from `config.github`, preserving `webhookSecret` and `smeeUrl`
- `GET /status` — response shape extended with optional `deviceFlowStatus` field (route itself unchanged)

### `server/index.ts` — Minor changes

- Remove `clientSecret` from router instantiation
- Add hardcoded default: `const DEFAULT_GITHUB_CLIENT_ID = '<id-from-github-app>';`
- Use: `clientId: process.env.GITHUB_CLIENT_ID || DEFAULT_GITHUB_CLIENT_ID`
- Delete the separate unprotected `/auth/github/callback` route mount (5 lines)
- All `/auth/github/*` routes now go through `requireAuth`

### `server/types.ts` — No changes

Config shape (`github.accessToken`, `github.username`) is unchanged. Device flow tokens are stored identically to OAuth tokens.

## Frontend Changes

### `frontend/src/lib/api.ts`

Replace `fetchGitHubAuthUrl()`:

```ts
// Before
export async function fetchGitHubAuthUrl(): Promise<string>

// After
export async function initiateGitHubDevice(): Promise<{
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}>
```

`fetchGitHubStatus()` and `disconnectGitHub()` unchanged.

### `frontend/src/components/dialogs/SettingsDialog.svelte`

Replace `connectGitHub()` function:

**Before:** Opens a popup window to GitHub OAuth consent, polls status.
**After:**
1. Call `initiateGitHubDevice()` → receive `userCode`, `verificationUri`, `expiresIn`
2. Set reactive state to show inline "enter code" UI (replaces the Connect button area — no popup, no modal)
3. Auto-open `verificationUri` in new tab via `window.open()`
4. Poll `fetchGitHubStatus()` every 2s (same pattern as today). Check both `connected` and `deviceFlowStatus` fields.
5. On `connected: true`: clear poll interval, clear code UI, show connected state
6. On `deviceFlowStatus === 'denied'`: clear poll interval, show "Authorization denied. Try again."
7. On `deviceFlowStatus === 'expired'`: clear poll interval, show "Code expired. Try again."
8. Fallback timeout: `setTimeout` using `expiresIn * 1000` from when the frontend receives the response. Clears the poll interval if still running. Shows "expired" message.

**Inline UI during authorization:**
```
Enter code: ABCD-1234    [Copy]
at github.com/login/device

Waiting for authorization...
```

The `[Copy]` button writes the code to clipboard via `navigator.clipboard.writeText()`.

No new Svelte components — this is conditional rendering within the existing GitHub section of SettingsDialog.

## Test Changes

### `test/github-app.test.ts`

**Rewrite 3 of 4 tests:**

| Test | Before | After |
|------|--------|-------|
| Auth initiation | Tests OAuth URL with `client_id` + `state` | Tests device flow returns `userCode`, `verificationUri`, `expiresIn`; mocks POST to `/login/device/code` |
| Status (disconnected) | **Unchanged** | **Unchanged** |
| Token exchange | Mocks callback code exchange | Mocks device poll returning `access_token`; verifies config save + username fetch |
| Status (connected) | **Unchanged** | **Unchanged** |

**Add new tests:**
- `slow_down` response increases poll interval: mock returns `slow_down` then `authorization_pending` then `access_token`. Verify by counting mock calls and checking elapsed time between them (the `fetchFn` mock can record call timestamps). Alternatively, export a `_getDeviceFlowState()` test helper that exposes the current interval for assertions.
- `access_denied` sets `deviceFlowStatus` to `'denied'` on the status endpoint.
- `expired_token` sets `deviceFlowStatus` to `'expired'` on the status endpoint.
- Device code initiation failure (mock `/login/device/code` returning 500) returns error to caller.

**Remove `clientSecret` from test helper:** The `startServer()` helper in the test file passes `clientSecret: 'test-client-secret'` — remove this parameter to match the updated `GitHubAppDeps` interface.

**Mock structure:** Tests use the existing `fetchFn` dependency injection pattern. Mock responses for:
- `POST github.com/login/device/code` → `{ device_code, user_code, verification_uri, expires_in, interval }`
- `POST github.com/login/oauth/access_token` → `{ error: "authorization_pending" }` then `{ access_token: "..." }`
- `POST api.github.com/graphql` → `{ data: { viewer: { login: "testuser" } } }`

## GitHub App Setup (one-time)

Create a GitHub OAuth App at github.com/settings/developers → OAuth Apps → New OAuth App:
- **Application name:** `claude-remote-cli`
- **Homepage URL:** repo URL
- **Authorization callback URL:** `http://localhost` (required field but unused by device flow)
- **Enable Device Flow:** Check the "Enable Device Flow" checkbox
- **Note:** An OAuth App (not a GitHub App) is used because the device flow setup is simpler and the `repo` scope provides all needed access. GitHub Apps use fine-grained permissions but require installation, which adds friction for a local CLI tool.

Bake the resulting Client ID into source as `DEFAULT_GITHUB_CLIENT_ID`. Client ID is public — safe to commit.

## Environment Variables

| Variable | Before | After |
|----------|--------|-------|
| `GITHUB_CLIENT_ID` | Required | Optional override (default hardcoded) |
| `GITHUB_CLIENT_SECRET` | Required | **Removed** |

## What Doesn't Change

- Token storage location and format (`config.github.accessToken`, `config.github.username`)
- GraphQL client (`server/github-graphql.ts`)
- Webhook handling (`server/webhooks.ts`)
- `gh` CLI fallback (`server/integration-github.ts`)
- WebSocket communication
- Config file schema

## Edge Cases

- **Concurrent device flows:** Only one active at a time. Starting a new `GET /auth/github` cancels any in-progress poll timer and increments a generation counter. Stale poll callbacks check the generation before acting.
- **In-flight stale requests:** If a poll request is already in-flight when the timer is cancelled, the response handler re-checks the generation counter after the await. Mismatched generations cause the callback to return as a no-op.
- **Server restart during flow:** In-memory device code is lost. User simply re-initiates. No persistence needed for a 15-minute flow.
- **Rate limiting:** GitHub's `slow_down` error increases the poll interval by 5s. The server clears the current timer and starts a new one with the adjusted interval.
- **User denies authorization:** GitHub returns `access_denied`. Server clears the timer and sets `flowStatus = 'denied'`. Frontend detects this via `deviceFlowStatus` on the status endpoint and shows "Authorization denied" immediately.
- **Token expiration:** GitHub device flow tokens don't expire by default. Same as current OAuth tokens.
- **Device code initiation failure:** If the POST to `/login/device/code` fails, `GET /` returns `500 { error: "..." }`. No timer is started. Frontend shows the error.
