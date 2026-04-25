import { test, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import getPort from 'get-port';
import { createWebSession } from '../server/web-session-handler.js';
import type { Session } from '../server/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STUB_SCRIPT = path.resolve(
  __dirname,
  'fixtures',
  'hermes-gateway-stub.cjs'
);

async function startHermesGatewayStub(): Promise<{
  child: ChildProcess;
  endpoint: string;
}> {
  const port = await getPort();
  const child = spawn(process.execPath, [STUB_SCRIPT, String(port)], {
    env: {
      ...process.env,
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: 'test-hermes-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Hermes gateway stub did not start within 5s'));
    }, 5000);
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Hermes gateway stub listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Hermes gateway stub exited with code ${code}: ${stderr}`)
      );
    });
  });

  return { child, endpoint: `http://127.0.0.1:${port}` };
}

/**
 * End-to-end happy path for creating a Hermes web session.
 *
 * Spins up the mock Hermes gateway stub, creates a WebSession with
 * the Hermes adapter, sends a message, and verifies SSE events
 * flow through the canonical ChatEvent type system.
 */
test('hermes session happy path — connect, send message, receive streaming events', async () => {
  const gateway = await startHermesGatewayStub();
  const sessionsMap = new Map<string, Session>();
  const onBackendStateChanged = vi.fn() as unknown as (
    session: Session
  ) => void;

  try {
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
        extra: {
          endpoint: gateway.endpoint,
          apiToken: 'test-hermes-key',
        },
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session.mode).toBe('web');
    expect(session.adapterType).toBe('hermes');
    expect(session.runtimeOwnership).toBe('attached');
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
  } finally {
    gateway.child.kill('SIGTERM');
  }
});
