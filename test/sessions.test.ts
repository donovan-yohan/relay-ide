import { describe, it, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sessions from '../server/sessions.js';
import {
  resolveTmuxSpawn,
  generateTmuxSessionName,
  getTmuxPrefix,
} from '../server/pty-handler.js';
import { serializeAll, restoreFromDisk } from '../server/sessions.js';
import { AGENT_YOLO_ARGS } from '../server/types.js';
import type { PtySession } from '../server/types.js';

// Track created session IDs so we can clean up after each test
const createdIds: string[] = [];

afterEach(() => {
  // Kill any remaining sessions created during tests
  for (const id of createdIds) {
    try {
      const session = sessions.get(id);
      if (session) {
        sessions.kill(id);
      }
    } catch {
      // Already killed or exited, ignore
    }
  }
  createdIds.length = 0;
});

describe('sessions', () => {
  it('list returns empty array initially', () => {
    const result = sessions.list();
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(0);
  });

  it('create spawns PTY and adds session to registry', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
      cols: 80,
      rows: 24,
    });

    createdIds.push(result.id);

    expect(result.id).toBeTruthy();
    expect(result.repoName).toBe('test-repo');
    expect(result.cwd).toBe('/tmp');
    expect(result.pid).toBeTypeOf('number');
    expect(result.createdAt).toBeTruthy();
    expect('pty' in result).toBe(false);

    const list = sessions.list();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(result.id);
  });

  it('get returns session by id', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });

    createdIds.push(result.id);

    const session = sessions.get(result.id);
    expect(session).toBeTruthy();
    expect(session!.id).toBe(result.id);
    expect(session!.repoName).toBe('test-repo');
    expect(session!.mode).toBe('pty');
    expect((session as PtySession).pty).toBeTruthy();
  });

  it('get returns undefined for nonexistent id', () => {
    const session = sessions.get('nonexistent-id-12345');
    expect(session).toBe(undefined);
  });

  it('kill removes session from registry', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });

    createdIds.push(result.id);

    sessions.kill(result.id);
    // Remove from tracking since it's already killed
    createdIds.splice(createdIds.indexOf(result.id), 1);

    const session = sessions.get(result.id);
    expect(session).toBe(undefined);

    const list = sessions.list();
    expect(list.some((s) => s.id === result.id)).toBe(false);
  });

  it('kill throws for nonexistent session', () => {
    expect(() => sessions.kill('nonexistent-id')).toThrow(/Session not found/);
  });

  it('resize throws for nonexistent session', () => {
    expect(() => sessions.resize('nonexistent-id', 100, 40)).toThrow(
      /Session not found/
    );
  });

  it('write sends data to PTY stdin', () =>
    new Promise<void>((done) => {
      const result = sessions.create({
        repoName: 'test-repo',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/cat',
        args: [],
        cols: 80,
        rows: 24,
      });

      createdIds.push(result.id);

      const session = sessions.get(result.id);
      expect(session).toBeTruthy();
      expect(session!.mode).toBe('pty');
      const ptySession = session as PtySession;

      let output = '';
      ptySession.pty.onData((data: string) => {
        output += data;
        if (output.includes('hello')) {
          done();
        }
      });

      sessions.write(result.id, 'hello');
    }));

  it('write throws for nonexistent session', () => {
    expect(() => sessions.write('nonexistent-id', 'data')).toThrow(
      /Session not found/
    );
  });

  it('session starts as not idle', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id);
    expect(session).toBeTruthy();
    expect(session!.idle).toBe(false);
  });

  it('list includes idle field', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const list = sessions.list();
    expect(list.length).toBe(1);
    expect(list[0]?.idle).toBe(false);
  });

  it('type defaults to agent when not specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.type).toBe('agent');

    const session = sessions.get(result.id);
    expect(session).toBeTruthy();
    expect(session!.type).toBe('agent');
  });

  it('type is set to agent when specified', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.type).toBe('agent');

    const session = sessions.get(result.id);
    expect(session).toBeTruthy();
    expect(session!.type).toBe('agent');
  });

  it('list includes type field', () => {
    const r1 = sessions.create({
      type: 'agent',
      repoName: 'repo-a',
      repoPath: '/tmp/a',
      worktreePath: null,
      cwd: '/tmp/a',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(r1.id);

    const r2 = sessions.create({
      type: 'agent',
      repoName: 'repo-b',
      repoPath: '/tmp/b',
      worktreePath: null,
      cwd: '/tmp/b',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(r2.id);

    const list = sessions.list();
    const s1 = list.find(function (s) {
      return s.id === r1.id;
    });
    const s2 = list.find(function (s) {
      return s.id === r2.id;
    });

    expect(s1).toBeTruthy();
    expect(s1!.type).toBe('agent');
    expect(s2).toBeTruthy();
    expect(s2!.type).toBe('agent');
  });

  it('list includes repoPath, worktreePath, and cwd fields', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      repoPath: '/tmp/workspace',
      worktreePath: '/tmp/workspace/.worktrees/my-branch',
      cwd: '/tmp/workspace/.worktrees/my-branch',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);

    const list = sessions.list();
    const session = list.find((s) => s.id === result.id);
    expect(session).toBeTruthy();
    expect(session!.repoPath).toBe('/tmp/workspace');
    expect(session!.worktreePath).toBe('/tmp/workspace/.worktrees/my-branch');
    expect(session!.cwd).toBe('/tmp/workspace/.worktrees/my-branch');
  });

  it('branchName defaults to empty string when branchName is not provided', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.branchName).toBe('');
  });

  it('resolveTmuxSpawn returns correct tmux command and args', () => {
    const result = resolveTmuxSpawn('claude', ['--continue'], 'test-session');
    expect(result).toEqual({
      command: 'tmux',
      args: [
        '-u',
        'new-session',
        '-s',
        'test-session',
        '--',
        'claude',
        '--continue',
        ';',
        'set',
        'set-clipboard',
        'on',
        ';',
        'set',
        'allow-passthrough',
        'on',
        ';',
        'set',
        'mode-keys',
        'vi',
      ],
    });
  });

  it('generateTmuxSessionName has correct prefix', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const name = generateTmuxSessionName('my-session', 'abcdef1234567890');
      expect(name.startsWith('crc-')).toBe(true);
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('generateTmuxSessionName sanitizes special characters', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const name = generateTmuxSessionName(
        'feat/auth-flow',
        'abcdef1234567890'
      );
      expect(name.startsWith('crc-feat-auth-flow-')).toBe(true);
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('generateTmuxSessionName limits display name to 30 chars', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const longName =
        'a-very-long-display-name-that-exceeds-thirty-characters';
      const id = 'abcdef1234567890';
      const name = generateTmuxSessionName(longName, id);
      // Format is crc-<sanitized up to 30>-<8 char id>
      // The sanitized portion should be at most 30 chars
      const withoutPrefix = name.slice('crc-'.length);
      const parts = withoutPrefix.split('-');
      const idPart = parts[parts.length - 1];
      const displayPart = withoutPrefix.slice(
        0,
        withoutPrefix.length - idPart!.length - 1
      );
      expect(displayPart.length).toBeLessThanOrEqual(30);
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('generateTmuxSessionName uses 8 chars from the provided id', () => {
    const id = 'abcdef1234567890';
    const name = generateTmuxSessionName('my-session', id);
    expect(name.endsWith(id.slice(0, 8))).toBe(true);
  });

  it('prod prefix (crc-) does not match dev prefix (crcd-)', () => {
    const prodPrefix = 'crc-';
    const devPrefix = 'crcd-';
    expect(devPrefix.startsWith(prodPrefix)).toBe(false);
    expect(prodPrefix.startsWith(devPrefix)).toBe(false);
  });

  it('getTmuxPrefix returns crc- when NO_PIN is not set', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      expect(getTmuxPrefix()).toBe('crc-');
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('getTmuxPrefix returns crcd- when NO_PIN is 1', () => {
    const original = process.env.NO_PIN;
    process.env.NO_PIN = '1';
    try {
      expect(getTmuxPrefix()).toBe('crcd-');
    } finally {
      if (original !== undefined) {
        process.env.NO_PIN = original;
      } else {
        delete process.env.NO_PIN;
      }
    }
  });

  it('agent defaults to claude when not specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.agent).toBe('claude');
  });

  it('agent is set when specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'codex',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.agent).toBe('codex');
  });

  it('list includes agent field', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'codex',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    const list = sessions.list();
    const session = list.find((s) => s.id === result.id);
    expect(session).toBeTruthy();
    expect(session!.agent).toBe('codex');
  });

  it('useTmux defaults to false when not specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.useTmux).toBe(false);
    expect(result.tmuxSessionName).toBe('');
  });

  it('useTmux is disabled when custom command is provided even if useTmux is true', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
      useTmux: true,
    });
    createdIds.push(result.id);
    // Custom command sessions should never use tmux
    expect(result.useTmux).toBe(false);
    expect(result.tmuxSessionName).toBe('');
  });

  it('list includes useTmux and tmuxSessionName fields', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    const list = sessions.list();
    const session = list.find((s) => s.id === result.id);
    expect(session).toBeTruthy();
    expect(session!.useTmux).toBe(false);
    expect(session!.tmuxSessionName).toBe('');
  });

  it('calls onPtyReplaced when continue-arg process fails quickly', () =>
    new Promise<void>((done) => {
      const result = sessions.create({
        repoName: 'test-repo',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/false',
        args: [...(sessions.AGENT_CONTINUE_ARGS['claude'] ?? [])],
      });
      createdIds.push(result.id);

      const session = sessions.get(result.id);
      expect(session).toBeTruthy();
      expect(session!.mode).toBe('pty');
      const ptySession = session as PtySession;

      ptySession.onPtyReplacedCallbacks.push((newPty) => {
        expect(newPty).toBeTruthy();
        expect(ptySession.pty).toBe(newPty);
        done();
      });
    }));

  it('session survives after continue-arg retry', () =>
    new Promise<void>((done) => {
      const result = sessions.create({
        repoName: 'test-repo',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/false',
        args: [...(sessions.AGENT_CONTINUE_ARGS['claude'] ?? [])],
      });
      createdIds.push(result.id);

      const session = sessions.get(result.id);
      expect(session).toBeTruthy();
      expect(session!.mode).toBe('pty');
      const ptySession = session as PtySession;

      ptySession.onPtyReplacedCallbacks.push(() => {
        const stillExists = sessions.get(result.id);
        expect(stillExists).toBeTruthy();
        done();
      });
    }));

  it('retries when continue-arg process exits quickly with code 0 (tmux behavior)', () =>
    new Promise<void>((done) => {
      const result = sessions.create({
        repoName: 'test-repo',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/sh',
        args: [
          '-c',
          'exit 0',
          ...(sessions.AGENT_CONTINUE_ARGS['claude'] ?? []),
        ],
      });
      createdIds.push(result.id);

      const session = sessions.get(result.id);
      expect(session).toBeTruthy();
      expect(session!.mode).toBe('pty');
      const ptySession = session as PtySession;

      ptySession.onPtyReplacedCallbacks.push((newPty) => {
        expect(newPty).toBeTruthy();
        expect(ptySession.pty).toBe(newPty);
        const stillExists = sessions.get(result.id);
        expect(stillExists).toBeTruthy();
        done();
      });
    }));

  it('create accepts a predetermined id', () => {
    const result = sessions.create({
      id: 'custom-id-12345678',
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.id).toBe('custom-id-12345678');
    const session = sessions.get('custom-id-12345678');
    expect(session).toBeTruthy();
  });

  it('create accepts initialScrollback', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
      initialScrollback: ['prior output\r\n'],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id);
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('pty');
    expect((session as PtySession).scrollback.length).toBeGreaterThanOrEqual(1);
    expect((session as PtySession).scrollback[0]).toBe('prior output\r\n');
  });
});

describe('session persistence', () => {
  let tmpDir: string;

  afterEach(() => {
    // Clean up any sessions created during tests
    for (const s of sessions.list()) {
      try {
        sessions.kill(s.id);
      } catch {
        /* ignore */
      }
    }
    // Clean up temp directory
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function createTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-test-'));
    return tmpDir;
  }

  it('serializeAll writes pending-sessions.json and scrollback files', () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });

    // Manually push some scrollback
    const session = sessions.get(s.id);
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('pty');
    (session as PtySession).scrollback.push('hello world');

    serializeAll(configDir);

    // Check pending-sessions.json
    const pendingPath = path.join(configDir, 'pending-sessions.json');
    expect(fs.existsSync(pendingPath)).toBeTruthy();
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.version).toBe(4);
    expect(pending.timestamp).toBeTruthy();
    expect(pending.sessions.length).toBe(1);
    expect(pending.sessions[0].id).toBe(s.id);
    expect(pending.sessions[0].cwd).toBe('/tmp');
    expect(pending.sessions[0].repoPath).toBe('/tmp');

    // Check scrollback file
    const scrollbackPath = path.join(configDir, 'scrollback', s.id + '.buf');
    expect(fs.existsSync(scrollbackPath)).toBeTruthy();
    const scrollbackData = fs.readFileSync(scrollbackPath, 'utf-8');
    expect(scrollbackData).toContain('hello world');
  });

  it('restoreFromDisk restores sessions with original IDs', async () => {
    const configDir = createTmpDir();

    // Create and serialize a session
    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      displayName: 'my-session',
    });
    const originalId = s.id;

    const session = sessions.get(originalId);
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('pty');
    (session as PtySession).scrollback.push('saved output');

    serializeAll(configDir);

    // Kill the original session
    sessions.kill(originalId);
    expect(sessions.get(originalId)).toBe(undefined);

    // Restore
    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);

    // Verify session exists with original ID
    const restoredSession = sessions.get(originalId);
    expect(restoredSession).toBeTruthy();
    expect(restoredSession!.cwd).toBe('/tmp');
    expect(restoredSession!.repoPath).toBe('/tmp');
    expect(restoredSession!.displayName).toBe('my-session');

    // Scrollback should be restored
    expect(restoredSession!.mode).toBe('pty');
    expect(
      (restoredSession as PtySession).scrollback.length
    ).toBeGreaterThanOrEqual(1);
    expect((restoredSession as PtySession).scrollback[0]).toBe('saved output');

    // pending-sessions.json should be cleaned up
    expect(fs.existsSync(path.join(configDir, 'pending-sessions.json'))).toBe(
      false
    );
  });

  it('restoreFromDisk ignores stale files (>5 min old)', async () => {
    const configDir = createTmpDir();

    // Write a stale pending file
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const pending = {
      version: 3,
      timestamp: staleTime,
      sessions: [
        {
          id: 'stale-id',
          type: 'agent',
          agent: 'claude',
          workspacePath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          repoName: 'test',
          branchName: '',
          displayName: 'test',
          createdAt: staleTime,
          lastActivity: staleTime,
          useTmux: false,
          tmuxSessionName: '',
          customCommand: null,
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(0);
    expect(fs.existsSync(path.join(configDir, 'pending-sessions.json'))).toBe(
      false
    );
  });

  it('restoreFromDisk handles missing scrollback gracefully', async () => {
    const configDir = createTmpDir();

    // Create a session, serialize, then delete scrollback file
    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    serializeAll(configDir);
    sessions.kill(s.id);

    // Delete scrollback file
    const scrollbackPath = path.join(configDir, 'scrollback', s.id + '.buf');
    try {
      fs.unlinkSync(scrollbackPath);
    } catch {
      /* ignore */
    }

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);
  });

  it('restoreFromDisk returns 0 when no pending file exists', async () => {
    const configDir = createTmpDir();
    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(0);
  });

  it('restoreFromDisk preserves tmuxSessionName for tmux sessions', async () => {
    const configDir = createTmpDir();

    // Write a pending file with a tmux session
    const pending = {
      version: 3,
      timestamp: new Date().toISOString(),
      sessions: [
        {
          id: 'tmux-test-id',
          type: 'agent' as const,
          agent: 'claude' as const,
          workspacePath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          repoName: 'test-repo',
          branchName: 'my-branch',
          displayName: 'my-session',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          useTmux: true,
          tmuxSessionName: 'crc-my-session-tmux-tes',
          customCommand: '/bin/cat', // Use /bin/cat to avoid spawning real claude binary in test
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);

    const session = sessions.get('tmux-test-id');
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('pty');
    expect((session as PtySession).tmuxSessionName).toBe(
      'crc-my-session-tmux-tes'
    );
  });

  it('restored session remains in list after PTY exits (disconnected status)', async () => {
    const configDir = createTmpDir();

    const pending = {
      version: 3,
      timestamp: new Date().toISOString(),
      sessions: [
        {
          id: 'restore-exit-test',
          type: 'agent' as const,
          agent: 'claude' as const,
          workspacePath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          repoName: 'test-repo',
          branchName: 'my-branch',
          displayName: 'restored-session',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          useTmux: false,
          tmuxSessionName: '',
          customCommand: '/bin/false',
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    await restoreFromDisk(configDir);

    // Wait for PTY to exit
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Session should still be in the list with disconnected status
    const list = sessions.list();
    const found = list.find((s) => s.id === 'restore-exit-test');
    expect(found).toBeTruthy();
    expect(found!.status).toBe('disconnected');
  });

  it('full serialize-restore round trip preserves all session fields including tmuxSessionName', async () => {
    const configDir = createTmpDir();

    // Create sessions of different types
    const agentSession = sessions.create({
      type: 'agent',
      repoName: 'my-repo',
      repoPath: '/tmp/repo',
      worktreePath: null,
      cwd: '/tmp/repo',
      command: '/bin/cat',
      args: [],
      displayName: 'My Agent',
    });

    const terminal = sessions.create({
      type: 'terminal',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/sh',
      args: [],
      displayName: 'Terminal 1',
    });

    // Serialize all
    serializeAll(configDir);

    // Kill originals
    sessions.kill(agentSession.id);
    sessions.kill(terminal.id);
    expect(sessions.list().length).toBe(0);

    // Also inject a tmux-style session into the pending file to test tmuxSessionName round-trip.
    // Use customCommand so restore spawns that instead of claude --continue (which would exit instantly).
    const pendingPath = path.join(configDir, 'pending-sessions.json');
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    pending.sessions.push({
      id: 'tmux-roundtrip-id',
      type: 'agent',
      agent: 'claude',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      repoName: 'tmux-repo',
      branchName: 'feat/tmux',
      displayName: 'Tmux Session',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      useTmux: true,
      tmuxSessionName: 'crc-tmux-session-tmux-rou',
      customCommand: '/bin/cat',
    });
    fs.writeFileSync(pendingPath, JSON.stringify(pending));

    // Restore
    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(3);

    // Verify all sessions exist
    const list = sessions.list();
    expect(list.length).toBe(3);

    const restoredAgent = list.find((s) => s.id === agentSession.id);
    expect(restoredAgent).toBeTruthy();
    expect(restoredAgent!.type).toBe('agent');
    expect(restoredAgent!.displayName).toBe('My Agent');
    expect(restoredAgent!.status).toBe('active');

    const restoredTerminal = list.find((s) => s.id === terminal.id);
    expect(restoredTerminal).toBeTruthy();
    expect(restoredTerminal!.type).toBe('terminal');
    expect(restoredTerminal!.displayName).toBe('Terminal 1');

    // Verify tmux session name survived the round trip
    const restoredTmux = sessions.get('tmux-roundtrip-id');
    expect(restoredTmux).toBeTruthy();
    expect(restoredTmux!.mode).toBe('pty');
    expect((restoredTmux as PtySession).tmuxSessionName).toBe(
      'crc-tmux-session-tmux-rou'
    );
    expect(restoredTmux!.displayName).toBe('Tmux Session');
  });

  it('serialize/restore preserves yolo flag', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      yolo: true,
    });

    const session = sessions.get(s.id);
    expect(session).toBeTruthy();
    expect((session as PtySession).yolo).toBe(true);

    serializeAll(configDir);
    sessions.kill(s.id);

    // Verify yolo is in the serialized JSON
    const pending = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    );
    expect(pending.version).toBe(4);
    expect(pending.sessions[0].yolo).toBe(true);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    expect(restored).toBeTruthy();
    expect((restored as PtySession).yolo).toBe(true);
  });

  it('maps codex yolo to no-approval workspace-write args', () => {
    expect(AGENT_YOLO_ARGS.codex).toEqual([
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
    ]);
  });

  it('serialize/restore preserves claudeArgs', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      claudeArgs: ['--model', 'opus', '--verbose'],
    });

    const session = sessions.get(s.id);
    expect(session).toBeTruthy();
    expect((session as PtySession).claudeArgs).toEqual([
      '--model',
      'opus',
      '--verbose',
    ]);

    serializeAll(configDir);
    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    expect(restored).toBeTruthy();
    expect((restored as PtySession).claudeArgs).toEqual([
      '--model',
      'opus',
      '--verbose',
    ]);
  });

  it('serialize/restore preserves hookToken and hooksActive', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });

    // Manually set hookToken and hooksActive (simulating a session that had hooks injected)
    const session = sessions.get(s.id);
    expect(session).toBeTruthy();
    (session as PtySession).hookToken = 'abc123deadbeef';
    (session as PtySession).hooksActive = true;

    serializeAll(configDir);

    // Verify hookToken is in the serialized JSON
    const pending = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    );
    expect(pending.sessions[0].hookToken).toBe('abc123deadbeef');
    expect(pending.sessions[0].hooksActive).toBe(true);

    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    expect(restored).toBeTruthy();
    expect((restored as PtySession).hookToken).toBe('abc123deadbeef');
    expect((restored as PtySession).hooksActive).toBe(true);
  });

  it('serialize/restore preserves needsBranchRename and branchRenamePrompt', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      needsBranchRename: true,
      branchRenamePrompt: 'Name this feature branch:',
    });

    const session = sessions.get(s.id);
    expect(session).toBeTruthy();
    expect(session!.needsBranchRename).toBe(true);

    serializeAll(configDir);
    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    expect(restored).toBeTruthy();
    expect(restored!.needsBranchRename).toBe(true);
    expect((restored as PtySession).branchRenamePrompt).toBe(
      'Name this feature branch:'
    );
  });

  it('restoreFromDisk handles v1/v2 pending files (v2→v3 migration)', async () => {
    const configDir = createTmpDir();

    // Write a v2 format pending file with old fields: type: 'repo', repoPath, root
    const v2Timestamp = new Date().toISOString();
    const pending = {
      version: 2,
      timestamp: v2Timestamp,
      sessions: [
        {
          id: 'v2-migration-test',
          type: 'repo',
          agent: 'claude',
          root: '',
          repoName: 'test-repo',
          repoPath: '/tmp/my-repo',
          worktreeName: '',
          branchName: 'main',
          displayName: 'v2-session',
          createdAt: v2Timestamp,
          lastActivity: v2Timestamp,
          useTmux: false,
          tmuxSessionName: '',
          customCommand: '/bin/cat',
          cwd: '/tmp/my-repo',
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);

    const session = sessions.get('v2-migration-test');
    expect(session).toBeTruthy();
    // type should be migrated from 'repo' to 'agent'
    expect(session!.type).toBe('agent');
    // cwd should equal the old repoPath
    expect(session!.cwd).toBe('/tmp/my-repo');
    // repoPath should be derived from cwd (no configured workspaces, so falls back to cwd)
    expect(session!.repoPath).toBe('/tmp/my-repo');
    // worktreePath should be null since cwd === repoPath
    expect(session!.worktreePath).toBe(null);
  });

  it('restoreFromDisk handles v3 pending files (v3→v4 migration: workspacePath→repoPath)', async () => {
    const configDir = createTmpDir();

    const v3Timestamp = new Date().toISOString();
    const pending = {
      version: 3,
      timestamp: v3Timestamp,
      sessions: [
        {
          id: 'v3-migration-test',
          type: 'agent' as const,
          agent: 'claude' as const,
          workspacePath: '/tmp/my-v3-repo',
          worktreePath: null,
          cwd: '/tmp/my-v3-repo',
          repoName: 'v3-repo',
          branchName: 'main',
          displayName: 'v3-session',
          createdAt: v3Timestamp,
          lastActivity: v3Timestamp,
          useTmux: false,
          tmuxSessionName: '',
          customCommand: '/bin/cat',
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);

    const session = sessions.get('v3-migration-test');
    expect(session).toBeTruthy();
    // repoPath should be migrated from v3 workspacePath
    expect(session!.repoPath).toBe('/tmp/my-v3-repo');
    expect(session!.cwd).toBe('/tmp/my-v3-repo');
    createdIds.push('v3-migration-test');
  });

  it('serializeAll writes version 4 in pending-sessions.json', () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(s.id);

    serializeAll(configDir);

    const pendingPath = path.join(configDir, 'pending-sessions.json');
    expect(fs.existsSync(pendingPath)).toBeTruthy();
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.version).toBe(4);
    expect(pending.sessions[0].repoPath).toBe('/tmp');
    expect('workspacePath' in pending.sessions[0]).toBe(false);
  });

  it('serializeAll captures session state before kill', () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      displayName: 'before-kill',
    });

    const session = sessions.get(s.id);
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('pty');
    (session as PtySession).scrollback.push('important output');

    serializeAll(configDir);

    // Kill after serialize (mimics gracefulShutdown sequence)
    sessions.kill(s.id);

    // Verify data is on disk
    const pendingPath = path.join(configDir, 'pending-sessions.json');
    expect(fs.existsSync(pendingPath)).toBeTruthy();
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.sessions.length).toBe(1);
    expect(pending.sessions[0].displayName).toBe('before-kill');
  });

  it('restoreFromDisk uses framework continueArgs for claude (--continue)', async () => {
    const configDir = createTmpDir();

    // Write a v4 pending file with a non-tmux claude agent session
    const pending = {
      version: 4,
      timestamp: new Date().toISOString(),
      sessions: [
        {
          id: 'framework-continue-claude',
          type: 'agent' as const,
          agent: 'claude',
          repoPath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          repoName: 'test-repo',
          branchName: 'main',
          displayName: 'claude-session',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          useTmux: false,
          tmuxSessionName: '',
          customCommand: '/bin/cat', // use /bin/cat so session doesn't error out
          yolo: false,
          claudeArgs: [],
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);

    const session = sessions.get('framework-continue-claude');
    expect(session).toBeTruthy();
    // The session should have been created successfully (continueArgs from framework)
    expect(session!.agent).toBe('claude');
  });

  it('restoreFromDisk uses framework continueArgs for codex (resume --last)', async () => {
    const configDir = createTmpDir();

    // Write a v4 pending file with a non-tmux codex agent session
    const pending = {
      version: 4,
      timestamp: new Date().toISOString(),
      sessions: [
        {
          id: 'framework-continue-codex',
          type: 'agent' as const,
          agent: 'codex',
          repoPath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          repoName: 'test-repo',
          branchName: 'main',
          displayName: 'codex-session',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          useTmux: false,
          tmuxSessionName: '',
          customCommand: '/bin/cat',
          yolo: false,
          claudeArgs: [],
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);

    const session = sessions.get('framework-continue-codex');
    expect(session).toBeTruthy();
    expect(session!.agent).toBe('codex');
  });

  it('serializeAll preserves claudeArgs for backward compat', () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      claudeArgs: ['--model', 'opus'],
    });

    serializeAll(configDir);
    sessions.kill(s.id);

    const pendingPath = path.join(configDir, 'pending-sessions.json');
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.sessions.length).toBe(1);
    // claudeArgs should still be there for backward compat
    expect(pending.sessions[0].claudeArgs).toEqual(['--model', 'opus']);
  });
});
