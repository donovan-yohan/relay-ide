import type {
  AgentPatchV2,
  AgentProviderV2,
  AgentSessionV2,
} from './agent-chat-protocol-v2.js';
import type { WorkContextId } from './work-context.js';

export type NativeSessionProvider = Extract<
  AgentProviderV2,
  'claude' | 'codex' | 'hermes' | 'opencode' | 'pi'
>;

export type ProviderInstallStatusKind =
  | 'installed'
  | 'unavailable'
  | 'unsupported';

export interface ProviderInstallDiagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface ProviderInstallStatus {
  provider: NativeSessionProvider;
  status: ProviderInstallStatusKind;
  detectedAt: string;
  stateRoots: string[];
  diagnostics: ProviderInstallDiagnostic[];
  version?: string;
}

export interface AgentHarnessStateCapabilities {
  canImportTranscript: boolean;
  canReadProviderState: boolean;
  canResumeNative: boolean;
  canStreamLiveEvents: boolean;
  canRespondToApprovals: boolean;
  canExposeToolCalls: boolean;
  readOnly: true;
}

export interface NativeSessionRef {
  provider: NativeSessionProvider;
  nativeId: string;
  sourcePath?: string;
  stateRoot?: string;
  cwd?: string;
}

export interface NativeSessionWorkContextHints {
  workContextId?: WorkContextId;
  cwd?: string;
  repoPath?: string;
  worktreePath?: string;
}

export interface NativeSessionListScope extends NativeSessionWorkContextHints {
  provider?: NativeSessionProvider;
}

export interface NativeSessionPreview {
  text: string;
  source: 'metadata' | 'transcript' | 'filename' | 'none';
  redacted: boolean;
  charCount: number;
}

export interface NativeSessionSummary {
  provider: NativeSessionProvider;
  nativeId: string;
  sourcePath: string;
  cwd?: string;
  repoPath?: string;
  worktreePath?: string;
  workContextId?: WorkContextId;
  createdAt?: string;
  updatedAt?: string;
  lastMessageAt?: string;
  title?: string;
  preview: NativeSessionPreview;
  metadata: {
    lineCount?: number;
    byteCount?: number;
    hashSha256?: string;
    nativeSessionId?: string;
    eventTypes?: string[];
    readTruncation?: NativeSessionJsonlReadTruncation;
  };
  capabilities: AgentHarnessStateCapabilities;
}

export interface ProviderStateSnapshot {
  ref: NativeSessionRef;
  capturedAt: string;
  sourcePath: string;
  summary: {
    lineCount: number;
    byteCount: number;
    hashSha256: string;
    eventTypes: string[];
    firstTimestamp?: string;
    lastTimestamp?: string;
    preview: NativeSessionPreview;
    readTruncation?: NativeSessionJsonlReadTruncation;
  };
  redaction: {
    rawPayloadStored: false;
    strategy: 'preview';
    classes: ('credential' | 'secret' | 'payload' | 'transcript')[];
  };
}

export interface NativeSessionJsonlReadTruncation {
  truncated: true;
  reason: 'byte-limit' | 'line-limit' | 'event-limit';
  maxBytes: number;
  maxLines: number;
  maxEvents: number;
  totalLinesSeen: number;
  parsedEvents: number;
}

export interface NativeSessionImportTruncation {
  truncated: true;
  strategy: 'fifo-oldest-non-audit';
  maxTranscriptBytes: number;
  approximateTranscriptBytes: number;
  originalTurns: number;
  retainedTurns: number;
  droppedTurns: number;
  droppedItems: number;
}

export interface NativeSessionImportResult {
  provider: NativeSessionProvider;
  nativeId: string;
  importedAt: string;
  sourcePath: string;
  session: AgentSessionV2;
  patches: AgentPatchV2[];
  importTruncation?: NativeSessionImportTruncation;
  sourceReadTruncation?: NativeSessionJsonlReadTruncation;
}
