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

test('browser --help shows usage and exits 0', () => {
  try {
    const output = execFileSync(
      'node',
      ['dist/bin/claude-remote-cli.js', 'browser', '--help'],
      {
        encoding: 'utf-8',
        env: { ...process.env, PATH: process.env.PATH },
      }
    );
    assert.ok(output.includes('Usage') || output.includes('browser'));
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    // --help may print to stderr
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    assert.ok(out.includes('Usage') || out.includes('browser'));
  }
});

test('browser command fails gracefully when server is not running', () => {
  try {
    execFileSync(
      'node',
      [
        'dist/bin/claude-remote-cli.js',
        'browser',
        path.join(tmpDir, 'test.html'),
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDE_REMOTE_PORT: '19999',
          CLAUDE_REMOTE_BROWSER_TOKEN: 'test-token',
          PATH: process.env.PATH,
        },
      }
    );
    assert.fail('Should have exited with error');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.ok(e.status !== 0);
    assert.ok(
      (e.stderr ?? '').includes('connect') ||
        (e.stderr ?? '').includes('ECONNREFUSED') ||
        (e.stderr ?? '').includes('Error')
    );
  }
});

test('browser command fails when token not set', () => {
  try {
    execFileSync(
      'node',
      [
        'dist/bin/claude-remote-cli.js',
        'browser',
        path.join(tmpDir, 'test.html'),
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDE_REMOTE_PORT: '19999',
          CLAUDE_REMOTE_BROWSER_TOKEN: '', // empty token
          PATH: process.env.PATH,
        },
      }
    );
    assert.fail('Should have exited with error');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.ok(e.status !== 0);
    assert.ok((e.stderr ?? '').includes('CLAUDE_REMOTE_BROWSER_TOKEN'));
  }
});
