import { test, expect } from 'vitest';
import {
  hashPin,
  isPinConfigured,
  verifyPin,
  isLegacyHash,
  isRateLimited,
  recordFailedAttempt,
  generateCookieToken,
  verifyCookieToken,
  browserSessionRequiredChallenge,
  cliGatewayOrBrowserAuthRequiredChallenge,
  scopedSessionOrBrowserAuthRequiredChallenge,
  AUTH_ROUTE_LANE_INVENTORY,
  _resetForTesting,
} from '../server/auth.js';
import type { AuthRouteLaneInventoryEntry } from '../server/auth.js';

test('hashPin returns scrypt hash with expected format', async () => {
  _resetForTesting();
  const hash = await hashPin('1234');
  expect(hash.startsWith('scrypt:')).toBe(true);
  const parts = hash.split(':');
  expect(parts.length).toBe(3);
});

test('verifyPin returns true for correct PIN', async () => {
  _resetForTesting();
  const hash = await hashPin('1234');
  const result = await verifyPin('1234', hash);
  expect(result).toBe(true);
});

test('verifyPin returns false for wrong PIN', async () => {
  _resetForTesting();
  const hash = await hashPin('1234');
  const result = await verifyPin('9999', hash);
  expect(result).toBe(false);
});

test('rate limiter blocks after 5 failures', () => {
  _resetForTesting();
  const ip = '127.0.0.1';

  for (let i = 0; i < 5; i++) {
    recordFailedAttempt(ip);
  }

  expect(isRateLimited(ip)).toBe(true);
});

test('rate limiter allows under threshold', () => {
  _resetForTesting();
  const ip = '127.0.0.1';

  for (let i = 0; i < 4; i++) {
    recordFailedAttempt(ip);
  }

  expect(isRateLimited(ip)).toBe(false);
});

test('verifyPin returns false for legacy bcrypt hash (requires PIN reset)', async () => {
  _resetForTesting();
  const legacyHash =
    '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';
  const result = await verifyPin('1234', legacyHash);
  expect(result).toBe(false);
});

test('verifyPin returns false for malformed scrypt hash (missing parts)', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', 'scrypt:saltonly');
  expect(result).toBe(false);
});

test('verifyPin returns false for scrypt hash with empty salt', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', 'scrypt::deadbeef');
  expect(result).toBe(false);
});

test('verifyPin returns false for scrypt hash with wrong key length', async () => {
  _resetForTesting();
  // Valid hex but wrong length (should be 64 bytes = 128 hex chars)
  const result = await verifyPin('1234', 'scrypt:abcd1234:deadbeef');
  expect(result).toBe(false);
});

test('verifyPin returns false for completely empty hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', '');
  expect(result).toBe(false);
});

test('verifyPin returns false for garbage input', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', 'not-a-valid-hash-at-all');
  expect(result).toBe(false);
});

test('hashPin produces unique salts', async () => {
  _resetForTesting();
  const hash1 = await hashPin('1234');
  const hash2 = await hashPin('1234');
  expect(hash1).not.toBe(hash2);
  // But both should verify correctly
  expect(await verifyPin('1234', hash1)).toBe(true);
  expect(await verifyPin('1234', hash2)).toBe(true);
});

test('isLegacyHash returns true for bcrypt hashes', () => {
  expect(
    isLegacyHash('$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012')
  ).toBe(true);
  expect(isLegacyHash('$2a$10$someotherbcrypthashvalue')).toBe(true);
});

test('isLegacyHash returns false for scrypt hashes', async () => {
  const hash = await hashPin('1234');
  expect(isLegacyHash(hash)).toBe(false);
});

test('isLegacyHash returns false for empty string', () => {
  expect(isLegacyHash('')).toBe(false);
});

test('isPinConfigured treats legacy disabled sentinel and unsupported hashes as not configured', async () => {
  const hash = await hashPin('1234');
  expect(isPinConfigured(hash)).toBe(true);
  expect(isPinConfigured('disabled')).toBe(false);
  expect(
    isPinConfigured(
      '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012'
    )
  ).toBe(false);
  expect(isPinConfigured('')).toBe(false);
  expect(isPinConfigured(undefined)).toBe(false);
  expect(isPinConfigured(null)).toBe(false);
});

test('generateCookieToken returns non-empty string', () => {
  _resetForTesting();
  const token = generateCookieToken();
  expect(token).toBeTypeOf('string');
  expect(token.length).toBeGreaterThan(0);
});

test('signed browser-session cookies verify after in-memory auth state is reset', async () => {
  _resetForTesting();
  const pinHash = await hashPin('1234');
  const now = Date.now();
  const token = generateCookieToken({
    pinHash,
    ttlMs: 60_000,
    now,
  });

  _resetForTesting();

  expect(verifyCookieToken(token, pinHash, now + 30_000)).toBe(true);
});

test('signed browser-session cookies reject expired or wrong-pin-hash tokens', async () => {
  _resetForTesting();
  const pinHash = await hashPin('1234');
  const otherPinHash = await hashPin('9999');
  const now = Date.now();
  const token = generateCookieToken({
    pinHash,
    ttlMs: 60_000,
    now,
  });

  expect(verifyCookieToken(token, pinHash, now + 60_001)).toBe(false);
  expect(verifyCookieToken(token, otherPinHash, now + 30_000)).toBe(false);
});

test('verifyPin returns false for undefined hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', undefined);
  expect(result).toBe(false);
});

test('verifyPin returns false for null hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', null);
  expect(result).toBe(false);
});

test('auth lane challenges return typed denial payloads', () => {
  expect(browserSessionRequiredChallenge()).toMatchObject({
    error: {
      code: 'BROWSER_SESSION_REQUIRED',
      message: expect.stringContaining('Browser session'),
      retryable: false,
      lane: 'denied',
      acceptedLanes: ['browser-session'],
      migrationTarget: 'scoped-actor-credential',
    },
  });

  expect(cliGatewayOrBrowserAuthRequiredChallenge()).toMatchObject({
    error: {
      code: 'CLI_GATEWAY_OR_BROWSER_AUTH_REQUIRED',
      retryable: false,
      lane: 'denied',
      acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    },
  });

  expect(scopedSessionOrBrowserAuthRequiredChallenge()).toMatchObject({
    error: {
      code: 'SCOPED_SESSION_OR_BROWSER_AUTH_REQUIRED',
      retryable: false,
      lane: 'denied',
      acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    },
  });
});

const expectedInventoryCoverage = [
  {
    surface: 'browser UI and authenticated local app APIs',
    middleware: 'requireAuth',
    acceptedLanes: ['browser-session'],
    routes: [
      '/auth/check',
      '/workspaces/*',
      '/workspace-groups/*',
      '/workbench/*',
      '/git/*',
      '/gh/*',
      '/integration-github/*',
      '/integration-jira/*',
      '/auth/github/*',
      '/branch-linker/*',
      '/ticket-transitions/*',
      '/org-dashboard/*',
      '/analytics/*',
      '/api/analytics/*',
      '/telemetry/*',
      '/work-contexts/*',
      '/agent-profiles/*',
    ],
  },
  {
    surface: 'browser diagnostics, config, and lifecycle APIs',
    middleware: 'requireAuth',
    acceptedLanes: ['browser-session'],
    routes: [
      '/api/frontend-log',
      '/api/frameworks',
      '/api/node/manifest',
      '/config/*',
      '/presets/*',
      '/repos',
      '/worktrees/status',
      '/worktrees',
      '/push/*',
      '/version',
      '/update',
      '/update-channel',
      '/sessions/:id (DELETE/PATCH)',
      '/sessions/:id/image',
    ],
  },
  {
    surface: 'browser webhook management APIs',
    middleware:
      'requireAuth via createWebhookManagerRouter mounted at /webhooks/manage',
    acceptedLanes: ['browser-session'],
    routes: [
      'POST /webhooks/manage/setup',
      'DELETE /webhooks/manage/setup',
      'GET /webhooks/manage/status',
      'POST /webhooks/manage/reload',
      'POST /webhooks/manage/ping',
      'POST /webhooks/manage/repos',
      'POST /webhooks/manage/repos/remove',
      'POST /webhooks/manage/backfill',
    ],
  },
  {
    surface: 'browser event and PTY WebSocket APIs',
    middleware: 'setupWebSocket authenticated browser cookie',
    acceptedLanes: ['browser-session'],
    routes: [
      'WS /ws/events',
      'WS /ws/:sessionId',
      'WS /nodes/:nodeId/ws/sessions/:sessionId',
    ],
  },
  {
    surface: 'CLI gateway APIs',
    middleware: 'requireCliGatewayAuth',
    acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    routes: [
      '/sessions (GET/POST)',
      '/context/*',
      '/inbox/*',
      '/events/*',
      '/handoffs/*',
      '/nodes',
      '/hub/audit/*',
      '/hub/nodes/:nodeId/logs',
      '/hub/nodes/:nodeId/sessions',
    ],
  },
  {
    surface: 'CLI gateway channel APIs',
    middleware: 'requireChannelGatewayAuthForCommand',
    acceptedLanes: [
      'scoped-actor-credential',
      'operator-client-credential',
      'browser-session',
    ],
    routes: ['/channels/*'],
  },
  {
    surface: 'scoped session APIs',
    middleware: 'requireScopedSessionAuth',
    acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    routes: [
      '/sessions/:id',
      '/sessions/:id/replay',
      '/sessions/:id/interventions',
      '/sessions/:id/input',
      '/supervisor/sessions',
      '/supervisor/actions/:action',
      '/hub/scoped-sessions',
      '/hub/scoped-sessions/:sessionId/renew',
      '/hub/scoped-sessions/:sessionId/revoke',
      '/hub/scoped-sessions/:sessionId (DELETE)',
    ],
  },
  {
    surface: 'hub operator node and repo APIs',
    middleware: 'requireAuth',
    acceptedLanes: ['browser-session'],
    routes: [
      '/hub/confirmations/*',
      '/hub/pair-tokens',
      '/hub/nodes/:nodeId/credential-rotation/*',
      '/hub/nodes/:nodeId/updating',
      '/hub/nodes/:nodeId/cwd/:operation',
      '/hub/nodes/:nodeId/sessions/:sessionId/files/:operation',
      '/hub/nodes/:nodeId/sessions/:sessionId (DELETE)',
      '/nodes/:nodeId (DELETE)',
      '/hub/repo-inventory',
      '/hub/repo-groups',
      '/hub/ia/tree',
      '/hub/ia/benches/*',
      '/hub/ia/workspaces/*',
      '/hub/nodes/:nodeId/sessions/reopen',
    ],
  },
  {
    surface: 'node credential APIs',
    middleware: 'bearer node credential',
    acceptedLanes: ['node-credential'],
    routes: ['POST /hub/node-heartbeat', 'WS /hub/node-link'],
  },
  {
    surface: 'pairing exchange APIs',
    middleware: 'pair token exchange',
    acceptedLanes: ['pair-token'],
    routes: ['POST /hub/pairing/exchange'],
  },
  {
    surface: 'public local setup and callbacks',
    middleware:
      'public setup/login, localhost hook callback, webhook secret, or static file serving',
    acceptedLanes: ['public-local-only'],
    routes: [
      '/health',
      '/healthz',
      '/auth/status',
      'POST /auth/setup',
      'POST /auth',
      '/hooks/*',
      'POST /webhooks',
      '/static frontend assets',
    ],
  },
  {
    surface: 'intentionally denied or no-route surfaces',
    middleware: 'challenge payload or 404/no route',
    acceptedLanes: ['denied'],
    routes: [
      'browser cookie as node credential',
      'pair token as browser/CLI/node runtime credential',
      'scoped actor credential as node credential',
      'unauthenticated /sessions/*',
      'unknown WebSocket paths',
      'unknown API routes',
    ],
  },
] satisfies Array<Omit<AuthRouteLaneInventoryEntry, 'notes'>>;

test('auth route lane inventory covers browser, scoped, node, pair, public, and denied lanes', () => {
  const lanes = new Set(
    AUTH_ROUTE_LANE_INVENTORY.flatMap((entry) => entry.acceptedLanes)
  );
  expect(lanes).toEqual(
    new Set([
      'browser-session',
      'scoped-actor-credential',
      'operator-client-credential',
      'node-credential',
      'pair-token',
      'public-local-only',
      'denied',
    ])
  );
  expect(browserSessionRequiredChallenge().error.lane).toBe('denied');
});

test('auth route lane inventory exactly matches asserted route coverage', () => {
  const inventoryCoverage = AUTH_ROUTE_LANE_INVENTORY.map(
    ({ notes: _notes, ...entry }) => entry
  );

  expect(inventoryCoverage).toEqual(expectedInventoryCoverage);
});

test('auth route lane inventory keeps credential classes distinct', () => {
  const routeToLanes = new Map<string, string[]>();
  for (const entry of AUTH_ROUTE_LANE_INVENTORY) {
    for (const route of entry.routes)
      routeToLanes.set(route, entry.acceptedLanes);
  }

  expect(routeToLanes.get('WS /hub/node-link')).toEqual(['node-credential']);
  expect(routeToLanes.get('POST /hub/node-heartbeat')).toEqual([
    'node-credential',
  ]);
  expect(routeToLanes.get('POST /hub/pairing/exchange')).toEqual([
    'pair-token',
  ]);
  expect(routeToLanes.get('/sessions (GET/POST)')).toEqual([
    'scoped-actor-credential',
    'browser-session',
  ]);
  expect(routeToLanes.get('/channels/*')).toEqual([
    'scoped-actor-credential',
    'operator-client-credential',
    'browser-session',
  ]);
  expect(routeToLanes.get('POST /webhooks/manage/setup')).toEqual([
    'browser-session',
  ]);
  expect(routeToLanes.get('POST /webhooks')).toEqual(['public-local-only']);
  expect(routeToLanes.has('/webhooks/*')).toBe(false);
  expect(routeToLanes.get('WS /ws/:sessionId')).toEqual(['browser-session']);
  expect(routeToLanes.get('browser cookie as node credential')).toEqual([
    'denied',
  ]);
});
