/**
 * Offline Prime Agent RPC transport double for the conformance suite.
 *
 * `PrimeAgentProtocolAdapter` takes a `ClientFactory` seam in its constructor,
 * so no production code changes to run it offline: the factory hands back a
 * real `PrimeAgentRpcClient` whose three process-touching methods
 * (`start`/`call`/`stop`) are stubbed. Everything else — the EventEmitter it
 * extends, the `'event'` channel the adapter subscribes to — stays real, so the
 * transcript exercises the adapter's actual listener wiring.
 *
 * The stubbed payloads are transcribed from the captured Prime RPC responses in
 * `test/server/protocol-adapters/prime-agent-adapter.test.ts` (`harness()`,
 * lines 22-110): the `get_state` readiness payload `start()` resolves with, and
 * the `get_available_models` / `get_state` control-lane responses.
 *
 * Every value here is fixed — no clocks, no counters, no randomness — because
 * the conformance floor replays the same transcript twice and diffs the patch
 * streams byte for byte.
 */
import { vi } from 'vitest';
import {
  PrimeAgentRpcClient,
  type PrimeAgentRpcClientOptions,
  type PrimeAgentRpcMessage,
} from '../../../../../server/prime-agent-rpc-client.js';

/** Pinned provider session identity echoed into `providerSession` patches. */
export const PRIME_CONFORMANCE_SESSION_ID = 'prime-conf-1';
export const PRIME_CONFORMANCE_SESSION_FILE = '/tmp/prime-conf-1.jsonl';

/**
 * The single catalog entry `get_available_models` returns. One model keeps the
 * discovered `/model` and `/thinking` control catalog (and therefore the
 * `agent-session-updated-v2` payload) deterministic across replays.
 */
const PRIME_CONFORMANCE_MODEL: Record<string, unknown> = {
  id: 'gpt-prime',
  name: 'GPT Prime',
  provider: 'prime-inference',
  reasoning: true,
  thinkingLevelMap: { xhigh: 'xhigh' },
};

function model(): Record<string, unknown> {
  return { ...PRIME_CONFORMANCE_MODEL };
}

function stateData(): Record<string, unknown> {
  return {
    sessionId: PRIME_CONFORMANCE_SESSION_ID,
    sessionFile: PRIME_CONFORMANCE_SESSION_FILE,
    thinkingLevel: 'medium',
    model: model(),
  };
}

export interface PrimeAgentTransportDouble {
  /** The one client every `clientFactory()` call hands back. */
  client: PrimeAgentRpcClient;
  clientFactory: (options: PrimeAgentRpcClientOptions) => PrimeAgentRpcClient;
  /** Launch options the adapter passed per client construction. */
  factoryOptions: PrimeAgentRpcClientOptions[];
  /** `[method, fields]` for every RPC the adapter issued. */
  calls: Array<[string, Record<string, unknown>]>;
  /** Deliver one native Prime event on the channel the adapter listens to. */
  feed(event: unknown): void;
}

export function makePrimeAgentTransportDouble(): PrimeAgentTransportDouble {
  const client = new PrimeAgentRpcClient();
  const factoryOptions: PrimeAgentRpcClientOptions[] = [];
  const calls: Array<[string, Record<string, unknown>]> = [];

  // `start()` resolves with the readiness `get_state` response, exactly as the
  // real client does after its handshake barrier.
  vi.spyOn(client, 'start').mockResolvedValue({
    type: 'response',
    command: 'get_state',
    success: true,
    data: { ...stateData(), isStreaming: false },
  });

  vi.spyOn(client, 'call').mockImplementation(
    async (
      type: string,
      fields: Record<string, unknown> = {}
    ): Promise<PrimeAgentRpcMessage> => {
      calls.push([type, fields]);
      if (type === 'get_available_models') {
        return {
          type: 'response',
          command: type,
          success: true,
          data: { models: [model()] },
        };
      }
      if (type === 'get_state') {
        return {
          type: 'response',
          command: type,
          success: true,
          data: stateData(),
        };
      }
      // `prompt` and `abort` acknowledge with a bare success envelope; the
      // user-visible consequence arrives on the event channel.
      return { type: 'response', command: type, success: true };
    }
  );

  vi.spyOn(client, 'stop').mockResolvedValue();

  return {
    client,
    factoryOptions,
    calls,
    clientFactory: (options) => {
      factoryOptions.push(options);
      return client;
    },
    feed: (event) => {
      client.emit('event', event);
    },
  };
}
