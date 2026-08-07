import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as sessions from '../server/sessions.js';
import { restoreFromDisk } from '../server/sessions.js';

describe('legacy tmux pending session restore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    for (const session of sessions.list()) {
      try {
        sessions.kill(session.id);
      } catch {
        // ignore cleanup races
      }
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('tombstones legacy tmux records instead of silently restoring as relay-pty', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-legacy-tmux-'));
    const pendingPath = path.join(tmpDir, 'pending-sessions.json');
    fs.writeFileSync(
      pendingPath,
      JSON.stringify({
        version: 7,
        timestamp: new Date().toISOString(),
        reason: 'dev-restart',
        sessions: [
          {
            id: 'legacy-tmux-session',
            type: 'terminal',
            repoPath: '/tmp',
            worktreePath: null,
            cwd: '/tmp',
            repoName: 'test',
            branchName: '',
            displayName: 'legacy tmux session',
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            useTmux: true,
            tmuxSessionName: 'relay-ide-legacy-tmux-session',
            customCommand: '/bin/cat',
          },
        ],
      })
    );

    const restored = await restoreFromDisk(tmpDir);

    expect(restored).toBe(0);
    expect(sessions.get('legacy-tmux-session')).toBeUndefined();
    expect(fs.existsSync(pendingPath)).toBe(false);

    const tombstonePath = path.join(tmpDir, 'unsupported-tmux-sessions.json');
    expect(fs.existsSync(tombstonePath)).toBe(true);
    const tombstone = JSON.parse(fs.readFileSync(tombstonePath, 'utf8')) as {
      sessions: Array<{ id: string; reasonCode: string; message: string }>;
    };
    expect(tombstone.sessions).toHaveLength(1);
    expect(tombstone.sessions[0]).toMatchObject({
      id: 'legacy-tmux-session',
      reasonCode: 'REMOVED_TMUX_BACKEND',
    });
    expect(tombstone.sessions[0]!.message).toContain(
      'removed tmux-compat backend'
    );
  });
});
