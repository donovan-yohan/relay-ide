import { test, beforeEach, afterEach, expect } from 'vitest';
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
  expect(typeof token === 'string').toBeTruthy();
  expect(token.length > 0).toBeTruthy();
});

test('validateToken returns baseDir for valid token', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  const result = validateToken(token);
  expect(result).toBeTruthy();
  expect(result!.baseDir).toBe(tmpDir);
});

test('validateToken returns null for invalid token', () => {
  expect(validateToken('nonexistent-token')).toBe(null);
});

test('resolveTokenPath serves file within baseDir', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  expect(resolveTokenPath(token, 'index.html')).toBe(filePath);
});

test('resolveTokenPath serves nested file', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  expect(resolveTokenPath(token, 'sub/nested.js')).toBe(
    path.join(tmpDir, 'sub', 'nested.js')
  );
});

test('resolveTokenPath rejects path traversal', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  expect(resolveTokenPath(token, '../../../etc/passwd')).toBe(null);
});

test('resolveTokenPath rejects absolute path in relative', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  expect(resolveTokenPath(token, '/etc/passwd')).toBe(null);
});

// Scoped auth token tests
test('generateScopedToken returns a hex string', () => {
  const token = generateScopedToken();
  expect(/^[a-f0-9]+$/.test(token)).toBeTruthy();
});

test('validateScopedToken returns true for correct token', () => {
  const token = generateScopedToken();
  expect(validateScopedToken(token)).toBe(true);
});

test('validateScopedToken returns false for wrong token', () => {
  generateScopedToken();
  expect(validateScopedToken('wrong-token')).toBe(false);
});

// Token expiry tests
test('cleanExpiredTokens removes old tokens', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  expect(validateToken(token)).toBeTruthy();
  cleanExpiredTokens(0); // TTL of 0ms = everything expired
  expect(validateToken(token)).toBe(null);
});

test('cleanExpiredTokens keeps fresh tokens', () => {
  const token = createBrowserToken(path.join(tmpDir, 'index.html'));
  cleanExpiredTokens(24 * 60 * 60 * 1000);
  expect(validateToken(token)).toBeTruthy();
});

// Idempotent token creation
test('createBrowserToken for same path returns existing token', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token1 = createBrowserToken(filePath);
  const token2 = createBrowserToken(filePath);
  expect(token1).toBe(token2);
});

// getTokenForPath
test('getTokenForPath returns token for known path', () => {
  const filePath = path.join(tmpDir, 'index.html');
  const token = createBrowserToken(filePath);
  expect(getTokenForPath(filePath)).toBe(token);
});

test('getTokenForPath returns null for unknown path', () => {
  expect(getTokenForPath('/no/such/file')).toBe(null);
});
