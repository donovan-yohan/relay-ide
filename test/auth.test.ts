import { test, expect } from 'vitest';
import {
  hashPin,
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

test('auth route lane inventory covers browser, scoped, node, pair, public, and denied lanes', () => {
  const lanes = new Set(
    AUTH_ROUTE_LANE_INVENTORY.flatMap((entry) => entry.acceptedLanes)
  );
  expect(lanes).toEqual(
    new Set([
      'browser-session',
      'scoped-actor-credential',
      'node-credential',
      'pair-token',
      'public-local-only',
    ])
  );
  expect(browserSessionRequiredChallenge().error.lane).toBe('denied');

  expect(AUTH_ROUTE_LANE_INVENTORY).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        middleware: 'requireAuth',
        acceptedLanes: ['browser-session'],
        routes: expect.arrayContaining(['/auth/check', '/workspaces/*']),
      }),
      expect.objectContaining({
        middleware: 'bearer node credential',
        acceptedLanes: ['node-credential'],
        routes: expect.arrayContaining([
          'POST /hub/node-heartbeat',
          'WS /hub/node-link',
        ]),
      }),
      expect.objectContaining({
        middleware: 'pair token exchange',
        acceptedLanes: ['pair-token'],
        routes: ['POST /hub/pairing/exchange'],
      }),
    ])
  );
});
