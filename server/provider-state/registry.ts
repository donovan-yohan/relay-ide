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
  private readonly adapters = new Map<NativeSessionProvider, AgentHarnessStateAdapter>();

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
    const statuses: ProviderInstallStatus[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        statuses.push(await adapter.detectInstall());
      } catch (error) {
        statuses.push({
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
        });
      }
    }
    return statuses;
  }

  async listAllSessions(
    scope?: NativeSessionListScope
  ): Promise<NativeSessionRegistryReport> {
    const providers: ProviderInstallStatus[] = [];
    const sessions: NativeSessionSummary[] = [];

    for (const adapter of this.adapters.values()) {
      if (scope?.provider && scope.provider !== adapter.provider) continue;

      try {
        const install = await adapter.detectInstall();
        providers.push(install);
        if (install.status !== 'installed') continue;

        const providerSessions = await adapter.listNativeSessions(scope);
        sessions.push(...providerSessions);
      } catch (error) {
        providers.push({
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
      }
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

  private requireAdapter(provider: NativeSessionProvider): AgentHarnessStateAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No native session adapter registered for provider '${provider}'.`);
    }
    return adapter;
  }
}

export function createDefaultNativeSessionRegistry(): NativeSessionAdapterRegistry {
  const registry = new NativeSessionAdapterRegistry();
  return registry;
}