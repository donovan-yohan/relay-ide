import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';
import { CodexJsonlStateAdapter } from '../../../server/provider-state/codex-jsonl-state-adapter.js';

async function writeFixture(): Promise<{
  root: string;
  sessionPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-codex-jsonl-'));
  const sessionDir = path.join(root, 'rollout-2026-01-01T00-00-00');
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, 'session-codex-abc.jsonl');
  const lines = [
    {
      type: 'session.started',
      session_id: 'codex-abc',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
      workContextId: 'wc-codex-1',
    },
    {
      type: 'user',
      session_id: 'codex-abc',
      id: 'user-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'user',
        content: 'please check the api_key=secret123 setup',
      },
    },
    {
      type: 'assistant',
      session_id: 'codex-abc',
      id: 'assistant-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need to inspect files' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'shell',
            input: { command: 'npm test', cwd: '/tmp/repo', apiKey: 'leaked-key' },
          },
          { type: 'text', text: 'the codex adapter can read JSONL safely' },
        ],
      },
    },
    {
      type: 'user',
      session_id: 'codex-abc',
      id: 'tool-result-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'stdout contained «redacted:ghp_…»',
          },
        ],
      },
    },
  ];
  await writeFile(
    sessionPath,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
  return { root, sessionPath };
}

describe('CodexJsonlStateAdapter', () => {
  it('detects readable Codex JSONL state and lists redacted native sessions', async () => {
    const { root, sessionPath } = await writeFixture();
    const adapter = new CodexJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    await expect(adapter.detectInstall()).resolves.toMatchObject({
      provider: 'codex',
      status: 'installed',
      stateRoots: [root],
    });

    const sessions = await adapter.listNativeSessions({ cwd: '/tmp/repo' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: 'codex',
      nativeId: 'codex-abc',
      sourcePath: sessionPath,
      cwd: '/tmp/repo',
      workContextId: 'wc-codex-1',
      capabilities: {
        canImportTranscript: true,
        canReadProviderState: true,
        canResumeNative: true,
        readOnly: true,
      },
    });
    expect(sessions[0]?.preview.text).toContain('api_key=[redacted]');
    expect(sessions[0]?.preview.text).not.toContain('secret123');
  });

  it('rejects caller-provided source paths outside the configured state root', async () => {
    const { root } = await writeFixture();
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-codex-jsonl-outside-')
    );
    const outsidePath = path.join(outsideRoot, 'escape.jsonl');
    await writeFile(
      outsidePath,
      `${JSON.stringify({
        type: 'session.started',
        session_id: 'escape',
        timestamp: '2026-01-01T00:00:00.000Z',
      })}\n`
    );
    const adapter = new CodexJsonlStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'codex',
        nativeId: 'escape',
        sourcePath: path.join(
          root,
          '..',
          path.basename(outsideRoot),
          'escape.jsonl'
        ),
      })
    ).rejects.toThrow(/state root/i);
  });

  it('rejects non-jsonl and symlink source paths even when they appear inside the state root', async () => {
    const { root } = await writeFixture();
    const nonJsonlPath = path.join(
      root,
      'rollout-2026-01-01T00-00-00',
      'not-json.txt'
    );
    await writeFile(nonJsonlPath, '{}\n');
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-codex-jsonl-symlink-')
    );
    const outsidePath = path.join(outsideRoot, 'outside.jsonl');
    await writeFile(
      outsidePath,
      `${JSON.stringify({
        type: 'session.started',
        session_id: 'outside',
        timestamp: '2026-01-01T00:00:00.000Z',
      })}\n`
    );
    const linkPath = path.join(
      root,
      'rollout-2026-01-01T00-00-00',
      'linked-outside.jsonl'
    );
    await symlink(outsidePath, linkPath);
    const adapter = new CodexJsonlStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'codex',
        nativeId: 'not-json',
        sourcePath: nonJsonlPath,
      })
    ).rejects.toThrow(/jsonl/i);
    await expect(
      adapter.readProviderState({
        provider: 'codex',
        nativeId: 'outside',
        sourcePath: linkPath,
      })
    ).rejects.toThrow(/symlink/i);
  });

  it('rejects JSONL source files above the explicit byte limit before import', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'relay-codex-jsonl-oversize-')
    );
    const sessionDir = path.join(root, 'rollout-2026-01-01T00-00-00');
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'huge-session.jsonl');
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: 'session.started',
        session_id: 'huge-session',
      })}\n${'x'.repeat(5_100_000)}`
    );
    const adapter = new CodexJsonlStateAdapter({ stateRoot: root });

    await expect(
      adapter.importSession({
        provider: 'codex',
        nativeId: 'huge-session',
        sourcePath: sessionPath,
      })
    ).rejects.toThrow(/exceeds/i);
  });

  it('truncates JSONL parsing at the explicit event limit and reports source metadata', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'relay-codex-jsonl-event-limit-')
    );
    const sessionDir = path.join(root, 'rollout-2026-01-01T00-00-00');
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'event-limit-session.jsonl');
    const lines = Array.from({ length: 5_010 }, () => ({
      type: 'session.started',
      session_id: 'event-limit-session',
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
    await writeFile(
      sessionPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    );
    const adapter = new CodexJsonlStateAdapter({ stateRoot: root });

    const snapshot = await adapter.readProviderState({
      provider: 'codex',
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
  });

  it('imports a Codex JSONL fixture into an AgentSessionV2 read model with an audit marker', async () => {
    const { root, sessionPath } = await writeFixture();
    const adapter = new CodexJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'codex',
      nativeId: 'codex-abc',
      sourcePath: sessionPath,
    });

    expect(result.provider).toBe('codex');
    expect(result.session.provider).toBe('codex');
    expect(result.session.providerSession).toMatchObject({
      nativeId: 'codex-abc',
      sourcePath: sessionPath,
      stateKind: 'codex-jsonl',
    });
    expect(result.session.turns[0]?.items[0]).toMatchObject({
      type: 'providerExtension',
      namespace: 'provider-state-import',
      payload: {
        event: 'native-session-imported',
        sourceProvider: 'codex',
        readOnly: true,
      },
    });
    expect(result.session.turns[1]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'userMessage',
          text: expect.stringContaining('api_key=[redacted]'),
        }),
        expect.objectContaining({
          type: 'reasoning',
          summary: 'need to inspect files',
        }),
        expect.objectContaining({
          type: 'commandExecution',
          command: 'npm test',
        }),
        expect.objectContaining({
          type: 'assistantMessage',
          text: 'the codex adapter can read JSONL safely',
        }),
        expect.objectContaining({
          type: 'providerExtension',
          namespace: 'codex',
        }),
      ])
    );
    expect(JSON.stringify(result.session)).not.toContain('«redacted:sk-…»');
    expect(result.patches).toHaveLength(1);
    expect(result.patches.every(isAgentPatchV2)).toBe(true);
  });

  it('keeps mid-conversation assistant/tool-result records on one synthetic turn', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'relay-codex-jsonl-midturn-')
    );
    const sessionDir = path.join(root, 'rollout-2026-01-01T00-00-00');
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'midturn.jsonl');
    const lines = [
      {
        type: 'assistant',
        session_id: 'midturn',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'already working' }],
        },
      },
      {
        type: 'user',
        session_id: 'midturn',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'tool finished' }],
        },
      },
    ];
    await writeFile(
      sessionPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    );
    const adapter = new CodexJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'codex',
      nativeId: 'midturn',
      sourcePath: sessionPath,
    });
    const nonAuditTurns = result.session.turns.filter(
      (turn) => turn.id !== 'native-import-audit'
    );

    expect(nonAuditTurns).toHaveLength(1);
    expect(nonAuditTurns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'assistantMessage',
          text: 'already working',
        }),
        expect.objectContaining({
          type: 'providerExtension',
          namespace: 'codex',
        }),
      ])
    );
  });

  it('trims oversized imports FIFO while preserving the audit marker and reporting truncation', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'relay-codex-jsonl-large-')
    );
    const sessionDir = path.join(root, 'rollout-2026-01-01T00-00-00');
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'large-session.jsonl');
    const lines = [
      {
        type: 'session.started',
        session_id: 'large-session',
        cwd: '/tmp/repo',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        type: 'user',
        session_id: 'large-session',
        id: `large-user-${index}`,
        cwd: '/tmp/repo',
        timestamp: `2026-01-01T00:${String(index + 1).padStart(2, '0')}:00.000Z`,
        message: {
          role: 'user',
          content: `message-${index}:${'x'.repeat(20_000)}`,
        },
      })),
    ];
    await writeFile(
      sessionPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    );
    const adapter = new CodexJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:30:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'codex',
      nativeId: 'large-session',
      sourcePath: sessionPath,
    });

    expect(result.session.turns[0]?.id).toBe('native-import-audit');
    expect(result.importTruncation).toMatchObject({
      truncated: true,
      droppedTurns: expect.any(Number),
    });
    expect(result.session.config.providerOptions?.importTruncation).toEqual(
      result.importTruncation
    );
    expect(JSON.stringify(result.session)).not.toContain('message-0:');
    expect(JSON.stringify(result.session)).toContain('message-23:');
    expect(result.session.turns.length).toBeLessThan(lines.length);
  });

  it('returns bounded provider snapshots and copyable resume argv without executing it', async () => {
    const { root, sessionPath } = await writeFixture();
    const adapter = new CodexJsonlStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const snapshot = await adapter.readProviderState({
      provider: 'codex',
      nativeId: 'codex-abc',
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
      eventTypes: expect.arrayContaining([
        'session.started',
        'user',
        'assistant',
      ]),
      firstTimestamp: '2026-01-01T00:00:00.000Z',
      lastTimestamp: '2026-01-01T00:00:03.000Z',
    });
    expect(
      adapter.resumeCommand({ provider: 'codex', nativeId: 'codex-abc' })
    ).toEqual(['codex', '--resume', 'codex-abc']);
  });
});