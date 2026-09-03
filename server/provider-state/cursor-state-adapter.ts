import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
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

/**
 * Read-only provider-state adapter for Cursor CLI (`cursor-agent`).
 *
 * Cursor CLI does not persist native session transcripts in an open on-disk
 * log format like Claude or DeepSeek Harness; native sessions are managed
 * directly via the ACP protocol or interactive terminal commands.
 *
 * `resumeCommand` provides copyable argv data for `cursor-agent --resume <id>`
 * when a native session id is supplied.
 */

const CURSOR_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: false,
  canReadProviderState: false,
  canResumeNative: true,
  canStreamLiveEvents: false,
  canRespondToApprovals: false,
  canExposeToolCalls: false,
  readOnly: true,
};

export interface CursorStateAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
}

export class CursorStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'cursor' as const;
  readonly capabilities = CURSOR_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;

  constructor(options: CursorStateAdapterOptions = {}) {
    this.stateRoot = options.stateRoot ?? path.join(homedir(), '.cursor');
    this.now = options.now ?? (() => new Date());
  }

  async detectInstall(): Promise<ProviderInstallStatus> {
    const detectedAt = this.now().toISOString();
    try {
      await access(this.stateRoot, constants.R_OK);
      return {
        provider: this.provider,
        status: 'installed',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: [
          {
            code: 'CURSOR_STATE_READABLE',
            message: 'Cursor state directory is readable.',
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
            code: 'CURSOR_STATE_ROOT_NOT_FOUND',
            message: `Cursor directory not found at ${this.stateRoot}`,
            severity: 'warning',
          },
        ],
      };
    }
  }

  async listNativeSessions(
    _scope: NativeSessionListScope = {}
  ): Promise<NativeSessionSummary[]> {
    return [];
  }

  async readProviderState(
    _ref: NativeSessionRef
  ): Promise<ProviderStateSnapshot> {
    throw new Error('Cursor native session state reading is not supported.');
  }

  async importSession(
    _ref: NativeSessionRef
  ): Promise<NativeSessionImportResult> {
    throw new Error('Cursor native session import is not supported.');
  }

  resumeCommand(ref: NativeSessionRef): string[] {
    if (!ref.nativeId) return [];
    return ['cursor-agent', '--resume', ref.nativeId];
  }
}
