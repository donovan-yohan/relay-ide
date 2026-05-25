import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';
import { ClaudeJsonlStateAdapter } from '../../../server/provider-state/claude-jsonl-state-adapter.js';

async function writeFixture(): Promise<{ root: string; sessionPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-claude-jsonl-'));
  const projectDir = path.join(root, 'projects', '-tmp-repo');
  await mkdir(projectDir, { recursive: true });
  const sessionPath = path.join(projectDir, 'session-abc.jsonl');
  const lines = [
    {
      type: 'summary',
      summary: 'Investigate native state import',
      sessionId: 'session-abc',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
      workContextId: 'wc-1',
    },
    {
      type: 'user',
      sessionId: 'session-abc',
      uuid: 'user-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'user',
        content: 'please inspect token=abc123 and explain the setup',
      },
    },
    {
      type: 'assistant',
      sessionId: 'session-abc',
      uuid: 'assistant-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need check files' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'npm test', cwd: '/tmp/repo', apiKey: 'sk-1234567890abcdef' },
          },
          { type: 'text', text: 'the adapter can read JSONL safely' },
        ],
      },
    },
    {
      type: 'user',
      sessionId: 'session-abc',
      uuid: 'tool-result-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'stdout contained ghp_deadbeef12345678' }],
      },
    },
  ];
  await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return { root, sessionPath };
}

describe('ClaudeJsonlStateAdapter', () => {
  it('detects readable Claude JSONL state and lists redacted native sessions', async () => {
    const { root, sessionPath } = await writeFixture();
    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    await expect(adapter.detectInstall()).resolves.toMatchObject({
      provider: 'claude',
      status: 'installed',
      stateRoots: [root],
    });

    const sessions = await adapter.listNativeSessions({ cwd: '/tmp/repo' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: 'claude',
      nativeId: 'session-abc',
      sourcePath: sessionPath,
      cwd: '/tmp/repo',
      workContextId: 'wc-1',
      title: 'Investigate native state import',
      capabilities: {
        canImportTranscript: true,
        canReadProviderState: true,
        canResumeNative: true,
        readOnly: true,
      },
    });
    expect(sessions[0]?.preview.text).toContain('token=[redacted]');
    expect(sessions[0]?.preview.text).not.toContain('abc123');
  });

  it('rejects caller-provided source paths outside the configured state root', async () => {
    const { root } = await writeFixture();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'relay-claude-jsonl-outside-'));
    const outsidePath = path.join(outsideRoot, 'escape.jsonl');
    await writeFile(
      outsidePath,
      `${JSON.stringify({ type: 'summary', sessionId: 'escape', timestamp: '2026-01-01T00:00:00.000Z' })}\n`
    );
    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'claude',
        nativeId: 'escape',
        sourcePath: path.join(root, '..', path.basename(outsideRoot), 'escape.jsonl'),
      })
    ).rejects.toThrow(/state root/i);
  });

  it('rejects non-jsonl and symlink source paths even when they appear inside the state root', async () => {
    const { root } = await writeFixture();
    const nonJsonlPath = path.join(root, 'projects', '-tmp-repo', 'not-json.txt');
    await writeFile(nonJsonlPath, '{}\n');
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'relay-claude-jsonl-symlink-'));
    const outsidePath = path.join(outsideRoot, 'outside.jsonl');
    await writeFile(
      outsidePath,
      `${JSON.stringify({ type: 'summary', sessionId: 'outside', timestamp: '2026-01-01T00:00:00.000Z' })}\n`
    );
    const linkPath = path.join(root, 'projects', '-tmp-repo', 'linked-outside.jsonl');
    await symlink(outsidePath, linkPath);
    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({ provider: 'claude', nativeId: 'not-json', sourcePath: nonJsonlPath })
    ).rejects.toThrow(/jsonl/i);
    await expect(
      adapter.readProviderState({ provider: 'claude', nativeId: 'outside', sourcePath: linkPath })
    ).rejects.toThrow(/symlink/i);
  });

  it('rejects JSONL source files above the explicit byte limit before import', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-claude-jsonl-oversize-'));
    const projectDir = path.join(root, 'projects', '-tmp-repo');
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, 'huge-session.jsonl');
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: 'summary', sessionId: 'huge-session' })}\n${'x'.repeat(5_100_000)}`
    );
    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });

    await expect(
      adapter.importSession({ provider: 'claude', nativeId: 'huge-session', sourcePath: sessionPath })
    ).rejects.toThrow(/exceeds/i);
  });

  it('truncates JSONL parsing at the explicit event limit and reports source metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-claude-jsonl-event-limit-'));
    const projectDir = path.join(root, 'projects', '-tmp-repo');
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, 'event-limit-session.jsonl');
    const lines = Array.from({ length: 5_010 }, (_, index) => ({
      type: 'summary',
      sessionId: 'event-limit-session',
      summary: `event-${index}`,
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
    await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });

    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'event-limit-session',
      sourcePath: sessionPath,
    });

    expect(snapshot.summary.lineCount).toBe(5_000);
    expect(snapshot.summary.readTruncation).toMatchObject({
      truncated: true,
      reason: 'event-limit',
      maxEvents: 5_000,
      parsedEvents: 5_000,
    });
    expect(JSON.stringify(snapshot)).not.toContain('event-5009');
  });

  it('imports a Claude JSONL fixture into an AgentSessionV2 read model with an audit marker', async () => {
    const { root, sessionPath } = await writeFixture();
    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'claude',
      nativeId: 'session-abc',
      sourcePath: sessionPath,
    });

    expect(result.provider).toBe('claude');
    expect(result.session.provider).toBe('claude');
    expect(result.session.providerSession).toMatchObject({
      nativeId: 'session-abc',
      sourcePath: sessionPath,
      stateKind: 'claude-jsonl',
    });
    expect(result.session.turns[0]?.items[0]).toMatchObject({
      type: 'providerExtension',
      namespace: 'provider-state-import',
      payload: {
        event: 'native-session-imported',
        sourceProvider: 'claude',
        readOnly: true,
      },
    });
    expect(result.session.turns[1]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'userMessage', text: expect.stringContaining('token=[redacted]') }),
        expect.objectContaining({ type: 'reasoning', summary: 'need check files' }),
        expect.objectContaining({ type: 'commandExecution', command: 'npm test' }),
        expect.objectContaining({ type: 'assistantMessage', text: 'the adapter can read JSONL safely' }),
        expect.objectContaining({ type: 'providerExtension', namespace: 'claude' }),
      ])
    );
    expect(JSON.stringify(result.session)).not.toContain('sk-1234567890abcdef');
    expect(JSON.stringify(result.session)).not.toContain('ghp_deadbeef12345678');
    expect(result.patches).toHaveLength(1);
    expect(result.patches.every(isAgentPatchV2)).toBe(true);
  });

  it('trims oversized imports FIFO while preserving the audit marker and reporting truncation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-claude-jsonl-large-'));
    const projectDir = path.join(root, 'projects', '-tmp-repo');
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, 'large-session.jsonl');
    const lines = [
      {
        type: 'summary',
        summary: 'large import',
        sessionId: 'large-session',
        cwd: '/tmp/repo',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        type: 'user',
        sessionId: 'large-session',
        uuid: `large-user-${index}`,
        cwd: '/tmp/repo',
        timestamp: `2026-01-01T00:${String(index + 1).padStart(2, '0')}:00.000Z`,
        message: {
          role: 'user',
          content: `message-${index}:${'x'.repeat(20_000)}`,
        },
      })),
    ];
    await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:30:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'claude',
      nativeId: 'large-session',
      sourcePath: sessionPath,
    });

    expect(result.session.turns[0]?.id).toBe('native-import-audit');
    expect(result.importTruncation).toMatchObject({ truncated: true, droppedTurns: expect.any(Number) });
    expect(result.session.config.providerOptions?.importTruncation).toEqual(result.importTruncation);
    expect(JSON.stringify(result.session)).not.toContain('message-0:');
    expect(JSON.stringify(result.session)).toContain('message-23:');
    expect(result.session.turns.length).toBeLessThan(lines.length);
  });

  it('returns bounded provider snapshots and copyable resume argv without executing it', async () => {
    const { root, sessionPath } = await writeFixture();
    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-abc',
      sourcePath: sessionPath,
    });

    expect(snapshot.redaction).toEqual({
      rawPayloadStored: false,
      strategy: 'preview',
      classes: ['credential', 'secret', 'payload', 'transcript'],
    });
    expect(snapshot.summary).toMatchObject({
      lineCount: 4,
      byteCount: expect.any(Number),
      hashSha256: expect.any(String),
      eventTypes: ['summary', 'user', 'assistant'],
      firstTimestamp: '2026-01-01T00:00:00.000Z',
      lastTimestamp: '2026-01-01T00:00:03.000Z',
    });
    expect(adapter.resumeCommand({ provider: 'claude', nativeId: 'session-abc' })).toEqual([
      'claude',
      '--resume',
      'session-abc',
    ]);
  });
});
