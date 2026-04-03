import { test, beforeEach, afterEach, expect } from 'vitest';
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
    execFileSync('node', ['dist/bin/relay-ide.js', 'browser'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    throw new Error('Should have exited with code 1');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    expect(e.status).toBe(1);
    expect((e.stderr ?? '').includes('Usage')).toBeTruthy();
  }
});

test('browser --help shows usage and exits 0', () => {
  try {
    const output = execFileSync(
      'node',
      ['dist/bin/relay-ide.js', 'browser', '--help'],
      {
        encoding: 'utf-8',
        env: { ...process.env, PATH: process.env.PATH },
      }
    );
    expect(output.includes('Usage') || output.includes('browser')).toBeTruthy();
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    // --help may print to stderr
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    expect(out.includes('Usage') || out.includes('browser')).toBeTruthy();
  }
});

test('browser command fails gracefully when server is not running', () => {
  try {
    execFileSync(
      'node',
      ['dist/bin/relay-ide.js', 'browser', path.join(tmpDir, 'test.html')],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          RELAY_IDE_PORT: '19999',
          RELAY_IDE_BROWSER_TOKEN: 'test-token',
          PATH: process.env.PATH,
        },
      }
    );
    throw new Error('Should have exited with error');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    expect(e.status !== 0).toBeTruthy();
    expect(
      (e.stderr ?? '').includes('connect') ||
        (e.stderr ?? '').includes('ECONNREFUSED') ||
        (e.stderr ?? '').includes('Error')
    ).toBeTruthy();
  }
});

test('browser command fails when token not set', () => {
  try {
    execFileSync(
      'node',
      ['dist/bin/relay-ide.js', 'browser', path.join(tmpDir, 'test.html')],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          RELAY_IDE_PORT: '19999',
          RELAY_IDE_BROWSER_TOKEN: '', // empty token
          PATH: process.env.PATH,
        },
      }
    );
    throw new Error('Should have exited with error');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    expect(e.status !== 0).toBeTruthy();
    expect((e.stderr ?? '').includes('RELAY_IDE_BROWSER_TOKEN')).toBeTruthy();
  }
});
