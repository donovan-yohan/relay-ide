# PIN Unlock Fix + PIN Management Implementation Plan

> **Status**: Complete | **Created**: 2026-03-27 | **Last Updated**: 2026-03-27
> **Bug Analysis**: `docs/bug-analyses/2026-03-27-pin-unlock-json-parse-error-bug-analysis.md`
> **Consulted Learnings**: L-20260327-api-error-body-parse, L-20260327-express4-async-errors, L-20260325-silent-catch-blocks
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-27 | Design | PIN setup via web UI, reset via CLI only | Local access = proof of ownership for reset |
| 2026-03-27 | Design | `parseErrorBody` helper for all API error paths | Single fix for 7 fragile call sites |
| 2026-03-27 | Design | `GET /auth/status` + `POST /auth/setup` — no auth required | These are pre-auth endpoints |
| 2026-03-27 | Design | `claude-remote-cli pin reset` CLI subcommand | Interactive TTY flow with optional current PIN verification |

## Progress

- [x] Task 1: Defensive fixes — `verifyPin` null guard + `parseErrorBody` helper _(completed 2026-03-27)_
- [x] Task 2: Server auth status + setup endpoints _(completed 2026-03-27)_
- [x] Task 3: Frontend auth state — `needsSetup` mode _(completed 2026-03-27)_
- [x] Task 4: PinGate context-aware UI _(completed 2026-03-27)_
- [x] Task 5: CLI `pin reset` subcommand _(completed 2026-03-27)_
- [x] Task 6: Server-side async handler safety wrapper _(completed 2026-03-27)_

## Surprises & Discoveries

_None yet — updated during execution by /harness:orchestrate._

## Plan Drift

_None yet — updated when tasks deviate from plan during execution._

---

### Task 1: Defensive fixes — `verifyPin` null guard + `parseErrorBody` helper

**Files:**
- Modify: `server/auth.ts:22` — add null guard
- Modify: `frontend/src/lib/api.ts:26-41` — add `parseErrorBody`, fix `authenticate` + 6 other call sites
- Modify: `test/auth.test.ts` — add test for undefined/null hash

- [ ] **Step 1: Add `verifyPin` null guard test**

Add to `test/auth.test.ts`:

```ts
test('verifyPin returns false for undefined hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', undefined as unknown as string);
  assert.strictEqual(result, false);
});

test('verifyPin returns false for null hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', null as unknown as string);
  assert.strictEqual(result, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'startsWith')`

- [ ] **Step 3: Add null guard to `verifyPin`**

In `server/auth.ts`, change the top of `verifyPin`:

```ts
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith('scrypt:')) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All auth tests PASS

- [ ] **Step 5: Add `parseErrorBody` helper to `api.ts`**

In `frontend/src/lib/api.ts`, after the existing `json<T>` helper (line 29), add:

```ts
async function parseErrorBody(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 6: Fix `authenticate` to use `parseErrorBody`**

Replace the `authenticate` function body:

```ts
export async function authenticate(pin: string): Promise<void> {
  const res = await fetch('/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const message = await parseErrorBody(res, 'Authentication failed');
    throw new Error(message);
  }
}
```

- [ ] **Step 7: Fix all other fragile `.json()` calls on error responses**

Apply `parseErrorBody` to the 6 other call sites:

**`addWorkspace` (line 63):**
```ts
if (!res.ok) { throw new Error(await parseErrorBody(res, 'Failed to add workspace')); }
```

**`createWorktree` (lines 153-155):**
```ts
if (!res.ok) {
  throw new Error(await parseErrorBody(res, 'Failed to create worktree'));
}
```

**`createSession` (lines 202-205) — the 409 conflict path:**
```ts
if (res.status === 409) {
  try {
    const data = await res.json() as { sessionId?: string };
    throw new ConflictError(data.sessionId ?? '');
  } catch (e) {
    if (e instanceof ConflictError) throw e;
    throw new ConflictError('');
  }
}
```

**`deleteWorktree` (lines 227-229):**
```ts
if (!res.ok) {
  throw new Error(await parseErrorBody(res, 'Failed to delete worktree'));
}
```

**`updateWorkspaceSettings` (around line 281)** and **`updateWebhookSettings` (around line 341):**
Find all remaining `await res.json() as { error?: string }` patterns in error paths and replace with `await parseErrorBody(res, 'Operation failed')`.

- [ ] **Step 8: Commit**

```bash
git add server/auth.ts frontend/src/lib/api.ts test/auth.test.ts
git commit -m "fix: defensive error handling — verifyPin null guard + parseErrorBody helper"
```

---

### Task 2: Server auth status + setup endpoints

**Files:**
- Modify: `server/index.ts` — add `GET /auth/status`, `POST /auth/setup`, guard in `POST /auth`

- [ ] **Step 1: Add `GET /auth/status` endpoint**

In `server/index.ts`, right before the `POST /auth` handler (line 500), add:

```ts
// GET /auth/status — no auth required, tells frontend if PIN is configured
app.get('/auth/status', (_req, res) => {
  const config = getConfig();
  res.json({ hasPIN: !!config.pinHash });
});
```

- [ ] **Step 2: Add `POST /auth/setup` endpoint**

Right after the new `GET /auth/status`, add:

```ts
// POST /auth/setup — set initial PIN (only works when no PIN is configured)
app.post('/auth/setup', async (req, res) => {
  try {
    const config = getConfig();
    if (config.pinHash) {
      res.status(403).json({ error: 'PIN is already configured. Use CLI to reset.' });
      return;
    }

    const { pin, confirm } = req.body as { pin?: string; confirm?: string };
    if (!pin || !confirm) {
      res.status(400).json({ error: 'PIN and confirmation required' });
      return;
    }
    if (pin !== confirm) {
      res.status(400).json({ error: 'PINs do not match' });
      return;
    }
    if (pin.length < 4) {
      res.status(400).json({ error: 'PIN must be at least 4 characters' });
      return;
    }

    const freshConfig = loadConfig(CONFIG_PATH);
    freshConfig.pinHash = await auth.hashPin(pin);
    saveConfig(CONFIG_PATH, freshConfig);

    // Auto-login: generate token and set cookie
    const token = auth.generateCookieToken();
    authenticatedTokens.add(token);
    const ttlMs = parseTTL(freshConfig.cookieTTL);
    setTimeout(() => authenticatedTokens.delete(token), ttlMs);

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: ttlMs,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set PIN' });
  }
});
```

- [ ] **Step 3: Add guard in `POST /auth` for missing pinHash**

In the existing `POST /auth` handler, after the rate limit check and PIN presence check, add a guard before `verifyPin`:

```ts
const authConfig = getConfig();
if (!authConfig.pinHash) {
  res.status(412).json({ error: 'No PIN configured', needsSetup: true });
  return;
}
const valid = await auth.verifyPin(pin, authConfig.pinHash);
```

Remove the `as string` cast — the guard makes it safe.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: add GET /auth/status and POST /auth/setup endpoints"
```

---

### Task 3: Frontend auth state — `needsSetup` mode

**Files:**
- Modify: `frontend/src/lib/api.ts` — add `checkAuthStatus` and `setupPin` API functions
- Modify: `frontend/src/lib/state/auth.svelte.ts` — add `needsSetup` state, `setupNewPin` action

- [ ] **Step 1: Add API functions**

In `frontend/src/lib/api.ts`, after the `checkAuth` function, add:

```ts
export async function checkAuthStatus(): Promise<{ hasPIN: boolean }> {
  const res = await fetch('/auth/status');
  return res.json() as Promise<{ hasPIN: boolean }>;
}

export async function setupPin(pin: string, confirm: string): Promise<void> {
  const res = await fetch('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, confirm }),
  });
  if (!res.ok) {
    const message = await parseErrorBody(res, 'Failed to set PIN');
    throw new Error(message);
  }
}
```

- [ ] **Step 2: Update auth state module**

Replace `frontend/src/lib/state/auth.svelte.ts`:

```ts
import { authenticate as apiAuth, checkAuth, checkAuthStatus, setupPin as apiSetupPin } from '../api.js';

let authenticated = $state(false);
let pinError = $state<string | null>(null);
let checking = $state(true);
let needsSetup = $state(false);

export function getAuth() {
  return {
    get authenticated() { return authenticated; },
    get pinError() { return pinError; },
    get checking() { return checking; },
    get needsSetup() { return needsSetup; },
  };
}

export async function checkExistingAuth(): Promise<void> {
  checking = true;
  try {
    // First check if a PIN is even configured
    const status = await checkAuthStatus();
    if (!status.hasPIN) {
      needsSetup = true;
      checking = false;
      return;
    }
    needsSetup = false;
    authenticated = await checkAuth();
  } catch {
    authenticated = false;
  } finally {
    checking = false;
  }
}

export async function submitPin(pin: string): Promise<void> {
  pinError = null;
  try {
    await apiAuth(pin);
    authenticated = true;
  } catch (err) {
    pinError = err instanceof Error ? err.message : 'Authentication failed';
  }
}

export async function setupNewPin(pin: string, confirm: string): Promise<void> {
  pinError = null;
  try {
    await apiSetupPin(pin, confirm);
    needsSetup = false;
    authenticated = true;
  } catch (err) {
    pinError = err instanceof Error ? err.message : 'Failed to set PIN';
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/state/auth.svelte.ts
git commit -m "feat: frontend auth state with needsSetup mode and setupNewPin action"
```

---

### Task 4: PinGate context-aware UI

**Files:**
- Modify: `frontend/src/components/PinGate.svelte` — dual-mode form (unlock vs setup)
- Modify: `frontend/src/App.svelte` — show PinGate for both `!authenticated` and `needsSetup`

- [ ] **Step 1: Rewrite PinGate with dual modes**

Replace the `<script>` block and template of `frontend/src/components/PinGate.svelte`:

```svelte
<script lang="ts">
  import { getAuth, submitPin, setupNewPin } from '../lib/state/auth.svelte.js';

  const auth = getAuth();
  let pinValue = $state('');
  let confirmValue = $state('');
  let localError = $state('');

  async function handleUnlock() {
    localError = '';
    const pin = pinValue.trim();
    if (!pin) return;
    await submitPin(pin);
    if (auth.pinError) {
      pinValue = '';
    }
  }

  async function handleSetup() {
    localError = '';
    const pin = pinValue.trim();
    const confirm = confirmValue.trim();
    if (!pin || !confirm) {
      localError = 'enter a PIN and confirm it';
      return;
    }
    if (pin.length < 4) {
      localError = 'PIN must be at least 4 characters';
      return;
    }
    if (pin !== confirm) {
      localError = 'PINs do not match';
      confirmValue = '';
      return;
    }
    await setupNewPin(pin, confirm);
    if (auth.pinError) {
      pinValue = '';
      confirmValue = '';
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (auth.needsSetup) {
        handleSetup();
      } else {
        handleUnlock();
      }
    }
  }

  let displayError = $derived(localError || auth.pinError);
</script>

<div class="pin-gate">
  <div class="pin-container">
    <h1>Relay</h1>

    {#if auth.needsSetup}
      <p>set up a PIN to secure this instance</p>
      <input
        type="password"
        inputmode="numeric"
        maxlength="20"
        placeholder="choose a PIN"
        bind:value={pinValue}
        onkeydown={handleKeydown}
        autofocus
      />
      <input
        type="password"
        inputmode="numeric"
        maxlength="20"
        placeholder="confirm PIN"
        bind:value={confirmValue}
        onkeydown={handleKeydown}
      />
      <button onclick={handleSetup}>Set PIN</button>
    {:else}
      <p>enter PIN to continue</p>
      <input
        type="password"
        inputmode="numeric"
        maxlength="20"
        placeholder="PIN"
        bind:value={pinValue}
        onkeydown={handleKeydown}
        autofocus
      />
      <button onclick={handleUnlock}>Unlock</button>
      <p class="hint">forgot your PIN? run <code>claude-remote-cli pin reset</code> on the host machine</p>
    {/if}

    {#if displayError}
      <p class="error">{displayError}</p>
    {/if}
  </div>
</div>
```

- [ ] **Step 2: Add `.hint` and `code` styles**

Add to the existing `<style>` block in `PinGate.svelte`:

```css
.hint {
  color: var(--text-muted);
  font-size: 0.75rem;
  opacity: 0.6;
  margin-top: -0.25rem;
}

code {
  font-family: var(--font-mono, monospace);
  background: var(--surface);
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 0.72rem;
}
```

- [ ] **Step 3: Update App.svelte to handle `needsSetup`**

In `frontend/src/App.svelte`, change the conditional rendering (around line 737-740):

```svelte
{#if auth.checking}
  <!-- Loading -->
{:else if !auth.authenticated || auth.needsSetup}
  <PinGate />
{:else}
```

This shows PinGate both when not authenticated AND when no PIN is set.

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean build, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PinGate.svelte frontend/src/App.svelte
git commit -m "feat: PinGate dual-mode UI — unlock vs PIN setup with reset hint"
```

---

### Task 5: CLI `pin reset` subcommand

**Files:**
- Modify: `bin/claude-remote-cli.ts` — add `pin reset` command handler

- [ ] **Step 1: Add `pin` command to help text**

In the help text string (line 23), add after the `worktree` section:

```
  pin                Manage authentication PIN
    reset              Reset the PIN (interactive, requires TTY)
```

- [ ] **Step 2: Add `pin reset` command handler**

In `bin/claude-remote-cli.ts`, after the `worktree` command block (after line 180) and before the service commands block (line 182), add:

```ts
if (command === 'pin') {
  const subCommand = args[1];
  if (subCommand !== 'reset') {
    console.error('Usage: claude-remote-cli pin reset');
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    console.error('PIN reset requires an interactive terminal.');
    process.exit(1);
  }

  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    console.error('No config file found. Run claude-remote-cli first to create one.');
    process.exit(1);
  }

  const { loadConfig: loadCfg, saveConfig: saveCfg } = await import('../server/config.js');
  const { hashPin, verifyPin } = await import('../server/auth.js');

  const config = loadCfg(configPath);
  const readline = await import('node:readline');

  function prompt(query: string, hidden = false): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      if (hidden) {
        process.stdout.write(query);
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        if (stdin.setRawMode) stdin.setRawMode(true);
        let value = '';
        const onData = (ch: Buffer) => {
          const c = ch.toString('utf8');
          if (c === '\n' || c === '\r') {
            if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            rl.close();
            resolve(value);
          } else if (c === '\u007f' || c === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (c >= ' ') {
            value += c;
            process.stdout.write('*');
          }
        };
        stdin.on('data', onData);
      } else {
        rl.question(query, (answer) => { rl.close(); resolve(answer); });
      }
    });
  }

  // If PIN exists, optionally verify current PIN
  if (config.pinHash) {
    const current = await prompt('Current PIN (press Enter to skip): ', true);
    if (current) {
      const valid = await verifyPin(current, config.pinHash);
      if (!valid) {
        console.error('Current PIN is incorrect.');
        process.exit(1);
      }
    }
  }

  const newPin = await prompt('New PIN: ', true);
  if (!newPin || newPin.length < 4) {
    console.error('PIN must be at least 4 characters.');
    process.exit(1);
  }

  const confirmPin = await prompt('Confirm new PIN: ', true);
  if (newPin !== confirmPin) {
    console.error('PINs do not match.');
    process.exit(1);
  }

  config.pinHash = await hashPin(newPin);
  saveCfg(configPath, config);
  console.log('PIN updated successfully. All existing sessions will need to re-authenticate.');
  process.exit(0);
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build, no type errors.

- [ ] **Step 4: Commit**

```bash
git add bin/claude-remote-cli.ts
git commit -m "feat: add 'claude-remote-cli pin reset' CLI subcommand"
```

---

### Task 6: Server-side async handler safety wrapper

**Files:**
- Modify: `server/index.ts` — wrap the `POST /auth` handler in try-catch

- [ ] **Step 1: Add try-catch to `POST /auth` handler**

Wrap the body of the `POST /auth` handler with a try-catch to ensure a JSON error response is always returned, even if an unexpected error occurs:

```ts
app.post('/auth', async (req, res) => {
  try {
    const ip = (req.ip || req.connection.remoteAddress) as string;
    if (auth.isRateLimited(ip)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }

    const { pin } = req.body as { pin?: string };
    if (!pin) {
      res.status(400).json({ error: 'PIN required' });
      return;
    }

    const authConfig = getConfig();
    if (!authConfig.pinHash) {
      res.status(412).json({ error: 'No PIN configured', needsSetup: true });
      return;
    }
    const valid = await auth.verifyPin(pin, authConfig.pinHash);
    if (!valid) {
      auth.recordFailedAttempt(ip);
      res.status(401).json({ error: 'Invalid PIN' });
      return;
    }

    auth.clearRateLimit(ip);
    const token = auth.generateCookieToken();
    authenticatedTokens.add(token);

    const ttlMs = parseTTL(authConfig.cookieTTL);
    setTimeout(() => authenticatedTokens.delete(token), ttlMs);

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: ttlMs,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] Unhandled error in POST /auth:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 2: Build and test**

Run: `npm run build && npm test`
Expected: Clean build, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "fix: wrap POST /auth handler in try-catch for Express 4 async safety"
```

---

## Deliverable Traceability

| Bug Analysis Deliverable | Plan Task |
|-------------------------|-----------|
| `parseErrorBody` helper for all 7 fragile `.json()` call sites | Task 1 |
| `verifyPin` null guard in `auth.ts` | Task 1 |
| `GET /auth/status` endpoint | Task 2 |
| `POST /auth/setup` endpoint | Task 2 |
| `POST /auth` pinHash guard | Task 2 + Task 6 |
| Frontend `needsSetup` auth state | Task 3 |
| PinGate dual-mode UI (unlock vs setup) | Task 4 |
| PinGate reset hint | Task 4 |
| `claude-remote-cli pin reset` CLI subcommand | Task 5 |
| Try-catch wrapper for Express 4 async handler | Task 6 |

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
-

**What didn't:**
-

**Learnings to codify:**
-
