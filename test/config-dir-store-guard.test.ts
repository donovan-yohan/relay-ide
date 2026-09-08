import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { initWorkContextStore } from '../server/work-contexts.js';

describe('config-dir store open guard (#1587)', () => {
  it('refuses opening a sibling config-dir store when a live hub.lock exists', () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-config-guard-')
    );
    const sleeper: ChildProcess = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1_000_000)',
    ]);
    try {
      fs.writeFileSync(
        path.join(configDir, 'hub.lock'),
        JSON.stringify(
          {
            pid: sleeper.pid,
            port: 3456,
            host: '127.0.0.1',
            startedAt: new Date().toISOString(),
            hostname: os.hostname(),
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      expect(() => initWorkContextStore(configDir)).toThrow(/hub\.lock/);
    } finally {
      sleeper.kill('SIGKILL');
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
