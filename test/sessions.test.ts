import { describe, it, afterEach, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sessions from '../server/sessions.js';
import { serializeAll, restoreFromDisk } from '../server/sessions.js';
import { AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS } from '../server/types.js';
import type { PtySession } from '../server/types.js';
import { LOCAL_COMPATIBILITY_SESSION_INTENT } from '../shared/session-envelope.js';
import { DEFAULT_SESSION_REPLAY_CAPACITY_BYTES } from '../shared/session-replay.js';

// Track created session IDs so we can clean up after each test
const createdIds: string[] = [];
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  // Kill any remaining sessions created during tests. Some restore tests add
  // sessions directly from disk, so cleanup must inspect the live registry too.
  const ids = new Set([
    ...createdIds,
    ...sessions.list().map((session) => session.id),
  ]);
  for (const id of ids) {
    try {
      if (sessions.get(id)) {
        sessions.kill(id);
      }
    } catch {
      // Already killed or exited, ignore
    }
  }
  createdIds.length = 0;
});

describe('buildAgentArgs cold-resume claudeArgs leak gate', () => {
  type SerializedSession = Parameters<typeof sessions.buildAgentArgs>[0];
  // config.claudeArgs (persisted as the session's claudeArgs) are Claude-only
  // flags. Replaying them into a codex resume exits the CLI with code 2.
  const claudeArgs = ['--model', 'opus', '--effort', 'high'];
  const base = {
    id: 's1',
    type: 'agent' as const,
    cwd: '/tmp',
    displayName: 'Agent',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    customCommand: null,
  };

  it('drops serialized claudeArgs when restoring a codex session', () => {
    const args = sessions.buildAgentArgs({
      ...base,
      agent: 'codex',
      claudeArgs,
      yolo: false,
    } as SerializedSession);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    // Codex resume still gets its own continue args, never the claudeArgs.
    expect(args).toEqual([...(AGENT_CONTINUE_ARGS['codex'] ?? [])]);
  });

  it('replays serialized claudeArgs when restoring a claude session', () => {
    const args = sessions.buildAgentArgs({
      ...base,
      agent: 'claude',
      claudeArgs,
      yolo: false,
    } as SerializedSession);
    expect(args).toEqual([
      ...(AGENT_CONTINUE_ARGS['claude'] ?? []),
      ...claudeArgs,
    ]);
  });
});

describe('initial prompt delivery', () => {
  it('passes a Codex initial prompt as the final distinct argv element', async () => {
    const probeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-codex-argv-')
    );
    const probePath = path.join(probeDir, 'argv-probe.mjs');
    fs.writeFileSync(
      probePath,
      [
        "process.stdout.write('ARGV=' + JSON.stringify(process.argv.slice(2)));",
        'setTimeout(() => {}, 10_000);',
      ].join('\n'),
      'utf-8'
    );
    const initialPrompt = 'fix spaces; $(never-shell-interpolate) && verify';
    const cases = [
      {
        name: 'fresh',
        args: ['--ask-for-approval', 'never'],
      },
      {
        name: 'resume',
        args: ['resume', '--last', '--ask-for-approval', 'never'],
      },
    ];

    try {
      for (const testCase of cases) {
        const result = sessions.create({
          repoName: `codex-${testCase.name}`,
          repoPath: '/tmp',
          worktreePath: null,
          cwd: '/tmp',
          agent: 'codex',
          command: process.execPath,
          args: [probePath, ...testCase.args],
          initialPrompt,
        });
        createdIds.push(result.id);

        let output = '';
        for (let attempt = 0; attempt < 100; attempt += 1) {
          output =
            (
              sessions.get(result.id) as PtySession | undefined
            )?.scrollback.join('') ?? '';
          if (output.includes('ARGV=')) break;
          await delay(10);
        }

        expect(output).toContain(
          `ARGV=${JSON.stringify([...testCase.args, initialPrompt])}`
        );
        expect(
          (sessions.get(result.id) as PtySession | undefined)?.initialPrompt
        ).toBeUndefined();
      }
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });

  it('schedules typed injection for Claude but not Codex', () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const codex = sessions.create({
        repoName: 'codex-native-prompt',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        agent: 'codex',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 10_000);'],
        initialPrompt: 'native prompt',
      });
      createdIds.push(codex.id);

      expect(timeoutSpy.mock.calls.some((call) => call[1] === 8000)).toBe(
        false
      );
      expect(
        (sessions.get(codex.id) as PtySession | undefined)?.initialPrompt
      ).toBeUndefined();

      timeoutSpy.mockClear();
      const claude = sessions.create({
        repoName: 'claude-typed-prompt',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        agent: 'claude',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 10_000);'],
        initialPrompt: 'typed prompt',
      });
      createdIds.push(claude.id);

      const fallbackCallIndex = timeoutSpy.mock.calls.findIndex(
        (call) => call[1] === 8000
      );
      expect(fallbackCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        (sessions.get(claude.id) as PtySession | undefined)?.initialPrompt
      ).toBe('typed prompt');

      const fallbackTimer = timeoutSpy.mock.results[fallbackCallIndex]
        ?.value as ReturnType<typeof setTimeout> | undefined;
      if (fallbackTimer) clearTimeout(fallbackTimer);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
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
    expect(result.sessionEnvelope).toMatchObject({
      sessionId: result.id,
      globalSessionId: `local:${result.id}`,
      nodeId: 'local',
      intent: { kind: LOCAL_COMPATIBILITY_SESSION_INTENT },
      scope: {
        kind: 'local-compatibility',
        nodeId: 'local',
        cwd: '/tmp',
        repoPath: '/tmp',
        worktreePath: null,
      },
      revocable: true,
      peerIdentity: { kind: 'local-user', id: 'local-dev' },
    });
    expect(result.sessionEnvelope.expiresAt).toBeNull();

    const list = sessions.list();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(result.id);
    expect(list[0]?.sessionEnvelope).toMatchObject({
      sessionId: result.id,
      intent: { kind: LOCAL_COMPATIBILITY_SESSION_INTENT },
      scope: { kind: 'local-compatibility', cwd: '/tmp' },
    });
  });

  it('records optional best-effort session lineage without requiring the parent to exist', () => {
    const child = sessions.create({
      spawnedBySessionId: 'unknown-parent-session',
      repoName: 'lineage-child',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(child.id);

    expect(child.spawnedBySessionId).toBe('unknown-parent-session');
    expect(sessions.get(child.id)?.spawnedBySessionId).toBe(
      'unknown-parent-session'
    );
    expect(
      sessions.list().find((session) => session.id === child.id)
        ?.spawnedBySessionId
    ).toBe('unknown-parent-session');

    const topLevel = sessions.create({
      repoName: 'lineage-top-level',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(topLevel.id);
    expect(topLevel).not.toHaveProperty('spawnedBySessionId');
    expect(sessions.get(topLevel.id)).not.toHaveProperty('spawnedBySessionId');
    expect(
      sessions.list().find((session) => session.id === topLevel.id)
    ).not.toHaveProperty('spawnedBySessionId');
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
    expect(result).not.toHaveProperty('branchName');

    const listed = sessions.list().find((session) => session.id === result.id);
    expect(listed).toBeDefined();
    expect(listed?.globalSessionId).toBe(`local:${result.id}`);
    expect(listed?.repoInstanceId).toBeUndefined();
    expect(listed?.worktreeInstanceId).toBeUndefined();
    expect(listed).not.toHaveProperty('branchName');
  });

  it('list populates durability and emits a transition event on change', () => {
    const transitions: Array<{
      sessionId: string;
      from: string | undefined;
      to: string;
    }> = [];
    const unsubscribe = sessions.onSessionDurabilityChanged((event) => {
      transitions.push({
        sessionId: event.sessionId,
        from: event.from,
        to: event.to,
      });
    });
    try {
      const result = sessions.create({
        repoName: 'durability-repo',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/echo',
        args: ['hi'],
      });
      createdIds.push(result.id);

      // First list() call must populate `durability` and emit the
      // initial transition (undefined -> running-attached).
      let summary = sessions.list().find((session) => session.id === result.id);
      expect(summary?.durability).toBe('running-attached');
      const initial = transitions.filter((t) => t.sessionId === result.id);
      expect(initial).toHaveLength(1);
      expect(initial[0]).toMatchObject({
        from: undefined,
        to: 'running-attached',
      });

      // No change between calls: emit must not refire.
      sessions.list();
      expect(transitions.filter((t) => t.sessionId === result.id)).toHaveLength(
        1
      );

      // Flip the underlying session to `disconnected` and recompute.
      const session = sessions.get(result.id);
      expect(session).toBeTruthy();
      session!.status = 'disconnected';
      summary = sessions.list().find((entry) => entry.id === result.id);
      expect(summary?.durability).toBe('running-detached');
      const after = transitions.filter((t) => t.sessionId === result.id);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({
        from: 'running-attached',
        to: 'running-detached',
      });
    } finally {
      unsubscribe();
    }
  });

  it('emits durability transitions pushed from fireStateChange without list()', () => {
    const transitions: Array<{ from: string | undefined; to: string }> = [];
    const unsubscribe = sessions.onSessionDurabilityChanged((event) => {
      transitions.push({ from: event.from, to: event.to });
    });
    try {
      const result = sessions.create({
        repoName: 'durability-push',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/echo',
        args: ['hi'],
      });
      createdIds.push(result.id);

      // Initial list() warms `_lastEmittedDurability` so subsequent state
      // changes have a baseline to compare against.
      sessions.list();
      const baselineCount = transitions.length;

      const session = sessions.get(result.id);
      expect(session).toBeTruthy();
      session!.agentState = 'permission-prompt';
      sessions.fireStateChange(result.id, 'permission-prompt');

      // No list() call between the state change and now — the event must
      // have fired directly from fireStateChange.
      expect(transitions.length).toBeGreaterThan(baselineCount);
      expect(transitions[transitions.length - 1]).toMatchObject({
        to: 'permission-needed',
      });
    } finally {
      unsubscribe();
    }
  });

  it('surfaces stale-node when the hub reports the owning node is offline', () => {
    const transitions: Array<{ to: string }> = [];
    const unsubscribe = sessions.onSessionDurabilityChanged((event) => {
      transitions.push({ to: event.to });
    });
    try {
      const result = sessions.create({
        repoName: 'durability-stale',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        command: '/bin/echo',
        args: ['hi'],
      });
      createdIds.push(result.id);

      // Treat this session as belonging to a remote node so the resolver
      // is consulted. Without a resolver, the field is null and the
      // session resolves to `running-attached`.
      const session = sessions.get(result.id);
      session!.nodeId = 'remote-test' as typeof session.nodeId;

      let reportedStatus: 'online' | 'offline' = 'online';
      sessions.setSessionNodeStatusResolver(() => reportedStatus);
      try {
        sessions.list(); // emits running-attached
        reportedStatus = 'offline';
        sessions.refreshDurability([result.id]);
        const last = transitions[transitions.length - 1];
        expect(last?.to).toBe('stale-node');
      } finally {
        sessions.setSessionNodeStatusResolver(null);
      }
    } finally {
      unsubscribe();
    }
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
    expect(result).toHaveProperty('branchName');

    const listed = sessions.list().find((session) => session.id === result.id);
    expect(listed).toBeDefined();
    expect(listed!.branchName).toBe('');
    expect(listed).toHaveProperty('branchName');
  });

  it('preserves explicit branchName for repo-bound sessions', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      repoPath: '/tmp/workspace',
      worktreePath: '/tmp/workspace/.worktrees/feature-branch',
      cwd: '/tmp/workspace/.worktrees/feature-branch',
      branchName: 'feature/branch',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);

    expect(result.branchName).toBe('feature/branch');

    const listed = sessions.list().find((session) => session.id === result.id);
    expect(listed).toBeDefined();
    expect(listed!.branchName).toBe('feature/branch');

    const stored = sessions.get(result.id);
    expect(stored).toBeDefined();
    expect(stored!.branchName).toBe('feature/branch');
  });

  it('serializes control state separately from transport mode for PTY sessions', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      repoPath: '/tmp/workspace',
      worktreePath: null,
      cwd: '/tmp/workspace',
      command: '/bin/echo',
      args: ['hello'],
      controlState: {
        controlMode: 'agent-driven',
        activeActors: [{ kind: 'agent', id: 'worker-1' }],
        activeWorker: { kind: 'agent', id: 'worker-1' },
        lastInterventionAt: '2026-01-02T03:04:05.000Z',
        lastInterventionBy: { kind: 'human', id: 'operator' },
        lastInterventionEventId: 'evt-pty-1',
        controlFreshness: 'fresh',
      },
    });
    createdIds.push(result.id);

    expect(result.mode).toBe('pty');
    expect(result.controlMode).toBe('agent-driven');
    expect(result.activeWorker).toEqual({ kind: 'agent', id: 'worker-1' });

    const listed = sessions.list().find((session) => session.id === result.id);
    expect(listed).toMatchObject({
      mode: 'pty',
      controlMode: 'agent-driven',
      controlFreshness: 'fresh',
      lastInterventionEventId: 'evt-pty-1',
    });
  });

  it('backfills missing PTY control state to human-driven unknown freshness', () => {
    const result = sessions.create({
      type: 'agent',
      repoName: 'test-repo',
      repoPath: '/tmp/workspace',
      worktreePath: null,
      cwd: '/tmp/workspace',
      command: '/bin/echo',
      args: ['hello'],
    });
    createdIds.push(result.id);

    const listed = sessions.list().find((session) => session.id === result.id);
    expect(listed).toMatchObject({
      mode: 'pty',
      controlMode: 'human-driven',
      controlFreshness: 'unknown',
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
    });
  });

  it('prod prefix (relay-ide-) does not match dev prefix (relay-dev-)', () => {
    const prodPrefix = 'relay-ide-';
    const devPrefix = 'relay-dev-';
    expect(devPrefix.startsWith(prodPrefix)).toBe(false);
    expect(prodPrefix.startsWith(devPrefix)).toBe(false);
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

  it.skip('useTmux defaults to false when not specified', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    expect(result.terminalBackend).toBe('relay-pty');
    expect(result.useTmux).toBe(false);
    expect(result.tmuxSessionName).toBe('');
  });

  it.skip('useTmux:false opts custom command sessions into relay-pty', () => {
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
    expect(result.terminalBackend).toBe('relay-pty');
    expect(result.useTmux).toBe(false);
    expect(result.tmuxSessionName).toBe('');
  });

  it('returns a bounded rendered screen snapshot for relay-pty sessions', async () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-i'],
      cols: 80,
      rows: 12,
      useTmux: false,
    });
    createdIds.push(result.id);

    sessions.write(result.id, 'printf SCREEN_SNAPSHOT_READY\\n');
    sessions.write(result.id, '\n');

    let snapshot: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      const resultSnapshot = sessions.getRenderedScreenSnapshot(result.id, {
        requestedId: result.globalSessionId,
        includeScrollback: true,
        maxScrollbackLines: 5,
      });
      expect(resultSnapshot.ok).toBe(true);
      if (resultSnapshot.ok) {
        snapshot = resultSnapshot.snapshot;
        const visible = snapshot.visible as { text?: string };
        if (visible.text?.includes('SCREEN_SNAPSHOT_READY')) break;
      }
      await delay(50);
    }

    expect(snapshot).toBeDefined();
    expect(snapshot).toMatchObject({
      session: {
        id: result.id,
        requestedId: result.globalSessionId,
        nodeId: 'local',
        globalSessionId: result.globalSessionId,
        status: 'active',
      },
      backend: {
        terminalBackend: 'relay-pty',
        runtime: 'relay-pty/libghostty-vt',
      },
      scrollback: {
        requested: true,
        included: true,
        maxLines: 5,
      },
    });
    const visible = snapshot!.visible as { text?: string; rows?: unknown[] };
    expect(visible.text).toContain('SCREEN_SNAPSHOT_READY');
    expect(Array.isArray(visible.rows)).toBe(true);
  });

  it('defaults rendered screen scrollback counters for legacy relay-pty records', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      cols: 80,
      rows: 12,
      useTmux: false,
    });
    createdIds.push(result.id);

    const session = sessions.get(result.id) as PtySession;
    delete (session as Partial<PtySession>).scrollbackBytesEvicted;
    delete (session as Partial<PtySession>).scrollbackCapacityBytes;

    const resultSnapshot = sessions.getRenderedScreenSnapshot(result.id, {
      includeScrollback: true,
      maxScrollbackLines: 5,
    });

    expect(resultSnapshot.ok).toBe(true);
    if (!resultSnapshot.ok)
      throw new Error('expected rendered screen snapshot');
    expect(resultSnapshot.snapshot).toMatchObject({
      scrollback: {
        rows: expect.any(Array),
        bytesDropped: 0,
        capacityBytes: DEFAULT_SESSION_REPLAY_CAPACITY_BYTES,
      },
    });
  });

  it('rejects Object prototype terminal keys for relay-pty sessions', async () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      terminalBackend: 'relay-pty',
    });
    createdIds.push(result.id);

    await sessions.sendTerminalText(result.id, 'VALID_KEY');
    await sessions.sendTerminalKeys(result.id, ['Enter']);
    await expect
      .poll(() => sessions.captureTerminalVisibleText(result.id))
      .toContain('VALID_KEY');

    for (const inheritedKey of [
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
    ]) {
      await expect(
        sessions.sendTerminalKeys(result.id, [inheritedKey])
      ).rejects.toThrow(`Unsupported relay-pty input key: ${inheritedKey}`);
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
    expect(pending.version).toBe(7);
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
      spawnedBySessionId: 'orchestrator-session',
    });
    const originalId = s.id;

    const session = sessions.get(originalId);
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('pty');
    (session as PtySession).scrollback.push('saved output');

    serializeAll(configDir);
    const serialized = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8')
    ) as { sessions: Array<{ spawnedBySessionId?: string }> };
    expect(serialized.sessions[0]?.spawnedBySessionId).toBe(
      'orchestrator-session'
    );

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
    expect(restoredSession!.spawnedBySessionId).toBe('orchestrator-session');
    expect(
      sessions.list().find((entry) => entry.id === originalId)
        ?.spawnedBySessionId
    ).toBe('orchestrator-session');

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

  it.skip('restoreFromDisk keeps failed restore records and scrollback for a retry', async () => {
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

  it.skip('serializeAll preserves failed restore records across the next clean restart', async () => {
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

  it.skip('restored session remains in list after PTY exits (disconnected status)', async () => {
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

  it('full serialize-restore round trip preserves relay-pty session fields', async () => {
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

    // Restore
    const restored = await restoreFromDisk(configDir);
    expect(restored).toBe(2);

    // Verify all sessions exist
    const list = sessions.list();
    expect(list.length).toBe(2);

    const restoredAgent = list.find((s) => s.id === agentSession.id);
    expect(restoredAgent).toBeTruthy();
    expect(restoredAgent!.type).toBe('agent');
    expect(restoredAgent!.displayName).toBe('My Agent');
    expect(restoredAgent!.status).toBe('active');

    const restoredTerminal = list.find((s) => s.id === terminal.id);
    expect(restoredTerminal).toBeTruthy();
    expect(restoredTerminal!.type).toBe('terminal');
    expect(restoredTerminal!.displayName).toBe('Terminal 1');
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
    expect(pending.version).toBe(7);
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

  it.skip('restoreFromDisk handles v1/v2 pending files (v2→v3 migration)', async () => {
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

  it.skip('restoreFromDisk handles v3 pending files (v3→v4 migration: workspacePath→repoPath)', async () => {
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

  it('serializeAll writes version 7 in pending-sessions.json', () => {
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
    expect(pending.version).toBe(7);
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

  it.skip('restoreFromDisk uses framework continueArgs for claude (--continue)', async () => {
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

  it.skip('restoreFromDisk uses framework continueArgs for codex (resume --last)', async () => {
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
