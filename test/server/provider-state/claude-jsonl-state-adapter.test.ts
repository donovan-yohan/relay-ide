import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
