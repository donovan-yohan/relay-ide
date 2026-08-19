/**
 * Offline transport double for the Codex app-server JSON-RPC client.
 *
 * `CodexNativeProtocolAdapter` takes a `CodexClientFactory` in its constructor,
 * so the conformance rig injects this stub instead of spawning
 * `codex app-server`. The stub is a faithful copy of the seam already used by
 * `codex-native-adapter.test.ts` (`StubCodexClient` / `makeStubFactory`),
 * lifted here so the conformance fixture and the deep tests drive the adapter
 * through exactly the same door.
 *
 * Everything here is Codex-local: the JSON-RPC call/notification/server-request
 * vocabulary is a provider quirk and never leaks into the shared harness.
 */
import { EventEmitter } from 'node:events';
import type {
  CodexAppServerClient,
  CodexAppServerClientOptions,
  CodexNotification,
  CodexServerRequest,
} from '../../../../../server/codex-app-server-client.js';
import type { CodexClientFactory } from '../../../../../server/protocol-adapters/codex-native-adapter.js';

/** One outbound RPC the adapter made, in call order. */
export interface StubCodexCall {
  method: string;
  params: unknown;
}

/**
 * Stub for `CodexAppServerClient`. `feedNotification` / `feedRequest` are the
 * inbound half (what the app-server would push at us); `calls` is the outbound
 * half (what the adapter asked the app-server to do), including the
 * `__respond:<id>` / `__error:<id>` pseudo-entries for server-request replies.
 */
export class StubCodexClient extends EventEmitter {
  readonly calls: StubCodexCall[] = [];
  /** Pre-seeded results per RPC method. An `Error` value makes the call reject. */
  readonly serverResponses = new Map<string, unknown>();
  stopped = false;

  async start(): Promise<void> {
    // The real client performs the initialize handshake here; nothing to do.
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params: params ?? null });
    if (this.serverResponses.has(method)) {
      const response = this.serverResponses.get(method);
      if (response instanceof Error) throw response;
      return response as T;
    }
    return {} as T;
  }

  respondToServerRequest(id: number | string, result: unknown): void {
    this.calls.push({ method: `__respond:${String(id)}`, params: result });
  }

  respondToServerRequestError(
    id: number | string,
    code: number,
    message: string
  ): void {
    this.calls.push({
      method: `__error:${String(id)}`,
      params: { code, message },
    });
  }

  async stop(_signal?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.emit('close', 0);
  }

  // ── Inbound feed helpers ───────────────────────────────────────────────

  /** Push a native `notification` frame (`turn/*`, `item/*`, `thread/*`). */
  feedNotification(method: string, params?: unknown): void {
    const notification: CodexNotification = { method, params };
    this.emit('notification', notification);
  }

  /** Push a native server-initiated `request` frame (approvals, elicitation). */
  feedRequest(id: number | string, method: string, params?: unknown): void {
    const request: CodexServerRequest = { id, method, params };
    this.emit('request', request);
  }
}

export interface CodexClientStubHarness {
  factory: CodexClientFactory;
  /** The stub the adapter is currently wired to. Re-read after any reconnect. */
  readonly client: StubCodexClient;
  /** Every stub handed out, oldest first. */
  readonly clients: readonly StubCodexClient[];
  readonly lastOptions: CodexAppServerClientOptions | undefined;
}

/**
 * Build a factory that hands the adapter a stub client. A second connect
 * generation (resume / reconnect) gets a fresh stub carrying the same seeded
 * responses, mirroring the real client's one-process-per-connection lifetime,
 * and `harness.client` always points at the live one.
 */
export function makeCodexClientStubHarness(
  seedResponses: Record<string, unknown> = {}
): CodexClientStubHarness {
  const newStub = (): StubCodexClient => {
    const stub = new StubCodexClient();
    for (const [method, response] of Object.entries(seedResponses)) {
      stub.serverResponses.set(method, response);
    }
    return stub;
  };

  const clients: StubCodexClient[] = [newStub()];
  let handedOut = 0;
  let lastOptions: CodexAppServerClientOptions | undefined;

  const factory: CodexClientFactory = (options) => {
    lastOptions = options;
    // The first factory call adopts the pre-built stub so a fixture can seed
    // responses before `connect()`; later generations get a fresh one.
    if (handedOut > 0) clients.push(newStub());
    handedOut += 1;
    return clients[clients.length - 1]! as unknown as CodexAppServerClient;
  };

  return {
    factory,
    get client() {
      return clients[clients.length - 1]!;
    },
    get clients() {
      return clients;
    },
    get lastOptions() {
      return lastOptions;
    },
  };
}
