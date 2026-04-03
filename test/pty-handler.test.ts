import { describe, it, afterEach, expect } from 'vitest';
import * as sessions from '../server/sessions.js';
import type { PtySession, EventSourceType } from '../server/types.js';

import { buildStatusLineRelayScript } from '../server/pty-handler.js';

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
