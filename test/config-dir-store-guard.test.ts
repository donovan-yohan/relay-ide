import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { initAgentProfileStore } from '../server/agent-profile-store.js';
import { initScopedActorCredentialStore } from '../server/scoped-actor-credential-store.js';
import { initWorkContextStore } from '../server/work-contexts.js';
import { initWorkspaceTopicStore } from '../server/workspace-topics.js';

const GUARDED_INITS: Array<{
  name: string;
  open: (configDir: string) => void;
}> = [
  { name: 'work-contexts', open: (dir) => initWorkContextStore(dir) },
  { name: 'agent-profiles', open: (dir) => initAgentProfileStore(dir) },
  { name: 'workspace-topics', open: (dir) => initWorkspaceTopicStore(dir) },
  {
    name: 'scoped-actor-credentials',
    open: (dir) => initScopedActorCredentialStore(dir),
  },
];

describe('config-dir store open guard (#1587)', () => {
  it.each(GUARDED_INITS)(
    'refuses opening $name when a live hub.lock exists',
    ({ open }) => {
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
        expect(() => open(configDir)).toThrow(/hub\.lock/);
      } finally {
        sleeper.kill('SIGKILL');
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    }
  );
});
