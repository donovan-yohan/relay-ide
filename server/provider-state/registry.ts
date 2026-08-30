import type { AgentHarnessStateAdapter } from '../harness-state-adapter.js';
import type {
  NativeSessionImportResult,
  NativeSessionListScope,
  NativeSessionProvider,
  NativeSessionRef,
  NativeSessionSummary,
  ProviderInstallStatus,
  ProviderStateSnapshot,
} from '../../shared/provider-native-session-state.js';

/**
 * Cross-provider registry: enumerates installed adapters and aggregates
 * listNativeSessions across providers into one normalized, provider-tagged
 * list, surfacing per-provider install status rather than hard failures when
 * one provider is missing.
 *
 * Adapters are read-only. The registry never mutates provider stores or
 * executes native resume commands; it dispatches to each adapter's methods and
 * collects results with graceful per-provider error containment.
 */
export interface NativeSessionRegistryReport {
  sessions: NativeSessionSummary[];
  providers: ProviderInstallStatus[];
}

export class NativeSessionAdapterRegistry {
  private readonly adapters = new Map<
    NativeSessionProvider,
    AgentHarnessStateAdapter
  >();

  register(adapter: AgentHarnessStateAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(
        `Native session adapter for provider '${adapter.provider}' is already registered.`
      );
    }
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: NativeSessionProvider): AgentHarnessStateAdapter | undefined {
    return this.adapters.get(provider);
  }

  providers(): AgentHarnessStateAdapter[] {
    return Array.from(this.adapters.values());
  }

  async detectAllInstalls(): Promise<ProviderInstallStatus[]> {
    // #1449: detects are independent filesystem probes; run them concurrently.
    // `Promise.all` preserves registration order, so the result is unchanged.
    return Promise.all(
      Array.from(this.adapters.values()).map(
        async (adapter): Promise<ProviderInstallStatus> => {
          try {
            return await adapter.detectInstall();
          } catch (error) {
            return {
              provider: adapter.provider,
              status: 'unavailable',
              detectedAt: new Date().toISOString(),
              stateRoots: [],
              diagnostics: [
                {
                  code: 'ADAPTER_DETECT_FAILED',
                  message:
                    error instanceof Error ? error.message : String(error),
                  severity: 'error',
                },
              ],
            };
          }
        }
      )
    );
  }

  async listAllSessions(
    scope?: NativeSessionListScope
  ): Promise<NativeSessionRegistryReport> {
    // #1449: providers are independent read-only stores, so detect + list them
    // concurrently instead of paying the sum of their walks. Results are
    // collected in registration order, keeping `providers` and the pre-sort
    // session order identical to the previous serial loop.
    const selected = Array.from(this.adapters.values()).filter(
      (adapter) => !scope?.provider || scope.provider === adapter.provider
    );

    const outcomes = await Promise.all(
      selected.map(
        async (
          adapter
        ): Promise<{
          installs: ProviderInstallStatus[];
          sessions: NativeSessionSummary[];
        }> => {
          const installs: ProviderInstallStatus[] = [];
          try {
            const install = await adapter.detectInstall();
            installs.push(install);
            if (install.status !== 'installed')
              return { installs, sessions: [] };
            return {
              installs,
              sessions: await adapter.listNativeSessions(scope),
            };
          } catch (error) {
            // `installs` may already hold a successful detect: a list failure
            // after a successful detect reported both entries before #1449 and
            // still does, so the response is byte-identical.
            installs.push({
              provider: adapter.provider,
              status: 'unavailable',
              detectedAt: new Date().toISOString(),
              stateRoots: [],
              diagnostics: [
                {
                  code: 'ADAPTER_LIST_FAILED',
                  message:
                    error instanceof Error ? error.message : String(error),
                  severity: 'error',
                },
              ],
            });
            return { installs, sessions: [] };
          }
        }
      )
    );

    const providers: ProviderInstallStatus[] = [];
    const sessions: NativeSessionSummary[] = [];
    for (const outcome of outcomes) {
      providers.push(...outcome.installs);
      sessions.push(...outcome.sessions);
    }

    sessions.sort((a, b) => {
      const aTime = a.updatedAt ?? a.lastMessageAt ?? a.createdAt ?? '';
      const bTime = b.updatedAt ?? b.lastMessageAt ?? b.createdAt ?? '';
      return bTime.localeCompare(aTime);
    });

    return { sessions, providers };
  }

  async getProviderState(
    ref: NativeSessionRef
  ): Promise<ProviderStateSnapshot> {
    const adapter = this.requireAdapter(ref.provider);
    return adapter.readProviderState(ref);
  }

  async importSession(
    ref: NativeSessionRef
  ): Promise<NativeSessionImportResult> {
    const adapter = this.requireAdapter(ref.provider);
    return adapter.importSession(ref);
  }

  resumeCommand(ref: NativeSessionRef): string[] {
    const adapter = this.requireAdapter(ref.provider);
    return adapter.resumeCommand(ref);
  }

  /**
   * List sessions for one provider only, without the install-status fan-out of
   * `listAllSessions` (#1428 live-tail path uses this to resolve a nativeId to
   * its source file).
   */
  async listNativeSessionsByProvider(
    provider: NativeSessionProvider,
    scope?: NativeSessionListScope
  ): Promise<NativeSessionSummary[]> {
    const adapter = this.requireAdapter(provider);
    return adapter.listNativeSessions(scope);
  }

  private requireAdapter(
    provider: NativeSessionProvider
  ): AgentHarnessStateAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `No native session adapter registered for provider '${provider}'.`
      );
    }
    return adapter;
  }
}

export function createDefaultNativeSessionRegistry(): NativeSessionAdapterRegistry {
  const registry = new NativeSessionAdapterRegistry();
  return registry;
}
