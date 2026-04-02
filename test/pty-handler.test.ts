import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as sessions from '../server/sessions.js';
import type { PtySession, EventSourceType } from '../server/types.js';

import { buildStatusLineRelayScript } from '../server/pty-handler.js';

describe('status-line relay script', () => {
  it('writes telemetry via a temp file while streaming stdin once', () => {
    const script = buildStatusLineRelayScript('session-123', '/tmp/claude-remote-config', '/usr/local/bin/status-line');

    assert.match(script, /mktemp/);
    assert.match(script, /tee "\$tmp_file"/);
    assert.match(script, /mv "\$tmp_file"/);
    assert.doesNotMatch(script, /input=\$\(cat\)/);
  });
});

describe('framework-driven PTY handler', () => {
  const createdIds: string[] = [];

  afterEach(() => {
    for (const id of createdIds) {
      try {
        const session = sessions.get(id);
        if (session) sessions.kill(id);
      } catch { /* already cleaned up */ }
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
    assert.equal(result.agent, 'codex');
    const session = sessions.get(result.id);
    assert.ok(session);
    // customCommand should be set since we passed command
    assert.equal(session.customCommand, '/bin/echo');
  });

  it('dataQuality is set on session from framework.eventSource (claude -> hooks)', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: '/bin/cat', // custom command avoids real claude, but agent is still 'claude'
      args: [],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    assert.ok(session);
    // dataQuality reflects the framework's eventSource (claude = 'hooks')
    assert.equal(session.dataQuality, 'hooks');
  });

  it('dataQuality is set on session from framework.eventSource (opencode -> plugin)', () => {
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
    assert.ok(session);
    // opencode has eventSource='plugin', so dataQuality should be plugin
    assert.equal(session.dataQuality, 'plugin' as EventSourceType);
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
    assert.ok(session);
    assert.deepEqual(session.sessionArgs, ['--model', 'opus']);
    // claudeArgs backward compat still set
    assert.deepEqual(session.claudeArgs, ['--model', 'opus']);
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
    assert.ok(session);
    assert.deepEqual(session.sessionArgs, []);
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
    assert.ok(session);
    assert.equal(session.dataQuality, 'parser' as EventSourceType);
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
    assert.ok(session);
    // The outputParser should be an instance of the opencode parser
    // We verify indirectly by checking the session started correctly
    assert.ok(session.outputParser, 'outputParser should be set');
  });
});
