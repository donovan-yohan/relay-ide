/**
 * Offline `DshAcpClient` double for the dsh conformance fixture.
 *
 * `DshProtocolAdapter` takes a client factory in its constructor — the same
 * seam `dsh-adapter.test.ts` uses — so the rig needs no production change and
 * never spawns a `dsh --profile acp` child: `start`, `request`, `prompt`,
 * `notify`, `respond`, and `stop` are spied. Scripted server traffic arrives as
 * `emit('notification', …)` and `emit('peerRequest', …)`, exactly how the real
 * NDJSON reader delivers it.
 *
 * The one thing this double owns that the others do not is the PROMPT SLOT.
 * `session/prompt` is answered only when the whole turn has settled, so the
 * fixture settles it explicitly with a `transport-reply` step instead of it
 * resolving on its own.
 *
 * Everything here is transport plumbing. The ACP vocabulary lives in
 * `fixtures/dsh.fixture.ts`, per the quirk-vs-choreography rule in
 * `server/protocol-adapters/AGENTS.md`.
 */
import { vi } from 'vitest';
import {
  DshAcpClient,
  type DshAcpClientOptions,
  type DshAcpNotification,
  type DshAcpPeerRequest,
} from '../../../../../server/dsh-acp-client.js';

/**
 * Fixed ACP session identity. The server mints a UUID per `session/new`; the
 * double pins one so the session snapshot is byte-identical across replays
 * (invariant d).
 */
export const DSH_SESSION_ID = 'conf-dsh-session-1';

/** The `initialize` result, transcribed from the real capture. */
export const DSH_INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
  agentCapabilities: {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
  authMethods: [],
};

export interface DshAcpRequest {
  method: string;
  params: Record<string, unknown> | undefined;
}

export interface DshAcpClientDouble {
  /** The single client every `clientFactory` invocation hands back. */
  client: DshAcpClient;
  factory: (options: DshAcpClientOptions) => DshAcpClient;
  /** Options the adapter built per factory call (command, args, cwd, env). */
  factoryOptions: DshAcpClientOptions[];
  /** Ordered requests: `session/new`, `session/resume`, … */
  requests: DshAcpRequest[];
  /** Ordered `session/prompt` payloads. */
  prompts: Record<string, unknown>[];
  /** Ordered client notifications, e.g. `session/cancel`. */
  notifications: DshAcpRequest[];
  /** Answers the adapter gave to server-to-client requests. */
  responses: Array<{ id: string | number; result: unknown }>;
  emitNotification(notification: DshAcpNotification): void;
  emitPeerRequest(request: DshAcpPeerRequest): void;
  /** Settle the in-flight prompt, as the ACP server does when a turn ends. */
  settlePrompt(stopReason: string): boolean;
  stopped(): boolean;
}

export function makeDshAcpClientDouble(): DshAcpClientDouble {
  const client = new DshAcpClient();
  // The rig reuses ONE client for the whole transcript, so each `connect`
  // attaches another listener set. Production builds a fresh client per spawn
  // and never accumulates; raise the cap rather than let the rig warn.
  client.setMaxListeners(50);
  const requests: DshAcpRequest[] = [];
  const prompts: Record<string, unknown>[] = [];
  const notifications: DshAcpRequest[] = [];
  const responses: Array<{ id: string | number; result: unknown }> = [];
  const factoryOptions: DshAcpClientOptions[] = [];
  let pendingPrompt: ((value: unknown) => void) | null = null;
  let stopped = false;

  vi.spyOn(client, 'start').mockResolvedValue({ ...DSH_INITIALIZE_RESULT });

  vi.spyOn(client, 'request').mockImplementation(
    async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'session/new' || method === 'session/resume')
        return { sessionId: DSH_SESSION_ID, configOptions: [] };
      return {};
    }
  );

  vi.spyOn(client, 'prompt').mockImplementation(
    (params: Record<string, unknown>) => {
      prompts.push(params);
      return new Promise((resolve) => {
        pendingPrompt = resolve;
      });
    }
  );

  vi.spyOn(client, 'notify').mockImplementation(
    (method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params });
    }
  );

  vi.spyOn(client, 'respond').mockImplementation(
    (id: string | number, result: unknown) => {
      responses.push({ id, result });
    }
  );

  vi.spyOn(client, 'respondError').mockImplementation(() => undefined);

  vi.spyOn(client, 'stop').mockImplementation(async () => {
    stopped = true;
    // A stopped transport can never answer an outstanding prompt.
    pendingPrompt = null;
  });

  return {
    client,
    factory: (options) => {
      factoryOptions.push(options);
      return client;
    },
    factoryOptions,
    requests,
    prompts,
    notifications,
    responses,
    emitNotification: (notification) => {
      client.emit('notification', notification);
    },
    emitPeerRequest: (request) => {
      client.emit('peerRequest', request);
    },
    settlePrompt: (stopReason) => {
      if (!pendingPrompt) return false;
      const resolve = pendingPrompt;
      pendingPrompt = null;
      resolve({ stopReason });
      return true;
    },
    stopped: () => stopped,
  };
}
