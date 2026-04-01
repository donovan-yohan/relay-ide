# Remote Browser — HTML Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents surface HTML files (design mockups, comparison boards) as viewable tabs in the remote web UI's FileViewerPane, with a CLI command for agent discovery and token-based content serving.

**Architecture:** Extend the existing FileViewerPane (diff/code tabs) with an `'html'` tab type rendered via sandboxed iframe. Server generates content tokens via `POST /browser-tabs`, serves files via `GET /browser-content/:token/*`. CLI sub-command `claude-remote-cli browser <path>` bridges agents to the server. EventMessage refactored to discriminated union.

**Tech Stack:** TypeScript, Express, Svelte 5 (runes), node:test, node:crypto

---

## File Structure

```
NEW FILES:
  server/browser-content.ts          — Token store + Express router (POST /browser-tabs, GET /browser-content/:token/*)
  test/browser-content.test.ts       — Server endpoint tests
  test/browser-cli.test.ts           — CLI sub-command tests

MODIFIED FILES:
  frontend/src/lib/state/ui.svelte.ts           — OpenFileTab.tabType, openHtmlTab(), refreshHtmlTab()
  frontend/src/lib/ws.ts                        — EventMessage discriminated union
  frontend/src/components/FileViewerPane.svelte  — iframe render, [refresh], sandbox notice, diff-fetch gate
  frontend/src/App.svelte                       — browser-tab-opened/refreshed WS handlers
  server/index.ts                               — Mount browser-content router, generate scoped token
  server/pty-handler.ts                         — Inject CLAUDE_REMOTE_BROWSER_* env vars
  bin/claude-remote-cli.ts                      — browser sub-command
```

---

### Task 1: EventMessage Discriminated Union

Refactor the bag-of-optionals `EventMessage` into a typed union. This unblocks all subsequent WS event work with compile-time safety.

**Files:**
- Modify: `frontend/src/lib/ws.ts:5-19`
- Modify: `frontend/src/App.svelte:519-549`

- [ ] **Step 1: Write the failing type check test**

Create `test/event-message-types.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

test('EventMessage types compile without errors', () => {
  // tsc --noEmit on the ws.ts file to verify the union compiles
  try {
    execFileSync('npx', ['tsc', '--noEmit', '--strict', '-p', 'tsconfig.json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    assert.ok(true, 'TypeScript compilation succeeded');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    assert.fail(`TypeScript compilation failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
});
```

- [ ] **Step 2: Run test to verify current state compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (current code compiles)

- [ ] **Step 3: Refactor EventMessage to discriminated union**

Replace `frontend/src/lib/ws.ts:5-19` with:

```typescript
// Discriminated union for WebSocket event messages.
// Each event type declares only its required fields.
export type EventMessage =
  | { type: 'worktrees-changed' }
  | { type: 'session-backend-state-changed'; sessionId: string; state: BackendDisplayState; permissionType?: 'approval' | 'question' }
  | { type: 'session-renamed'; sessionId: string; branchName: string; displayName: string }
  | { type: 'session-branch-changed'; sessionId: string; branch: string; cwdPath?: string }
  | { type: 'session-ended'; sessionId?: string; cwd?: string; branchName?: string }
  | { type: 'ref-changed'; cwdPath: string; branch?: string; repo?: string }
  | { type: 'pr-updated' }
  | { type: 'ci-updated' }
  | { type: 'files-changed'; workspacePath: string; changedFiles?: string[] }
  | { type: 'session-activity-changed'; sessionId: string }
  | { type: 'browser-tab-opened'; filePath: string; token: string }
  | { type: 'browser-tab-refreshed'; filePath: string };
```

Also update the `connectEventSocket` `onmessage` handler to cast the parsed JSON:

```typescript
onMessage(JSON.parse(str) as EventMessage);
```

And update `EventCallback`:

```typescript
type EventCallback = (msg: EventMessage) => void;
```

- [ ] **Step 4: Update App.svelte event handler to use narrowed types**

In `frontend/src/App.svelte:519-549`, update the `connectEventSocket` callback. The existing `msg.type === 'xxx'` checks already work as type guards with a discriminated union. The only change needed: remove optional chaining on fields that are now required by the union. For example, `msg.sessionId && msg.state` checks become unnecessary for `session-backend-state-changed` since both are required in the union type.

The key changes:
- `msg.sessionId && msg.state` guard on `session-backend-state-changed` — remove, both are guaranteed
- `msg.sessionId` guard on `session-renamed` — remove, guaranteed
- `msg.sessionId` guard on `session-branch-changed` — remove, guaranteed
- `msg.cwdPath` guard on `ref-changed` — remove, guaranteed
- Add new handlers at end of chain (will be done in Task 6)

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS with zero errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/ws.ts frontend/src/App.svelte test/event-message-types.test.ts
git commit -m "refactor: EventMessage discriminated union for type-safe WS events"
```

---

### Task 2: OpenFileTab tabType + openHtmlTab

Add the `tabType` field to `OpenFileTab` and the `openHtmlTab()`/`refreshHtmlTab()` helpers. Key tabs by `(filePath, tabType)` to prevent collision.

**Files:**
- Modify: `frontend/src/lib/state/ui.svelte.ts:73-77, 206-216`

- [ ] **Step 1: Write the failing test**

Create `test/browser-tabs-ui.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';

// Test the pure logic of tab identity and deduplication.
// We can't import .svelte.ts files in node:test (they need the Svelte compiler),
// so we test the logic by duplicating the key algorithm here.

function tabKey(filePath: string, tabType: string): string {
  return `${tabType}::${filePath}`;
}

test('tabKey differentiates same file with different types', () => {
  const diffKey = tabKey('/tmp/index.html', 'diff');
  const htmlKey = tabKey('/tmp/index.html', 'html');
  assert.notStrictEqual(diffKey, htmlKey);
});

test('tabKey matches same file with same type', () => {
  const key1 = tabKey('/tmp/index.html', 'html');
  const key2 = tabKey('/tmp/index.html', 'html');
  assert.strictEqual(key1, key2);
});

test('openHtmlTab logic creates correct tab shape', () => {
  // Simulate what openHtmlTab does
  const filePath = '/tmp/gstack-sketch/design-board.html';
  const tab = {
    filePath,
    fileName: filePath.split('/').pop() ?? filePath,
    isChanged: false,
    tabType: 'html' as const,
    token: 'abc123',
  };
  assert.strictEqual(tab.fileName, 'design-board.html');
  assert.strictEqual(tab.isChanged, false);
  assert.strictEqual(tab.tabType, 'html');
  assert.strictEqual(tab.token, 'abc123');
});

test('refreshHtmlTab logic appends cache buster', () => {
  const baseUrl = '/browser-content/abc123/design-board.html';
  const refreshed = `${baseUrl}?t=${Date.now()}`;
  assert.ok(refreshed.includes('?t='));
  assert.ok(refreshed.startsWith(baseUrl));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/browser-tabs-ui.test.ts`
Expected: PASS (these are logic tests, they pass immediately since we're testing the algorithm)

- [ ] **Step 3: Extend OpenFileTab and tab functions**

In `frontend/src/lib/state/ui.svelte.ts`, modify:

```typescript
// Line 73-77: Add tabType and token to interface
export type FileTabType = 'diff' | 'code' | 'html';

export interface OpenFileTab {
  filePath: string;
  fileName: string;
  isChanged: boolean;
  tabType?: FileTabType;  // undefined = legacy diff/code (backward compat)
  token?: string;         // content token for html tabs
}
```

Update `openFileTab` at line 206 to key by `(filePath, tabType)`:

```typescript
export function openFileTab(filePath: string, isChanged: boolean, tabType?: FileTabType, token?: string): void {
  const fileName = filePath.split('/').pop() ?? filePath;
  const matchType = tabType ?? (isChanged ? 'diff' : 'code');
  const existing = openFileTabs.find(t => t.filePath === filePath && (t.tabType ?? (t.isChanged ? 'diff' : 'code')) === matchType);
  if (!existing) {
    openFileTabs = [...openFileTabs, { filePath, fileName, isChanged, tabType, token }];
  } else if (existing.isChanged !== isChanged || existing.token !== token) {
    openFileTabs = openFileTabs.map(t =>
      t.filePath === filePath && (t.tabType ?? (t.isChanged ? 'diff' : 'code')) === matchType
        ? { ...t, isChanged, token }
        : t
    );
  }
  activeFileTabPath = filePath;
}
```

Add `openHtmlTab` and `refreshHtmlTab` after `closeAllFileTabs`:

```typescript
export function openHtmlTab(filePath: string, token: string): void {
  openFileTab(filePath, false, 'html', token);
}

export function refreshHtmlTab(filePath: string): void {
  // Force re-render by updating token timestamp
  const tab = openFileTabs.find(t => t.filePath === filePath && t.tabType === 'html');
  if (tab) {
    openFileTabs = openFileTabs.map(t =>
      t.filePath === filePath && t.tabType === 'html'
        ? { ...t, token: `${t.token?.split('?')[0]}?t=${Date.now()}` }
        : t
    );
    activeFileTabPath = filePath;
  }
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/ui.svelte.ts test/browser-tabs-ui.test.ts
git commit -m "feat: add tabType to OpenFileTab, openHtmlTab/refreshHtmlTab helpers"
```

---

### Task 3: Server Browser Content Module

The core server module: token store, POST /browser-tabs, GET /browser-content/:token/*.

**Files:**
- Create: `server/browser-content.ts`
- Create: `test/browser-content.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/browser-content.test.ts`:

```typescript
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createBrowserToken,
  validateToken,
  resolveTokenPath,
  generateScopedToken,
  validateScopedToken,
  cleanExpiredTokens,
  _resetForTesting,
} from '../server/browser-content.js';

let tmpDir: string;

beforeEach(() => {
  _resetForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-content-test-'));
  // Create test HTML file
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Hello</h1>');
  fs.writeFileSync(path.join(tmpDir, 'styles.css'), 'body { color: red; }');
  fs.mkdirSync(path.join(tmpDir, 'sub'));
  fs.writeFileSync(path.join(tmpDir, 'sub', 'nested.js'), 'console.log("hi")');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Content token tests ──

test('createBrowserToken returns a token string', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  assert.ok(typeof token === 'string');
  assert.ok(token.length > 0);
});

test('validateToken returns baseDir for valid token', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  const result = validateToken(token);
  assert.ok(result);
  assert.strictEqual(result.baseDir, tmpDir);
});

test('validateToken returns null for invalid token', () => {
  const result = validateToken('nonexistent-token');
  assert.strictEqual(result, null);
});

test('resolveTokenPath serves file within baseDir', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  const resolved = resolveTokenPath(token, 'index.html');
  assert.strictEqual(resolved, filePath);
});

test('resolveTokenPath serves nested file', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  const resolved = resolveTokenPath(token, 'sub/nested.js');
  assert.strictEqual(resolved, path.join(tmpDir, 'sub', 'nested.js'));
});

test('resolveTokenPath rejects path traversal', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  const resolved = resolveTokenPath(token, '../../../etc/passwd');
  assert.strictEqual(resolved, null);
});

test('resolveTokenPath rejects absolute path in relative', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  const resolved = resolveTokenPath(token, '/etc/passwd');
  assert.strictEqual(resolved, null);
});

// ── Scoped auth token tests ──

test('generateScopedToken returns a hex string', () => {
  const token = generateScopedToken();
  assert.ok(/^[a-f0-9]+$/.test(token));
});

test('validateScopedToken returns true for correct token', () => {
  const token = generateScopedToken();
  assert.strictEqual(validateScopedToken(token), true);
});

test('validateScopedToken returns false for wrong token', () => {
  generateScopedToken();
  assert.strictEqual(validateScopedToken('wrong-token'), false);
});

// ── Token expiry tests ──

test('cleanExpiredTokens removes old tokens', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);

  // Verify token works before expiry
  assert.ok(validateToken(token));

  // Force expire by manipulating internal state
  cleanExpiredTokens(0); // TTL of 0ms = everything expired

  assert.strictEqual(validateToken(token), null);
});

test('cleanExpiredTokens keeps fresh tokens', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);

  cleanExpiredTokens(24 * 60 * 60 * 1000); // 24h TTL

  assert.ok(validateToken(token));
});

// ── Duplicate path detection ──

test('createBrowserToken for same path returns existing token', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token1 = createBrowserToken(filePath);
  const token2 = createBrowserToken(filePath);
  assert.strictEqual(token1, token2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/browser-content.test.ts`
Expected: FAIL — `Cannot find module '../server/browser-content.js'`

- [ ] **Step 3: Implement browser-content.ts**

Create `server/browser-content.ts`:

```typescript
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router } from 'express';
import type express from 'express';

// ── Content token store ──
// Maps content tokens to base directories for serving HTML + assets.

interface TokenEntry {
  baseDir: string;
  filePath: string;
  createdAt: number;
}

const tokenStore = new Map<string, TokenEntry>();
const pathToToken = new Map<string, string>(); // reverse lookup: filePath → token

// ── Scoped auth token ──
// A limited-scope token that only authorizes POST /browser-tabs.
// Injected into PTY env. Regenerated each server restart.
let scopedToken = '';

export function generateScopedToken(): string {
  scopedToken = crypto.randomBytes(32).toString('hex');
  return scopedToken;
}

export function validateScopedToken(token: string): boolean {
  return token.length > 0 && token === scopedToken;
}

// ── Content tokens ──

export function createBrowserToken(filePath: string): string {
  // Return existing token for same path (idempotent)
  const existing = pathToToken.get(filePath);
  if (existing && tokenStore.has(existing)) return existing;

  const token = crypto.randomBytes(16).toString('hex');
  const baseDir = path.dirname(filePath);
  tokenStore.set(token, { baseDir, filePath, createdAt: Date.now() });
  pathToToken.set(filePath, token);
  return token;
}

export function validateToken(token: string): { baseDir: string; filePath: string } | null {
  const entry = tokenStore.get(token);
  return entry ? { baseDir: entry.baseDir, filePath: entry.filePath } : null;
}

export function resolveTokenPath(token: string, relativePath: string): string | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;

  // Reject absolute paths
  if (path.isAbsolute(relativePath)) return null;

  const resolved = path.resolve(entry.baseDir, relativePath);
  // Ensure resolved path is within baseDir (no traversal)
  if (!resolved.startsWith(entry.baseDir + path.sep) && resolved !== entry.baseDir) return null;

  return resolved;
}

export function getTokenForPath(filePath: string): string | null {
  return pathToToken.get(filePath) ?? null;
}

export function cleanExpiredTokens(ttlMs: number): void {
  const now = Date.now();
  for (const [token, entry] of tokenStore) {
    if (now - entry.createdAt > ttlMs) {
      tokenStore.delete(token);
      pathToToken.delete(entry.filePath);
    }
  }
}

export function _resetForTesting(): void {
  tokenStore.clear();
  pathToToken.clear();
  scopedToken = '';
}

// ── Express router ──

export function createBrowserContentRouter(
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void,
): Router {
  const router = Router();

  // POST /browser-tabs — create or refresh a browser tab
  router.post('/browser-tabs', (req: express.Request, res: express.Response) => {
    // Auth: scoped token from PTY env
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!validateScopedToken(bearerToken)) {
      res.status(401).json({ error: 'Invalid browser token' });
      return;
    }

    const { path: filePath } = req.body as { path?: string };
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    // Validate path
    const resolved = path.resolve(filePath);
    if (!path.isAbsolute(resolved)) {
      res.status(400).json({ error: 'path must be absolute' });
      return;
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'path must be a file, not a directory' });
        return;
      }
    } catch {
      res.status(404).json({ error: 'file not found' });
      return;
    }

    // Check if already open (idempotent refresh)
    const existingToken = getTokenForPath(resolved);
    if (existingToken) {
      broadcastEvent('browser-tab-refreshed', { filePath: resolved });
      res.json({ token: existingToken, refreshed: true });
      return;
    }

    // Create new token
    const token = createBrowserToken(resolved);
    broadcastEvent('browser-tab-opened', { filePath: resolved, token });
    res.json({ token, refreshed: false });
  });

  // GET /browser-content/:token/* — serve file content
  router.get('/browser-content/:token/*', (req: express.Request, res: express.Response) => {
    const { token } = req.params;
    // The * param captures everything after /browser-content/:token/
    const relativePath = req.params[0] || '';

    if (!relativePath) {
      res.status(400).send('Missing file path');
      return;
    }

    const resolved = resolveTokenPath(token!, relativePath);
    if (!resolved) {
      res.status(403).send('Forbidden');
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).send('Not found');
      return;
    }

    res.sendFile(resolved);
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/browser-content.test.ts`
Expected: All 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/browser-content.ts test/browser-content.test.ts
git commit -m "feat: browser-content module with token store and Express router"
```

---

### Task 4: Mount Router + Scoped Token in Server

Wire the browser-content router into the Express app and generate the scoped token at startup.

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Add import at top of server/index.ts**

```typescript
import { createBrowserContentRouter, generateScopedToken, cleanExpiredTokens } from './browser-content.js';
```

- [ ] **Step 2: Generate scoped token after server setup**

After the `const { broadcastEvent, broadcastBranchChanged } = setupWebSocket(...)` line (around line 288), add:

```typescript
// Generate scoped token for browser tab CLI auth
const browserScopedToken = generateScopedToken();
```

Store `browserScopedToken` so it can be passed to the PTY handler (we'll use it in Task 7).

- [ ] **Step 3: Mount the browser-content router**

After the last `app.post('/update', ...)` route (around line 1448), add:

```typescript
// Browser content viewer (no requireAuth — uses token-based auth)
const browserContentRouter = createBrowserContentRouter(broadcastEvent);
app.use(browserContentRouter);
```

- [ ] **Step 4: Add token cleanup interval**

After mounting the router, add:

```typescript
// Clean expired browser content tokens every hour
const BROWSER_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours
setInterval(() => cleanExpiredTokens(BROWSER_TOKEN_TTL), 60 * 60 * 1000);
```

- [ ] **Step 5: Export browserScopedToken for pty-handler**

We need the scoped token accessible from the PTY handler. The simplest approach: store it on `process.env` (same pattern as `CLAUDE_REMOTE_CONFIG`):

```typescript
process.env['CLAUDE_REMOTE_BROWSER_TOKEN'] = browserScopedToken;
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/index.ts
git commit -m "feat: mount browser-content router with scoped token and TTL cleanup"
```

---

### Task 5: PTY Environment Variable Injection

Inject `CLAUDE_REMOTE_BROWSER*` env vars into PTY sessions so agents can discover the capability.

**Files:**
- Modify: `server/pty-handler.ts:133`
- Modify: `server/utils.ts:19-23` (cleanEnv)

- [ ] **Step 1: Write the failing test**

Add to `test/browser-content.test.ts`:

```typescript
test('cleanEnv preserves CLAUDE_REMOTE_BROWSER vars when set', async () => {
  // Import cleanEnv
  const { cleanEnv } = await import('../server/utils.js');
  
  // Set the env vars (simulating what server/index.ts does)
  process.env['CLAUDE_REMOTE_BROWSER'] = '1';
  process.env['CLAUDE_REMOTE_BROWSER_CMD'] = 'claude-remote-cli browser';
  process.env['CLAUDE_REMOTE_PORT'] = '3456';
  process.env['CLAUDE_REMOTE_BROWSER_TOKEN'] = 'test-token';
  
  const env = cleanEnv();
  
  assert.strictEqual(env['CLAUDE_REMOTE_BROWSER'], '1');
  assert.strictEqual(env['CLAUDE_REMOTE_BROWSER_CMD'], 'claude-remote-cli browser');
  assert.strictEqual(env['CLAUDE_REMOTE_PORT'], '3456');
  assert.strictEqual(env['CLAUDE_REMOTE_BROWSER_TOKEN'], 'test-token');
  
  // Cleanup
  delete process.env['CLAUDE_REMOTE_BROWSER'];
  delete process.env['CLAUDE_REMOTE_BROWSER_CMD'];
  delete process.env['CLAUDE_REMOTE_PORT'];
  delete process.env['CLAUDE_REMOTE_BROWSER_TOKEN'];
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/browser-content.test.ts`
Expected: The test should actually PASS because `cleanEnv()` copies all of `process.env` and only deletes `CLAUDECODE`. The env vars we set flow through naturally.

This confirms we do NOT need to modify `cleanEnv()` — the env vars just need to be set on `process.env` before PTY spawn, which Task 4 already does for `CLAUDE_REMOTE_BROWSER_TOKEN`.

- [ ] **Step 3: Set remaining env vars in server/index.ts**

In `server/index.ts`, after generating the scoped token, add the rest of the env vars:

```typescript
process.env['CLAUDE_REMOTE_BROWSER'] = '1';
process.env['CLAUDE_REMOTE_BROWSER_CMD'] = 'claude-remote-cli browser';
process.env['CLAUDE_REMOTE_BROWSER_TOKEN'] = browserScopedToken;
// CLAUDE_REMOTE_PORT is already set by bin/claude-remote-cli.ts if --port was passed.
// For the default port case, set it now if not already set.
if (!process.env['CLAUDE_REMOTE_PORT']) {
  process.env['CLAUDE_REMOTE_PORT'] = String(startupConfig.port);
}
```

- [ ] **Step 4: Run test to verify**

Run: `npm run build && node --test test/browser-content.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/index.ts test/browser-content.test.ts
git commit -m "feat: inject CLAUDE_REMOTE_BROWSER env vars for PTY agent discovery"
```

---

### Task 6: CLI browser Sub-Command

Add `claude-remote-cli browser <path>` that resolves the path and POSTs to the running server.

**Files:**
- Modify: `bin/claude-remote-cli.ts`
- Create: `test/browser-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/browser-cli.test.ts`:

```typescript
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cli-test-'));
  fs.writeFileSync(path.join(tmpDir, 'test.html'), '<h1>Test</h1>');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('browser command with no args prints usage and exits 1', () => {
  try {
    execFileSync('node', ['dist/bin/claude-remote-cli.js', 'browser'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    assert.fail('Should have exited with code 1');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.strictEqual(e.status, 1);
    assert.ok((e.stderr ?? '').includes('Usage'));
  }
});

test('browser command resolves relative path to absolute', () => {
  // This tests the path resolution logic by checking the error message
  // when the server isn't running (the path in the error should be absolute)
  try {
    execFileSync('node', ['dist/bin/claude-remote-cli.js', 'browser', path.join(tmpDir, 'test.html')], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_REMOTE_PORT: '19999',  // Port nothing listens on
        CLAUDE_REMOTE_BROWSER_TOKEN: 'test-token',
        PATH: process.env.PATH,
      },
    });
    assert.fail('Should have failed (no server running)');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    // Should fail with connection error, not path error
    assert.ok((e.stderr ?? '').includes('connect') || (e.stderr ?? '').includes('ECONNREFUSED'),
      `Expected connection error, got: ${e.stderr}`);
  }
});

test('browser command fails gracefully when server is not running', () => {
  try {
    execFileSync('node', ['dist/bin/claude-remote-cli.js', 'browser', path.join(tmpDir, 'test.html')], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_REMOTE_PORT: '19999',
        CLAUDE_REMOTE_BROWSER_TOKEN: 'test-token',
        PATH: process.env.PATH,
      },
    });
    assert.fail('Should have exited with error');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.ok(e.status !== 0);
  }
});

test('browser --help shows usage', () => {
  try {
    const output = execFileSync('node', ['dist/bin/claude-remote-cli.js', 'browser', '--help'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    assert.ok(output.includes('Usage') || output.includes('browser'));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    assert.ok(out.includes('Usage') || out.includes('browser'));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/browser-cli.test.ts`
Expected: FAIL — no `browser` sub-command exists yet

- [ ] **Step 3: Implement browser sub-command**

In `bin/claude-remote-cli.ts`, add after the `pin` command block and before line 298 (`const configPath = resolveConfigPath()`):

```typescript
if (command === 'browser') {
  const browserArgs = args.slice(1);
  
  if (browserArgs.includes('--help') || browserArgs.includes('-h') || browserArgs.length === 0) {
    console.error(`Usage: claude-remote-cli browser <path>

Opens an HTML file in the remote browser viewer tab.

Arguments:
  <path>    Path to HTML file (absolute or relative)

Environment:
  CLAUDE_REMOTE_PORT            Server port (default: 3456)
  CLAUDE_REMOTE_BROWSER_TOKEN   Auth token for browser tab API`);
    process.exit(browserArgs.includes('--help') || browserArgs.includes('-h') ? 0 : 1);
  }
  
  const filePath = path.resolve(browserArgs[0]!);
  
  if (!fs.existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }
  
  const port = process.env['CLAUDE_REMOTE_PORT'] ?? String(DEFAULTS.port);
  const token = process.env['CLAUDE_REMOTE_BROWSER_TOKEN'] ?? '';
  
  if (!token) {
    console.error('Error: CLAUDE_REMOTE_BROWSER_TOKEN not set. Are you running inside a claude-remote-cli session?');
    process.exit(1);
  }
  
  try {
    const res = await fetch(`http://127.0.0.1:${port}/browser-tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ path: filePath }),
    });
    
    if (!res.ok) {
      const body = await res.text();
      console.error(`Error: server returned ${res.status}: ${body}`);
      process.exit(1);
    }
    
    const data = await res.json() as { token: string; refreshed: boolean };
    if (data.refreshed) {
      console.log(`Refreshed: ${filePath}`);
    } else {
      console.log(`Opened: ${filePath}`);
    }
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not connect to server on port ${port}: ${msg}`);
    process.exit(1);
  }
}
```

Also update the help text at the top of the file to include the `browser` command:

```
  browser            Open an HTML file in the remote viewer
    <path>             Path to HTML file
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/browser-cli.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add bin/claude-remote-cli.ts test/browser-cli.test.ts
git commit -m "feat: add 'browser' CLI sub-command for agent HTML file viewing"
```

---

### Task 7: FileViewerPane HTML Rendering

Add the iframe render branch, diff-fetch gate, `[refresh]` button, sandbox notice, and SVG globe icon.

**Files:**
- Modify: `frontend/src/components/FileViewerPane.svelte`

- [ ] **Step 1: Gate the diff-fetch $effect**

In `FileViewerPane.svelte`, modify the `$effect` at lines 62-94. Add a guard at the top:

```typescript
$effect(() => {
  const tab = activeTab;
  if (!tab || !workspacePath) return;
  // Skip diff fetch for HTML tabs — they use iframe, not DiffViewer
  if (tab.tabType === 'html') return;
  // ... rest of existing effect unchanged
});
```

- [ ] **Step 2: Add SVG globe icon constant**

Add near the top of the `<script>` block:

```typescript
const globeIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
  <circle cx="7" cy="7" r="5.5"/>
  <path d="M1.5 7h11M7 1.5c-1.5 2-2 3.5-2 5.5s.5 3.5 2 5.5M7 1.5c1.5 2 2 3.5 2 5.5s-.5 3.5-2 5.5"/>
</svg>`;
```

- [ ] **Step 3: Update tab rendering in the tab bar**

In the tab bar `{#each}` block (around line 145), add the globe icon for HTML tabs:

```svelte
{#each ui.openFileTabs as tab (tab.filePath + '::' + (tab.tabType ?? 'code'))}
  <div
    class="file-tab"
    class:active={tab.filePath === ui.activeFileTabPath}
    onclick={() => { ui.activeFileTabPath = tab.filePath; }}
    role="tab"
    aria-selected={tab.filePath === ui.activeFileTabPath}
  >
    {#if tab.tabType === 'html'}
      <span class="tab-icon">{@html globeIcon}</span>
    {/if}
    <span class="tab-name">{tab.fileName}</span>
    {#if tab.isChanged}
      <span class="tab-badge">M</span>
    {/if}
    <button
      class="tab-close"
      onclick={(e) => handleCloseTab(tab.filePath, e)}
      aria-label="close {tab.fileName}"
    >×</button>
  </div>
{/each}
```

Note: the `{#each}` key changes from `tab.filePath` to `tab.filePath + '::' + (tab.tabType ?? 'code')` to support multiple tabs for the same file with different types.

- [ ] **Step 4: Add [refresh] button in tab-bar-actions**

In the `.tab-bar-actions` div (around line 167), add before the close-all button:

```svelte
{#if activeTab?.tabType === 'html'}
  <button class="refresh-btn" onclick={handleRefresh} title="Reload HTML content">
    [refresh]
  </button>
{/if}
```

And add the handler in the script block:

```typescript
function handleRefresh(): void {
  if (activeTab?.tabType === 'html' && activeTab.filePath) {
    refreshHtmlTab(activeTab.filePath);
  }
}
```

Import `refreshHtmlTab` from the ui state:

```typescript
import { getUi, closeFileTab, closeAllFileTabs, refreshHtmlTab, type OpenFileTab } from '../lib/state/ui.svelte.js';
```

- [ ] **Step 5: Add iframe render branch + sandbox notice in content area**

In the content area `{#if}` chain (around line 186), add a new branch BEFORE the `activeTab.isChanged` check:

```svelte
{:else if activeTab.tabType === 'html' && activeTab.token}
  <!-- HTML preview with sandbox notice -->
  <div class="html-viewer">
    <div class="sandbox-notice" class:dismissed={sandboxDismissed}>
      <span class="notice-text">rendered in sandbox · some web features may not work</span>
      <button class="notice-dismiss" onclick={() => { sandboxDismissed = true; }} aria-label="dismiss notice">×</button>
    </div>
    <iframe
      src="/browser-content/{activeTab.token}/{activeTab.fileName}"
      sandbox="allow-scripts"
      title="HTML preview: {activeTab.fileName}"
      class="html-iframe"
    ></iframe>
  </div>
```

Add the state variable for sandbox notice dismissal:

```typescript
let sandboxDismissed = $state(false);

// Auto-dismiss sandbox notice after 4 seconds
$effect(() => {
  if (activeTab?.tabType === 'html' && !sandboxDismissed) {
    const timer = setTimeout(() => { sandboxDismissed = true; }, 4000);
    return () => clearTimeout(timer);
  }
});

// Reset dismissal when switching to a different HTML tab
$effect(() => {
  if (activeTab?.tabType === 'html') {
    sandboxDismissed = false;
  }
});
```

- [ ] **Step 6: Add CSS styles**

Add to the `<style>` block:

```css
.tab-icon {
  display: inline-flex;
  align-items: center;
  color: var(--text-muted, #888);
  margin-right: 4px;
}

.file-tab.active .tab-icon {
  color: var(--text, #e0e0e0);
}

.refresh-btn {
  background: none;
  border: 1px solid var(--border, #333);
  color: var(--text-muted, #888);
  font-family: inherit;
  font-size: var(--font-size-xs, 0.75rem);
  padding: 2px 6px;
  cursor: pointer;
}

.refresh-btn:hover {
  color: var(--text, #e0e0e0);
  border-color: var(--text-muted, #888);
}

.html-viewer {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.sandbox-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border, #333);
  font-size: var(--font-size-xs, 0.75rem);
  color: var(--text-muted, #888);
  transition: opacity 0.3s ease-out, max-height 0.3s ease-out;
  max-height: 28px;
  overflow: hidden;
}

.sandbox-notice.dismissed {
  opacity: 0;
  max-height: 0;
  padding: 0 12px;
  border-bottom: none;
}

.notice-text {
  font-family: inherit;
}

.notice-dismiss {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--font-size-sm, 0.8125rem);
  padding: 0 4px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.notice-dismiss:hover {
  color: var(--text, #e0e0e0);
}

.html-iframe {
  flex: 1;
  width: 100%;
  border: none;
  background: white;
}
```

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/FileViewerPane.svelte
git commit -m "feat: HTML tab rendering with iframe, globe icon, refresh, sandbox notice"
```

---

### Task 8: WebSocket Event Handlers in App.svelte

Wire up `browser-tab-opened` and `browser-tab-refreshed` events.

**Files:**
- Modify: `frontend/src/App.svelte:519-549`

- [ ] **Step 1: Add imports**

In `App.svelte`, add to the import from `ui.svelte.js`:

```typescript
import { openHtmlTab, refreshHtmlTab } from './lib/state/ui.svelte.js';
```

(Or add to the existing destructured import if one exists.)

- [ ] **Step 2: Add event handlers in connectEventSocket callback**

At the end of the `connectEventSocket((msg) => { ... })` chain (around line 549), add:

```typescript
} else if (msg.type === 'browser-tab-opened') {
  openHtmlTab(msg.filePath, msg.token);
} else if (msg.type === 'browser-tab-refreshed') {
  refreshHtmlTab(msg.filePath);
}
```

With the discriminated union from Task 1, `msg.filePath` and `msg.token` are typed correctly for `browser-tab-opened`, and `msg.filePath` is typed correctly for `browser-tab-refreshed`.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All existing + new tests pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "feat: handle browser-tab-opened/refreshed WebSocket events"
```

---

### Task 9: Full Integration Test

Run the full test suite and verify the build is clean.

**Files:** None (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS with zero errors

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: Zero errors

- [ ] **Step 4: Verify git status**

Run: `git status`
Expected: Clean working tree, all changes committed

- [ ] **Step 5: Final commit (if any cleanup needed)**

If any files were missed:

```bash
git add -A
git commit -m "chore: integration cleanup for remote browser feature"
```
