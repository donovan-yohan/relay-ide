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
  getTokenForPath,
  _resetForTesting,
} from '../server/browser-content.js';

let tmpDir: string;

beforeEach(() => {
  _resetForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-content-test-'));
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Hello</h1>');
  fs.writeFileSync(path.join(tmpDir, 'styles.css'), 'body { color: red; }');
  fs.mkdirSync(path.join(tmpDir, 'sub'));
  fs.writeFileSync(path.join(tmpDir, 'sub', 'nested.js'), 'console.log("hi")');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Content token tests
test('createBrowserToken returns a token string', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
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
  assert.strictEqual(validateToken('nonexistent-token'), null);
});

test('resolveTokenPath serves file within baseDir', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  assert.strictEqual(resolveTokenPath(token, 'index.html'), filePath);
});

test('resolveTokenPath serves nested file', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  assert.strictEqual(resolveTokenPath(token, 'sub/nested.js'), path.join(tmpDir, 'sub', 'nested.js'));
});

test('resolveTokenPath rejects path traversal', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  assert.strictEqual(resolveTokenPath(token, '../../../etc/passwd'), null);
});

test('resolveTokenPath rejects absolute path in relative', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  assert.strictEqual(resolveTokenPath(token, '/etc/passwd'), null);
});

// Scoped auth token tests
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

// Token expiry tests
test('cleanExpiredTokens removes old tokens', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  assert.ok(validateToken(token));
  cleanExpiredTokens(0); // TTL of 0ms = everything expired
  assert.strictEqual(validateToken(token), null);
});

test('cleanExpiredTokens keeps fresh tokens', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  cleanExpiredTokens(24 * 60 * 60 * 1000);
  assert.ok(validateToken(token));
});

// Idempotent token creation
test('createBrowserToken for same path returns existing token', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token1 = createBrowserToken(filePath);
  const token2 = createBrowserToken(filePath);
  assert.strictEqual(token1, token2);
});

// getTokenForPath
test('getTokenForPath returns token for known path', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  assert.strictEqual(getTokenForPath(filePath), token);
});

test('getTokenForPath returns null for unknown path', () => {
  assert.strictEqual(getTokenForPath('/no/such/file'), null);
});
