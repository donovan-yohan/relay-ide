/**
 * Offline transport double for the `opencode-attached` adapter.
 *
 * `OpenCodeAttachedAdapter` spawns nothing: it talks to an already-running
 * `opencode serve` / `opencode web` over plain `fetch` (see
 * `server/protocol-adapters/opencode-attached-adapter.ts` lines 10-90 for the
 * endpoint, `/global/health` probe, and `/event` SSE wiring). So the seam is
 * `globalThis.fetch`, spied exactly the way `opencode-adapter.test.ts` already
 * spies it for the attached probe test (lines 126-151) — same routes, same
 * status codes, no new grammar.
 *
 * The `/event` route hands back a held-open `Response` whose body is a
 * `ReadableStream` this double owns. `push()` writes one real SSE frame
 * (`data: <json>\n\n`) into it, which lands in the adapter's own
 * `consumeSse` → `mapOpenCodeEvent` path — the identical dispatcher the
 * existing attached-adapter delta test drives directly (lines 175-187).
 *
 * Nothing here is opinionated about the conformance transcript: the double is
 * a server, the fixture is the script.
 */
import { vi } from 'vitest';

/** Every HTTP call the adapter made, in order, for post-run assertions. */
export interface RecordedOpenCodeRequest {
  method: string;
  url: string;
  body?: string;
}

export interface OpenCodeAttachedServerDouble {
  readonly endpoint: string;
  readonly requests: RecordedOpenCodeRequest[];
  /** Deliver one native OpenCode SSE event to every live `/event` reader. */
  push(event: unknown): void;
  /** End the SSE stream cleanly, as a server hang-up would. */
  closeEventStream(): void;
  /** Restore `globalThis.fetch` and drop any held-open stream. */
  dispose(): void;
}

export interface OpenCodeAttachedServerDoubleOptions {
  /** Must match `config.extra.endpoint`. Default is a fixed offline port. */
  endpoint?: string;
}

/**
 * Fixed, non-default port: the adapter's built-in default is
 * `http://127.0.0.1:4096`, and a real opencode server on the developer's box
 * must never be able to satisfy a conformance run by accident.
 */
export const CONFORMANCE_OPENCODE_ENDPOINT = 'http://127.0.0.1:14096';

export function makeOpenCodeAttachedServerDouble(
  options?: OpenCodeAttachedServerDoubleOptions
): OpenCodeAttachedServerDouble {
  const endpoint = (options?.endpoint ?? CONFORMANCE_OPENCODE_ENDPOINT).replace(
    /\/$/,
    ''
  );
  const requests: RecordedOpenCodeRequest[] = [];
  const encoder = new TextEncoder();
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const closeController = (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): void => {
    if (!controllers.delete(controller)) return;
    try {
      controller.close();
    } catch {
      // Already closed by a cancelled reader; nothing to unwind.
    }
  };

  const newEventStream = (
    signal: AbortSignal | null | undefined
  ): ReadableStream<Uint8Array> => {
    let owned: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        owned = controller;
        controllers.add(controller);
      },
      cancel() {
        if (owned) controllers.delete(owned);
      },
    });
    // `onDetach()` aborts the SSE controller. Closing (not erroring) the stream
    // makes the adapter's read loop finish normally, which is what a graceful
    // server hang-up looks like and keeps `AbortError` noise out of the run.
    if (signal && owned) {
      const controller = owned;
      if (signal.aborted) closeController(controller);
      else
        signal.addEventListener('abort', () => closeController(controller), {
          once: true,
        });
    }
    return stream;
  };

  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({
        method,
        url,
        ...(body === undefined ? {} : { body }),
      });

      // Health probe used by both `onConnect` and `probeOpenCodeAttachedApi`.
      if (url === `${endpoint}/global/health`) {
        return json({ healthy: true, version: 'conformance-double' });
      }

      // Held-open SSE stream — the adapter's only inbound channel.
      if (url === `${endpoint}/event`) {
        return new Response(newEventStream(init?.signal), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      }

      if (method === 'POST' && url.startsWith(`${endpoint}/session/`)) {
        if (url.endsWith('/prompt_async')) return json({ ok: true });
        if (url.endsWith('/abort')) return json(true);
      }

      if (
        method === 'POST' &&
        url.startsWith(`${endpoint}/permission/`) &&
        (url.endsWith('/allow') || url.endsWith('/deny'))
      ) {
        return json({ ok: true });
      }

      if (
        method === 'POST' &&
        url.startsWith(`${endpoint}/question/`) &&
        url.endsWith('/reply')
      ) {
        return json({ ok: true });
      }

      throw new Error(
        `opencode-attached conformance double: unexpected ${method} ${url}`
      );
    });

  return {
    endpoint,
    requests,
    push: (event) => {
      const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      for (const controller of [...controllers]) controller.enqueue(frame);
    },
    closeEventStream: () => {
      for (const controller of [...controllers]) closeController(controller);
    },
    dispose: () => {
      for (const controller of [...controllers]) closeController(controller);
      spy.mockRestore();
    },
  };
}
