import { test } from 'node:test';
import assert from 'node:assert';
import {
  hashPin,
  verifyPin,
  isLegacyHash,
  isRateLimited,
  recordFailedAttempt,
  generateCookieToken,
  _resetForTesting,
} from '../server/auth.js';

test('hashPin returns scrypt hash with expected format', async () => {
  _resetForTesting();
  const hash = await hashPin('1234');
  assert.ok(
    hash.startsWith('scrypt:'),
    `Expected hash to start with scrypt:, got: ${hash}`
  );
  const parts = hash.split(':');
  assert.strictEqual(
    parts.length,
    3,
    'Hash should have 3 colon-separated parts'
  );
});

test('verifyPin returns true for correct PIN', async () => {
  _resetForTesting();
  const hash = await hashPin('1234');
  const result = await verifyPin('1234', hash);
  assert.strictEqual(result, true);
});

test('verifyPin returns false for wrong PIN', async () => {
  _resetForTesting();
  const hash = await hashPin('1234');
  const result = await verifyPin('9999', hash);
  assert.strictEqual(result, false);
});

test('rate limiter blocks after 5 failures', () => {
  _resetForTesting();
  const ip = '127.0.0.1';

  for (let i = 0; i < 5; i++) {
    recordFailedAttempt(ip);
  }

  assert.strictEqual(isRateLimited(ip), true);
});

test('rate limiter allows under threshold', () => {
  _resetForTesting();
  const ip = '127.0.0.1';

  for (let i = 0; i < 4; i++) {
    recordFailedAttempt(ip);
  }

  assert.strictEqual(isRateLimited(ip), false);
});

test('verifyPin returns false for legacy bcrypt hash (requires PIN reset)', async () => {
  _resetForTesting();
  const legacyHash =
    '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';
  const result = await verifyPin('1234', legacyHash);
  assert.strictEqual(result, false);
});

test('verifyPin returns false for malformed scrypt hash (missing parts)', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', 'scrypt:saltonly');
  assert.strictEqual(result, false);
});

test('verifyPin returns false for scrypt hash with empty salt', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', 'scrypt::deadbeef');
  assert.strictEqual(result, false);
});

test('verifyPin returns false for scrypt hash with wrong key length', async () => {
  _resetForTesting();
  // Valid hex but wrong length (should be 64 bytes = 128 hex chars)
  const result = await verifyPin('1234', 'scrypt:abcd1234:deadbeef');
  assert.strictEqual(result, false);
});

test('verifyPin returns false for completely empty hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', '');
  assert.strictEqual(result, false);
});

test('verifyPin returns false for garbage input', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', 'not-a-valid-hash-at-all');
  assert.strictEqual(result, false);
});

test('hashPin produces unique salts', async () => {
  _resetForTesting();
  const hash1 = await hashPin('1234');
  const hash2 = await hashPin('1234');
  assert.notStrictEqual(
    hash1,
    hash2,
    'Two hashes of the same PIN should have different salts'
  );
  // But both should verify correctly
  assert.strictEqual(await verifyPin('1234', hash1), true);
  assert.strictEqual(await verifyPin('1234', hash2), true);
});

test('isLegacyHash returns true for bcrypt hashes', () => {
  assert.strictEqual(
    isLegacyHash('$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012'),
    true
  );
  assert.strictEqual(isLegacyHash('$2a$10$someotherbcrypthashvalue'), true);
});

test('isLegacyHash returns false for scrypt hashes', async () => {
  const hash = await hashPin('1234');
  assert.strictEqual(isLegacyHash(hash), false);
});

test('isLegacyHash returns false for empty string', () => {
  assert.strictEqual(isLegacyHash(''), false);
});

test('generateCookieToken returns non-empty string', () => {
  _resetForTesting();
  const token = generateCookieToken();
  assert.ok(typeof token === 'string' && token.length > 0);
});

test('verifyPin returns false for undefined hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', undefined);
  assert.strictEqual(result, false);
});

test('verifyPin returns false for null hash', async () => {
  _resetForTesting();
  const result = await verifyPin('1234', null);
  assert.strictEqual(result, false);
});
