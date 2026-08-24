import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';
import { PrimeAgentStateAdapter } from '../../../server/provider-state/prime-agent-state-adapter.js';

/**
 * Synthetic Prime Agent transcript fixtures shaped like real
 * `~/.prime/agent/sessions/<uuid>.jsonl` files (verified ground truth for
 * #1426): a `type:"session"` v3 header, then typed events with `message`
 * envelopes (roles user/assistant/toolResult, blocks text/thinking/toolCall).
 * Tests never read the real `~/.prime` store.
 */

function primeHeaderLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: '019f1111-2222-7333-8444-555566667777',
    timestamp: '2026-08-01T00:00:00.000Z',
    cwd: '/tmp/repo',
    git: {
      repoUrl: 'https://github.com/donovan-yohan/relay-ide.git',
      commit: 'e70ac46076d09a599ce3f9635d075d3ad6ef4617',
      branch: 'feat/native-prime-sessions',
    },
    rlmDepth: 0,
    ...overrides,
  });
}

async function writePrimeFixture(): Promise<{
  root: string;
  sessionPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-prime-sessions-'));
  // Prime keeps this directory FLAT: one <uuid>.jsonl per session. A
  // subdirectory here must never appear as a listed session.
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await writeFile(path.join(root, 'logs', 'agent.jsonl'), '{"type":"log"}\n');

  const sessionPath = path.join(
    root,
    '019f1111-2222-7333-8444-555566667777.jsonl'
  );
  const lines = [
    primeHeaderLine(),
    JSON.stringify({
      type: 'thinking_level_change',
      id: 'aaa11111',
      parentId: null,
      timestamp: '2026-08-01T00:00:00.100Z',
      thinkingLevel: 'medium',
    }),
    JSON.stringify({
      type: 'model_change',
      id: 'bbb22222',
      parentId: 'aaa11111',
      timestamp: '2026-08-01T00:00:01.000Z',
      provider: 'openai-codex',
      modelId: 'gpt-5.6-sol',
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-user-1',
      parentId: 'bbb22222',
      timestamp: '2026-08-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'check the api_key=secret123 setup' }],
        timestamp: 1754000000000,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-asst-1',
      parentId: 'msg-user-1',
      timestamp: '2026-08-01T00:00:03.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need to inspect files' },
          {
            type: 'toolCall',
            id: 'call_abc123',
            name: 'ipython',
            arguments: {
              code: 'print(open("/tmp/creds").read())',
              apiKey: 'supersecret',
            },
          },
          {
            type: 'text',
            text: 'the prime agent adapter can read JSONL safely',
          },
        ],
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        stopReason: 'stop',
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-tool-1',
      parentId: 'msg-asst-1',
      timestamp: '2026-08-01T00:00:04.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call_abc123',
        toolName: 'ipython',
        content: [
          {
            type: 'text',
            text: 'stdout had ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'agent_status',
      id: 'ccc33333',
      parentId: 'msg-tool-1',
      timestamp: '2026-08-01T00:00:05.000Z',
      status: { summary: '', taskState: 'needs_input' },
    }),
  ];
  await writeFile(sessionPath, `${lines.join('\n')}\n`);
  return { root, sessionPath };
}

describe('PrimeAgentStateAdapter', () => {
  it('detects readable Prime Agent sessions and lists redacted native summaries', async () => {
    const { root, sessionPath } = await writePrimeFixture();
    const adapter = new PrimeAgentStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-01T00:10:00.000Z'),
    });

    await expect(adapter.detectInstall()).resolves.toMatchObject({
      provider: 'prime-agent',
      status: 'installed',
      stateRoots: [root],
    });

    const sessions = await adapter.listNativeSessions({ cwd: '/tmp/repo' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: 'prime-agent',
      nativeId: '019f1111-2222-7333-8444-555566667777',
      sourcePath: sessionPath,
      cwd: '/tmp/repo',
      repoPath: 'https://github.com/donovan-yohan/relay-ide.git',
      worktreePath: 'feat/native-prime-sessions',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastMessageAt: '2026-08-01T00:00:05.000Z',
      capabilities: {
        canImportTranscript: true,
        canReadProviderState: true,
        canResumeNative: true,
        canStreamLiveEvents: true,
        readOnly: true,
      },
    });
    expect(sessions[0]?.preview.source).toBe('transcript');
    expect(sessions[0]?.preview.text).toContain('api_key=[redacted]');
    expect(sessions[0]?.preview.text).not.toContain('secret123');
  });

  it('excludes subdirectories and non-transcript artifacts from listing', async () => {
    const { root, sessionPath } = await writePrimeFixture();
    const adapter = new PrimeAgentStateAdapter({ stateRoot: root });

    const sessions = await adapter.listNativeSessions();
    expect(sessions.map((session) => session.sourcePath)).toEqual([
      sessionPath,
    ]);
    void root;
  });

  it('rejects caller-provided source paths outside the configured state root', async () => {
    const { root } = await writePrimeFixture();
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-prime-sessions-outside-')
    );
    const outsidePath = path.join(outsideRoot, 'escape.jsonl');
    await writeFile(
      outsidePath,
      `${primeHeaderLine({ id: 'escape-session' })}\n`
    );
    const adapter = new PrimeAgentStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'prime-agent',
        nativeId: 'escape-session',
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
    const { root } = await writePrimeFixture();
    // Prime keeps sessions at the top level; a stray non-JSONL file there must
    // still be rejected on direct ref reads.
    const nonJsonlPath = path.join(root, 'not-json.txt');
    await writeFile(nonJsonlPath, '{}\n');
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-prime-sessions-symlink-')
    );
    const outsidePath = path.join(outsideRoot, 'outside.jsonl');
    await writeFile(outsidePath, `${primeHeaderLine({ id: 'outside' })}\n`);
    const linkPath = path.join(root, 'linked-outside.jsonl');
    const { symlink } = await import('node:fs/promises');
    await symlink(outsidePath, linkPath);
    const adapter = new PrimeAgentStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'prime-agent',
        nativeId: 'not-json',
        sourcePath: nonJsonlPath,
      })
    ).rejects.toThrow(/jsonl/i);
    await expect(
      adapter.readProviderState({
        provider: 'prime-agent',
        nativeId: 'outside',
        sourcePath: linkPath,
      })
    ).rejects.toThrow(/symlink/i);
  });

  it('truncates JSONL parsing at the explicit event limit and reports source metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-prime-event-limit-'));
    const sessionPath = path.join(root, 'event-limit.jsonl');
    const lines = [
      primeHeaderLine({ id: 'event-limit' }),
      ...Array.from({ length: 5_005 }, (_, index) =>
        JSON.stringify({
          type: 'agent_status',
          id: `st-${index}`,
          parentId: null,
          timestamp: '2026-08-01T00:00:00.000Z',
          status: { summary: '', taskState: 'idle' },
        })
      ),
    ];
    await writeFile(sessionPath, `${lines.join('\n')}\n`);
    const adapter = new PrimeAgentStateAdapter({ stateRoot: root });

    const snapshot = await adapter.readProviderState({
      provider: 'prime-agent',
      nativeId: 'event-limit',
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

  it('imports a Prime Agent JSONL fixture into an AgentSessionV2 read model with an audit marker', async () => {
    const { root, sessionPath } = await writePrimeFixture();
    const adapter = new PrimeAgentStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-01T00:10:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'prime-agent',
      nativeId: '019f1111-2222-7333-8444-555566667777',
      sourcePath: sessionPath,
    });

    expect(result.provider).toBe('prime-agent');
    expect(result.session.provider).toBe('prime-agent');
    expect(result.session.providerSession).toMatchObject({
      nativeId: '019f1111-2222-7333-8444-555566667777',
      sourcePath: sessionPath,
      stateKind: 'prime-agent-jsonl',
    });
    expect(result.session.turns[0]?.items[0]).toMatchObject({
      type: 'providerExtension',
      namespace: 'provider-state-import',
      payload: {
        event: 'native-session-imported',
        sourceProvider: 'prime-agent',
        readOnly: true,
      },
    });
    // One turn per user prompt; assistant blocks + tool result ride along.
    const conversationTurn = result.session.turns[1];
    expect(conversationTurn?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'userMessage',
          text: 'check the api_key=[redacted] setup',
        }),
        expect.objectContaining({
          type: 'reasoning',
          summary: 'need to inspect files',
        }),
        expect.objectContaining({
          type: 'dynamicToolCall',
          namespace: 'prime-agent',
        }),
        expect.objectContaining({
          type: 'assistantMessage',
          text: 'the prime agent adapter can read JSONL safely',
        }),
        expect.objectContaining({
          type: 'providerExtension',
          namespace: 'prime-agent',
        }),
      ])
    );
    expect(JSON.stringify(result.session)).not.toContain('supersecret');
    expect(JSON.stringify(result.session)).not.toContain('ghp_AAAAAAAA');
    expect(result.patches).toHaveLength(1);
    expect(result.patches.every(isAgentPatchV2)).toBe(true);
  });

  it('is deterministic: the same fixture imports to identical session bytes', async () => {
    const { root, sessionPath } = await writePrimeFixture();
    const adapter = new PrimeAgentStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-01T00:10:00.000Z'),
    });
    const ref = {
      provider: 'prime-agent' as const,
      nativeId: '019f1111-2222-7333-8444-555566667777',
      sourcePath: sessionPath,
    };
    const a = await adapter.importSession(ref);
    const b = await adapter.importSession(ref);
    expect(JSON.stringify(b.session.turns)).toBe(
      JSON.stringify(a.session.turns)
    );
  });

  it('trims oversized imports FIFO while preserving the audit marker and reporting truncation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-prime-large-'));
    const sessionPath = path.join(root, 'large.jsonl');
    const lines = [
      primeHeaderLine({ id: 'large-session' }),
      ...Array.from({ length: 24 }, (_, index) =>
        JSON.stringify({
          type: 'message',
          id: `large-user-${index}`,
          parentId: index === 0 ? null : `large-user-${index - 1}`,
          timestamp: `2026-08-01T00:${String(index + 1).padStart(2, '0')}:00.000Z`,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: `message-${index}:${'x'.repeat(20_000)}` },
            ],
          },
        })
      ),
    ];
    await writeFile(sessionPath, `${lines.join('\n')}\n`);
    const adapter = new PrimeAgentStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'prime-agent',
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
    const { root, sessionPath } = await writePrimeFixture();
    const adapter = new PrimeAgentStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-01T00:10:00.000Z'),
    });

    const snapshot = await adapter.readProviderState({
      provider: 'prime-agent',
      nativeId: '019f1111-2222-7333-8444-555566667777',
      sourcePath: sessionPath,
    });

    expect(snapshot.redaction).toEqual({
      rawPayloadStored: false,
      strategy: 'preview',
      classes: ['credential', 'secret', 'payload', 'transcript'],
    });
    expect(snapshot.summary).toMatchObject({
      lineCount: 7,
      byteCount: expect.any(Number),
      hashSha256: expect.any(String),
      eventTypes: expect.arrayContaining([
        'session',
        'message',
        'model_change',
        'agent_status',
      ]),
      firstTimestamp: '2026-08-01T00:00:00.000Z',
      lastTimestamp: '2026-08-01T00:00:05.000Z',
    });
    // Copyable argv mirroring prime-agent-adapter.ts; never executed here.
    expect(
      adapter.resumeCommand({
        provider: 'prime-agent',
        nativeId: '019f1111-2222-7333-8444-555566667777',
      })
    ).toEqual([
      'prime-agent',
      '--resume',
      '019f1111-2222-7333-8444-555566667777',
    ]);
    expect(adapter.provider).toBe('prime-agent');
  });
});
