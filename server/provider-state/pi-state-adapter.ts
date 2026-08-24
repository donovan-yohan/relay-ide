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

const logger = createLogger('provider-state:pi-state');

// Ground truth (verified against real `~/.pi/agent/sessions` stores, #1426):
// Pi persists one directory per cwd, named `--<cwd without leading slash,
// '/' -> '-'>--` (case preserved), holding per-session JSONL files named
// `<ISO-timestamp with dashes>_<uuid>.jsonl`. Line 1 is a `type: 'session'`
// header carrying id/timestamp/cwd; later lines are `type: 'message'`
// (message.role user|assistant|toolResult), `model_change`,
// `thinking_level_change`, and `compaction` records, each with
// id/parentId/timestamp chains.
const PI_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: true,
  canReadProviderState: true,
  canResumeNative: true,
  // #1426: JSONL live tail shares the #1428 infrastructure end-to-end via
  // `sessions native watch`.
  canStreamLiveEvents: true,
  canRespondToApprovals: false,
  canExposeToolCalls: true,
  readOnly: true,
};

const MAX_LIST_FILES = 500;
const SESSION_DIR_DEPTH = 2; // <stateRoot>/<cwd-slug>/<session>.jsonl
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

interface PiJsonlFile {
  path: string;
  bytes: number;
  hashSha256: string;
  /** Parsed `type: 'session'` header record, when the first line carries one. */
  header: Record<string, unknown> | null;
  lines: ParsedJsonlLine[];
  readTruncation?: NativeSessionJsonlReadTruncation;
}

interface ImportedTurns {
  turns: AgentTurnV2[];
  truncation?: NativeSessionImportTruncation;
}

interface PiAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
  maxFiles?: number;
}

export class PiStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'pi' as const;
  readonly capabilities = PI_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxFiles: number;

  constructor(options: PiAdapterOptions = {}) {
    this.stateRoot =
      options.stateRoot ?? path.join(homedir(), '.pi', 'agent', 'sessions');
    this.now = options.now ?? (() => new Date());
    this.maxFiles = options.maxFiles ?? MAX_LIST_FILES;
  }

  async detectInstall(): Promise<ProviderInstallStatus> {
    const detectedAt = this.nowIso();
    try {
      await access(this.stateRoot, constants.R_OK);
      const files = await findSessionFiles(this.stateRoot, {
        maxFiles: 1,
        maxDepth: SESSION_DIR_DEPTH,
      });
      return {
        provider: this.provider,
        status: 'installed',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics:
          files.length > 0
            ? [
                {
                  code: 'PI_STATE_READABLE',
                  message: 'Pi agent sessions directory is readable.',
                  severity: 'info',
                },
              ]
            : [
                {
                  code: 'PI_STATE_EMPTY',
                  message:
                    'Pi agent sessions directory is readable but no session JSONL files were found.',
                  severity: 'warning',
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
            code: 'PI_STATE_ROOT_NOT_FOUND',
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
    // Pi buckets sessions by cwd slug; a cwd/repoPath scope only needs to walk
    // the matching bucket. Header cwd is still re-checked below so a slug
    // drift can never surface a session from the wrong working directory.
    const roots = await sessionDirRoots(this.stateRoot, scope);
    const summaries: NativeSessionSummary[] = [];

    for (const dirRoot of roots) {
      const files = await findSessionFiles(dirRoot, {
        maxFiles: Math.max(this.maxFiles - summaries.length, 0),
        maxDepth: 1,
      });
      for (const filePath of files) {
        try {
          const parsed = await readPiJsonl(filePath);
          const summary = summarizePiJsonl(parsed, this.capabilities);
          if (
            (scope.cwd || scope.repoPath) &&
            summary.cwd !== (scope.cwd ?? scope.repoPath)
          ) {
            continue;
          }
          if (
            scope.workContextId &&
            summary.workContextId !== scope.workContextId
          )
            continue;
          summaries.push(summary);
        } catch {
          // Skip unreadable or over-limit provider files during discovery.
        }
        if (summaries.length >= this.maxFiles) break;
      }
      if (summaries.length >= this.maxFiles) break;
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
    const summary = summarizePiJsonl(file, this.capabilities);
    const eventTypes = collectEventTypes(file.lines);
    const timestamps = collectTimestamps(file.lines);

    return {
      ref: normalizeRef(ref, summary),
      capturedAt: this.nowIso(),
      sourcePath: file.path,
      summary: {
        lineCount: file.lines.length,
        byteCount: file.bytes,
        hashSha256: file.hashSha256,
        eventTypes,
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
    const summary = summarizePiJsonl(file, this.capabilities);
    const importedAt = this.nowIso();
    const sessionId = relaySessionId(summary.nativeId, file.hashSha256);
    const session = emptyAgentSessionV2({
      id: sessionId,
      provider: 'pi',
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
          importSource: 'pi-jsonl',
          readOnly: true,
        },
      },
    });

    const importedTurns = buildTurns(file, sessionId, importedAt);
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

  resumeCommand(ref: NativeSessionRef): string[] {
    return ['pi', '--resume', ref.nativeId];
  }

  private async readRef(ref: NativeSessionRef): Promise<PiJsonlFile> {
    if (ref.provider !== this.provider) {
      throw new Error(`Pi adapter cannot read provider '${ref.provider}'.`);
    }
    if (ref.sourcePath) {
      return readPiJsonl(await this.resolveSafeSourcePath(ref.sourcePath));
    }

    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (!found) {
      throw new Error(`Pi native session '${ref.nativeId}' was not found.`);
    }
    return readPiJsonl(await this.resolveSafeSourcePath(found.sourcePath));
  }

  private async resolveSafeSourcePath(sourcePath: string): Promise<string> {
    const rootRealPath = await realpath(this.stateRoot);
    const candidatePath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(rootRealPath, sourcePath);
    if (path.extname(candidatePath) !== '.jsonl') {
      throw new Error(
        'Pi native session sourcePath must point to a .jsonl file.'
      );
    }

    const sourceInfo = await lstat(candidatePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error('Pi native session sourcePath must not be a symlink.');
    }
    if (!sourceInfo.isFile()) {
      throw new Error(
        'Pi native session sourcePath must point to a regular .jsonl file.'
      );
    }

    const sourceRealPath = await realpath(candidatePath);
    if (path.extname(sourceRealPath) !== '.jsonl') {
      throw new Error(
        'Pi native session sourcePath must resolve to a .jsonl file.'
      );
    }
    if (!isPathInside(rootRealPath, sourceRealPath)) {
      throw new Error(
        'Pi native session sourcePath must resolve under the configured state root.'
      );
    }

    return sourceRealPath;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

/**
 * Directory bucket roots to walk for a listing. Without a cwd/repoPath scope
 * this is `[stateRoot]`; with one it is the matching slug bucket when present.
 * An unmatched scope yields no roots (no bucket exists for that cwd).
 */
async function sessionDirRoots(
  stateRoot: string,
  scope: NativeSessionListScope
): Promise<string[]> {
  const cwd = scope.cwd ?? scope.repoPath;
  if (!cwd) return [stateRoot];

  const slugDir = path.join(stateRoot, piSessionDirSlug(cwd));
  try {
    const info = await lstat(slugDir);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    // Defense in depth: never follow a bucket that escapes the state root.
    const realSlug = await realpath(slugDir);
    const realRoot = await realpath(stateRoot);
    if (!isPathInside(realRoot, realSlug)) return [];
    return [slugDir];
  } catch {
    return [];
  }
}

/**
 * Pi's own cwd -> bucket-name rule, verified against real stores (#1426):
 * strip the leading slash, map every `/` to `-`, preserve case, wrap in `--`.
 */
export function piSessionDirSlug(cwd: string): string {
  return `--${cwd.replace(/^\/+/, '').replace(/\/+$/, '').replaceAll('/', '-')}--`;
}

/** Recover the uuid portion of a Pi session filename, when present. */
function uuidFromFileName(fileName: string): string | null {
  const base = path.basename(fileName, '.jsonl');
  const index = base.indexOf('_');
  const uuid = index >= 0 ? base.slice(index + 1) : '';
  return /^[0-9a-fA-F-]{16,}$/.test(uuid) ? uuid : null;
}

async function findSessionFiles(
  root: string,
  opts: { maxFiles: number; maxDepth: number }
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= opts.maxFiles || depth > opts.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= opts.maxFiles) return;
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(entryPath);
      }
    }
  }

  await walk(root, 0);
  return found;
}

async function readPiJsonl(filePath: string): Promise<PiJsonlFile> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error('Pi JSONL source must not be a symlink.');
  }
  if (!info.isFile()) {
    throw new Error('Pi JSONL source must be a regular file.');
  }
  if (info.size > MAX_JSONL_BYTES) {
    throw new Error(`Pi JSONL source exceeds ${MAX_JSONL_BYTES} bytes.`);
  }

  const hash = createHash('sha256');
  const lines: ParsedJsonlLine[] = [];
  let readTruncation: NativeSessionJsonlReadTruncation | undefined;
  let pending = '';
  let seenLines = 0;
  let parsedEvents = 0;
  let header: Record<string, unknown> | null = null;

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
        if (!header && stringField(value.type) === 'session') {
          header = value;
        }
        lines.push({ lineNumber: seenLines, value });
      }
    } catch {
      // Ignore corrupt lines during read-only listing/import.
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

  return {
    path: filePath,
    bytes: info.size,
    hashSha256: hash.digest('hex'),
    header,
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

function summarizePiJsonl(
  file: PiJsonlFile,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  const fileName = path.basename(file.path);
  const nativeId =
    (file.header ? stringFromRecord(file.header, ['id']) : '') ||
    uuidFromFileName(fileName) ||
    path.basename(file.path, '.jsonl');
  const headerCwd = file.header ? stringFromRecord(file.header, ['cwd']) : '';
  const timestamps = collectTimestamps(file.lines);
  const title = titleFromLines(file.lines);
  const preview = previewFromLines(file.lines, nativeId);

  return {
    provider: 'pi',
    nativeId,
    sourcePath: file.path,
    ...(headerCwd ? { cwd: headerCwd } : {}),
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

function buildTurns(
  file: PiJsonlFile,
  _sessionId: string,
  importedAt: string
): ImportedTurns {
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
            sourceProvider: 'pi',
            importSource: 'pi-jsonl',
            importedAt,
            sourcePath: file.path,
            hashSha256: file.hashSha256,
            readOnly: true,
          },
        },
      ],
    },
  ];

  const unmappedEventTypes = new Map<string, number>();
  let activeTurn: AgentTurnV2 | null = null;
  let assistantSeq = 0;
  let extensionSeq = 0;

  for (const parsed of file.lines) {
    const record = parsed.value;
    const type = stringField(record.type);
    const timestamp = timestampFromRecord(record) ?? importedAt;

    // The session header is consumed via `file.header`; it contributes no turn.
    if (type === 'session') continue;

    if (type === 'message') {
      const message = objectField(record.message);
      const role = stringField(message.role);
      const blocks = messageBlocks(message);

      if (role === 'user') {
        const text = redactText(textFromBlocks(blocks));
        if (!text) {
          noteUnmapped(unmappedEventTypes, `${type}:user(empty)`);
          continue;
        }
        const turnId = `native-turn-${turns.length}`;
        const itemId = `user-${turnId}`;
        const userItem: AgentItemV2 = {
          id: itemId,
          type: 'userMessage',
          text: truncate(text, TEXT_LIMIT),
          startedAt: timestamp,
          completedAt: timestamp,
          status: 'completed',
          ...(stringField(record.id)
            ? { providerItemId: stringField(record.id) }
            : {}),
        };
        const turn: AgentTurnV2 = {
          id: turnId,
          ...(stringField(record.id)
            ? { providerTurnId: stringField(record.id) }
            : {}),
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
        appendAssistantBlocks(turn, blocks, timestamp, ++assistantSeq);
        turn.completedAt = timestamp;
        continue;
      }

      if (role === 'toolResult') {
        const turn: AgentTurnV2 =
          activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
        activeTurn = turn;
        const outputText = redactText(textFromBlocks(blocks));
        turn.items.push({
          id: `native-tool-result-${++extensionSeq}`,
          type: 'providerExtension',
          namespace: 'pi',
          startedAt: timestamp,
          completedAt: timestamp,
          status: 'completed',
          payload: {
            kind: 'tool_result',
            lineNumber: parsed.lineNumber,
            ...(stringField(message.toolName)
              ? { toolName: stringField(message.toolName) }
              : {}),
            isError: message.isError === true,
            contentPreview: truncate(outputText, PREVIEW_LIMIT),
            redacted: true,
          },
        });
        continue;
      }

      noteUnmapped(unmappedEventTypes, `${type}:${role || 'unknown-role'}`);
      continue;
    }

    if (
      type === 'model_change' ||
      type === 'thinking_level_change' ||
      type === 'compaction'
    ) {
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      const payload: Record<string, unknown> = {
        kind: type,
        lineNumber: parsed.lineNumber,
      };
      const modelId = stringField(record.modelId);
      const provider = stringField(record.provider);
      const thinkingLevel = stringField(record.thinkingLevel);
      const summary = stringField(record.summary);
      if (modelId) payload.modelId = modelId;
      if (provider) payload.modelProvider = provider;
      if (thinkingLevel) payload.thinkingLevel = thinkingLevel;
      if (summary) {
        payload.summaryPreview = truncate(redactText(summary), PREVIEW_LIMIT);
        payload.redacted = true;
      }
      turn.items.push({
        id: `native-extension-${++extensionSeq}`,
        type: 'providerExtension',
        namespace: 'pi',
        startedAt: timestamp,
        completedAt: timestamp,
        status: 'completed',
        payload,
      });
      continue;
    }

    // Fidelity invariant (server/protocol-adapters/AGENTS.md): an unmapped
    // native event is a logged gap, never silence.
    noteUnmapped(unmappedEventTypes, type || 'unknown');
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

  void _sessionId;
  return truncation ? { turns, truncation } : { turns };
}

function noteUnmapped(seen: Map<string, number>, eventType: string): void {
  seen.set(eventType, (seen.get(eventType) ?? 0) + 1);
  logger.info(
    `Unmapped native Pi session event '${eventType}' reported as import gap.`
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

function appendAssistantBlocks(
  turn: AgentTurnV2,
  blocks: Record<string, unknown>[],
  timestamp: string,
  seq: number
): void {
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
    } else if (
      blockType === 'toolCall' ||
      blockType === 'tool_use' ||
      blockType === 'function_call'
    ) {
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
      providerMessageId: `pi-assistant-${seq}`,
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

/**
 * Map one native Pi `toolCall` content block. Pi shells through a `bash`
 * tool whose `arguments.command` mirrors Codex's shell convention; other
 * tools become dynamic calls under the `pi` namespace.
 */
function toolCallItem(
  block: Record<string, unknown>,
  timestamp: string,
  seq: number,
  index: number
): AgentItemV2 {
  const toolName = stringField(block.name, 'tool');
  const input = redactJsonValue(block.arguments ?? block.input) as Record<
    string,
    unknown
  >;
  if (
    (toolName === 'bash' || toolName === 'shell') &&
    typeof input.command === 'string'
  ) {
    return {
      id: `assistant-command-${seq}-${index}`,
      providerItemId: stringField(block.id),
      type: 'commandExecution',
      command: truncate(input.command, PREVIEW_LIMIT),
      output: '',
      exitCode: null,
      startedAt: timestamp,
      completedAt: timestamp,
      status: 'completed',
      metadata: { sourceProvider: 'pi', readOnlyImport: true },
      ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    };
  }

  return {
    id: `assistant-tool-${seq}-${index}`,
    providerItemId: stringField(block.id),
    type: 'dynamicToolCall',
    namespace: 'pi',
    tool: toolName,
    arguments: input,
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'completed',
    metadata: { sourceProvider: 'pi', readOnlyImport: true },
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
    provider: 'pi',
    nativeId: summary.nativeId,
    sourcePath: summary.sourcePath,
    ...(summary.cwd ? { cwd: summary.cwd } : {}),
    ...(ref.stateRoot ? { stateRoot: ref.stateRoot } : {}),
  };
}

function providerSession(
  summary: NativeSessionSummary,
  file: PiJsonlFile
): Record<string, string> {
  const providerSession: Record<string, string> = {
    nativeId: summary.nativeId,
    sourcePath: file.path,
    stateKind: 'pi-jsonl',
    hashSha256: file.hashSha256,
  };
  if (summary.cwd) providerSession.cwd = summary.cwd;
  return providerSession;
}

function titleFromLines(lines: ParsedJsonlLine[]): string | null {
  for (const parsed of lines) {
    const summary = stringFromRecord(parsed.value, [
      'summary',
      'title',
      'name',
    ]);
    // Only trust metadata-shaped records, not message payloads whose text
    // happens to sit in a `summary`-keyed block.
    if (summary && stringField(parsed.value.type) !== 'message') return summary;
  }
  return null;
}

function previewFromLines(
  lines: ParsedJsonlLine[],
  fallback: string
): NativeSessionPreview {
  for (const parsed of lines) {
    const record = parsed.value;
    if (stringField(record.type) !== 'message') continue;
    const message = objectField(record.message);
    if (stringField(message.role) !== 'user') continue;
    const text = redactText(textFromBlocks(messageBlocks(message)));
    if (text) {
      return {
        text: truncate(text, PREVIEW_LIMIT),
        source: 'transcript',
        redacted: true,
        charCount: Math.min(text.length, PREVIEW_LIMIT),
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

function messageBlocks(
  message: Record<string, unknown>
): Record<string, unknown>[] {
  const content = message.content;
  if (Array.isArray(content)) {
    return content.filter(isRecord) as Record<string, unknown>[];
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function textFromBlocks(blocks: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (stringField(block.type) === 'text') {
      const text = stringField(block.text);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

function timestampFromRecord(record: Record<string, unknown>): string | null {
  const ts = stringFromRecord(record, [
    'timestamp',
    'created_at',
    'time',
    'ts',
  ]);
  if (ts) return ts;
  const epoch = record.timestamp;
  if (typeof epoch === 'number') {
    try {
      return new Date(epoch).toISOString();
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
  return `native-pi-${slug(nativeId)}-${hash.slice(0, 12)}`;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-|-$/g, '').slice(0, 48) || 'session';
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
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
