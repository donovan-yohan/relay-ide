import type {
  AgentHarnessStateCapabilities,
  NativeSessionImportResult,
  NativeSessionListScope,
  NativeSessionProvider,
  NativeSessionRef,
  NativeSessionSummary,
  ProviderInstallStatus,
  ProviderStateSnapshot,
} from '../shared/provider-native-session-state.js';

/**
 * Read-only adapter over provider-owned session stores.
 *
 * Implementations may inspect and normalize native provider state, but must not
 * mutate provider stores or execute native resume/open commands. `resumeCommand`
 * returns copyable argv data only; callers decide if and when to run it.
 */
export interface AgentHarnessStateAdapter {
  readonly provider: NativeSessionProvider;
  readonly capabilities: AgentHarnessStateCapabilities;

  detectInstall(): Promise<ProviderInstallStatus>;
  listNativeSessions(
    scope?: NativeSessionListScope
  ): Promise<NativeSessionSummary[]>;
  importSession(ref: NativeSessionRef): Promise<NativeSessionImportResult>;
  readProviderState(ref: NativeSessionRef): Promise<ProviderStateSnapshot>;
  resumeCommand(ref: NativeSessionRef): string[];
}
