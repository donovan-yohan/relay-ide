import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import type {
  AgentItemV2,
  AgentPatchV2,
  AgentTurnV2,
} from '../../shared/agent-chat-protocol-v2.js';
import type {
  AgentHarnessStateCapabilities,
  NativeSessionImportResult,
  NativeSessionImportTruncation,
  NativeSessionJsonlReadTruncation,
  NativeSessionListScope,
  NativeSessionPreview,
  NativeSessionRef,
  NativeSessionSummary,
  ProviderInstallStatus,
  ProviderStateSnapshot,
} from '../../shared/provider-native-session-state.js';
import type { AgentHarnessStateAdapter } from '../harness-state-adapter.js';
import { createLogger } from '../logger.js';

const logger = createLogger('provider-state:prime-agent');

/**
 * Read-only adapter over the Prime Agent local session store (#1426).
 *
 * Prime persists one flat JSONL transcript per session under
 * `~/.prime/agent/sessions/<uuid>.jsonl`. Line 1 is a `type:"session"` header
 * carrying `{ id, timestamp, cwd, git?: { repoUrl, commit, branch }, rlmDepth }`;
 * later lines are typed events (`message` with roles user/assistant/toolResult,
 * `model_change`, `agent_status`, `compaction`, ...). Harness/refinement and
 * operational-log artifacts never live in this directory, but the enumeration
 * below still filters to top-level `*.jsonl` transcripts only.
 *
 * Observation only: this adapter never mutates the store. `resumeCommand`
 * mirrors the launch argv proven in `server/protocol-adapters/
 * prime-agent-adapter.ts` (`prime-agent --resume <nativeId>`) and returns
 * copyable data; callers decide whether to run it.
 */

const PRIME_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: true,
  canReadProviderState: true,
  canResumeNative: true,
  // Wired through NativeSessionLiveTailManager alongside claude/codex (#1426).
  canStreamLiveEvents: true,
  canRespondToApprovals: false,
  canExposeToolCalls: true,
  readOnly: true,
};

const MAX_LIST_FILES = 500;
const PREVIEW_LIMIT = 240;
const TEXT_LIMIT = 32_000;
const MAX_JSONL_BYTES = 5_000_000;
const MAX_JSONL_LINES = 20_000;
const MAX_JSONL_EVENTS = 5_000;
const MAX_IMPORT_TRANSCRIPT_BYTES = 256_000;

interface ParsedJsonlLine {
  lineNumber: number;
  value: Record<string, unknown>;
}

interface PrimeJsonlFile {
  path: string;
  bytes: number;
  hashSha256: string;
  lines: ParsedJsonlLine[];
  readTruncation?: NativeSessionJsonlReadTruncation;
}

interface ImportedTurns {
  turns: AgentTurnV2[];
  truncation?: NativeSessionImportTruncation;
}

export interface PrimeAgentStateAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
  maxFiles?: number;
}

export class PrimeAgentStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'prime-agent' as const;
  readonly capabilities = PRIME_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxFiles: number;

  constructor(options: PrimeAgentStateAdapterOptions = {}) {
    this.stateRoot =
      options.stateRoot ?? path.join(homedir(), '.prime', 'agent', 'sessions');
    this.now = options.now ?? (() => new Date());
    this.maxFiles = options.maxFiles ?? MAX_LIST_FILES;
  }

  async detectInstall(): Promise<ProviderInstallStatus> {
    const detectedAt = this.nowIso();
    try {
      await access(this.stateRoot, constants.R_OK);
      const files = await listPrimeSessionFiles(this.stateRoot, 1);
      return {
        provider: this.provider,
        status: 'installed',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: [
          {
            code:
              files.length > 0 ? 'PRIME_STATE_READABLE' : 'PRIME_STATE_EMPTY',
            message:
              files.length > 0
                ? 'Prime Agent session directory is readable.'
                : 'Prime Agent session directory is readable but contains no JSONL transcripts yet.',
            severity: files.length > 0 ? 'info' : 'warning',
          },
        ],
      };
    } catch (error) {
      return {
        provider: this.provider,
        status: 'unavailable',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: [
          {
            code: 'PRIME_STATE_UNREADABLE',
            message: safeErrorMessage(error),
            severity: 'warning',
          },
        ],
      };
    }
  }

  async listNativeSessions(
    scope: NativeSessionListScope = {}
  ): Promise<NativeSessionSummary[]> {
    const files = await listPrimeSessionFiles(this.stateRoot, this.maxFiles);
    const summaries: NativeSessionSummary[] = [];

    for (const filePath of files) {
      try {
        const parsed = await readPrimeJsonl(filePath);
        const summary = summarizePrimeJsonl(parsed, this.capabilities);
        if (scope.cwd && summary.cwd !== scope.cwd) continue;
        if (
          scope.workContextId &&
          summary.workContextId !== scope.workContextId
        )
          continue;
        summaries.push(summary);
      } catch {
        // Skip unreadable or over-limit provider files during discovery.
      }
    }

    return summaries.sort((a, b) => {
      const aTime = a.updatedAt ?? a.lastMessageAt ?? a.createdAt ?? '';
      const bTime = b.updatedAt ?? b.lastMessageAt ?? b.createdAt ?? '';
      return bTime.localeCompare(aTime);
    });
  }

  async readProviderState(
    ref: NativeSessionRef
  ): Promise<ProviderStateSnapshot> {
    const file = await this.readRef(ref);
    const summary = summarizePrimeJsonl(file, this.capabilities);
    const timestamps = collectTimestamps(file.lines);

    return {
      ref: normalizeRef(ref, summary),
      capturedAt: this.nowIso(),
      sourcePath: file.path,
      summary: {
        lineCount: file.lines.length,
        byteCount: file.bytes,
        hashSha256: file.hashSha256,
        eventTypes: collectEventTypes(file.lines),
        ...(timestamps.first ? { firstTimestamp: timestamps.first } : {}),
        ...(timestamps.last ? { lastTimestamp: timestamps.last } : {}),
        preview: summary.preview,
        ...(file.readTruncation ? { readTruncation: file.readTruncation } : {}),
      },
      redaction: {
        rawPayloadStored: false,
        strategy: 'preview',
        classes: ['credential', 'secret', 'payload', 'transcript'],
      },
    };
  }

  async importSession(
    ref: NativeSessionRef
  ): Promise<NativeSessionImportResult> {
    const file = await this.readRef(ref);
    const summary = summarizePrimeJsonl(file, this.capabilities);
    const importedAt = this.nowIso();
    const sessionId = relaySessionId(summary.nativeId, file.hashSha256);
    const session = emptyAgentSessionV2({
      id: sessionId,
      provider: 'prime-agent',
      cwd: summary.cwd ?? ref.cwd ?? '',
      capabilities: {
        text: true,
        reasoning: true,
        tools: true,
        commandExecution: true,
        fileChanges: false,
        approvals: false,
        questions: false,
        plans: false,
        resume: true,
        telemetry: true,
        streaming: false,
      },
      providerSession: providerSession(summary, file),
      config: {
        providerOptions: {
          importedFromNativeProvider: true,
          importSource: 'prime-agent-jsonl',
          readOnly: true,
        },
      },
    });

    const importedTurns = buildTurns(file, importedAt);
    session.turns = importedTurns.turns;
    if (importedTurns.truncation || file.readTruncation) {
      session.config.providerOptions = {
        ...session.config.providerOptions,
        ...(importedTurns.truncation
          ? { importTruncation: importedTurns.truncation }
          : {}),
        ...(file.readTruncation
          ? { sourceReadTruncation: file.readTruncation }
          : {}),
      };
      annotateAuditMarker(session.turns, {
        ...(importedTurns.truncation
          ? { importTruncation: importedTurns.truncation }
          : {}),
        ...(file.readTruncation
          ? { sourceReadTruncation: file.readTruncation }
          : {}),
      });
    }

    const patches: AgentPatchV2[] = [
      {
        type: 'agent-session-snapshot-v2',
        sessionId,
        timestamp: importedAt,
        session,
      },
    ];

    const result: NativeSessionImportResult = {
      provider: this.provider,
      nativeId: summary.nativeId,
      importedAt,
      sourcePath: file.path,
      session,
      patches,
      ...(importedTurns.truncation
        ? { importTruncation: importedTurns.truncation }
        : {}),
      ...(file.readTruncation
        ? { sourceReadTruncation: file.readTruncation }
        : {}),
    };
    return result;
  }

  /**
   * Copyable argv mirroring the proven resume path in
   * `prime-agent-adapter.ts` (`--resume <resumeSessionId>`); never executed here.
   */
  resumeCommand(ref: NativeSessionRef): string[] {
    return ['prime-agent', '--resume', ref.nativeId];
  }

  private async readRef(ref: NativeSessionRef): Promise<PrimeJsonlFile> {
    if (ref.provider !== this.provider) {
      throw new Error(
        `Prime Agent adapter cannot read provider '${ref.provider}'.`
      );
    }
    if (ref.sourcePath) {
      return readPrimeJsonl(await this.resolveSafeSourcePath(ref.sourcePath));
    }

    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (!found) {
      throw new Error(
        `Prime Agent native session '${ref.nativeId}' was not found.`
      );
    }
    return readPrimeJsonl(await this.resolveSafeSourcePath(found.sourcePath));
  }

  private async resolveSafeSourcePath(sourcePath: string): Promise<string> {
    const rootRealPath = await realpath(this.stateRoot);
    const candidatePath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(rootRealPath, sourcePath);
    if (path.extname(candidatePath) !== '.jsonl') {
      throw new Error(
        'Prime Agent native session sourcePath must point to a .jsonl file.'
      );
    }

    const sourceInfo = await lstat(candidatePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error(
        'Prime Agent native session sourcePath must not be a symlink.'
      );
    }
    if (!sourceInfo.isFile()) {
      throw new Error(
        'Prime Agent native session sourcePath must point to a regular .jsonl file.'
      );
    }

    const sourceRealPath = await realpath(candidatePath);
    if (path.extname(sourceRealPath) !== '.jsonl') {
      throw new Error(
        'Prime Agent native session sourcePath must resolve to a .jsonl file.'
      );
    }
    if (!isPathInside(rootRealPath, sourceRealPath)) {
      throw new Error(
        'Prime Agent native session sourcePath must resolve under the configured state root.'
      );
    }

    return sourceRealPath;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

/**
 * Enumerate top-level `*.jsonl` transcripts only: Prime keeps this directory
 * flat (one file per session), so any subdirectory or non-JSONL artifact
 * (e.g. operational logs) is excluded from listing by construction.
 */
async function listPrimeSessionFiles(
  root: string,
  maxFiles: number
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (found.length >= maxFiles) return found;
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    found.push(path.join(root, entry.name));
  }
  return found;
}

async function readPrimeJsonl(filePath: string): Promise<PrimeJsonlFile> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error('Prime Agent JSONL source must not be a symlink.');
  }
  if (!info.isFile()) {
    throw new Error('Prime Agent JSONL source must be a regular file.');
  }
  if (info.size > MAX_JSONL_BYTES) {
    throw new Error(
      `Prime Agent JSONL source exceeds ${MAX_JSONL_BYTES} bytes.`
    );
  }

  const hash = createHash('sha256');
  const lines: ParsedJsonlLine[] = [];
  let readTruncation: NativeSessionJsonlReadTruncation | undefined;
  let pending = '';
  let seenLines = 0;
  let parsedEvents = 0;

  const processLine = (line: string): void => {
    seenLines += 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (seenLines > MAX_JSONL_LINES) {
      readTruncation =
        readTruncation ??
        jsonlReadTruncation('line-limit', seenLines, parsedEvents);
      return;
    }
    if (parsedEvents >= MAX_JSONL_EVENTS) {
      readTruncation =
        readTruncation ??
        jsonlReadTruncation('event-limit', seenLines, parsedEvents);
      return;
    }
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) {
        parsedEvents += 1;
        lines.push({ lineNumber: seenLines, value });
      }
    } catch {
      // Tolerant parsing: corrupt lines are tolerated during read-only reads.
    }
  };

  for await (const chunk of createReadStream(filePath, { encoding: 'utf8' })) {
    hash.update(chunk, 'utf8');
    pending += chunk;
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
      processLine(line);
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf('\n');
    }
  }
  if (pending.length > 0) processLine(pending.replace(/\r$/, ''));

  logUnknownEventTypes(lines, filePath);

  return {
    path: filePath,
    bytes: info.size,
    hashSha256: hash.digest('hex'),
    lines,
    ...(readTruncation ? { readTruncation } : {}),
  };
}

function jsonlReadTruncation(
  reason: NativeSessionJsonlReadTruncation['reason'],
  totalLinesSeen: number,
  parsedEvents: number
): NativeSessionJsonlReadTruncation {
  return {
    truncated: true,
    reason,
    maxBytes: MAX_JSONL_BYTES,
    maxLines: MAX_JSONL_LINES,
    maxEvents: MAX_JSONL_EVENTS,
    totalLinesSeen,
    parsedEvents,
  };
}

/**
 * Prime's transcript vocabulary is larger than what Relay maps. Known but
 * non-conversational types are expected; anything else is logged as a gap so
 * a new native event type surfaces instead of disappearing silently.
 */
const KNOWN_PRIME_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session',
  'message',
  'model_change',
  'thinking_level_change',
  'service_tier_change',
  'session_state',
  'agent_status',
  'custom_message',
  'custom',
  'compaction',
  'child_usage_attributed',
]);

function logUnknownEventTypes(
  lines: ParsedJsonlLine[],
  filePath: string
): void {
  for (const parsed of lines) {
    const type = stringField(parsed.value.type);
    if (type && !KNOWN_PRIME_EVENT_TYPES.has(type)) {
      logger.info(
        `Unmapped Prime Agent event type '${type}' at ${path.basename(filePath)}:${parsed.lineNumber}; treated as gap.`
      );
    }
  }
}

function summarizePrimeJsonl(
  file: PrimeJsonlFile,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  const nativeId =
    nativeIdFromLines(file.lines) ?? path.basename(file.path, '.jsonl');
  const header = sessionHeader(file.lines);
  const cwd = header?.cwd ?? firstStringField(file.lines, ['cwd']);
  const gitBranch = header?.git?.branch;
  // Prime records the remote URL in the session header's git block; commit
  // alone does not identify a checkout path, so only repoUrl maps here.
  const repoPath = header?.git?.repoUrl;
  const timestamps = collectTimestamps(file.lines);
  const title = titleFromLines(file.lines);
  const preview = previewFromLines(
    file.lines,
    title ?? path.basename(file.path, '.jsonl')
  );

  return {
    provider: 'prime-agent',
    nativeId,
    sourcePath: file.path,
    ...(cwd ? { cwd } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(gitBranch ? { worktreePath: gitBranch } : {}),
    ...(timestamps.first ? { createdAt: timestamps.first } : {}),
    ...(timestamps.last
      ? { updatedAt: timestamps.last, lastMessageAt: timestamps.last }
      : {}),
    ...(title ? { title } : {}),
    preview,
    metadata: {
      lineCount: file.lines.length,
      byteCount: file.bytes,
      hashSha256: file.hashSha256,
      nativeSessionId: nativeId,
      eventTypes: collectEventTypes(file.lines),
      ...(file.readTruncation ? { readTruncation: file.readTruncation } : {}),
    },
    capabilities,
  };
}

interface PrimeSessionHeaderGit {
  repoUrl?: string;
  commit?: string;
  branch?: string;
}

interface PrimeSessionHeader {
  id?: string;
  timestamp?: string;
  cwd?: string;
  git?: PrimeSessionHeaderGit;
}

function sessionHeader(lines: ParsedJsonlLine[]): PrimeSessionHeader | null {
  for (const parsed of lines) {
    if (stringField(parsed.value.type) !== 'session') continue;
    const gitRecord = isRecord(parsed.value.git) ? parsed.value.git : null;
    let git: PrimeSessionHeaderGit | undefined;
    if (gitRecord) {
      const entry: PrimeSessionHeaderGit = {};
      const repoUrl = stringOrUndefined(gitRecord.repoUrl);
      const commit = stringOrUndefined(gitRecord.commit);
      const branch = stringOrUndefined(gitRecord.branch);
      if (repoUrl) entry.repoUrl = repoUrl;
      if (commit) entry.commit = commit;
      if (branch) entry.branch = branch;
      git = entry;
    }
    const header: PrimeSessionHeader = {};
    const id = stringOrUndefined(parsed.value.id);
    if (id) header.id = id;
    const ts = stringOrUndefined(parsed.value.timestamp);
    if (ts) header.timestamp = ts;
    const cwd = stringOrUndefined(parsed.value.cwd);
    if (cwd) header.cwd = cwd;
    if (git) header.git = git;
    return header;
  }
  return null;
}

function nativeIdFromLines(lines: ParsedJsonlLine[]): string | null {
  // The `session` header line carries the canonical transcript id.
  for (const parsed of lines) {
    if (stringField(parsed.value.type) !== 'session') continue;
    const id = stringField(parsed.value.id);
    if (id) return id;
  }
  for (const parsed of lines) {
    const id = stringFromRecord(parsed.value, [
      'sessionId',
      'session_id',
      'id',
    ]);
    if (id) return id;
  }
  return null;
}

function titleFromLines(lines: ParsedJsonlLine[]): string | null {
  for (const parsed of lines) {
    const summary = stringFromRecord(parsed.value, ['summary', 'title']);
    if (summary) return summary;
  }
  return null;
}

/**
 * Preview from the FIRST user message in the transcript, redacted; falls back
 * to compaction summary metadata, then the filename stem.
 */
function previewFromLines(
  lines: ParsedJsonlLine[],
  fallback: string
): NativeSessionPreview {
  for (const parsed of lines) {
    if (messageRole(parsed.value) !== 'user') continue;
    const text = redactText(messageText(parsed.value));
    if (text) {
      return {
        text: truncate(text, PREVIEW_LIMIT),
        source: 'transcript',
        redacted: true,
        charCount: Math.min(text.length, PREVIEW_LIMIT),
      };
    }
  }

  for (const parsed of lines) {
    const summary = stringFromRecord(parsed.value, ['summary', 'title']);
    if (summary) {
      return {
        text: truncate(summary, PREVIEW_LIMIT),
        source: 'metadata',
        redacted: false,
        charCount: Math.min(summary.length, PREVIEW_LIMIT),
      };
    }
  }

  return {
    text: truncate(fallback, PREVIEW_LIMIT),
    source: 'filename',
    redacted: false,
    charCount: Math.min(fallback.length, PREVIEW_LIMIT),
  };
}

/**
 * Deterministic import: same file bytes in, same AgentSessionV2 out. Prime
 * message records become turns keyed on user prompts; toolResult records
 * attach to the active turn as provider-extension items; every other record
 * type is either a known non-conversational event or a logged gap.
 */
function buildTurns(file: PrimeJsonlFile, importedAt: string): ImportedTurns {
  const turns: AgentTurnV2[] = [
    {
      id: 'native-import-audit',
      status: 'completed',
      inputMessageId: 'native-import-audit-marker',
      startedAt: importedAt,
      completedAt: importedAt,
      items: [
        {
          id: 'native-import-audit-marker',
          type: 'providerExtension',
          namespace: 'provider-state-import',
          status: 'completed',
          startedAt: importedAt,
          completedAt: importedAt,
          payload: {
            event: 'native-session-imported',
            sourceProvider: 'prime-agent',
            importSource: 'prime-agent-jsonl',
            importedAt,
            sourcePath: file.path,
            hashSha256: file.hashSha256,
            readOnly: true,
          },
        },
      ],
    },
  ];

  let activeTurn: AgentTurnV2 | null = null;
  let assistantSeq = 0;
  let extensionSeq = 0;

  for (const parsed of file.lines) {
    const record = parsed.value;
    const role = messageRole(record);
    const timestamp = timestampFromRecord(record) ?? importedAt;

    if (role === 'toolResult') {
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      const text = redactText(toolResultText(record));
      const toolName = stringOrUndefined(objectField(record.message).toolName);
      turn.items.push({
        id: `native-tool-result-${++extensionSeq}`,
        type: 'providerExtension',
        namespace: 'prime-agent',
        startedAt: timestamp,
        completedAt: timestamp,
        status: 'completed',
        payload: {
          kind: 'tool_result',
          lineNumber: parsed.lineNumber,
          ...(toolName ? { toolName } : {}),
          contentPreview: truncate(text, PREVIEW_LIMIT),
          redacted: true,
        },
      });
      continue;
    }

    if (role === 'user') {
      const text = redactText(messageText(record));
      if (!text) continue;
      const turnId = `native-turn-${turns.length}`;
      const itemId = `user-${turnId}`;
      const providerItemId = stringOrUndefined(
        (objectField(record.message) as Record<string, unknown>).id
      );
      const userItem: AgentItemV2 = {
        id: itemId,
        type: 'userMessage',
        text: truncate(text, TEXT_LIMIT),
        startedAt: timestamp,
        completedAt: timestamp,
        status: 'completed',
        ...(providerItemId ? { providerItemId } : {}),
      };
      const turn: AgentTurnV2 = {
        id: turnId,
        ...(providerItemId ? { providerTurnId: providerItemId } : {}),
        status: 'completed',
        inputMessageId: itemId,
        startedAt: timestamp,
        completedAt: timestamp,
        items: [userItem],
      };
      activeTurn = turn;
      turns.push(turn);
      continue;
    }

    if (role === 'assistant') {
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      appendAssistantBlocks(turn, record, timestamp, ++assistantSeq);
      turn.completedAt = timestamp;
      continue;
    }
  }

  for (const turn of turns) {
    turn.status = 'completed';
    turn.completedAt = turn.completedAt ?? turn.startedAt;
  }

  const truncation = trimImportedTurns(turns);

  return truncation ? { turns, truncation } : { turns };
}

function trimImportedTurns(
  turns: AgentTurnV2[]
): NativeSessionImportTruncation | undefined {
  let approximateTranscriptBytes = transcriptBytes(turns);
  if (approximateTranscriptBytes <= MAX_IMPORT_TRANSCRIPT_BYTES)
    return undefined;

  const originalTurns = turns.length;
  let droppedTurns = 0;
  let droppedItems = 0;

  while (
    approximateTranscriptBytes > MAX_IMPORT_TRANSCRIPT_BYTES &&
    turns.length > 1
  ) {
    const [removed] = turns.splice(1, 1);
    if (!removed) break;
    droppedTurns += 1;
    droppedItems += removed.items.length;
    approximateTranscriptBytes = transcriptBytes(turns);
  }

  return {
    truncated: true,
    strategy: 'fifo-oldest-non-audit',
    maxTranscriptBytes: MAX_IMPORT_TRANSCRIPT_BYTES,
    approximateTranscriptBytes,
    originalTurns,
    retainedTurns: turns.length,
    droppedTurns,
    droppedItems,
  };
}

function annotateAuditMarker(
  turns: AgentTurnV2[],
  metadata: Record<string, unknown>
): void {
  const marker = turns[0]?.items[0];
  if (!marker || marker.type !== 'providerExtension') return;
  marker.payload = {
    ...marker.payload,
    ...metadata,
  };
}

function transcriptBytes(turns: AgentTurnV2[]): number {
  return Buffer.byteLength(JSON.stringify(turns), 'utf8');
}

/**
 * Prime assistant content blocks: `{type:"text"}`, `{type:"thinking",
 * thinking}`, and `{type:"toolCall", id, name, arguments}`. Deterministic
 * mapping, redacted before anything is stored.
 */
function appendAssistantBlocks(
  turn: AgentTurnV2,
  record: Record<string, unknown>,
  timestamp: string,
  seq: number
): void {
  const blocks = contentBlocks(record);
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const extraItems: AgentItemV2[] = [];

  for (const block of blocks) {
    const blockType = stringField(block.type);
    if (blockType === 'text') {
      const text = stringField(block.text);
      if (text) textParts.push(text);
    } else if (blockType === 'thinking' || blockType === 'reasoning') {
      const text = stringField(block.thinking ?? block.text ?? block.summary);
      if (text) reasoningParts.push(text);
    } else if (blockType === 'toolCall' || blockType === 'tool_use') {
      extraItems.push(toolCallItem(block, timestamp, seq, extraItems.length));
    }
  }

  if (reasoningParts.length > 0) {
    extraItems.unshift({
      id: `assistant-reasoning-${seq}`,
      type: 'reasoning',
      summary: truncate(redactText(reasoningParts.join('\n')), PREVIEW_LIMIT),
      visibility: 'summary',
      startedAt: timestamp,
      completedAt: timestamp,
      status: 'completed',
    });
  }

  if (textParts.length > 0) {
    extraItems.push({
      id: `assistant-message-${seq}`,
      providerMessageId:
        stringOrUndefined(
          (objectField(record.message) as Record<string, unknown>).id
        ) ?? `prime-agent-assistant-${seq}`,
      type: 'assistantMessage',
      text: truncate(redactText(textParts.join('\n')), TEXT_LIMIT),
      phase: 'answer',
      startedAt: timestamp,
      completedAt: timestamp,
      status: 'completed',
    });
  }

  turn.items.push(...extraItems);
}

function toolCallItem(
  block: Record<string, unknown>,
  timestamp: string,
  seq: number,
  index: number
): AgentItemV2 {
  const toolName = stringField(block.name, 'unknown-tool');
  const args = objectField(block.arguments ?? block.input);
  const command = typeof args.command === 'string' ? args.command : '';
  const base = {
    id: `assistant-tool-${seq}-${index}`,
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'completed' as const,
    metadata: { sourceProvider: 'prime-agent', readOnlyImport: true },
  };
  const providerItemId = stringOrUndefined(block.id);

  if (command) {
    return {
      ...base,
      ...(providerItemId ? { providerItemId } : {}),
      type: 'commandExecution',
      command: truncate(command, PREVIEW_LIMIT),
      output: '',
      exitCode: null,
    };
  }
  return {
    ...base,
    ...(providerItemId ? { providerItemId } : {}),
    type: 'dynamicToolCall',
    namespace: 'prime-agent',
    tool: toolName,
    arguments: redactJsonValue(args),
  };
}

function createSyntheticTurn(
  turns: AgentTurnV2[],
  timestamp: string,
  importedAt: string
): AgentTurnV2 {
  const turn: AgentTurnV2 = {
    id: `native-turn-${turns.length}`,
    status: 'completed',
    inputMessageId: `native-synthetic-${turns.length}`,
    startedAt: timestamp,
    completedAt: importedAt,
    items: [],
  };
  turns.push(turn);
  return turn;
}
function normalizeRef(
  ref: NativeSessionRef,
  summary: NativeSessionSummary
): NativeSessionRef {
  return {
    provider: 'prime-agent',
    nativeId: summary.nativeId,
    sourcePath: summary.sourcePath,
    ...(summary.cwd ? { cwd: summary.cwd } : {}),
    ...(ref.stateRoot ? { stateRoot: ref.stateRoot } : {}),
  };
}

function providerSession(
  summary: NativeSessionSummary,
  file: PrimeJsonlFile
): Record<string, string> {
  const providerSession: Record<string, string> = {
    nativeId: summary.nativeId,
    sourcePath: file.path,
    stateKind: 'prime-agent-jsonl',
    hashSha256: file.hashSha256,
  };
  if (summary.cwd) providerSession.cwd = summary.cwd;
  return providerSession;
}

/** Role extraction keyed on the `message` envelope's inner `role`. */
function messageRole(record: Record<string, unknown>): string | null {
  const message = objectField(record.message);
  const role = stringField(message.role) || stringField(record.role);
  if (role === 'user' || role === 'assistant' || role === 'toolResult') {
    return role;
  }
  return null;
}

function contentBlocks(
  record: Record<string, unknown>
): Record<string, unknown>[] {
  const message = objectField(record.message);
  const content = message.content ?? record.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function toolResultText(record: Record<string, unknown>): string {
  const blocks = contentBlocks(record);
  const parts: string[] = [];
  for (const block of blocks) {
    if (stringField(block.type) === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (isRecord(block.content)) {
      const nested = block.content;
      if (typeof nested.text === 'string') parts.push(nested.text);
    } else if (typeof block.content === 'string') {
      parts.push(block.content);
    }
  }
  return parts.join('\n');
}

function messageText(record: Record<string, unknown>): string {
  const blocks = contentBlocks(record);
  const parts: string[] = [];
  for (const block of blocks) {
    if (stringField(block.type) === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function timestampFromRecord(record: Record<string, unknown>): string | null {
  const ts = record.timestamp;
  if (typeof ts === 'string' && ts) return ts;
  if (typeof ts === 'number') {
    try {
      return new Date(ts).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}
function collectTimestamps(lines: ParsedJsonlLine[]): {
  first: string | null;
  last: string | null;
} {
  let first: string | null = null;
  let last: string | null = null;
  for (const parsed of lines) {
    const ts = timestampFromRecord(parsed.value);
    if (ts) {
      if (!first) first = ts;
      last = ts;
    }
  }
  return { first, last };
}

function collectEventTypes(lines: ParsedJsonlLine[]): string[] {
  const seen = new Set<string>();
  for (const parsed of lines) {
    const type = stringField(parsed.value.type);
    if (type) seen.add(type);
  }
  return Array.from(seen).sort();
}

function firstStringField(
  lines: ParsedJsonlLine[],
  fields: readonly string[]
): string | undefined {
  for (const parsed of lines) {
    for (const field of fields) {
      const value = parsed.value[field];
      if (typeof value === 'string' && value) return value;
    }
  }
  return undefined;
}

function stringFromRecord(
  record: Record<string, unknown>,
  fields: readonly string[]
): string {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

const REDACT_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /\b(token|api[_-]?key|secret|password|credential)\s*[:=]\s*\S+/gi,
    replacement: '$1=[redacted]',
  },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/g, replacement: '«redacted:sk-…»' },
  { pattern: /\bghp_[A-Za-z0-9]{36,}/g, replacement: '«redacted:ghp_…»' },
];

function redactText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
function redactJsonValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (REDACT_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      result[key] = '[redacted]';
    } else if (typeof val === 'string') {
      result[key] = redactText(val);
    } else if (isRecord(val)) {
      result[key] = redactJsonValue(val);
    } else if (Array.isArray(val)) {
      result[key] = val.map((item) =>
        typeof item === 'string'
          ? redactText(item)
          : isRecord(item)
            ? redactJsonValue(item)
            : item
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

const REDACT_KEY_PATTERNS: readonly RegExp[] = [
  /^(token|api[_-]?key|apiKey|secret|password|credential|authorization)$/i,
];

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function relaySessionId(nativeId: string, hash: string): string {
  return `native-prime-agent-${slug(nativeId)}-${hash.slice(0, 12)}`;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-|-$/g, '').slice(0, 48) || 'session';
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
