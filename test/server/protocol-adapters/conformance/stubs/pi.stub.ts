/**
 * Offline `PiAgentRpcClient` double for the pi conformance fixture.
 *
 * `PiAgentProtocolAdapter` takes a client factory in its constructor — the same
 * seam `pi-agent-adapter.test.ts` uses — so the conformance rig needs no
 * production change and never spawns a `pi --mode rpc` child: `start`, `call`,
 * and `stop` are spied, and scripted native frames arrive as `emit('event', …)`,
 * exactly how the real JSONL reader delivers them.
 *
 * Everything here is transport plumbing. The event grammar itself lives in
 * `fixtures/pi.fixture.ts`, per the quirk-vs-choreography rule in
 * `server/protocol-adapters/AGENTS.md`.
 */
import { vi } from 'vitest';
import {
  PiAgentRpcClient,
  type PiAgentRpcClientOptions,
  type PiAgentRpcMessage,
} from '../../../../../server/pi-agent-rpc-client.js';

/**
 * Fixed provider session identity. Pi reports these from the `get_state`
 * response `start()` resolves with, and the adapter publishes them on its
 * session snapshot — so they must be pinned for invariant (d) to hold.
 */
export const PI_SESSION_ID = 'pi-conf-1';
export const PI_SESSION_FILE = '/tmp/pi-conf-1.jsonl';

export interface PiRpcCall {
  type: string;
  fields: Record<string, unknown>;
}

export interface PiRpcClientDouble {
  /** The single client every `clientFactory` invocation hands back. */
  client: PiAgentRpcClient;
  factory: (options: PiAgentRpcClientOptions) => PiAgentRpcClient;
  /** Options the adapter built per factory call (command, args, cwd, env). */
  factoryOptions: PiAgentRpcClientOptions[];
  /** Ordered RPC the adapter sent: `prompt`, `abort`, `steer`, `compact`, … */
  calls: PiRpcCall[];
  /** Deliver one native Pi RPC frame, as the JSONL reader would. */
  emit(event: PiAgentRpcMessage): void;
  stopped(): boolean;
}

/**
 * A double whose `start()` resolves with the real `get_state` response shape
 * (`sessionId` / `sessionFile` / `isStreaming`) captured in
 * `pi-agent-adapter.test.ts`, and whose `call()` acknowledges every RPC
 * successfully. A conformance transcript drives failure through native events,
 * never through a rigged transport error — the transport-failure paths are
 * deep-tested next door.
 */
export function makePiRpcClientDouble(): PiRpcClientDouble {
  const client = new PiAgentRpcClient();
  const calls: PiRpcCall[] = [];
  const factoryOptions: PiAgentRpcClientOptions[] = [];
  let stopped = false;

  vi.spyOn(client, 'start').mockResolvedValue({
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      sessionId: PI_SESSION_ID,
      sessionFile: PI_SESSION_FILE,
      isStreaming: false,
    },
  });

  vi.spyOn(client, 'call').mockImplementation(
    async (type: string, fields: Record<string, unknown> = {}) => {
      calls.push({ type, fields });
      return { type: 'response', command: type, success: true };
    }
  );

  vi.spyOn(client, 'stop').mockImplementation(async () => {
    stopped = true;
  });

  return {
    client,
    factory: (options) => {
      factoryOptions.push(options);
      return client;
    },
    factoryOptions,
    calls,
    emit: (event) => {
      client.emit('event', event);
    },
    stopped: () => stopped,
  };
}
