import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as sessions from '../server/sessions.js';
import {
  closeInterventionLog,
  initInterventionLog,
} from '../server/intervention-log.js';
import { setupWebSocket } from '../server/ws.js';
import type { PtySession } from '../server/types.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import {
  testBrowserAuthTokens,
  testBrowserWsHeaders,
} from './helpers/ws-auth.js';

const execFileAsync = promisify(execFile);
const cleanupFns: Array<() => void | Promise<void>> = [];
const createdIds: string[] = [];
const originalTmuxTmpdir = process.env.TMUX_TMPDIR;
let tmuxTmpdir: string;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await Promise.race([
    once(ws, 'open'),
    delay(500).then(() => {
      throw new Error(`websocket did not open; readyState=${ws.readyState}`);
    }),
  ]);
}

async function waitForInterventionCount(
  sessionId: string,
  count: number
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (sessions.getInterventions(sessionId).length === count) return;
    await delay(10);
  }
  expect(sessions.getInterventions(sessionId)).toHaveLength(count);
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

beforeAll(() => {
  tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-ws-pty-'));
  process.env.TMUX_TMPDIR = tmuxTmpdir;
});

afterEach(async () => {
  const ids = new Set([
    ...createdIds,
    ...sessions.list().map((session) => session.id),
  ]);
  for (const id of Array.from(ids)) {
    try {
      sessions.kill(id);
    } catch {
      // Already gone.
    }
  }
  createdIds.length = 0;

  for (const cleanup of cleanupFns.splice(0).reverse()) {
    await cleanup();
  }

  closeInterventionLog();
  sessions.configure({});
  sessions.__resetStateChangeCallbacksForTests();
});

afterAll(async () => {
  await execFileAsync('tmux', ['kill-server'], {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir },
  }).catch(() => {});
  if (originalTmuxTmpdir === undefined) {
    delete process.env.TMUX_TMPDIR;
  } else {
    process.env.TMUX_TMPDIR = originalTmuxTmpdir;
  }
  fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
});

describe('PTY WebSocket intervention control', () => {
  it('records browser PTY input through the control engine without treating ping or resize as input', async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-ide-interventions-')
    );
    cleanupFns.push(() =>
      fs.rmSync(configDir, { recursive: true, force: true })
    );
    initInterventionLog(configDir);
    sessions.configure({ configDir, interventionDebounceMs: 5 });

    const server = http.createServer();
    const { wss } = setupWebSocket(
      server,
      testBrowserAuthTokens(),
      null,
      undefined,
      true
    );
    cleanupFns.push(() => closeServer(server));
    cleanupFns.push(() => wss.close());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const result = sessions.create({
      type: 'terminal',
      repoName: 'test-repo',
      repoPath: configDir,
      worktreePath: null,
      cwd: configDir,
      command: '/bin/sh',
      args: ['-c', 'while :; do sleep 1; done'],
      cols: 80,
      rows: 24,
      controlState: {
        controlMode: 'human-driven',
        activeActors: [{ kind: 'human', id: 'local-user' }],
        lastInterventionAt: null,
        lastInterventionBy: null,
        lastInterventionEventId: null,
        controlFreshness: 'fresh',
      },
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id);
    expect(session?.mode).toBe('pty');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/${result.id}`, {
      headers: testBrowserWsHeaders(),
    });
    cleanupFns.push(() => ws.terminate());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'ping' }));
    await delay(20);

    ws.send(JSON.stringify({ type: 'resize', cols: 101, rows: 33 }));
    await delay(20);

    for (const invalidResize of [
      { type: 'resize', cols: 0, rows: 33 },
      { type: 'resize', cols: 101, rows: 0 },
      { type: 'resize', cols: '101', rows: 33 },
      { type: 'resize', cols: 101 },
    ]) {
      ws.send(JSON.stringify(invalidResize));
    }
    await delay(20);

    expect(sessions.getInterventions(result.id)).toEqual([]);
    expect(
      (sessions.get(result.id) as PtySession).controlState?.controlMode
    ).toBe('human-driven');

    ws.send('hello from browser\n');
    await waitForInterventionCount(result.id, 1);

    const records = sessions.getInterventions(result.id);
    expect(records[0]).toMatchObject({
      sessionId: result.id,
      source: 'pty-input',
      kind: 'human-input',
      modeBefore: 'human-driven',
      modeAfter: 'human-driven',
    });
    expect((sessions.get(result.id) as PtySession).controlState).toMatchObject({
      controlMode: 'human-driven',
      controlReason: 'human input',
      lastInterventionEventId: records[0]!.id,
    });
  });

  it('records remote routed PTY input through the real sessions recorder', async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-ide-routed-interventions-')
    );
    cleanupFns.push(() =>
      fs.rmSync(configDir, { recursive: true, force: true })
    );
    initInterventionLog(configDir);
    sessions.configure({ configDir, interventionDebounceMs: 5 });

    const events: Array<
      Parameters<Parameters<typeof sessions.onControlEvent>[0]>[0]
    > = [];
    sessions.onControlEvent((event) => events.push(event));

    sessions.recordRoutedPtyInput({
      nodeId: 'remote-node-a',
      sessionId: 'remote-session-a',
      data: 'echo routed\\n',
    });

    await waitForInterventionCount('remote-session-a', 1);
    const records = sessions.getInterventions('remote-session-a', {
      nodeId: 'remote-node-a',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: 'remote-session-a',
      tabId: 'remote-node-a:remote-session-a',
      nodeId: 'remote-node-a',
      globalSessionId: 'remote-node-a:remote-session-a',
      source: 'pty-input',
      kind: 'human-input',
      modeBefore: 'human-driven',
      modeAfter: 'human-driven',
      payloadPreview: 'echo routed\\n',
    });
    expect(events.map((event) => event.type)).toEqual(['tab.intervention']);
    expect(events[0]?.identity).toMatchObject({
      nodeId: 'remote-node-a',
      sessionId: 'remote-session-a',
      globalSessionId: 'remote-node-a:remote-session-a',
    });
  });

  it('still appends control audit entries when a control-event listener throws', async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-ide-audit-isolation-')
    );
    cleanupFns.push(() =>
      fs.rmSync(configDir, { recursive: true, force: true })
    );
    initInterventionLog(configDir);
    const auditEntries: SecurityAuditEntryInput[] = [];
    sessions.configure({
      configDir,
      interventionDebounceMs: 5,
      securityAuditSink: { append: (entry) => auditEntries.push(entry) },
    });
    const deliveredEvents: Array<
      Parameters<Parameters<typeof sessions.onControlEvent>[0]>[0]
    > = [];
    sessions.onControlEvent(() => {
      throw new Error('listener boom');
    });
    sessions.onControlEvent((event) => deliveredEvents.push(event));
    expect(() =>
      sessions.recordRoutedPtyInput({
        nodeId: 'remote-node-a',
        sessionId: 'remote-session-a-throw',
        data: 'echo audited\\n',
      })
    ).not.toThrow();
    await waitForInterventionCount('remote-session-a-throw', 1);
    expect(deliveredEvents.map((event) => event.type)).toEqual([
      'tab.intervention',
    ]);
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries.map((entry) => entry.intent.action)).toEqual([
      'tab.intervention',
    ]);
    expect(auditEntries.map((entry) => entry.eventType)).toEqual([
      'bridge_event',
    ]);
  });
});
