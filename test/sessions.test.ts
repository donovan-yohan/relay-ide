import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sessions from '../server/sessions.js';
import { resolveTmuxSpawn, generateTmuxSessionName, getTmuxPrefix } from '../server/pty-handler.js';
import { serializeAll, restoreFromDisk } from '../server/sessions.js';
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
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });

  it('create spawns PTY and adds session to registry', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
      cols: 80,
      rows: 24,
    });

    createdIds.push(result.id);

    assert.ok(result.id, 'should have an id');
    assert.strictEqual(result.repoName, 'test-repo');
    assert.strictEqual(result.cwd, '/tmp');
    assert.ok(typeof result.pid === 'number', 'should have a numeric pid');
    assert.ok(result.createdAt, 'should have a createdAt timestamp');
    assert.strictEqual('pty' in result, false, 'should not expose pty object');

    const list = sessions.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.id, result.id);
  });

  it('get returns session by id', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });

    createdIds.push(result.id);

    const session = sessions.get(result.id);
    assert.ok(session, 'should return the session');
    assert.strictEqual(session.id, result.id);
    assert.strictEqual(session.repoName, 'test-repo');
    assert.strictEqual(session.mode, 'pty');
    assert.ok((session as PtySession).pty, 'get should include the pty object');
  });

  it('get returns undefined for nonexistent id', () => {
    const session = sessions.get('nonexistent-id-12345');
    assert.strictEqual(session, undefined);
  });

  it('kill removes session from registry', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
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
    assert.strictEqual(session, undefined, 'session should be removed after kill');

    const list = sessions.list();
    assert.ok(!list.some((s) => s.id === result.id), 'killed session should not appear in list');
  });

  it('kill throws for nonexistent session', () => {
    assert.throws(
      () => sessions.kill('nonexistent-id'),
      /Session not found/,
    );
  });

  it('resize throws for nonexistent session', () => {
    assert.throws(
      () => sessions.resize('nonexistent-id', 100, 40),
      /Session not found/,
    );
  });

  it('write sends data to PTY stdin', (_, done) => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      cols: 80,
      rows: 24,
    });

    createdIds.push(result.id);

    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    const ptySession = session as PtySession;

    let output = '';
    ptySession.pty.onData((data: string) => {
      output += data;
      if (output.includes('hello')) {
        done();
      }
    });

    sessions.write(result.id, 'hello');
  });

  it('write throws for nonexistent session', () => {
    assert.throws(
      () => sessions.write('nonexistent-id', 'data'),
      /Session not found/,
    );
  });

  it('session starts as not idle', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.idle, false);
  });

  it('list includes idle field', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const list = sessions.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.idle, false);
  });

  it('type defaults to agent when not specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    assert.strictEqual(result.type, 'agent');

    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.type, 'agent');
  });

  it('type is set to agent when specified', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    assert.strictEqual(result.type, 'agent');

    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.type, 'agent');
  });

  it('list includes type field', () => {
    const r1 = sessions.create({
      type: 'agent',
      repoName: 'repo-a',
      workspacePath: '/tmp/a',
      worktreePath: null,
      cwd: '/tmp/a',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(r1.id);

    const r2 = sessions.create({
      type: 'agent',
      repoName: 'repo-b',
      workspacePath: '/tmp/b',
      worktreePath: null,
      cwd: '/tmp/b',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(r2.id);

    const list = sessions.list();
    const s1 = list.find(function (s) { return s.id === r1.id; });
    const s2 = list.find(function (s) { return s.id === r2.id; });

    assert.ok(s1);
    assert.strictEqual(s1.type, 'agent');
    assert.ok(s2);
    assert.strictEqual(s2.type, 'agent');
  });

  it('list includes workspacePath, worktreePath, and cwd fields', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      workspacePath: '/tmp/workspace',
      worktreePath: '/tmp/workspace/.worktrees/my-branch',
      cwd: '/tmp/workspace/.worktrees/my-branch',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);

    const list = sessions.list();
    const session = list.find(s => s.id === result.id);
    assert.ok(session);
    assert.strictEqual(session.workspacePath, '/tmp/workspace');
    assert.strictEqual(session.worktreePath, '/tmp/workspace/.worktrees/my-branch');
    assert.strictEqual(session.cwd, '/tmp/workspace/.worktrees/my-branch');
  });

  it('branchName defaults to empty string when branchName is not provided', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    assert.strictEqual(result.branchName, '');
  });

  it('resolveTmuxSpawn returns correct tmux command and args', () => {
    const result = resolveTmuxSpawn('claude', ['--continue'], 'test-session');
    assert.deepStrictEqual(result, {
      command: 'tmux',
      args: [
        '-u', 'new-session', '-s', 'test-session', '--', 'claude', '--continue',
        ';', 'set', 'set-clipboard', 'on',
        ';', 'set', 'allow-passthrough', 'on',
        ';', 'set', 'mode-keys', 'vi',
      ],
    });
  });

  it('generateTmuxSessionName has correct prefix', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const name = generateTmuxSessionName('my-session', 'abcdef1234567890');
      assert.ok(name.startsWith('crc-'), `expected crc- prefix, got: ${name}`);
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('generateTmuxSessionName sanitizes special characters', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const name = generateTmuxSessionName('feat/auth-flow', 'abcdef1234567890');
      assert.ok(name.startsWith('crc-feat-auth-flow-'), `expected sanitized name, got: ${name}`);
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('generateTmuxSessionName limits display name to 30 chars', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const longName = 'a-very-long-display-name-that-exceeds-thirty-characters';
      const id = 'abcdef1234567890';
      const name = generateTmuxSessionName(longName, id);
      // Format is crc-<sanitized up to 30>-<8 char id>
      // The sanitized portion should be at most 30 chars
      const withoutPrefix = name.slice('crc-'.length);
      const parts = withoutPrefix.split('-');
      const idPart = parts[parts.length - 1];
      const displayPart = withoutPrefix.slice(0, withoutPrefix.length - idPart!.length - 1);
      assert.ok(displayPart.length <= 30, `display portion should be <= 30 chars, got: ${displayPart.length}`);
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('generateTmuxSessionName uses 8 chars from the provided id', () => {
    const id = 'abcdef1234567890';
    const name = generateTmuxSessionName('my-session', id);
    assert.ok(name.endsWith(id.slice(0, 8)), `expected name to end with ${id.slice(0, 8)}, got: ${name}`);
  });

  it('prod prefix (crc-) does not match dev prefix (crcd-)', () => {
    const prodPrefix = 'crc-';
    const devPrefix = 'crcd-';
    assert.ok(!devPrefix.startsWith(prodPrefix), `dev prefix '${devPrefix}' must not start with prod prefix '${prodPrefix}'`);
    assert.ok(!prodPrefix.startsWith(devPrefix), `prod prefix '${prodPrefix}' must not start with dev prefix '${devPrefix}'`);
  });

  it('getTmuxPrefix returns crc- when NO_PIN is not set', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      assert.strictEqual(getTmuxPrefix(), 'crc-');
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('getTmuxPrefix returns crcd- when NO_PIN is 1', () => {
    const original = process.env.NO_PIN;
    process.env.NO_PIN = '1';
    try {
      assert.strictEqual(getTmuxPrefix(), 'crcd-');
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
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    assert.strictEqual(result.agent, 'claude');
  });

  it('agent is set when specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'codex',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    assert.strictEqual(result.agent, 'codex');
  });

  it('list includes agent field', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'codex',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    const list = sessions.list();
    const session = list.find(s => s.id === result.id);
    assert.ok(session);
    assert.strictEqual(session.agent, 'codex');
  });

  it('useTmux defaults to false when not specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    assert.strictEqual(result.useTmux, false);
    assert.strictEqual(result.tmuxSessionName, '');
  });

  it('useTmux is disabled when custom command is provided even if useTmux is true', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
      useTmux: true,
    });
    createdIds.push(result.id);
    // Custom command sessions should never use tmux
    assert.strictEqual(result.useTmux, false);
    assert.strictEqual(result.tmuxSessionName, '');
  });

  it('list includes useTmux and tmuxSessionName fields', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    const list = sessions.list();
    const session = list.find(s => s.id === result.id);
    assert.ok(session);
    assert.strictEqual(session.useTmux, false);
    assert.strictEqual(session.tmuxSessionName, '');
  });

  it('calls onPtyReplaced when continue-arg process fails quickly', (_, done) => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/false',
      args: [...sessions.AGENT_CONTINUE_ARGS.claude],
    });
    createdIds.push(result.id);

    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    const ptySession = session as PtySession;

    ptySession.onPtyReplacedCallbacks.push((newPty) => {
      assert.ok(newPty, 'should receive new PTY');
      assert.strictEqual(ptySession.pty, newPty, 'session.pty should be updated to new PTY');
      done();
    });
  });

  it('session survives after continue-arg retry', (_, done) => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/false',
      args: [...sessions.AGENT_CONTINUE_ARGS.claude],
    });
    createdIds.push(result.id);

    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    const ptySession = session as PtySession;

    ptySession.onPtyReplacedCallbacks.push(() => {
      const stillExists = sessions.get(result.id);
      assert.ok(stillExists, 'session should still exist after retry');
      done();
    });
  });

  it('retries when continue-arg process exits quickly with code 0 (tmux behavior)', (_, done) => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'exit 0', ...sessions.AGENT_CONTINUE_ARGS.claude],
    });
    createdIds.push(result.id);

    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    const ptySession = session as PtySession;

    ptySession.onPtyReplacedCallbacks.push((newPty) => {
      assert.ok(newPty, 'should receive new PTY even with exit code 0');
      assert.strictEqual(ptySession.pty, newPty, 'session.pty should be updated');
      const stillExists = sessions.get(result.id);
      assert.ok(stillExists, 'session should still exist after retry');
      done();
    });
  });

  it('create accepts a predetermined id', () => {
    const result = sessions.create({
      id: 'custom-id-12345678',
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);
    assert.strictEqual(result.id, 'custom-id-12345678');
    const session = sessions.get('custom-id-12345678');
    assert.ok(session);
  });

  it('create accepts initialScrollback', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
      initialScrollback: ['prior output\r\n'],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    assert.ok((session as PtySession).scrollback.length >= 1);
    assert.strictEqual((session as PtySession).scrollback[0], 'prior output\r\n');
  });
});

describe('session persistence', () => {
  let tmpDir: string;

  afterEach(() => {
    // Clean up any sessions created during tests
    for (const s of sessions.list()) {
      try { sessions.kill(s.id); } catch { /* ignore */ }
    }
    // Clean up temp directory
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
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
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });

    // Manually push some scrollback
    const session = sessions.get(s.id);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    (session as PtySession).scrollback.push('hello world');

    serializeAll(configDir);

    // Check pending-sessions.json
    const pendingPath = path.join(configDir, 'pending-sessions.json');
    assert.ok(fs.existsSync(pendingPath), 'pending-sessions.json should exist');
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    assert.strictEqual(pending.version, 3);
    assert.ok(pending.timestamp);
    assert.strictEqual(pending.sessions.length, 1);
    assert.strictEqual(pending.sessions[0].id, s.id);
    assert.strictEqual(pending.sessions[0].cwd, '/tmp');
    assert.strictEqual(pending.sessions[0].workspacePath, '/tmp');

    // Check scrollback file
    const scrollbackPath = path.join(configDir, 'scrollback', s.id + '.buf');
    assert.ok(fs.existsSync(scrollbackPath), 'scrollback file should exist');
    const scrollbackData = fs.readFileSync(scrollbackPath, 'utf-8');
    assert.ok(scrollbackData.includes('hello world'));
  });

  it('restoreFromDisk restores sessions with original IDs', async () => {
    const configDir = createTmpDir();

    // Create and serialize a session
    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      displayName: 'my-session',
    });
    const originalId = s.id;

    const session = sessions.get(originalId);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    (session as PtySession).scrollback.push('saved output');

    serializeAll(configDir);

    // Kill the original session
    sessions.kill(originalId);
    assert.strictEqual(sessions.get(originalId), undefined);

    // Restore
    const restored = await restoreFromDisk(configDir);
    assert.strictEqual(restored, 1);

    // Verify session exists with original ID
    const restoredSession = sessions.get(originalId);
    assert.ok(restoredSession, 'restored session should exist');
    assert.strictEqual(restoredSession.cwd, '/tmp');
    assert.strictEqual(restoredSession.workspacePath, '/tmp');
    assert.strictEqual(restoredSession.displayName, 'my-session');

    // Scrollback should be restored
    assert.strictEqual(restoredSession.mode, 'pty');
    assert.ok((restoredSession as PtySession).scrollback.length >= 1);
    assert.strictEqual((restoredSession as PtySession).scrollback[0], 'saved output');

    // pending-sessions.json should be cleaned up
    assert.ok(!fs.existsSync(path.join(configDir, 'pending-sessions.json')));
  });

  it('restoreFromDisk ignores stale files (>5 min old)', async () => {
    const configDir = createTmpDir();

    // Write a stale pending file
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const pending = {
      version: 3,
      timestamp: staleTime,
      sessions: [{ id: 'stale-id', type: 'agent', agent: 'claude', workspacePath: '/tmp', worktreePath: null, cwd: '/tmp', repoName: 'test', branchName: '', displayName: 'test', createdAt: staleTime, lastActivity: staleTime, useTmux: false, tmuxSessionName: '', customCommand: null }],
    };
    fs.writeFileSync(path.join(configDir, 'pending-sessions.json'), JSON.stringify(pending));

    const restored = await restoreFromDisk(configDir);
    assert.strictEqual(restored, 0, 'should not restore stale sessions');
    assert.ok(!fs.existsSync(path.join(configDir, 'pending-sessions.json')), 'stale file should be deleted');
  });

  it('restoreFromDisk handles missing scrollback gracefully', async () => {
    const configDir = createTmpDir();

    // Create a session, serialize, then delete scrollback file
    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    serializeAll(configDir);
    sessions.kill(s.id);

    // Delete scrollback file
    const scrollbackPath = path.join(configDir, 'scrollback', s.id + '.buf');
    try { fs.unlinkSync(scrollbackPath); } catch { /* ignore */ }

    const restored = await restoreFromDisk(configDir);
    assert.strictEqual(restored, 1, 'should still restore without scrollback');
  });

  it('restoreFromDisk returns 0 when no pending file exists', async () => {
    const configDir = createTmpDir();
    const restored = await restoreFromDisk(configDir);
    assert.strictEqual(restored, 0);
  });

  it('restoreFromDisk preserves tmuxSessionName for tmux sessions', async () => {
    const configDir = createTmpDir();

    // Write a pending file with a tmux session
    const pending = {
      version: 3,
      timestamp: new Date().toISOString(),
      sessions: [{
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
      }],
    };
    fs.writeFileSync(path.join(configDir, 'pending-sessions.json'), JSON.stringify(pending));

    const restored = await restoreFromDisk(configDir);
    assert.strictEqual(restored, 1);

    const session = sessions.get('tmux-test-id');
    assert.ok(session, 'restored session should exist');
    assert.strictEqual(session.mode, 'pty');
    assert.strictEqual((session as PtySession).tmuxSessionName, 'crc-my-session-tmux-tes', 'tmuxSessionName should be preserved from serialized data');
  });

  it('restored session remains in list after PTY exits (disconnected status)', async () => {
    const configDir = createTmpDir();

    const pending = {
      version: 3,
      timestamp: new Date().toISOString(),
      sessions: [{
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
      }],
    };
    fs.writeFileSync(path.join(configDir, 'pending-sessions.json'), JSON.stringify(pending));

    await restoreFromDisk(configDir);

    // Wait for PTY to exit
    await new Promise(resolve => setTimeout(resolve, 500));

    // Session should still be in the list with disconnected status
    const list = sessions.list();
    const found = list.find(s => s.id === 'restore-exit-test');
    assert.ok(found, 'restored session should remain in list after PTY exit');
    assert.strictEqual(found.status, 'disconnected');
  });

  it('full serialize-restore round trip preserves all session fields including tmuxSessionName', async () => {
    const configDir = createTmpDir();

    // Create sessions of different types
    const agentSession = sessions.create({
      type: 'agent',
      repoName: 'my-repo',
      workspacePath: '/tmp/repo',
      worktreePath: null,
      cwd: '/tmp/repo',
      command: '/bin/cat',
      args: [],
      displayName: 'My Agent',
    });

    const terminal = sessions.create({
      type: 'terminal',
      workspacePath: '/tmp',
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
    assert.strictEqual(sessions.list().length, 0);

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
    assert.strictEqual(restored, 3);

    // Verify all sessions exist
    const list = sessions.list();
    assert.strictEqual(list.length, 3);

    const restoredAgent = list.find(s => s.id === agentSession.id);
    assert.ok(restoredAgent);
    assert.strictEqual(restoredAgent.type, 'agent');
    assert.strictEqual(restoredAgent.displayName, 'My Agent');
    assert.strictEqual(restoredAgent.status, 'active');

    const restoredTerminal = list.find(s => s.id === terminal.id);
    assert.ok(restoredTerminal);
    assert.strictEqual(restoredTerminal.type, 'terminal');
    assert.strictEqual(restoredTerminal.displayName, 'Terminal 1');

    // Verify tmux session name survived the round trip
    const restoredTmux = sessions.get('tmux-roundtrip-id');
    assert.ok(restoredTmux);
    assert.strictEqual(restoredTmux.mode, 'pty');
    assert.strictEqual((restoredTmux as PtySession).tmuxSessionName, 'crc-tmux-session-tmux-rou');
    assert.strictEqual(restoredTmux.displayName, 'Tmux Session');
  });

  it('serialize/restore preserves yolo flag', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      yolo: true,
    });

    const session = sessions.get(s.id);
    assert.ok(session);
    assert.strictEqual((session as PtySession).yolo, true);

    serializeAll(configDir);
    sessions.kill(s.id);

    // Verify yolo is in the serialized JSON
    const pending = JSON.parse(fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8'));
    assert.strictEqual(pending.version, 3);
    assert.strictEqual(pending.sessions[0].yolo, true);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    assert.ok(restored);
    assert.strictEqual((restored as PtySession).yolo, true);
  });

  it('serialize/restore preserves claudeArgs', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      claudeArgs: ['--model', 'opus', '--verbose'],
    });

    const session = sessions.get(s.id);
    assert.ok(session);
    assert.deepStrictEqual((session as PtySession).claudeArgs, ['--model', 'opus', '--verbose']);

    serializeAll(configDir);
    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    assert.ok(restored);
    assert.deepStrictEqual((restored as PtySession).claudeArgs, ['--model', 'opus', '--verbose']);
  });

  it('serialize/restore preserves hookToken and hooksActive', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });

    // Manually set hookToken and hooksActive (simulating a session that had hooks injected)
    const session = sessions.get(s.id);
    assert.ok(session);
    (session as PtySession).hookToken = 'abc123deadbeef';
    (session as PtySession).hooksActive = true;

    serializeAll(configDir);

    // Verify hookToken is in the serialized JSON
    const pending = JSON.parse(fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8'));
    assert.strictEqual(pending.sessions[0].hookToken, 'abc123deadbeef');
    assert.strictEqual(pending.sessions[0].hooksActive, true);

    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    assert.ok(restored);
    assert.strictEqual((restored as PtySession).hookToken, 'abc123deadbeef');
    assert.strictEqual((restored as PtySession).hooksActive, true);
  });

  it('serialize/restore preserves needsBranchRename and branchRenamePrompt', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      needsBranchRename: true,
      branchRenamePrompt: 'Name this feature branch:',
    });

    const session = sessions.get(s.id);
    assert.ok(session);
    assert.strictEqual(session.needsBranchRename, true);

    serializeAll(configDir);
    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    assert.ok(restored);
    assert.strictEqual(restored.needsBranchRename, true);
    assert.strictEqual((restored as PtySession).branchRenamePrompt, 'Name this feature branch:');
  });

  it('restoreFromDisk handles v1/v2 pending files (v2→v3 migration)', async () => {
    const configDir = createTmpDir();

    // Write a v2 format pending file with old fields: type: 'repo', repoPath, root
    const v2Timestamp = new Date().toISOString();
    const pending = {
      version: 2,
      timestamp: v2Timestamp,
      sessions: [{
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
      }],
    };
    fs.writeFileSync(path.join(configDir, 'pending-sessions.json'), JSON.stringify(pending));

    const restored = await restoreFromDisk(configDir);
    assert.strictEqual(restored, 1);

    const session = sessions.get('v2-migration-test');
    assert.ok(session, 'restored session should exist');
    // type should be migrated from 'repo' to 'agent'
    assert.strictEqual(session.type, 'agent', 'type should be migrated to agent');
    // cwd should equal the old repoPath
    assert.strictEqual(session.cwd, '/tmp/my-repo', 'cwd should be set from old repoPath');
    // workspacePath should be derived from cwd (no configured workspaces, so falls back to cwd)
    assert.strictEqual(session.workspacePath, '/tmp/my-repo', 'workspacePath should be derived');
    // worktreePath should be null since cwd === workspacePath
    assert.strictEqual(session.worktreePath, null, 'worktreePath should be null for main repo sessions');
  });

  it('serializeAll captures session state before kill', () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      displayName: 'before-kill',
    });

    const session = sessions.get(s.id);
    assert.ok(session);
    assert.strictEqual(session.mode, 'pty');
    (session as PtySession).scrollback.push('important output');

    serializeAll(configDir);

    // Kill after serialize (mimics gracefulShutdown sequence)
    sessions.kill(s.id);

    // Verify data is on disk
    const pendingPath = path.join(configDir, 'pending-sessions.json');
    assert.ok(fs.existsSync(pendingPath));
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    assert.strictEqual(pending.sessions.length, 1);
    assert.strictEqual(pending.sessions[0].displayName, 'before-kill');
  });
});
