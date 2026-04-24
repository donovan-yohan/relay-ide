import { test, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebSession } from '../server/web-session-handler.js';
import type { Session } from '../server/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STUB_SCRIPT = path.resolve(__dirname, 'fixtures', 'hermes-gateway-stub.cjs');

/**
 * End-to-end happy path for creating a Hermes web session.
 *
 * Spins up the mock Hermes gateway stub, creates a WebSession with
 * the Hermes adapter, sends a message, and verifies SSE events
 * flow through the canonical ChatEvent type system.
 */
test('hermes session happy path — connect, send message, receive streaming events', async () => {
  const sessionsMap = new Map<string, Session>();
  const onBackendStateChanged = vi.fn() as unknown as (session: Session) => void;

  const { session } = await createWebSession(
    {
      agentType: 'hermes',
      cwd: __dirname,
      repoPath: __dirname,
      repoName: 'hermes-test',
      branchName: 'main',
      displayName: 'Hermes E2E Test',
      port: 3000,
      configDir: __dirname,
      // Point the adapter at our mock stub instead of the real hermes binary
      extra: {
        command: process.execPath,
        args: [STUB_SCRIPT, '{{PORT}}'],
      },
    },
    sessionsMap,
    onBackendStateChanged
  );

  expect(session.mode).toBe('web');
  expect(session.adapterType).toBe('hermes');
  expect(session.agentState).toBe('idle');
  expect(sessionsMap.has(session.id)).toBe(true);

  // Send a message and collect events
  const events: import('../shared/chat-events.js').ChatEvent[] = [];
  const unbind = session.adapter.on((evt) => events.push(evt));

  const sendPromise = session.adapter.sendMessage('turn-1', 'hello hermes');

  // Wait for turn to become active
  await vi.waitFor(() => {
    expect(session.agentState).toBe('processing');
  });

  await sendPromise;

  // Wait for turn completion (idle state)
  await vi.waitFor(() => {
    expect(session.agentState).toBe('idle');
  });

  unbind();

  // Verify event sequence
  const textDeltas = events.filter((e) => e.type === 'chat:text-delta');
  const turnCompleted = events.find((e) => e.type === 'chat:turn-completed');

  expect(textDeltas.length).toBeGreaterThanOrEqual(1);
  expect(turnCompleted).toBeDefined();
  expect(turnCompleted!.reason).toBe('completed');

  // Cleanup
  await session.adapter.disconnect();
  sessionsMap.delete(session.id);
});
