/**
 * Offline transport double for the `opencode` conformance fixture.
 *
 * OpenCode is a two-plane provider and the double keeps those planes separate,
 * exactly as the real transport does:
 *
 * - **Command plane** — an HTTP surface the adapter drives with `fetch`
 *   (`/global/health`, `POST /session`, `POST /session/:id/message`,
 *   `POST /session/:id/abort`, `POST /session/:id/permissions/:requestId`).
 *   Scripted here with a `vi.spyOn(globalThis, 'fetch')` responder, the same
 *   seam `opencode-adapter.test.ts` already uses (lines 41-108).
 * - **Event plane** — the SSE subscription on `/global/event`. The fixture
 *   feeds native events straight into the adapter's `mapOpenCodeEvent`
 *   dispatcher (the repo-blessed seam behind `driveOpenCodeEvent`), so this
 *   double only has to keep the stream *open* rather than re-encode SSE frames.
 *
 * The one thing the double must get right beyond "answer the request" is
 * TIMING. An OpenCode turn is bounded by the message POST: the adapter fires
 * `chat:turn-completed` when that response lands. So the POST is deferred — it
 * stays in flight while the fixture streams events into the event plane, and a
 * fixture step completes it to end the turn. `interrupt()` and the toast-driven
 * failure path both work by aborting that same in-flight request, which is why
 * the double honours `init.signal`.
 *
 * Everything here is offline: no port is opened, no `opencode` binary runs, and
 * the spawned child is inert.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { vi } from 'vitest';

/**
 * Provider session id `POST /session` hands back. Fixed rather than generated:
 * the conformance floor replays every transcript and compares patch payloads,
 * and this id reaches the wire on every later request path.
 */
export const OPENCODE_SESSION_ID = 'opencode-conf-session';

/** Pid handed to the inert child, for the same replay-stability reason. */
const STUB_CHILD_PID = 4343;

export interface OpenCodeTransportStub {
  /** Injected into `new OpenCodeProtocolAdapter(spawnFn)`. */
  spawnFn: typeof spawn;
  /** Commands spawned so far. Inspected by tests, never by the harness. */
  spawns: Array<{ command: string; args: readonly string[] }>;
  /**
   * Complete the in-flight `POST /session/:id/message` with `body`, which is
   * what ends an OpenCode turn. Waits briefly for the request to appear so a
   * fixture step never races `sendMessage`.
   */
  completeMessagePost(body: unknown): Promise<void>;
  /** Restore the real `fetch` and close any still-open SSE body. */
  restore(): void;
}

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: unknown): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathnameOf(input: unknown): string {
  const raw = String(input);
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The rejection undici hands a caller whose request signal aborted. */
function abortError(signal: AbortSignal | null | undefined): unknown {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function makeInertChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: STUB_CHILD_PID,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

export function makeOpenCodeTransportStub(): OpenCodeTransportStub {
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const sseClosers: Array<() => void> = [];
  let pendingMessage: PendingRequest | null = null;

  const spawnFn = ((command: string, args: readonly string[]) => {
    spawns.push({ command, args });
    return makeInertChild();
  }) as unknown as typeof spawn;

  /**
   * A `/global/event` body that stays open until the adapter aborts its SSE
   * controller on teardown. Closing (rather than erroring) the stream lets
   * `consumeSse` unwind through its normal end-of-stream path, so teardown
   * emits no spurious `chat:error`.
   */
  const sseResponse = (signal: AbortSignal | null | undefined): Response => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        /* already closed by the consumer */
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        if (signal?.aborted) close();
      },
    });
    signal?.addEventListener('abort', close, { once: true });
    sseClosers.push(close);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  const messagePost = (
    signal: AbortSignal | null | undefined
  ): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const entry: PendingRequest = { resolve, reject };
      pendingMessage = entry;
      signal?.addEventListener(
        'abort',
        () => {
          if (pendingMessage === entry) pendingMessage = null;
          reject(abortError(signal));
        },
        { once: true }
      );
    });

  const messagePath = `/session/${OPENCODE_SESSION_ID}/message`;
  const abortPath = `/session/${OPENCODE_SESSION_ID}/abort`;
  const permissionPrefix = `/session/${OPENCODE_SESSION_ID}/permissions/`;

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (
    input: unknown,
    init?: RequestInit
  ): Promise<Response> => {
    const path = pathnameOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const signal = init?.signal;

    if (path === '/global/health') return jsonResponse({});
    if (path === '/global/event') return sseResponse(signal);
    if (path === '/session' && method === 'POST') {
      return jsonResponse({
        id: OPENCODE_SESSION_ID,
        title: 'Relay conformance',
      });
    }
    if (path === messagePath && method === 'POST') return messagePost(signal);
    if (path === abortPath && method === 'POST') return jsonResponse(true);
    if (path.startsWith(permissionPrefix) && method === 'POST') {
      return jsonResponse(true);
    }
    // Loud on purpose: an unscripted request means the adapter grew a call
    // the conformance transcript does not model.
    throw new Error(
      `opencode conformance stub: unscripted request ${method} ${path}`
    );
  }) as unknown as typeof fetch);

  return {
    spawnFn,
    spawns,
    completeMessagePost: async (body) => {
      const deadline = Date.now() + 1_000;
      while (!pendingMessage && Date.now() < deadline) await sleep(1);
      const entry = pendingMessage;
      if (!entry) {
        throw new Error(
          'opencode conformance stub: no message POST is in flight to complete'
        );
      }
      pendingMessage = null;
      entry.resolve(jsonResponse(body));
    },
    restore: () => {
      for (const close of sseClosers.splice(0)) close();
      fetchSpy.mockRestore();
    },
  };
}
