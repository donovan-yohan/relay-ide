import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalLogFollower,
  parseLogLineCount,
  readLocalLogSnapshot,
  resolveLocalLogPlan,
} from '../server/local-logs.js';

const cleanup: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-logs-'));
  cleanup.push(dir);
  return dir;
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > 1_000) {
        clearInterval(timer);
        reject(new Error('timed out waiting for log follower'));
      }
    }, 10);
  });
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('local Relay logs', () => {
  it('resolves local log files from the config path first', () => {
    const dir = makeTempDir();
    const plan = resolveLocalLogPlan(
      path.join(dir, 'config.json'),
      path.join(dir, 'service-logs')
    );

    expect(plan.logDir).toBe(path.join(dir, 'logs'));
    expect(plan.files).toEqual([
      path.join(dir, 'logs', 'relay-ide.log'),
      path.join(dir, 'logs', 'stdout.log'),
      path.join(dir, 'logs', 'stderr.log'),
      path.join(dir, 'service-logs', 'relay-ide.log'),
      path.join(dir, 'service-logs', 'stdout.log'),
      path.join(dir, 'service-logs', 'stderr.log'),
    ]);
  });

  it('tails the requested number of local log lines', () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'relay-ide.log'),
      ['one', 'two', 'three', 'four'].join('\n') + '\n'
    );

    const snapshot = readLocalLogSnapshot({
      role: 'hub',
      configPath: path.join(dir, 'config.json'),
      lines: 2,
    });

    expect(snapshot.status).toBe('ok');
    expect(snapshot.output).toBe('three\nfour\n');
  });

  it('reports missing local logs without invoking platform log systems', () => {
    const dir = makeTempDir();
    const snapshot = readLocalLogSnapshot({
      role: 'node',
      configPath: path.join(dir, 'config.json'),
      lines: 10,
    });

    expect(snapshot.status).toBe('missing');
    expect(snapshot.message).toContain('No local Relay node log files were found');
    expect(snapshot.message).toContain(path.join(dir, 'logs', 'relay-ide.log'));
    expect(snapshot.message).not.toContain('journalctl');
    expect(snapshot.message).not.toContain('systemctl');
  });

  it('reports empty local log files clearly', () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'relay-ide.log'), '');

    const snapshot = readLocalLogSnapshot({
      role: 'hub',
      configPath: path.join(dir, 'config.json'),
      lines: 10,
    });

    expect(snapshot.status).toBe('empty');
    expect(snapshot.message).toContain('Local Relay hub log files exist but are empty');
  });

  it('parses --lines as a non-negative integer', () => {
    expect(parseLogLineCount(undefined)).toBe(100);
    expect(parseLogLineCount('0')).toBe(0);
    expect(parseLogLineCount('25')).toBe(25);
    expect(() => parseLogLineCount('-1')).toThrow('Invalid --lines value');
    expect(() => parseLogLineCount('abc')).toThrow('Invalid --lines value');
  });

  it('follows appended log lines without requiring systemd or journalctl', async () => {
    const dir = makeTempDir();
    const logFile = path.join(dir, 'relay-ide.log');
    fs.writeFileSync(logFile, 'existing\n');
    let output = '';
    const follower = createLocalLogFollower({
      files: [logFile],
      pollIntervalMs: 20,
      write: (chunk) => {
        output += chunk;
      },
    });

    try {
      fs.appendFileSync(logFile, 'appended\n');
      await waitFor(() => output.includes('appended'));
      expect(output).toBe('appended\n');
    } finally {
      follower.close();
    }
  });
});
