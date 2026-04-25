import { test, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebSession } from '../server/web-session-handler.js';
import type { Session } from '../server/types.js';
import type { ChatEvent } from '../shared/chat-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_SCRIPT = path.resolve(
  __dirname,
  'fixtures',
  'opencode-serve-stub.cjs'
);

test('opencode web session sends prompts through serve API and receives streamed events', async () => {
  const sessionsMap = new Map<string, Session>();
  const onBackendStateChanged = vi.fn<(session: Session) => void>();

  const { session } = await createWebSession(
    {
      agentType: 'opencode',
      cwd: __dirname,
      repoPath: __dirname,
      repoName: 'opencode-test',
      branchName: 'main',
      displayName: 'OpenCode E2E Test',
      port: 3000,
      configDir: __dirname,
      extra: {
        command: process.execPath,
        args: [STUB_SCRIPT, '--port', '{{PORT}}'],
      },
    },
    sessionsMap,
    onBackendStateChanged
  );

  expect(session.mode).toBe('web');
  expect(session.adapterType).toBe('opencode');
  expect(session.agentState).toBe('idle');

  const events: ChatEvent[] = [];
  const unbind = session.adapter.on((evt) => events.push(evt));

  await session.adapter.sendMessage('turn-1', 'hello opencode');

  await vi.waitFor(
    () => {
      expect(session.agentState).toBe('idle');
      expect(events.some((e) => e.type === 'chat:text-delta')).toBe(true);
      expect(
        events.some(
          (e) =>
            e.type === 'chat:message-complete' &&
            e.role === 'user' &&
            e.content === 'hello opencode'
        )
      ).toBe(true);
      expect(events.some((e) => e.type === 'chat:turn-completed')).toBe(true);
    },
    { timeout: 5000, interval: 25 }
  );

  const text = events
    .filter((e) => e.type === 'chat:text-delta')
    .map((e) => e.delta)
    .join('');
  expect(text).toContain('hello from opencode');

  unbind();
  await session.adapter.disconnect();
  sessionsMap.delete(session.id);
});

test('opencode web session surfaces toast errors and releases the active turn', async () => {
  const sessionsMap = new Map<string, Session>();
  const onBackendStateChanged = vi.fn<(session: Session) => void>();

  const { session } = await createWebSession(
    {
      agentType: 'opencode',
      cwd: __dirname,
      repoPath: __dirname,
      repoName: 'opencode-test',
      branchName: 'main',
      displayName: 'OpenCode E2E Test',
      port: 3000,
      configDir: __dirname,
      extra: {
        command: process.execPath,
        args: [STUB_SCRIPT, '--port', '{{PORT}}'],
      },
    },
    sessionsMap,
    onBackendStateChanged
  );

  await session.adapter.sendMessage('turn-error', 'toast-error');

  await vi.waitFor(
    () => {
      expect(session.agentState).toBe('error');
      expect(session.currentTurnId).toBeNull();
      expect(session.agentSessionV2.live).toMatchObject({
        status: 'error',
        activeTurnId: null,
        error: 'OpenCode: stub toast failure',
      });
      expect(session.agentSessionV2.turns[0]).toMatchObject({
        id: 'turn-error',
        status: 'failed',
        error: 'OpenCode: stub toast failure',
      });
    },
    { timeout: 5000, interval: 25 }
  );

  await session.adapter.disconnect();
  sessionsMap.delete(session.id);
});

test('opencode web session treats retry errors with messages as terminal failures', async () => {
  const sessionsMap = new Map<string, Session>();
  const onBackendStateChanged = vi.fn<(session: Session) => void>();

  const { session } = await createWebSession(
    {
      agentType: 'opencode',
      cwd: __dirname,
      repoPath: __dirname,
      repoName: 'opencode-test',
      branchName: 'main',
      displayName: 'OpenCode E2E Test',
      port: 3000,
      configDir: __dirname,
      extra: {
        command: process.execPath,
        args: [STUB_SCRIPT, '--port', '{{PORT}}'],
      },
    },
    sessionsMap,
    onBackendStateChanged
  );

  await session.adapter.sendMessage('turn-retry', 'retry-error');

  await vi.waitFor(
    () => {
      expect(session.agentState).toBe('error');
      expect(session.idle).toBe(true);
      expect(session.currentTurnId).toBeNull();
      expect(session.agentSessionV2.live).toMatchObject({
        status: 'error',
        activeTurnId: null,
        error: 'UnknownError',
      });
      expect(session.agentSessionV2.turns[0]).toMatchObject({
        id: 'turn-retry',
        status: 'failed',
        error: 'UnknownError',
      });
    },
    { timeout: 5000, interval: 25 }
  );

  await session.adapter.disconnect();
  sessionsMap.delete(session.id);
});
