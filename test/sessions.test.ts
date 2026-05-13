import {
  describe,
  it,
  afterAll,
  afterEach,
  beforeAll,
  expect,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as sessions from '../server/sessions.js';
import {
  resolveTmuxSpawn,
  resolveTmuxWrappedSpawn,
  generateTmuxSessionName,
  getTmuxPrefix,
} from '../server/pty-handler.js';
import { serializeAll, restoreFromDisk } from '../server/sessions.js';
import { AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS } from '../server/types.js';
import type { PtySession } from '../server/types.js';

// Track created session IDs so we can clean up after each test
const createdIds: string[] = [];
const execFileAsync = promisify(execFile);
const originalTmuxTmpdir = process.env.TMUX_TMPDIR;
let tmuxTmpdir: string;

// Tmux tests run in a full-suite worker pool while other files also mutate
// process.env.TMUX_TMPDIR. Pin every tmux CLI assertion/cleanup to this file's
// socket dir so another test file cannot accidentally kill or query our server.
function tmuxCommandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TMUX_TMPDIR: tmuxTmpdir };
}

function execTmux(args: string[]) {
  return execFileAsync('tmux', args, { env: tmuxCommandEnv() });
}

beforeAll(() => {
  tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-tmux-'));
  process.env.TMUX_TMPDIR = tmuxTmpdir;
});

afterAll(async () => {
  await execTmux(['kill-server']).catch(() => {});
  if (originalTmuxTmpdir === undefined) {
    delete process.env.TMUX_TMPDIR;
  } else {
    process.env.TMUX_TMPDIR = originalTmuxTmpdir;
  }
  fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTmuxSession(name: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await execTmux(['has-session', '-t', name]);
      return;
    } catch {
      await delay(50);
    }
  }
  await execTmux(['has-session', '-t', name]);
}

async function waitForSessionRemoval(id: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (!sessions.get(id)) return;
    await delay(50);
  }
  expect(sessions.get(id)).toBeUndefined();
}

afterEach(() => {
  // Kill any remaining sessions created during tests. Some restore tests add
  // sessions directly from disk, so cleanup must inspect the live registry too.
  const ids = new Set([
    ...createdIds,
    ...sessions.list().map((session) => session.id),
  ]);
  for (const id of ids) {
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

  it('does not synthesize repo instance identity without repoPath', () => {
    const result = sessions.create({
      repoName: 'shell-only',
      repoPath: '',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hello'],
      cols: 80,
      rows: 24,
    });

    createdIds.push(result.id);

    expect(result.nodeId).toBe('local');
    expect(result.globalSessionId).toBe(`local:${result.id}`);
    expect(result.repoInstanceId).toBeUndefined();
    expect(result.worktreeInstanceId).toBeUndefined();

    const listed = sessions.list().find((session) => session.id === result.id);
    expect(listed).toBeDefined();
    expect(listed?.globalSessionId).toBe(`local:${result.id}`);
    expect(listed?.repoInstanceId).toBeUndefined();
    expect(listed?.worktreeInstanceId).toBeUndefined();
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

  it('resolveTmuxSpawn propagates valid environment variables into tmux', () => {
    const result = resolveTmuxSpawn(
      'node',
      ['-e', 'console.log(process.env.RELAY_IDE_TOKEN)'],
      'test-session',
      {
        RELAY_IDE_TOKEN: 'abc123',
        OPENCODE_CONFIG_CONTENT: '{"permission":{"read":"allow"}}',
        GITHUB_TOKEN: 'must-not-cross-tmux-argv',
        'bad-env-name': 'ignored',
        EMPTY_VALUE: undefined,
      }
    );

    expect(result.args).toContain('-e');
    expect(result.args).toContain('RELAY_IDE_TOKEN=abc123');
    expect(result.args).toContain(
      'OPENCODE_CONFIG_CONTENT={"permission":{"read":"allow"}}'
    );
    expect(result.args).not.toContain('bad-env-name=ignored');
    expect(result.args).not.toContain('EMPTY_VALUE=undefined');
    expect(result.args).not.toContain('GITHUB_TOKEN=must-not-cross-tmux-argv');
    expect(result.args.indexOf('RELAY_IDE_TOKEN=abc123')).toBeLessThan(
      result.args.indexOf('-s')
    );
  });

  it('resolveTmuxWrappedSpawn keeps inherited secrets in the child wrapper, not tmux argv', () => {
    const secret = 'relay-secret-token-for-tmux-test';
    const result = resolveTmuxWrappedSpawn(
      'tmux-wrapper-env-test',
      'node',
      ['-e', 'console.log(process.env.GITHUB_TOKEN)'],
      'test-session',
      {
        GITHUB_TOKEN: secret,
        RELAY_IDE_TOKEN: 'relay-token',
        SAFE_ENV: 'safe-value',
        'bad-env-name': 'ignored',
        EMPTY_VALUE: undefined,
      }
    );

    try {
      const argv = result.args.join('\0');
      expect(argv).not.toContain(secret);
      expect(argv).not.toContain('GITHUB_TOKEN=');
      expect(argv).not.toContain('RELAY_IDE_TOKEN=relay-token');
      expect(argv).toContain(result.wrapperPath);

      const wrapper = fs.readFileSync(result.wrapperPath, 'utf8');
      expect(wrapper).toContain(`export GITHUB_TOKEN='${secret}'`);
      expect(wrapper).toContain("export RELAY_IDE_TOKEN='relay-token'");
      expect(wrapper).toContain("export SAFE_ENV='safe-value'");
      expect(wrapper).not.toContain('bad-env-name');
      expect(wrapper).not.toContain('EMPTY_VALUE');
      expect(fs.statSync(result.wrapperPath).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(path.dirname(result.wrapperPath), {
        recursive: true,
        force: true,
      });
    }
  });

  it('generateTmuxSessionName has correct prefix', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const name = generateTmuxSessionName('my-session', 'abcdef1234567890');
      expect(name.startsWith('relay-ide-')).toBe(true);
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
      expect(name.startsWith('relay-ide-feat-auth-flow-')).toBe(true);
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
      // Format is relay-ide-<sanitized up to 30>-<8 char id>
      // The sanitized portion should be at most 30 chars
      const withoutPrefix = name.slice('relay-ide-'.length);
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

  it('prod prefix (relay-ide-) does not match dev prefix (relay-dev-)', () => {
    const prodPrefix = 'relay-ide-';
    const devPrefix = 'relay-dev-';
    expect(devPrefix.startsWith(prodPrefix)).toBe(false);
    expect(prodPrefix.startsWith(devPrefix)).toBe(false);
  });

  it('getTmuxPrefix returns relay-ide- when NO_PIN is not set', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      expect(getTmuxPrefix()).toBe('relay-ide-');
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('getTmuxPrefix returns relay-dev- when NO_PIN is 1', () => {
    const original = process.env.NO_PIN;
    process.env.NO_PIN = '1';
    try {
      expect(getTmuxPrefix()).toBe('relay-dev-');
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

  it('useTmux defaults to true when not specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    expect(result.useTmux).toBe(true);
    expect(result.tmuxSessionName).toMatch(/^relay-(ide|dev)-test-repo-/);
  });

  it('useTmux cannot be disabled by custom command sessions or useTmux:false', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      useTmux: false,
    });
    createdIds.push(result.id);
    expect(result.useTmux).toBe(true);
    expect(result.tmuxSessionName).toMatch(/^relay-(ide|dev)-test-repo-/);
  });

  it('list includes useTmux and tmuxSessionName fields', () => {
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
    const session = list.find((s) => s.id === result.id);
    expect(session).toBeTruthy();
    expect(session!.useTmux).toBe(true);
    expect(session!.tmuxSessionName).toMatch(/^relay-(ide|dev)-test-repo-/);
  });

  it('exposes targeted tmux send and capture helpers', async () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-i'],
    });
    createdIds.push(result.id);
    await waitForTmuxSession(result.tmuxSessionName!);

    await sessions.sendTmuxText(result.id, 'printf TMUX_TARGET_READY');
    await sessions.sendTmuxKeys(result.id, ['Enter']);

    let captured = '';
    for (let i = 0; i < 20; i++) {
      captured = await sessions.captureTmuxPane(result.id);
      if (captured.includes('TMUX_TARGET_READY')) break;
      await delay(50);
    }
    expect(captured).toContain('TMUX_TARGET_READY');
  });

  it('detachForRestart leaves the tmux session alive for restore adoption', async () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-i'],
    });
    const tmuxSessionName = result.tmuxSessionName!;
    const runtimeDir = path.join(os.tmpdir(), 'relay-ide', result.id);
    const sentinelPath = path.join(runtimeDir, 'restart-detach-sentinel');
    createdIds.push(result.id);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(sentinelPath, 'keep');

    try {
      await waitForTmuxSession(tmuxSessionName);

      sessions.detachForRestart(result.id);
      await waitForSessionRemoval(result.id);

      await expect(
        execTmux(['has-session', '-t', tmuxSessionName])
      ).resolves.toBeTruthy();
      expect(fs.existsSync(sentinelPath)).toBe(true);
    } finally {
      await execTmux(['kill-session', '-t', tmuxSessionName]).catch(() => {});
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('calls onPtyReplaced when continue-arg process fails quickly', () =>
    new Promise<void>((done) => {
      const result = sessions.create({
        repoName: 'test-repo',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/false',
        args: [...(AGENT_CONTINUE_ARGS['claude'] ?? [])],
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
        args: [...(AGENT_CONTINUE_ARGS['claude'] ?? [])],
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
        args: ['-c', 'exit 0', ...(AGENT_CONTINUE_ARGS['claude'] ?? [])],
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-test-'));
    return tmpDir;
  }

  function pendingPtySession(
    id: string,
    overrides: Record<string, unknown> = {}
  ) {
    const timestamp = new Date().toISOString();
    return {
      id,
      type: 'agent' as const,
      agent: 'claude' as const,
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      repoName: 'test',
      branchName: '',
      displayName: id,
      createdAt: timestamp,
      lastActivity: timestamp,
      useTmux: true,
      tmuxSessionName: `relay-ide-${id}`,
      customCommand: '/bin/cat',
      ...overrides,
    };
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

    serializeAll(configDir, { reason: 'dev-restart' });

    // Check pending-sessions.json
    const pendingPath = path.join(configDir, 'pending-sessions.json');
    expect(fs.existsSync(pendingPath)).toBeTruthy();
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.version).toBe(6);
    expect(pending.reason).toBe('dev-restart');
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

  it('serializeAll prunes scrollback files that are not in the new manifest', () => {
    const configDir = createTmpDir();
    const scrollbackDir = path.join(configDir, 'scrollback');
    fs.mkdirSync(scrollbackDir, { recursive: true });
    const orphanPath = path.join(scrollbackDir, 'orphan.buf');
    fs.writeFileSync(orphanPath, 'stale output');

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    const session = sessions.get(s.id);
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('pty');
    (session as PtySession).scrollback.push('current output');

    serializeAll(configDir, { reason: 'dev-restart' });

    expect(fs.existsSync(path.join(scrollbackDir, `${s.id}.buf`))).toBe(true);
    expect(fs.existsSync(orphanPath)).toBe(false);
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
    fs.mkdirSync(path.join(configDir, 'scrollback'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'scrollback', 'stale-id.buf'),
      'stale'
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(0);
    expect(fs.existsSync(path.join(configDir, 'pending-sessions.json'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(configDir, 'scrollback'))).toBe(false);
  });

  it('restoreFromDisk removes malformed timestamp pending files and scrollback', async () => {
    const configDir = createTmpDir();
    const pending = {
      version: 6,
      timestamp: 'not-a-date',
      reason: 'dev-restart',
      sessions: [
        {
          id: 'bad-timestamp-id',
          type: 'agent' as const,
          agent: 'claude' as const,
          repoPath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          repoName: 'test',
          branchName: '',
          displayName: 'bad timestamp',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          useTmux: true,
          tmuxSessionName: 'relay-ide-bad-timestamp',
          customCommand: '/bin/cat',
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );
    const scrollbackDir = path.join(configDir, 'scrollback');
    fs.mkdirSync(scrollbackDir, { recursive: true });
    fs.writeFileSync(path.join(scrollbackDir, 'bad-timestamp-id.buf'), 'stale');

    const restored = await restoreFromDisk(configDir);

    expect(restored).toBe(0);
    expect(fs.existsSync(path.join(configDir, 'pending-sessions.json'))).toBe(
      false
    );
    expect(fs.existsSync(scrollbackDir)).toBe(false);
  });

  it('restoreFromDisk removes orphan scrollback when no pending manifest exists', async () => {
    const configDir = createTmpDir();
    const scrollbackDir = path.join(configDir, 'scrollback');
    fs.mkdirSync(scrollbackDir, { recursive: true });
    fs.writeFileSync(path.join(scrollbackDir, 'orphan.buf'), 'old output');

    const restored = await restoreFromDisk(configDir);

    expect(restored).toBe(0);
    expect(fs.existsSync(scrollbackDir)).toBe(false);
  });

  it('restoreFromDisk keeps failed restore records and scrollback for a retry', async () => {
    const configDir = createTmpDir();
    const timestamp = new Date().toISOString();
    const pending = {
      version: 6,
      reason: 'dev-restart',
      timestamp,
      sessions: [
        {
          id: 'restore-failure-kept',
          type: 'agent' as const,
          agent: 'claude' as const,
          repoPath: '/tmp',
          worktreePath: null,
          cwd: path.join(configDir, 'missing-cwd'),
          repoName: 'test',
          branchName: '',
          displayName: 'retry-me',
          createdAt: timestamp,
          lastActivity: timestamp,
          useTmux: true,
          tmuxSessionName: 'relay-ide-retry-me-failure',
          customCommand: '/bin/cat',
          hookToken: 'keep-token',
          hooksActive: true,
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );
    const scrollbackDir = path.join(configDir, 'scrollback');
    fs.mkdirSync(scrollbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(scrollbackDir, 'restore-failure-kept.buf'),
      'important output'
    );

    const restored = await restoreFromDisk(configDir);

    expect(restored).toBe(0);
    const retryPending = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    );
    expect(retryPending.sessions).toHaveLength(1);
    expect(retryPending.timestamp).toBe(timestamp);
    expect(retryPending.sessions[0].id).toBe('restore-failure-kept');
    expect(retryPending.sessions[0].hookToken).toBe('keep-token');
    expect(
      fs.readFileSync(
        path.join(scrollbackDir, 'restore-failure-kept.buf'),
        'utf-8'
      )
    ).toBe('important output');
  });

  it('serializeAll preserves failed restore records across the next clean restart', async () => {
    const configDir = createTmpDir();
    const timestamp = new Date().toISOString();
    const pending = {
      version: 6,
      reason: 'dev-restart',
      timestamp,
      sessions: [
        pendingPtySession('restore-ok', {
          displayName: 'restores cleanly',
          tmuxSessionName: 'relay-ide-restores-cleanly',
        }),
        pendingPtySession('restore-fails', {
          cwd: path.join(configDir, 'missing-cwd'),
          displayName: 'fails transiently',
          tmuxSessionName: 'relay-ide-fails-transiently',
          hookToken: 'failed-token',
        }),
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );
    const scrollbackDir = path.join(configDir, 'scrollback');
    fs.mkdirSync(scrollbackDir, { recursive: true });
    fs.writeFileSync(path.join(scrollbackDir, 'restore-ok.buf'), 'a output');
    fs.writeFileSync(path.join(scrollbackDir, 'restore-fails.buf'), 'b output');

    const restored = await restoreFromDisk(configDir);

    expect(restored).toBe(1);
    expect(sessions.get('restore-ok')).toBeTruthy();
    const failedOnlyPending = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    );
    expect(failedOnlyPending.sessions.map((s: { id: string }) => s.id)).toEqual(
      ['restore-fails']
    );
    expect(failedOnlyPending.timestamp).toBe(timestamp);

    serializeAll(configDir, { reason: 'dev-restart' });

    const retryPending = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    );
    const retrySessions = retryPending.sessions as Array<{
      id: string;
      hookToken?: string;
      pendingSince?: string;
    }>;
    expect(retryPending.timestamp).toBeTruthy();
    expect(retrySessions.map((s) => s.id).sort()).toEqual([
      'restore-fails',
      'restore-ok',
    ]);
    const failedRetry = retrySessions.find((s) => s.id === 'restore-fails');
    const liveRetry = retrySessions.find((s) => s.id === 'restore-ok');
    expect(failedRetry?.pendingSince).toBe(timestamp);
    expect(liveRetry?.pendingSince).toBe(retryPending.timestamp);
    expect(failedRetry?.hookToken).toBe('failed-token');
    expect(
      fs.readFileSync(path.join(scrollbackDir, 'restore-fails.buf'), 'utf-8')
    ).toBe('b output');
  });

  it('serializeAll keeps fresh live sessions restorable when old preserved failures age out', async () => {
    const configDir = createTmpDir();
    const nowMs = Date.now();
    const nearlyStaleTime = new Date(
      nowMs - (5 * 60 * 1000 - 1000)
    ).toISOString();
    const pending = {
      version: 6,
      reason: 'dev-restart',
      timestamp: nearlyStaleTime,
      sessions: [
        pendingPtySession('old-restore-fails', {
          cwd: path.join(configDir, 'missing-cwd'),
          displayName: 'old failed restore',
          tmuxSessionName: 'relay-ide-old-failed-restore',
          pendingSince: nearlyStaleTime,
        }),
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );
    const scrollbackDir = path.join(configDir, 'scrollback');
    fs.mkdirSync(scrollbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(scrollbackDir, 'old-restore-fails.buf'),
      'old failed output'
    );

    const live = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      displayName: 'fresh live session',
    });
    const liveSession = sessions.get(live.id);
    expect(liveSession).toBeTruthy();
    expect(liveSession!.mode).toBe('pty');
    (liveSession as PtySession).scrollback.push('fresh output');

    serializeAll(configDir, { reason: 'dev-restart' });

    const serialized = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    );
    const serializedSessions = serialized.sessions as Array<{
      id: string;
      pendingSince?: string;
    }>;
    const serializedFailure = serializedSessions.find(
      (session) => session.id === 'old-restore-fails'
    );
    const serializedLive = serializedSessions.find(
      (session) => session.id === live.id
    );
    expect(serializedFailure?.pendingSince).toBe(nearlyStaleTime);
    expect(serializedLive?.pendingSince).toBe(serialized.timestamp);

    sessions.kill(live.id);
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs + 2000);
    try {
      const restored = await restoreFromDisk(configDir);

      expect(restored).toBe(1);
      expect(sessions.get(live.id)).toBeTruthy();
      expect(sessions.get('old-restore-fails')).toBeUndefined();
      expect(fs.existsSync(path.join(configDir, 'pending-sessions.json'))).toBe(
        false
      );
      expect(fs.existsSync(scrollbackDir)).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('serializeAll prunes stale failed restore records instead of refreshing them', () => {
    const configDir = createTmpDir();
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const pending = {
      version: 6,
      reason: 'dev-restart',
      timestamp: staleTime,
      sessions: [pendingPtySession('stale-failure')],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );
    const scrollbackDir = path.join(configDir, 'scrollback');
    fs.mkdirSync(scrollbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(scrollbackDir, 'stale-failure.buf'),
      'old output'
    );

    const s = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });

    serializeAll(configDir, { reason: 'dev-restart' });

    const retryPending = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    );
    expect(
      retryPending.sessions.map((session: { id: string }) => session.id)
    ).toEqual([s.id]);
    expect(fs.existsSync(path.join(scrollbackDir, 'stale-failure.buf'))).toBe(
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
          tmuxSessionName: 'relay-ide-my-session-tmux-tes',
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
    expect((session as PtySession).useTmux).toBe(true);
    expect((session as PtySession).tmuxSessionName).toBe(
      'relay-ide-my-session-tmux-tes'
    );
  });

  it('restoreFromDisk attaches to an alive tmux session and keeps tmux compatibility fields', async () => {
    const configDir = createTmpDir();
    const tmuxName = `relay-ide-restore-alive-${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      execFile(
        'tmux',
        ['new-session', '-d', '-s', tmuxName, '--', '/bin/sh'],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const pending = {
      version: 5,
      timestamp: new Date().toISOString(),
      sessions: [
        {
          id: 'tmux-alive-restore-id',
          type: 'agent' as const,
          agent: 'claude' as const,
          repoPath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          repoName: 'test-repo',
          branchName: 'my-branch',
          displayName: 'alive-session',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          useTmux: true,
          tmuxSessionName: tmuxName,
          customCommand: null,
          yolo: true,
          claudeArgs: ['--model', 'opus'],
          hookToken: 'restore-token',
          hooksActive: true,
        },
      ],
    };
    fs.writeFileSync(
      path.join(configDir, 'pending-sessions.json'),
      JSON.stringify(pending)
    );

    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(1);

    const session = sessions.get('tmux-alive-restore-id');
    expect(session).toBeTruthy();
    expect((session as PtySession).useTmux).toBe(true);
    expect((session as PtySession).tmuxSessionName).toBe(tmuxName);
    expect((session as PtySession).hookToken).toBe('restore-token');
    expect((session as PtySession).yolo).toBe(true);
    expect((session as PtySession).claudeArgs).toEqual(['--model', 'opus']);
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

    // Poll for the restored session's PTY (/bin/false) to exit and the
    // status to flip to 'disconnected'. Previously this used a fixed
    // 500ms sleep which flaked under CPU contention because the PTY had
    // not exited by the deadline. Restored sessions exit through a
    // dedicated branch in pty-handler.ts that flips status but does not
    // call fireSessionEnd, so polling is the cleanest signal here.
    // Use sessions.get() inside the loop — O(1) map lookup, avoids the
    // sessions.list() snapshot+sort cost on every iteration.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (sessions.get('restore-exit-test')?.status === 'disconnected') break;
      await delay(25);
    }

    const found = sessions.list().find((s) => s.id === 'restore-exit-test');

    expect(found).toBeTruthy();
    expect(found!.status).toBe('disconnected');
  });

  it('full serialize-restore round trip preserves all session fields including tmuxSessionName', async () => {
    const configDir = createTmpDir();

    // Create sessions of different types
    const agentSession = sessions.create({
      type: 'agent',
      repoName: 'my-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
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

    // Detach (preserves tmux sessions for restore reattach) rather than kill,
    // which would tear down tmux and leave nothing for restore to adopt.
    // Restore re-creates the in-memory entry under the same id, replacing it.
    sessions.detachForRestart(agentSession.id);
    sessions.detachForRestart(terminal.id);

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
      tmuxSessionName: 'relay-ide-tmux-session-tmux-rou',
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
      'relay-ide-tmux-session-tmux-rou'
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
    expect(pending.version).toBe(6);
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
    expect((session as PtySession).useTmux).toBe(true);
    expect((session as PtySession).tmuxSessionName).toMatch(
      /^relay-(ide|dev)-v2-session-/
    );
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
    expect(pending.version).toBe(6);
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
