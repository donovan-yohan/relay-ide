# GitHub Device Flow Authentication

> **Status**: Active | **Created**: 2026-03-24 | **Last Updated**: 2026-03-24
> **Design Doc**: `docs/design-docs/2026-03-23-github-device-flow-design.md`
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-23 | Design | Hardcoded client ID with env var override | Zero config for users, flexibility for forks |
| 2026-03-23 | Design | Server-side polling (not frontend-driven) | Simpler frontend, auth complexity stays server-side |
| 2026-03-23 | Design | OAuth App (not GitHub App) for device flow | Simpler setup, `repo` scope sufficient |
| 2026-03-24 | Eng Review | 10s AbortController timeout on device code POST | Prevent indefinite hang if GitHub is slow |
| 2026-03-24 | Eng Review | Generation counter only (no device_code match check) | Single mechanism, DRY |
| 2026-03-24 | Eng Review | Save token before username fetch | Prevents limbo state if GraphQL fails after token exchange |
| 2026-03-24 | Eng Review | Fix disconnect to preserve webhookSecret/smeeUrl | Pre-existing bug, trivial to fix alongside |
| 2026-03-24 | Eng Review | Catch-all for unknown poll responses | Treat as pending + warn log, prevent silent infinite poll |

## Progress

- [x] Task 1: Rewrite `server/github-app.ts` — device flow + poll logic
- [x] Task 2: Update `server/index.ts` — mounting + client ID
- [x] Task 3: Update `frontend/src/lib/api.ts` — new API function
- [x] Task 4: Update `frontend/src/components/dialogs/SettingsDialog.svelte` — device code UI
- [x] Task 5: Rewrite `test/github-app.test.ts` — all device flow tests
- [x] Task 6: Build + test — verify everything compiles and passes (435 tests pass, 0 fail)

## Surprises & Discoveries

- exactOptionalPropertyTypes required direct property assignment instead of spread for config.github save
- Tests already written by interrupted agent — only needed minor cleanup (unused import)

## Plan Drift

_None — all tasks completed as planned._

---

### Task 1: Rewrite `server/github-app.ts` — device flow + poll logic

**File:** `server/github-app.ts`
**Goal:** Replace OAuth Authorization Code Flow with Device Authorization Grant

**Steps:**

1. Remove `clientSecret` from `GitHubAppDeps` interface
2. Delete CSRF state store (`csrfStateStore`, `pruneExpiredStates()`, `CSRF_STATE_TTL_MS`)
3. Add module-level device flow state:
   ```ts
   interface DeviceFlowState {
     generation: number;
     deviceCode: string;
     interval: number;
     timerId: ReturnType<typeof setInterval> | null;
     flowStatus: 'polling' | 'denied' | 'expired' | null;
   }
   let deviceFlow: DeviceFlowState = { generation: 0, deviceCode: '', interval: 5, timerId: null, flowStatus: null };
   ```
4. Rewrite `GET /` route:
   - Cancel any existing poll timer, increment generation
   - POST to `https://github.com/login/device/code` with `client_id`, `scope=repo`, `Accept: application/json`
   - Use 10s `AbortController` timeout
   - On failure: return `500 { error: "Failed to initiate device flow" }`
   - On success: store device_code, set `flowStatus = 'polling'`, start poll timer
   - Return `{ userCode, verificationUri, expiresIn }` (camelCase mapping from GitHub's snake_case)
5. Add poll function (called by setInterval):
   - Capture generation at creation time; check it matches before acting
   - POST to `https://github.com/login/oauth/access_token` with `client_id`, `device_code`, `grant_type`
   - Handle responses:
     - `authorization_pending` → no-op (continue polling)
     - `slow_down` → clear timer, restart with `interval += 5` (do NOT increment generation)
     - `expired_token` → clear timer, set `flowStatus = 'expired'`
     - `access_denied` → clear timer, set `flowStatus = 'denied'`
     - `access_token` present → save token to config FIRST, then attempt username fetch via GraphQL (best-effort — save `username: null` if GraphQL fails), clear timer, set `flowStatus = null`, call `onConnected()`
     - Network error → `console.warn`, continue (next poll retries)
     - Unknown response (no recognized field) → `console.warn('Unknown device flow poll response')`, continue polling
6. Delete entire `GET /callback` route
7. Modify `GET /status` route:
   - Add `deviceFlowStatus` to response when `flowStatus` is not null
   ```ts
   res.json({ connected, username, ...(deviceFlow.flowStatus ? { deviceFlowStatus: deviceFlow.flowStatus } : {}) });
   ```
8. Fix `POST /disconnect` route:
   - Change `delete config.github` to only delete `accessToken` and `username`:
   ```ts
   if (config.github) {
     delete config.github.accessToken;
     delete config.github.username;
   }
   ```
   - Also reset `deviceFlow.flowStatus = null`

**Verify:** `npm run build` compiles without errors (TypeScript will catch the `clientSecret` removal if any callers still pass it)

---

### Task 2: Update `server/index.ts` — mounting + client ID

**File:** `server/index.ts`
**Goal:** Wire up the new router, remove clientSecret, add default client ID

**Steps:**

1. Add constant near the top of the file (after imports):
   ```ts
   const DEFAULT_GITHUB_CLIENT_ID = 'Ov23li...'; // placeholder — will be filled after OAuth App creation
   ```
2. Update router instantiation (~line 364-367):
   - Remove `clientSecret` line
   - Change `clientId` to: `clientId: process.env.GITHUB_CLIENT_ID || DEFAULT_GITHUB_CLIENT_ID`
3. Delete the separate unprotected callback route mount (~lines 374-378):
   ```ts
   // DELETE THIS BLOCK:
   app.get('/auth/github/callback', (req, res) => { ... });
   ```
4. The existing `app.use('/auth/github', requireAuth, githubAppRouter)` line stays — all routes now require auth

**Verify:** `npm run build` compiles

---

### Task 3: Update `frontend/src/lib/api.ts` — new API function

**File:** `frontend/src/lib/api.ts`
**Goal:** Replace `fetchGitHubAuthUrl()` with `initiateGitHubDevice()`

**Steps:**

1. Replace the function (~lines 422-425):
   ```ts
   // Before:
   export async function fetchGitHubAuthUrl(): Promise<string> {
     const data = await json<{ url: string }>(await fetch('/auth/github', { credentials: 'include' }));
     return data.url;
   }

   // After:
   export async function initiateGitHubDevice(): Promise<{
     userCode: string;
     verificationUri: string;
     expiresIn: number;
   }> {
     return json<{ userCode: string; verificationUri: string; expiresIn: number }>(
       await fetch('/auth/github', { credentials: 'include' })
     );
   }
   ```
2. Update `fetchGitHubStatus()` return type to include optional `deviceFlowStatus`:
   ```ts
   export async function fetchGitHubStatus(): Promise<{
     connected: boolean;
     username: string | null;
     deviceFlowStatus?: 'polling' | 'denied' | 'expired';
   }> {
     return json<{ connected: boolean; username: string | null; deviceFlowStatus?: 'polling' | 'denied' | 'expired' }>(
       await fetch('/auth/github/status', { credentials: 'include' })
     );
   }
   ```

**Verify:** `npm run build` compiles (TypeScript will flag any remaining references to `fetchGitHubAuthUrl`)

---

### Task 4: Update `SettingsDialog.svelte` — device code UI

**File:** `frontend/src/components/dialogs/SettingsDialog.svelte`
**Goal:** Replace popup OAuth flow with inline device code display

**Steps:**

1. Update import (~line 2): replace `fetchGitHubAuthUrl` with `initiateGitHubDevice`
2. Add reactive state for device flow:
   ```ts
   let deviceCode = $state<{ userCode: string; verificationUri: string; expiresIn: number } | null>(null);
   let deviceFlowError = $state('');
   let deviceFlowTimeout: ReturnType<typeof setTimeout> | null = null;
   ```
3. Update `githubStatus` type to include `deviceFlowStatus`:
   ```ts
   let githubStatus = $state<{ connected: boolean; username: string | null; deviceFlowStatus?: string }>({ connected: false, username: null });
   ```
4. Rewrite `connectGitHub()` function (~lines 33-50):
   ```ts
   async function connectGitHub() {
     if (githubPollInterval) { clearInterval(githubPollInterval); githubPollInterval = null; }
     deviceFlowError = '';
     try {
       const result = await initiateGitHubDevice();
       deviceCode = result;
       window.open(result.verificationUri, '_blank');
       // Poll for connection status
       githubPollInterval = setInterval(async () => {
         try {
           const status = await fetchGitHubStatus();
           if (status.connected) {
             githubStatus = status;
             clearDeviceFlow();
           } else if (status.deviceFlowStatus === 'denied') {
             deviceFlowError = 'Authorization denied. Try again.';
             clearDeviceFlow();
           } else if (status.deviceFlowStatus === 'expired') {
             deviceFlowError = 'Code expired. Try again.';
             clearDeviceFlow();
           }
         } catch { /* ignore network errors during polling */ }
       }, 2000);
       // Fallback timeout
       deviceFlowTimeout = setTimeout(() => {
         if (deviceCode) {
           deviceFlowError = 'Code expired. Try again.';
           clearDeviceFlow();
         }
       }, result.expiresIn * 1000);
     } catch {
       deviceFlowError = 'Failed to connect to GitHub. Try again.';
     }
   }

   function clearDeviceFlow() {
     deviceCode = null;
     if (githubPollInterval) { clearInterval(githubPollInterval); githubPollInterval = null; }
     if (deviceFlowTimeout) { clearTimeout(deviceFlowTimeout); deviceFlowTimeout = null; }
   }
   ```
5. Update the `$effect` cleanup (~lines 26-31) to also clear `deviceFlowTimeout`
6. Update the GitHub Connection template section (~line 247+) to show device code UI:
   - When `deviceCode` is set: show the code, copy button, "Waiting for authorization..." text
   - When `deviceFlowError` is set: show error message with "Try again" button
   - Otherwise: show existing Connect/Connected UI
   - Copy button: `navigator.clipboard.writeText(deviceCode.userCode)`

**Verify:** `npm run build` compiles

---

### Task 5: Rewrite `test/github-app.test.ts` — all device flow tests

**File:** `test/github-app.test.ts`
**Goal:** Full test coverage for device flow

**Steps:**

1. Update `startServer()` helper — remove `clientSecret` from routerDeps:
   ```ts
   const routerDeps = opts.fetchFn
     ? { configPath, clientId: 'test-client-id', fetchFn: opts.fetchFn }
     : { configPath, clientId: 'test-client-id' };
   ```
2. Rewrite Test 1 — "GET /auth/github initiates device flow":
   - Create mock fetchFn that intercepts POST to `login/device/code` and returns `{ device_code, user_code, verification_uri, expires_in, interval }`
   - Start server with mock fetchFn
   - Assert response has `userCode`, `verificationUri`, `expiresIn`
3. Keep Test 2 unchanged — "GET /auth/github/status returns { connected: false }"
4. Rewrite Test 3 — "Device flow poll completes and saves token":
   - Create mock fetchFn that returns device code response on `/login/device/code`, then `authorization_pending` on first poll, then `access_token` on second poll, then GraphQL username response
   - Start server with mock fetchFn
   - Call `GET /auth/github` to initiate flow
   - Wait for polls to complete (use a short interval in mock, or wait ~2-3 seconds)
   - Verify config file has `accessToken` and `username` saved
5. Keep Test 4 unchanged — "GET /auth/github/status returns connected after auth"
6. Add Test 5 — "slow_down increases poll interval":
   - Mock returns `slow_down` on first poll, record timestamps of subsequent polls
   - Export `_getDeviceFlowState()` test helper from github-app.ts or verify via call timing
7. Add Test 6 — "access_denied sets deviceFlowStatus":
   - Mock returns `access_denied` on first poll
   - Check `GET /status` returns `deviceFlowStatus: 'denied'`
8. Add Test 7 — "expired_token sets deviceFlowStatus":
   - Mock returns `expired_token` on first poll
   - Check `GET /status` returns `deviceFlowStatus: 'expired'`
9. Add Test 8 — "Device code initiation failure returns 500":
   - Mock `/login/device/code` returning 500
   - Assert `GET /auth/github` returns 500 with error message
10. Add Test 9 — "Network error during poll continues polling":
    - Mock poll endpoint throwing a network error, then returning `access_token`
    - Verify flow completes successfully despite the transient error
11. Add Test 10 — "Concurrent flow cancels previous":
    - Call `GET /auth/github` twice (second call uses different device_code in mock)
    - Verify only the second flow's token gets saved

**Verify:** `npm test` passes all tests

---

### Task 6: Build + test — verify everything compiles and passes

**Steps:**

1. Run `npm run build` — verify zero TypeScript errors
2. Run `npm test` — verify all tests pass
3. Manually verify the SettingsDialog template renders correctly by checking for unclosed tags or Svelte syntax errors in the build output

---

## Outcomes & Retrospective

**What worked:**
- Eng review caught 2 real bugs pre-implementation (token save order, disconnect wipe)
- Codex outside voice caught the token-before-username gap
- Parallel task execution (backend + frontend) cut wall-clock time
- Device flow state machine is clean and testable via `_getDeviceFlowState()` helper

**What didn't:**
- exactOptionalPropertyTypes caused a type error that wasn't caught by the spec review — needed manual fix during implementation

**Learnings to codify:**
- When saving to typed config objects with `exactOptionalPropertyTypes`, use direct property assignment (`config.x = val`) rather than object spread — spread can introduce `undefined` values that violate the type constraint
