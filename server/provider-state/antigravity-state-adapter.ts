import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  emptyAgentSessionV2,
  isAgentPatchV2,
} from '../../shared/agent-chat-protocol-v2.js';
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

const logger = createLogger('provider-state:antigravity-state');

/**
 * Read-only adapter over Google's Antigravity CLI (`agy`) local session store
 * (#1439). Ground truth verified against the real `~/.gemini/antigravity-cli`
 * store and agy v1.1.20:
 *
 * - `history.jsonl` — append-only, one record per user prompt:
 *   `{ display, timestamp (epoch-ms), workspace (cwd), conversationId, type? }`.
 *   Some early records (pre-conversation slash commands) omit `conversationId`.
 *   This is the natural listing source: grouping by `conversationId` yields one
 *   session whose title is the first `display` preview and whose newest
 *   timestamp is `lastMessageAt`.
 * - `brain/<conversationId>/.system_generated/logs/transcript.jsonl` (+ rolling
 *   `chunks/transcript/NNNNNNNN.jsonl`) — appended plaintext JSONL keyed on
 *   `type`: `USER_INPUT` (content wrapped in `<USER_REQUEST>`),
 *   `CONVERSATION_HISTORY`, `CHECKPOINT`, `PLANNER_RESPONSE` (carries optional
 *   `thinking`, `tool_calls[]`, and final answer text in `content`),
 *   tool-step records (`LIST_DIRECTORY`, …) with `step_index`/`source`/`status`/
 *   `created_at` (ISO).
 * - `conversations/<id>.pb` are opaque protobuf blobs and `<id>.db` are empty
 *   SQLite shells — NOT parseable data sources. Conversations backed only by
 *   those artifacts still list (from history.jsonl) and import degrades
 *   honestly: user turns from history, assistant content reported as an
 *   explicit diagnostic rather than fabricated.
 *
 * Observation only: this adapter never mutates the store. `resumeCommand`
 * returns copyable argv data (`agy --conversation <id>`, flag semantics
 * verified against `agy --help` v1.1.20); callers decide whether to run it.
 */

const ANTIGRAVITY_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: true,
  canReadProviderState: true,
  canResumeNative: true,
  // Wired through NativeSessionLiveTailManager via the plain JSONL tailer;
  // transcript.jsonl files are appended plaintext JSONL.
  canStreamLiveEvents: true,
  canRespondToApprovals: false,
  // Transcript records carry named tool calls (`PLANNER_RESPONSE.tool_calls`,
  // typed tool steps) surfaced as provider-extension payloads.
  canExposeToolCalls: true,
  readOnly: true,
};

const MAX_LIST_SESSIONS = 500;
const PREVIEW_LIMIT = 240;
const TEXT_LIMIT = 32_000;
const MAX_LOG_BYTES = 5_000_000;
const MAX_LOG_LINES = 20_000;
const MAX_LOG_EVENTS = 5_000;
const MAX_IMPORT_TRANSCRIPT_BYTES = 256_000;

const HISTORY_FILE = 'history.jsonl';

interface ParsedRecord {
  /** 1-based line number within the JSONL stream. */
  lineNumber: number;
  value: Record<string, unknown>;
}

interface ReadAntigravityLog {
  path: string;
  bytes: number;
  hashSha256: string;
  /** 'history' = history.jsonl grouped view; 'transcript' = brain log. */
  kind: 'history' | 'transcript';
  records: ParsedRecord[];
  readTruncation?: NativeSessionJsonlReadTruncation;
}

export interface AntigravityStateAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
  maxSessions?: number;
}

export class AntigravityStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'antigravity' as const;
  readonly capabilities = ANTIGRAVITY_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxSessions: number;

  constructor(options: AntigravityStateAdapterOptions = {}) {
    this.stateRoot =
      options.stateRoot ?? path.join(homedir(), '.gemini', 'antigravity-cli');
    this.now = options.now ?? (() => new Date());
    this.maxSessions = options.maxSessions ?? MAX_LIST_SESSIONS;
  }

  async detectInstall(): Promise<ProviderInstallStatus> {
    const detectedAt = this.nowIso();
    try {
      await access(this.stateRoot, constants.R_OK);
      let hasHistory = false;
      try {
        const info = await lstat(path.join(this.stateRoot, HISTORY_FILE));
        hasHistory = info.isFile() && !info.isSymbolicLink();
      } catch {
        hasHistory = false;
      }
      return {
        provider: this.provider,
        status: 'installed',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: [
          {
            code: hasHistory ? 'AGY_STATE_READABLE' : 'AGY_STATE_EMPTY',
            message: hasHistory
              ? 'Antigravity CLI state directory is readable.'
              : 'Antigravity CLI state directory is readable but contains no conversation history yet.',
            severity: hasHistory ? 'info' : 'warning',
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
            code: 'AGY_STATE_ROOT_NOT_FOUND',
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
    // Listing is driven entirely by history.jsonl (#1439): one grouped entry
    // per conversationId, newest-timestamp-wins ordering. Conversations whose
    // only other artifacts are opaque .pb blobs still list here; their
    // summaries carry `metadata.transcriptAvailable: false` so callers get an
    // honest signal instead of a failed import later.
    const groups = await readHistoryGroups(this.stateRoot);
    const summaries: NativeSessionSummary[] = [];

    for (const group of groups.values()) {
      if (summaries.length >= this.maxSessions) break;
      if (scope.cwd || scope.repoPath) {
        const wanted = scope.cwd ?? scope.repoPath;
        if (!group.workspace || group.workspace !== wanted) continue;
      }
      if (scope.workContextId && group.workContextId !== scope.workContextId) {
        continue;
      }

      const transcriptPath = this.transcriptPathFor(group.conversationId);
      const readTranscriptInfo = async (): Promise<{
        bytes: number;
        hashSha256: string;
      } | null> => {
        try {
          const resolved = await this.resolveSafeSourcePath(transcriptPath);
          const raw = await readFile(resolved);
          return {
            bytes: raw.length,
            hashSha256: createHash('sha256').update(raw).digest('hex'),
          };
        } catch {
          return null; // No parseable transcript (e.g. .pb-only conversation).
        }
      };
      const transcriptInfo = await readTranscriptInfo();

      summaries.push({
        provider: this.provider,
        nativeId: group.conversationId,
        sourcePath: transcriptInfo ? transcriptPath : this.historyPath,
        ...(group.workspace ? { cwd: group.workspace } : {}),
        ...(group.firstTimestamp ? { createdAt: group.firstTimestamp } : {}),
        ...(group.lastTimestamp ? { updatedAt: group.lastTimestamp } : {}),
        ...(group.lastTimestamp ? { lastMessageAt: group.lastTimestamp } : {}),
        ...(group.firstDisplay ? { title: group.firstDisplay.title } : {}),
        preview: group.preview(),
        metadata: {
          nativeSessionId: group.conversationId,
          transcriptAvailable: transcriptInfo !== null,
          ...(transcriptInfo
            ? {
                byteCount: transcriptInfo.bytes,
                hashSha256: transcriptInfo.hashSha256,
              }
            : {}),
        },
        capabilities: this.capabilities,
      });
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
    const timestamps = collectTimestamps(file.records);

    return {
      ref: {
        provider: this.provider,
        nativeId: ref.nativeId,
        sourcePath: file.path,
        ...(ref.stateRoot ? { stateRoot: ref.stateRoot } : {}),
      },
      capturedAt: this.nowIso(),
      sourcePath: file.path,
      summary: {
        lineCount: file.records.length,
        byteCount: file.bytes,
        hashSha256: file.hashSha256,
        eventTypes: collectEventTypes(file.records),
        ...(timestamps.first ? { firstTimestamp: timestamps.first } : {}),
        ...(timestamps.last ? { lastTimestamp: timestamps.last } : {}),
        preview: await this.previewFor(ref, file),
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
    const importedAt = this.nowIso();
    const sessionId = relaySessionId(ref.nativeId, file.hashSha256);
    const session = emptyAgentSessionV2({
      id: sessionId,
      provider: 'antigravity',
      cwd: ref.cwd ?? '',
      capabilities: {
        text: true,
        reasoning: true,
        tools: true,
        commandExecution: false,
        fileChanges: false,
        approvals: false,
        questions: false,
        plans: false,
        resume: true,
        telemetry: false,
        streaming: false,
      },
      providerSession: {
        nativeId: ref.nativeId,
        sourcePath: file.path,
        stateKind: `antigravity-${file.kind}-jsonl`,
        hashSha256: file.hashSha256,
        ...(ref.cwd ? { cwd: ref.cwd } : {}),
      },
      config: {
        providerOptions: {
          importedFromNativeProvider: true,
          importSource: 'antigravity-jsonl',
          readOnly: true,
        },
      },
    });

    const importedTurns = buildTurns(file, ref, importedAt);
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
    if (!patches.every(isAgentPatchV2)) {
      throw new Error('Antigravity import produced an invalid patch.');
    }

    const result: NativeSessionImportResult = {
      provider: this.provider,
      nativeId: ref.nativeId,
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

  resumeCommand(ref: NativeSessionRef): string[] {
    // Flag verified against `agy --help` (v1.1.20):
    // "--conversation  Resume a previous conversation by ID".
    return ['agy', '--conversation', ref.nativeId];
  }

  private get historyPath(): string {
    return path.join(this.stateRoot, HISTORY_FILE);
  }

  private transcriptPathFor(conversationId: string): string {
    return path.join(
      this.stateRoot,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
  }

  private async readRef(ref: NativeSessionRef): Promise<ReadAntigravityLog> {
    if (ref.provider !== this.provider) {
      throw new Error(
        `Antigravity adapter cannot read provider '${ref.provider}'.`
      );
    }
    if (ref.sourcePath) {
      return this.readResolved(
        await this.resolveSafeSourcePath(ref.sourcePath),
        ref.nativeId
      );
    }

    // Resolve nativeId -> sourcePath through our own listing so the caller
    // never supplies arbitrary filesystem paths.
    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (!found) {
      throw new Error(
        `Antigravity native session '${ref.nativeId}' was not found.`
      );
    }
    return this.readResolved(
      await this.resolveSafeSourcePath(found.sourcePath),
      ref.nativeId
    );
  }

  /**
   * Read one bounded JSONL source. A brain transcript parses as-is; a
   * history.jsonl source is filtered to the requested conversation so imports
   * of `.pb`-only conversations still yield their real user turns (with the
   * missing assistant side reported as an explicit diagnostic).
   */
  private async readResolved(
    filePath: string,
    nativeId: string
  ): Promise<ReadAntigravityLog> {
    const info = await lstat(filePath);
    const raw = await readFile(filePath);
    const hash = createHash('sha256').update(raw).digest('hex');

    const kind: ReadAntigravityLog['kind'] =
      path.basename(filePath) === HISTORY_FILE ? 'history' : 'transcript';

    const records: ParsedRecord[] = [];
    let readTruncation: NativeSessionJsonlReadTruncation | undefined;
    const lines = raw.toString('utf8').split('\n');
    let seenLines = 0;
    let parsedEvents = 0;
    let bytesSeen = 0;

    for (const line of lines) {
      seenLines += 1;
      bytesSeen += Buffer.byteLength(line, 'utf8') + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (seenLines > MAX_LOG_LINES && !readTruncation) {
        readTruncation = logReadTruncation(
          'line-limit',
          seenLines,
          parsedEvents
        );
      }
      if (bytesSeen > MAX_LOG_BYTES && !readTruncation) {
        readTruncation = logReadTruncation(
          'byte-limit',
          seenLines,
          parsedEvents
        );
      }
      if (parsedEvents >= MAX_LOG_EVENTS && !readTruncation) {
        readTruncation = logReadTruncation(
          'event-limit',
          seenLines,
          parsedEvents
        );
      }
      if (readTruncation) continue;
      try {
        const value: unknown = JSON.parse(trimmed);
        if (!isRecord(value)) continue;
        if (
          kind === 'history' &&
          stringField(value['conversationId']) &&
          stringField(value['conversationId']) !== nativeId
        ) {
          continue;
        }
        if (kind === 'history' && !stringField(value['conversationId'])) {
          continue; // Pre-conversation rows (bare slash commands) carry no id.
        }
        parsedEvents += 1;
        records.push({ lineNumber: seenLines, value });
      } catch {
        // Corrupt lines are skipped during read-only listing/import; the
        // live-tail path attributes them as gaps instead.
      }
    }

    return {
      path: filePath,
      bytes: info.size,
      hashSha256: hash,
      kind,
      records,
      ...(readTruncation ? { readTruncation } : {}),
    };
  }

  private async previewFor(
    ref: NativeSessionRef,
    file: ReadAntigravityLog
  ): Promise<NativeSessionPreview> {
    if (file.kind === 'transcript') {
      for (const parsed of file.records) {
        if (stringField(parsed.value['type']) !== 'USER_INPUT') continue;
        const text = redactText(extractUserRequestText(parsed.value));
        if (text) {
          return {
            text: truncate(text, PREVIEW_LIMIT),
            source: 'transcript',
            redacted: true,
            charCount: Math.min(text.length, PREVIEW_LIMIT),
          };
        }
      }
    }
    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (found?.title) {
      return {
        text: truncate(redactText(found.title), PREVIEW_LIMIT),
        source: 'metadata',
        redacted: true,
        charCount: Math.min(found.title.length, PREVIEW_LIMIT),
      };
    }
    return {
      text: truncate(ref.nativeId, PREVIEW_LIMIT),
      source: 'filename',
      redacted: false,
      charCount: Math.min(ref.nativeId.length, PREVIEW_LIMIT),
    };
  }

  private async resolveSafeSourcePath(sourcePath: string): Promise<string> {
    const rootRealPath = await realpath(this.stateRoot);
    const candidatePath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(rootRealPath, sourcePath);
    if (path.extname(candidatePath) !== '.jsonl') {
      throw new Error(
        'Antigravity native session sourcePath must point to a .jsonl file.'
      );
    }

    const sourceInfo = await lstat(candidatePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error(
        'Antigravity native session sourcePath must not be a symlink.'
      );
    }
    if (!sourceInfo.isFile()) {
      throw new Error(
        'Antigravity native session sourcePath must point to a regular .jsonl file.'
      );
    }

    const sourceRealPath = await realpath(candidatePath);
    if (path.extname(sourceRealPath) !== '.jsonl') {
      throw new Error(
        'Antigravity native session sourcePath must resolve to a .jsonl file.'
      );
    }
    if (!isPathInside(rootRealPath, sourceRealPath)) {
      throw new Error(
        'Antigravity native session sourcePath must resolve under the configured state root.'
      );
    }

    return sourceRealPath;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

interface HistoryGroup {
  conversationId: string;
  workspace?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  firstDisplay?: { title: string; redacted: boolean };
  workContextId?: string;
  displayCount: number;
  preview: () => NativeSessionPreview;
}

/** Read history.jsonl and fold its rows into one group per conversationId. */
async function readHistoryGroups(
  stateRoot: string
): Promise<Map<string, HistoryGroup>> {
  const groups = new Map<string, HistoryGroup>();
  const historyPath = path.join(stateRoot, 'history.jsonl');
  let raw: Buffer;
  try {
    const info = await lstat(historyPath);
    if (!info.isFile() || info.isSymbolicLink()) return groups;
    raw = await readFile(historyPath);
  } catch {
    return groups;
  }

  const lines = raw.toString('utf8').split('\n');
  let seen = 0;
  for (const line of lines) {
    seen += 1;
    if (seen > MAX_LOG_LINES) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const conversationId = stringField(value['conversationId']);
    if (!conversationId) continue;
    const display = stringField(value['display']);
    const timestampMs = numberField(value, 'timestamp');
    const timestamp =
      typeof timestampMs === 'number' && Number.isFinite(timestampMs)
        ? new Date(timestampMs).toISOString()
        : undefined;
    const workspace = stringField(value['workspace']);

    const existing = groups.get(conversationId);
    if (!existing) {
      const title = display ? truncate(redactText(display), PREVIEW_LIMIT) : '';
      const group: HistoryGroup = {
        conversationId,
        ...(workspace ? { workspace } : {}),
        ...(timestamp ? { firstTimestamp: timestamp } : {}),
        ...(timestamp ? { lastTimestamp: timestamp } : {}),
        ...(display ? { firstDisplay: { title, redacted: true } } : {}),
        displayCount: display ? 1 : 0,
        preview: () =>
          title
            ? {
                text: title,
                source: 'metadata',
                redacted: true,
                charCount: Math.min(title.length, PREVIEW_LIMIT),
              }
            : {
                text: truncate(conversationId, PREVIEW_LIMIT),
                source: 'filename',
                redacted: false,
                charCount: Math.min(conversationId.length, PREVIEW_LIMIT),
              },
      };
      groups.set(conversationId, group);
      continue;
    }

    if (
      timestamp &&
      (!existing.lastTimestamp || timestamp > existing.lastTimestamp)
    ) {
      existing.lastTimestamp = timestamp;
    }
    if (
      timestamp &&
      (!existing.firstTimestamp || timestamp < existing.firstTimestamp)
    ) {
      existing.firstTimestamp = timestamp;
    }
    if (display) existing.displayCount += 1;
  }

  return groups;
}

interface ImportedTurns {
  turns: AgentTurnV2[];
  truncation?: NativeSessionImportTruncation;
}

interface TurnBuildState {
  activeTurn: AgentTurnV2 | null;
  itemSeq: number;
}

interface RecordContext {
  record: Record<string, unknown>;
  timestamp: string;
  lineNumber: number;
  turns: AgentTurnV2[];
  state: TurnBuildState;
  unmappedEventTypes: Map<string, number>;
  importedAt: string;
}

function requireActiveTurn(
  ctx: RecordContext,
  createIfMissing: boolean
): AgentTurnV2 | null {
  if (ctx.state.activeTurn) return ctx.state.activeTurn;
  if (!createIfMissing) return null;
  const turn = createSyntheticTurn(ctx.turns, ctx.timestamp, ctx.importedAt);
  ctx.state.activeTurn = turn;
  return turn;
}

/**
 * History-sourced import (`.pb`-only conversations): every row is a user
 * prompt; the assistant side lives in unparseable artifacts and is reported
 * as an explicit degradation marker instead of fabricated.
 */
function applyHistoryRecord(ctx: RecordContext): void {
  const text = redactText(stringField(ctx.record['display']));
  if (!text) {
    noteUnmapped(ctx.unmappedEventTypes, 'history:empty-display');
    return;
  }
  const turn = userHistoryTurn(
    ctx.record,
    ctx.turns.length,
    text,
    ctx.timestamp
  );
  ctx.state.activeTurn = turn;
  ctx.turns.push(turn);
}

/** USER_INPUT opens a new conversation turn with its extracted request. */
function applyUserInput(ctx: RecordContext): void {
  const text = redactText(extractUserRequestText(ctx.record));
  if (!text) {
    noteUnmapped(
      ctx.unmappedEventTypes,
      `${stringField(ctx.record['type'], 'USER_INPUT')}:empty`
    );
    return;
  }
  const turnId = `native-turn-${ctx.turns.length}`;
  const itemId = `user-${turnId}`;
  const stepIndex = numberField(ctx.record, 'step_index');
  const userItem: AgentItemV2 = {
    id: itemId,
    type: 'userMessage',
    text: truncate(text, TEXT_LIMIT),
    startedAt: ctx.timestamp,
    completedAt: ctx.timestamp,
    status: 'completed',
    ...(stepIndex !== undefined ? { providerItemId: `step-${stepIndex}` } : {}),
  };
  const turn: AgentTurnV2 = {
    id: turnId,
    status: 'completed',
    inputMessageId: itemId,
    startedAt: ctx.timestamp,
    completedAt: ctx.timestamp,
    items: [userItem],
  };
  ctx.state.activeTurn = turn;
  ctx.turns.push(turn);
}

/**
 * PLANNER_RESPONSE folds thinking evidence, named tool calls, and the final
 * answer into the active turn — all three, in file order, never collapsing.
 */
function applyPlannerResponse(ctx: RecordContext): void {
  const type = stringField(ctx.record['type'], 'PLANNER_RESPONSE');
  const turn = requireActiveTurn(ctx, true)!;
  let emitted = false;

  const thinking = stringField(ctx.record['thinking']);
  if (thinking) {
    turn.items.push({
      id: `assistant-reasoning-${++ctx.state.itemSeq}`,
      type: 'reasoning',
      summary: truncate(redactText(thinking), PREVIEW_LIMIT),
      visibility: 'summary',
      startedAt: ctx.timestamp,
      completedAt: ctx.timestamp,
      status: 'completed',
    });
    emitted = true;
  }

  const toolCalls = Array.isArray(ctx.record['tool_calls'])
    ? ctx.record['tool_calls'].filter(isRecord)
    : [];
  for (const [callIndex, call] of toolCalls.entries()) {
    turn.items.push({
      id: `native-tool-call-${++ctx.state.itemSeq}`,
      type: 'providerExtension',
      namespace: 'antigravity',
      startedAt: ctx.timestamp,
      completedAt: ctx.timestamp,
      status: 'completed',
      payload: {
        kind: 'tool_call',
        ...(stringField(call['name'])
          ? { name: stringField(call['name']) }
          : {}),
        ...(call['args'] !== undefined
          ? {
              argsPreview: truncate(
                redactText(safeJson(call['args'])),
                PREVIEW_LIMIT
              ),
              redacted: true,
            }
          : {}),
        callIndex,
      },
    });
    emitted = true;
  }

  const answer = redactText(
    stringField(ctx.record['content']) || stringField(ctx.record['response'])
  );
  if (answer) {
    turn.items.push({
      id: `assistant-message-${++ctx.state.itemSeq}`,
      type: 'assistantMessage',
      text: truncate(answer, TEXT_LIMIT),
      phase: 'answer',
      startedAt: ctx.timestamp,
      completedAt: ctx.timestamp,
      status: 'completed',
    });
    emitted = true;
  }

  if (!emitted) {
    noteUnmapped(ctx.unmappedEventTypes, `${type}:empty`);
    return;
  }
  turn.completedAt = ctx.timestamp;
}

/** Typed MODEL tool steps map to provider-extension items with honest status. */
function applyToolStep(ctx: RecordContext, type: string): void {
  const turn = requireActiveTurn(ctx, true)!;
  const status = stringField(ctx.record['status'], 'UNKNOWN');
  const content = stringField(ctx.record['content']);
  turn.items.push({
    id: `native-tool-step-${++ctx.state.itemSeq}`,
    type: 'providerExtension',
    namespace: 'antigravity',
    startedAt: ctx.timestamp,
    completedAt: ctx.timestamp,
    status: status === 'ERROR' ? 'failed' : 'completed',
    payload: {
      kind: type,
      status,
      lineNumber: ctx.lineNumber,
      ...(content
        ? {
            textPreview: truncate(redactText(content), PREVIEW_LIMIT),
            redacted: true,
          }
        : {}),
    },
  });
  turn.completedAt = ctx.timestamp;
}

/**
 * CONVERSATION_HISTORY/CHECKPOINT are system-side bookkeeping: attach as
 * provenance while a turn is open; before the first turn there is nothing to
 * attach to, so they become attributed gaps (same rule as pre-turn policy
 * records in dsh).
 */
function applySystemBookkeeping(ctx: RecordContext, type: string): void {
  const turn = requireActiveTurn(ctx, false);
  if (!turn) {
    noteUnmapped(ctx.unmappedEventTypes, `${type}:pre-turn`);
    return;
  }
  turn.items.push({
    id: `native-extension-${++ctx.state.itemSeq}`,
    type: 'providerExtension',
    namespace: 'antigravity',
    startedAt: ctx.timestamp,
    completedAt: ctx.timestamp,
    status: 'completed',
    payload: {
      kind: type,
      lineNumber: ctx.lineNumber,
    },
  });
}

/**
 * Turn assembly follows the dsh/prime-agent mapping approach: audit-marker
 * turn first, then one turn per USER_INPUT, folding PLANNER_RESPONSE answer +
 * thinking evidence and typed tool steps into the active turn. Known system
 * records (CONVERSATION_HISTORY, CHECKPOINT) attach as extension items when a
 * turn is open and are attributed gaps before the first turn; anything else
 * unknown is a logged gap, never silence. Deterministic; FIFO truncation
 * identical to siblings.
 */
function buildTurns(
  file: ReadAntigravityLog,
  ref: NativeSessionRef,
  importedAt: string
): ImportedTurns {
  const turns: AgentTurnV2[] = [auditMarkerTurn(file, ref, importedAt)];

  const unmappedEventTypes = new Map<string, number>();
  const state: TurnBuildState = { activeTurn: null, itemSeq: 0 };

  for (const parsed of file.records) {
    const record = parsed.value;
    const type = stringField(record['type']);
    const timestamp = isoCreatedAt(record) ?? importedAt;
    const ctx: RecordContext = {
      record,
      timestamp,
      lineNumber: parsed.lineNumber,
      turns,
      state,
      unmappedEventTypes,
      importedAt,
    };

    if (file.kind === 'history') {
      applyHistoryRecord(ctx);
      continue;
    }
    switch (type) {
      case 'USER_INPUT':
        applyUserInput(ctx);
        break;
      case 'PLANNER_RESPONSE':
        applyPlannerResponse(ctx);
        break;
      default:
        if (isKnownToolStep(type)) {
          applyToolStep(ctx, type);
        } else if (type === 'CONVERSATION_HISTORY' || type === 'CHECKPOINT') {
          applySystemBookkeeping(ctx, type);
        } else {
          // Fidelity invariant (server/protocol-adapters/AGENTS.md): an
          // unmapped native event is a logged gap, never silence.
          noteUnmapped(unmappedEventTypes, type || 'unknown');
        }
    }
  }

  if (file.kind === 'history' && turns.length > 1) {
    // Honest degradation for `.pb`-only conversations: say plainly that no
    // parseable assistant content existed for these turns.
    annotateAuditMarker(turns, {
      degradedSource: 'antigravity-history-jsonl',
      degradedReason: 'assistant-content-not-parseable-from-pb-artifacts',
    });
  }

  for (const turn of turns) {
    turn.status = 'completed';
    turn.completedAt = turn.completedAt ?? turn.startedAt;
  }

  if (unmappedEventTypes.size > 0) {
    const flat: Record<string, number> = {};
    for (const [eventType, count] of unmappedEventTypes)
      flat[eventType] = count;
    annotateAuditMarker(turns, { unmappedEventTypes: flat });
  }

  const truncation = trimImportedTurns(turns);
  return truncation ? { turns, truncation } : { turns };
}

function isKnownToolStep(type: string): boolean {
  // Typed MODEL tool-step records. Deliberately an allowlist of observed
  // shapes rather than "anything not recognized": genuinely unknown types fall
  // through to the attributed-gap branch below so drift stays visible.
  return (
    type === 'LIST_DIRECTORY' ||
    type === 'READ_FILE' ||
    type === 'WRITE_FILE' ||
    type === 'RUN_COMMAND' ||
    type === 'SEARCH' ||
    type === 'WEB_SEARCH'
  );
}

function auditMarkerTurn(
  file: ReadAntigravityLog,
  ref: NativeSessionRef,
  importedAt: string
): AgentTurnV2 {
  return {
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
          sourceProvider: 'antigravity',
          importSource: `antigravity-${file.kind}-jsonl`,
          importedAt,
          sourcePath: file.path,
          hashSha256: file.hashSha256,
          nativeId: ref.nativeId,
          readOnly: true,
        },
      },
    ],
  };
}

function userHistoryTurn(
  record: Record<string, unknown>,
  turnCount: number,
  text: string,
  timestamp: string
): AgentTurnV2 {
  const turnId = `native-turn-${turnCount}`;
  const itemId = `user-${turnId}`;
  const epoch = numberField(record, 'timestamp');
  const userItem: AgentItemV2 = {
    id: itemId,
    type: 'userMessage',
    text: truncate(text, TEXT_LIMIT),
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'completed',
    ...(typeof epoch === 'number' ? { providerItemId: `hist-${epoch}` } : {}),
  };
  return {
    id: turnId,
    status: 'completed',
    inputMessageId: itemId,
    startedAt: timestamp,
    completedAt: timestamp,
    items: [userItem],
  };
}

/**
 * USER_INPUT content wraps the real prompt in `<USER_REQUEST>…</USER_REQUEST>`
 * followed by `<ADDITIONAL_METADATA>`/`<USER_SETTINGS_CHANGE>` system blocks.
 * Extract just the request; fall back to the full redacted content when the
 * wrapper is absent so format drift cannot blank a turn.
 */
export function extractUserRequestText(
  record: Record<string, unknown>
): string {
  const content = stringField(record['content']);
  if (!content) return '';
  const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const inner = match?.[1]?.trim();
  return inner || content.trim();
}

function noteUnmapped(seen: Map<string, number>, eventType: string): void {
  seen.set(eventType, (seen.get(eventType) ?? 0) + 1);
  logger.info(
    `Unmapped native Antigravity session event '${eventType}' reported as import gap.`
  );
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

function collectTimestamps(records: ParsedRecord[]): {
  first: string | null;
  last: string | null;
} {
  let first: string | null = null;
  let last: string | null = null;
  for (const parsed of records) {
    const ts = isoCreatedAt(parsed.value);
    if (ts) {
      if (!first) first = ts;
      last = ts;
    }
  }
  return { first, last };
}

function collectEventTypes(records: ParsedRecord[]): string[] {
  const seen = new Set<string>();
  for (const parsed of records) {
    const type = stringField(parsed.value['type']);
    if (type) seen.add(type);
  }
  return Array.from(seen).sort();
}

/** `created_at` is ISO in transcripts; history rows use epoch-ms `timestamp`. */
function isoCreatedAt(record: Record<string, unknown>): string | null {
  const iso = stringField(record['created_at']);
  if (iso) return iso;
  const epoch = numberField(record, 'timestamp');
  if (typeof epoch === 'number' && Number.isFinite(epoch)) {
    try {
      return new Date(epoch).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

const REDACT_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /\b(token|api[_-]?key|secret|password|credential)\s*[:=]\s*\S+/gi,
    replacement: '$1=[redacted]',
  },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/g, replacement: '«redacted:sk-…»' },
  { pattern: /\bghp_[A-Za-z0-9]{36,}/g, replacement: '«redacted:ghp-…»' },
];

function redactText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function logReadTruncation(
  reason: NativeSessionJsonlReadTruncation['reason'],
  totalLinesSeen: number,
  parsedEvents: number
): NativeSessionJsonlReadTruncation {
  return {
    truncated: true,
    reason,
    maxBytes: MAX_LOG_BYTES,
    maxLines: MAX_LOG_LINES,
    maxEvents: MAX_LOG_EVENTS,
    totalLinesSeen,
    parsedEvents,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function relaySessionId(nativeId: string, hash: string): string {
  return `native-antigravity-${slug(nativeId)}-${hash.slice(0, 12)}`;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-|-$/g, '').slice(0, 48) || 'session';
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberField(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
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
