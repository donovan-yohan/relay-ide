import { afterEach, describe, expect, it } from 'vitest';
import { createWebSession } from '../server/web-session-handler.js';
import type { Session, WebSession } from '../server/types.js';

const sessionsMap = new Map<string, Session>();

async function cleanupSessions(): Promise<void> {
  await Promise.all(
    [...sessionsMap.values()].map(async (session) => {
      if (session.mode !== 'web') return;
      await session.adapterV2?.disconnect().catch(() => {});
      await session.adapter.disconnect().catch(() => {});
    })
  );
  sessionsMap.clear();
}

async function createMockWebSession(): Promise<WebSession> {
  const { session } = await createWebSession(
    {
      id: 'web-v2-session',
      agentType: 'mock',
      cwd: '/tmp/repo',
      repoPath: '/tmp/repo',
      repoName: 'repo',
      worktreePath: null,
      branchName: 'main',
      displayName: 'Mock Web',
      port: 3456,
      configDir: '/tmp/relay-config',
    },
    sessionsMap,
    () => {}
  );
  return session;
}

describe('web session v2 state', () => {
  afterEach(async () => {
    await cleanupSessions();
  });

  it('initializes web sessions with canonical agent chat v2 state', async () => {
    const session = await createMockWebSession();

    expect(session.protocolVersion).toBe(2);
    expect(session.adapterV2?.agentType).toBe('mock');
    expect(session.agentSessionV2).toMatchObject({
      id: 'web-v2-session',
      provider: 'mock',
      config: { cwd: '/tmp/repo' },
      live: { status: 'idle' },
    });
    expect(session.agentPatchesV2).toEqual([
      expect.objectContaining({ type: 'agent-live-state-updated-v2' }),
    ]);
  });

  it('reduces native v2 adapter patches into reconnectable transcript state', async () => {
    const session = await createMockWebSession();

    await session.adapterV2?.sendMessage({
      turnId: 'turn-1',
      content: 'hello from web',
    });

    expect(session.currentTurnId).toBeNull();
    expect(session.agentState).toBe('idle');
    expect(session.agentSessionV2.turns).toHaveLength(1);
    expect(session.agentSessionV2.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'userMessage',
          text: 'hello from web',
        }),
        expect.objectContaining({
          type: 'assistantMessage',
          text: 'Mock v2 response complete.',
          status: 'completed',
        }),
        expect.objectContaining({ type: 'reasoning' }),
        expect.objectContaining({ type: 'commandExecution' }),
        expect.objectContaining({ type: 'fileChange' }),
        expect.objectContaining({ type: 'dynamicToolCall' }),
        expect.objectContaining({ type: 'providerExtension' }),
      ])
    );
    expect(session.agentPatchesV2.map((patch) => patch.type)).toContain(
      'agent-turn-completed-v2'
    );
  });
});
