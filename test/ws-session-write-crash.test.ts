import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  applyTerminalPtyMessage,
  resolveLocalWebSocketSessionId,
  TERMINAL_WS_SESSION_NOT_FOUND_CLOSE_CODE,
} from '../server/ws.js';

// #905: a stale browser tab writing/resizing to a reaped PTY session used to
// throw `Session not found: <id>` synchronously out of the ws 'message'
// callback, which is an uncaught exception that killed the whole hub process.
// applyTerminalPtyMessage must absorb that specific throw, close the socket with
// a typed code, and never let it propagate.
//
// Protocol note: the terminal client (frontend/src/lib/ws.ts) only renders
// recognized TerminalStreamEnvelope JSON or raw bytes — a JSON error blob would
// be painted as terminal garbage. So instead of an in-band error envelope we
// close with application close code 4404 'session-not-found'. The frontend's
// onclose treats any non-1000 code as a reconnect trigger, re-checks /sessions,
// and renders `[session ended]` when the session is gone — the desired UX.

interface FakeWs {
  readyState: number;
  readonly OPEN: number;
  closes: Array<{ code?: number; reason?: string }>;
  close(code?: number, reason?: string): void;
}

function createFakeWs(open = true): FakeWs {
  const OPEN = 1;
  return {
    OPEN,
    readyState: open ? OPEN : 3 /* CLOSED */,
    closes: [],
    close(code?: number, reason?: string) {
      this.closes.push({ code, reason });
      this.readyState = 3;
    },
  };
}

function notFoundSink(id: string) {
  const throwNotFound = () => {
    throw new Error(`Session not found: ${id}`);
  };
  return { resize: throwNotFound, write: throwNotFound };
}

describe('applyTerminalPtyMessage (#905 reaped-session write crash)', () => {
  it('does not throw when a write targets a reaped session', () => {
    const ws = createFakeWs();
    const outcome = applyTerminalPtyMessage(
      ws as unknown as WebSocket,
      'gone-session',
      notFoundSink('gone-session'),
      { kind: 'write', data: 'ls\n' }
    );
    expect(outcome).toBe('session-not-found');
  });

  it('closes the socket with the typed session-not-found code on write', () => {
    const ws = createFakeWs();
    applyTerminalPtyMessage(
      ws as unknown as WebSocket,
      'gone-session',
      notFoundSink('gone-session'),
      { kind: 'write', data: 'ls\n' }
    );
    expect(ws.closes).toHaveLength(1);
    expect(ws.closes[0]).toEqual({
      code: TERMINAL_WS_SESSION_NOT_FOUND_CLOSE_CODE,
      reason: 'session-not-found',
    });
    expect(TERMINAL_WS_SESSION_NOT_FOUND_CLOSE_CODE).toBe(4404);
  });

  it('does not throw when a resize targets a reaped session', () => {
    const ws = createFakeWs();
    const outcome = applyTerminalPtyMessage(
      ws as unknown as WebSocket,
      'gone-session',
      notFoundSink('gone-session'),
      { kind: 'resize', cols: 80, rows: 24, apply: true }
    );
    expect(outcome).toBe('session-not-found');
    expect(ws.closes[0]?.code).toBe(TERMINAL_WS_SESSION_NOT_FOUND_CLOSE_CODE);
  });

  it('skips the resize side effect (and never throws) when not the active owner', () => {
    const ws = createFakeWs();
    let resized = false;
    const outcome = applyTerminalPtyMessage(
      ws as unknown as WebSocket,
      'gone-session',
      {
        resize: () => {
          resized = true;
        },
        write: () => {},
      },
      { kind: 'resize', cols: 80, rows: 24, apply: false }
    );
    expect(outcome).toBeNull();
    expect(resized).toBe(false);
    expect(ws.closes).toHaveLength(0);
  });

  it('does not attempt to close an already-closed socket', () => {
    const ws = createFakeWs(false);
    const outcome = applyTerminalPtyMessage(
      ws as unknown as WebSocket,
      'gone-session',
      notFoundSink('gone-session'),
      { kind: 'write', data: 'x' }
    );
    expect(outcome).toBe('session-not-found');
    expect(ws.closes).toHaveLength(0);
  });

  it('re-throws non-session-not-found errors so genuine faults stay visible', () => {
    const ws = createFakeWs();
    const sink = {
      resize: () => {},
      write: () => {
        throw new Error('disk on fire');
      },
    };
    expect(() =>
      applyTerminalPtyMessage(
        ws as unknown as WebSocket,
        'live-session',
        sink,
        {
          kind: 'write',
          data: 'x',
        }
      )
    ).toThrow('disk on fire');
    expect(ws.closes).toHaveLength(0);
  });

  it('applies a normal write to a live session and reports applied', () => {
    const ws = createFakeWs();
    const writes: string[] = [];
    const outcome = applyTerminalPtyMessage(
      ws as unknown as WebSocket,
      'live-session',
      {
        resize: () => {},
        write: (_id, data) => {
          writes.push(data);
        },
      },
      { kind: 'write', data: 'echo hi\n' }
    );
    expect(outcome).toBe('applied');
    expect(writes).toEqual(['echo hi\n']);
    expect(ws.closes).toHaveLength(0);
  });
});

describe('resolveLocalWebSocketSessionId', () => {
  it('accepts raw local session ids', () => {
    expect(resolveLocalWebSocketSessionId('c0dbeb605f82d893')).toBe(
      'c0dbeb605f82d893'
    );
  });

  it('accepts scoped local session ids for cached chat bundles', () => {
    expect(resolveLocalWebSocketSessionId('local:c0dbeb605f82d893')).toBe(
      'c0dbeb605f82d893'
    );
  });

  it('rejects non-local scoped session ids on the local websocket route', () => {
    expect(
      resolveLocalWebSocketSessionId('node-a:c0dbeb605f82d893')
    ).toBeNull();
  });
});
