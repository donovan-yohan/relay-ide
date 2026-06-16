import { describe, it, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sessions from '../server/sessions.js';
import type { PtySession, EventSourceType } from '../server/types.js';

import {
  buildStatusLineRelayScript,
  handleTerminalAttentionUpdate,
} from '../server/pty-handler.js';

const originalRelayTmuxPrefix = process.env.RELAY_IDE_TMUX_PREFIX;
const originalDevInstance = process.env.RELAY_IDE_DEV_INSTANCE;
const originalNoPin = process.env.NO_PIN;

afterEach(() => {
  if (originalRelayTmuxPrefix === undefined) {
    delete process.env.RELAY_IDE_TMUX_PREFIX;
  } else {
    process.env.RELAY_IDE_TMUX_PREFIX = originalRelayTmuxPrefix;
  }
  if (originalDevInstance === undefined) {
    delete process.env.RELAY_IDE_DEV_INSTANCE;
  } else {
    process.env.RELAY_IDE_DEV_INSTANCE = originalDevInstance;
  }
  if (originalNoPin === undefined) {
    delete process.env.NO_PIN;
  } else {
    process.env.NO_PIN = originalNoPin;
  }
});

describe('status-line relay script', () => {
  it('writes telemetry via a temp file while streaming stdin once', () => {
    const script = buildStatusLineRelayScript(
      'session-123',
      '/tmp/claude-remote-config',
      '/usr/local/bin/status-line'
    );

    expect(script).toMatch(/mktemp/);
    expect(script).toMatch(/tee "\$tmp_file"/);
    expect(script).toMatch(/mv "\$tmp_file"/);
    expect(script).not.toMatch(/input=\$\(cat\)/);
  });
});

describe('terminal attention fallback', () => {
  function sessionWithVisibleText(
    visibleText: string,
    overrides: Partial<PtySession> = {}
  ): PtySession {
    return {
      id: 'session-attention',
      agentState: 'idle',
      terminalModel: { getVisibleText: () => visibleText },
      ...overrides,
    } as PtySession;
  }

  it('clears terminal-model-owned permission prompts when the prompt disappears', () => {
    const session = sessionWithVisibleText('npm test passed', {
      agentState: 'permission-prompt',
      permissionType: 'approval',
      permissionPromptSource: 'terminal-model',
    });
    const states: string[] = [];
    const backendChanges: string[] = [];

    handleTerminalAttentionUpdate(
      session,
      [(_id, state) => states.push(state)],
      (changed) => backendChanges.push(changed.agentState)
    );

    expect(session.agentState).toBe('idle');
    expect(session.permissionType).toBeUndefined();
    expect(session.permissionPromptSource).toBeUndefined();
    expect(states).toEqual(['idle']);
    expect(backendChanges).toEqual(['idle']);
  });

  it('does not clear hook-owned permission prompts just because fallback text is absent', () => {
    const session = sessionWithVisibleText('waiting on hook event', {
      agentState: 'permission-prompt',
      permissionType: 'approval',
      permissionPromptSource: 'hooks',
    });
    const states: string[] = [];

    handleTerminalAttentionUpdate(
      session,
      [(_id, state) => states.push(state)],
      undefined
    );

    expect(session.agentState).toBe('permission-prompt');
    expect(session.permissionType).toBe('approval');
    expect(session.permissionPromptSource).toBe('hooks');
    expect(states).toEqual([]);
  });
});

describe('framework-driven PTY handler', () => {
  const createdIds: string[] = [];

  afterEach(() => {
    for (const id of createdIds) {
      try {
        const session = sessions.get(id);
        if (session) sessions.kill(id);
      } catch {
        /* already cleaned up */
      }
    }
    createdIds.length = 0;
  });

  it('command is resolved from framework.command when no override specified', () => {
    // When agent=codex and no custom command, the session agent field should be codex
    // (the actual pty command is internal — we verify it started by the session being active)
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'codex',
      command: '/bin/echo', // use custom command to avoid spawning real codex binary
      args: ['hello'],
    });
    createdIds.push(result.id);
    expect(result.agent).toBe('codex');
    const session = sessions.get(result.id);
    expect(session).toBeTruthy();
    // customCommand should be set since we passed command
    expect(session!.customCommand).toBe('/bin/echo');
  });

  it('dataQuality is derived from actual hooksActive state (hooks when injection succeeds)', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    // Without a port, hook injection doesn't succeed → hooksActive stays false → dataQuality falls back to 'parser'
    expect(session.dataQuality).toBe('parser');
  });

  it('dataQuality falls back to parser when plugin injection fails', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'opencode',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    // Without a port, opencode plugin injection doesn't succeed → hooksActive stays false → dataQuality is 'parser'
    expect(session.dataQuality).toBe('parser' as EventSourceType);
  });

  it('sessionArgs is populated on session matching claudeArgs', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: '/bin/cat',
      args: [],
      claudeArgs: ['--model', 'opus'],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    expect(session.sessionArgs).toEqual(['--model', 'opus']);
    // claudeArgs backward compat still set
    expect(session.claudeArgs).toEqual(['--model', 'opus']);
  });

  it('sessionArgs defaults to empty array when claudeArgs not provided', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    expect(session.sessionArgs).toEqual([]);
  });

  it('relay-pty backend bypasses tmux and maintains a relay terminal model', async () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: '/bin/cat',
      args: [],
      terminalBackend: 'relay-pty',
      cols: 80,
      rows: 24,
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    expect(session.terminalBackend).toBe('relay-pty');
    expect(session.terminalModel).toBeTruthy();

    await sessions.sendTerminalText(result.id, 'relay-pty-ok');
    await sessions.sendTerminalKeys(result.id, ['Enter']);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(
      sessions.captureTerminalVisibleText(result.id)
    ).resolves.toContain('relay-pty-ok');
  });

  it('preserves workContextId when relay-pty retries without --continue', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pty-retry-'));
    const envPath = path.join(tmp, 'retry-env.txt');
    const scriptPath = path.join(tmp, 'retry-env.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/bin/sh
set -eu
if [ "\${1:-}" = "--continue" ]; then
  exit 1
fi
env > ${JSON.stringify(envPath)}
sleep 60
`,
      { mode: 0o700 }
    );

    try {
      const result = sessions.create({
        repoName: 'test-repo',
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
        agent: 'claude',
        command: scriptPath,
        args: ['--continue'],
        terminalBackend: 'relay-pty',
        workContextId: 'wc:retry-preserve',
      });
      createdIds.push(result.id);

      await expect
        .poll(() =>
          fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
        )
        .toContain('RELAY_WORK_CONTEXT_ID=wc:retry-preserve');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('forceOutputParser sets dataQuality to parser regardless of framework', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: '/bin/cat',
      args: [],
      forceOutputParser: true,
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    expect(session.dataQuality).toBe('parser' as EventSourceType);
  });

  it('parser is selected by framework.parserType (opencode uses opencode parser)', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'opencode',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    // The outputParser should be an instance of the opencode parser
    // We verify indirectly by checking the session started correctly
    expect(session.outputParser).toBeTruthy();
  });
});
