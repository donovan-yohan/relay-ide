import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
  AgentHarnessStateCapabilities,
  NativeSessionImportResult,
  NativeSessionListScope,
  NativeSessionRef,
  NativeSessionSummary,
  ProviderInstallStatus,
  ProviderStateSnapshot,
} from '../../shared/provider-native-session-state.js';
import type { AgentHarnessStateAdapter } from '../harness-state-adapter.js';

const PI_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: false,
  canReadProviderState: false,
  canResumeNative: true,
  canStreamLiveEvents: false,
  canRespondToApprovals: false,
  canExposeToolCalls: false,
  readOnly: true,
};

interface PiStateAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
}

export class PiStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'pi' as const;
  readonly capabilities = PI_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;

  constructor(options: PiStateAdapterOptions = {}) {
    this.stateRoot = options.stateRoot ?? path.join(homedir(), '.pi');
    this.now = options.now ?? (() => new Date());
  }

  async detectInstall(): Promise<ProviderInstallStatus> {
    const detectedAt = this.nowIso();
    try {
      await access(this.stateRoot, constants.R_OK);
      return {
        provider: this.provider,
        status: 'unsupported',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: [
          {
            code: 'PI_RPC_ONLY_NO_SESSION_HISTORY',
            message:
              'Pi is RPC-based and does not expose session history over its RPC protocol or via local session files. Native session listing/importing is not available for this provider.',
            severity: 'info',
          },
        ],
      };
    } catch {
      return {
        provider: this.provider,
        status: 'unavailable',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: [
          {
            code: 'PI_STATE_ROOT_NOT_FOUND',
            message:
              'Pi state root was not found. Pi is RPC-based and does not persist session transcripts to a local directory.',
            severity: 'info',
          },
        ],
      };
    }
  }

  async listNativeSessions(
    _scope?: NativeSessionListScope
  ): Promise<NativeSessionSummary[]> {
    return [];
  }

  async readProviderState(
    ref: NativeSessionRef
  ): Promise<ProviderStateSnapshot> {
    throw new Error(
      `Pi adapter cannot read provider state: Pi is RPC-based and does not expose session history (ref: ${ref.nativeId}).`
    );
  }

  async importSession(
    ref: NativeSessionRef
  ): Promise<NativeSessionImportResult> {
    throw new Error(
      `Pi adapter cannot import sessions: Pi is RPC-based and does not expose session history (ref: ${ref.nativeId}).`
    );
  }

  resumeCommand(ref: NativeSessionRef): string[] {
    return ['pi', '--resume', ref.nativeId];
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}