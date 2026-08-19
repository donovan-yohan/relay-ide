/**
 * Shared choreography for protocol adapters.
 *
 * Classification rule for anything you change in an adapter:
 * - QUIRK (event vocabulary, protocol handshake, resume-id name, permission
 *   flags) stays adapter-local and is never copied to a sibling adapter.
 * - CHOREOGRAPHY (the same dance in every adapter) lives here and is never
 *   hand-duplicated into a third adapter.
 *
 * This module is the seed of that layer. Broad extraction is sequenced behind
 * an adapter conformance suite; add here only what is already identical.
 */

import type { AdapterConfig } from '../protocol-adapter-v2.js';

export interface ReconnectWithStoredConfigOptions {
  /** Config captured by the last successful connect; null before one. */
  config: AdapterConfig | null | undefined;
  /** Tear down the live transport (adapters vary in how much they reset). */
  disconnect: () => void | Promise<void>;
  /** Re-establish the transport with the resolved config. */
  connect: (config: AdapterConfig) => void | Promise<void>;
  /**
   * Quirk hook for adapters that resume by folding a provider session id into
   * the config (pi-agent, prime-agent). Runs before `disconnect` so it reads
   * pre-teardown adapter state, matching the hand-written order it replaces.
   */
  transformConfig?: (config: AdapterConfig) => AdapterConfig;
  /** Per-adapter wording; adapters disagree and the text is observable. */
  notConnectedMessage?: string;
}

/**
 * Reconnect = re-run connect with the stored config after a full teardown.
 * Identical in every real adapter apart from the config transform and the
 * not-connected message, both parameterized here.
 */
export async function reconnectWithStoredConfig(
  options: ReconnectWithStoredConfigOptions
): Promise<void> {
  const { config } = options;
  if (!config) {
    throw new Error(
      options.notConnectedMessage ?? 'Cannot reconnect before connect'
    );
  }
  const nextConfig = options.transformConfig
    ? options.transformConfig(config)
    : config;
  await options.disconnect();
  await options.connect(nextConfig);
}
