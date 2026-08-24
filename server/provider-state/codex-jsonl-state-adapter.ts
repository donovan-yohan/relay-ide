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

const CODEX_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: true,
  canReadProviderState: true,
  canResumeNative: true,
  canStreamLiveEvents: false,
  canRespondToApprovals: false,
  canExposeToolCalls: true,
  readOnly: true,
};

const MAX_LIST_FILES = 500;
const MAX_SCAN_DEPTH = 6;
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

interface CodexJsonlFile {
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

interface CodexAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
  maxFiles?: number;
}

export class CodexJsonlStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'codex' as const;
  readonly capabilities = CODEX_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxFiles: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.stateRoot = options.stateRoot ?? path.join(homedir(), '.codex', 'sessions');
    this.now = options.now ?? (() => new Date());
    this.maxFiles = options.maxFiles ?? MAX_LIST_FILES;
  }

  async detectInstall(): Promise<ProviderInstallStatus> {
    const detectedAt = this.nowIso();
    try {
      await access(this.stateRoot, constants.R_OK);
      const files = await findJsonlFiles(this.stateRoot, {
        maxFiles: 1,
        maxDepth: MAX_SCAN_DEPTH,
      });
      return {
        provider: this.provider,
        status: 'installed',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: files.length > 0
          ? [
              {
                code: 'CODEX_STATE_READABLE',
                message: 'Codex state root is readable.',
                severity: 'info',
              },
            ]
          : [
              {
                code: 'CODEX_STATE_EMPTY',
                message: 'Codex state root is readable but no JSONL sessions were found.',
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
            code: 'CODEX_STATE_UNREADABLE',
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
    const files = await findJsonlFiles(this.stateRoot, {
      maxFiles: this.maxFiles,
      maxDepth: MAX_SCAN_DEPTH,
    });
    const summaries: NativeSessionSummary[] = [];

    for (const filePath of files) {
      try {
        const parsed = await readCodexJsonl(filePath);
        const summary = summarizeCodexJsonl(parsed, this.capabilities);
        if (scope.cwd && summary.cwd !== scope.cwd) continue;
        if (scope.workContextId && summary.workContextId !== scope.workContextId)
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

  async readProviderState(ref: NativeSessionRef): Promise<ProviderStateSnapshot> {
    const file = await this.readRef(ref);
    const summary = summarizeCodexJsonl(file, this.capabilities);
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

  async importSession(ref: NativeSessionRef): Promise<NativeSessionImportResult> {
    const file = await this.readRef(ref);
    const summary = summarizeCodexJsonl(file, this.capabilities);
    const importedAt = this.nowIso();
    const sessionId = relaySessionId(summary.nativeId, file.hashSha256);
    const session = emptyAgentSessionV2({
      id: sessionId,
      provider: 'codex',
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
          importSource: 'codex-jsonl',
          readOnly: true,
        },
      },
    });

    const importedTurns = buildTurns(file, sessionId, importedAt);
    session.turns = importedTurns.turns;
    if (importedTurns.truncation || file.readTruncation) {
      session.config.providerOptions = {
        ...session.config.providerOptions,
        ...(importedTurns.truncation ? { importTruncation: importedTurns.truncation } : {}),
        ...(file.readTruncation ? { sourceReadTruncation: file.readTruncation } : {}),
      };
      annotateAuditMarker(session.turns, {
        ...(importedTurns.truncation ? { importTruncation: importedTurns.truncation } : {}),
        ...(file.readTruncation ? { sourceReadTruncation: file.readTruncation } : {}),
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
      ...(importedTurns.truncation ? { importTruncation: importedTurns.truncation } : {}),
      ...(file.readTruncation ? { sourceReadTruncation: file.readTruncation } : {}),
    };
    return result;
  }

  resumeCommand(ref: NativeSessionRef): string[] {
    return ['codex', '--resume', ref.nativeId];
  }

  private async readRef(ref: NativeSessionRef): Promise<CodexJsonlFile> {
    if (ref.provider !== this.provider) {
      throw new Error(`Codex adapter cannot read provider '${ref.provider}'.`);
    }
    if (ref.sourcePath) {
      return readCodexJsonl(await this.resolveSafeSourcePath(ref.sourcePath));
    }

    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (!found) {
      throw new Error(`Codex native session '${ref.nativeId}' was not found.`);
    }
    return readCodexJsonl(await this.resolveSafeSourcePath(found.sourcePath));
  }

  private async resolveSafeSourcePath(sourcePath: string): Promise<string> {
    const rootRealPath = await realpath(this.stateRoot);
    const candidatePath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(rootRealPath, sourcePath);
    if (path.extname(candidatePath) !== '.jsonl') {
      throw new Error('Codex native session sourcePath must point to a .jsonl file.');
    }

    const sourceInfo = await lstat(candidatePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error('Codex native session sourcePath must not be a symlink.');
    }
    if (!sourceInfo.isFile()) {
      throw new Error('Codex native session sourcePath must point to a regular .jsonl file.');
    }

    const sourceRealPath = await realpath(candidatePath);
    if (path.extname(sourceRealPath) !== '.jsonl') {
      throw new Error('Codex native session sourcePath must resolve to a .jsonl file.');
    }
    if (!isPathInside(rootRealPath, sourceRealPath)) {
      throw new Error('Codex native session sourcePath must resolve under the configured state root.');
    }

    return sourceRealPath;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

async function findJsonlFiles(
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

async function readCodexJsonl(filePath: string): Promise<CodexJsonlFile> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error('Codex JSONL source must not be a symlink.');
  }
  if (!info.isFile()) {
    throw new Error('Codex JSONL source must be a regular file.');
  }
  if (info.size > MAX_JSONL_BYTES) {
    throw new Error(`Codex JSONL source exceeds ${MAX_JSONL_BYTES} bytes.`);
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
      readTruncation = readTruncation ?? jsonlReadTruncation('line-limit', seenLines, parsedEvents);
      return;
    }
    if (parsedEvents >= MAX_JSONL_EVENTS) {
      readTruncation = readTruncation ?? jsonlReadTruncation('event-limit', seenLines, parsedEvents);
      return;
    }
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) {
        parsedEvents += 1;
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

function summarizeCodexJsonl(
  file: CodexJsonlFile,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  const nativeId = nativeIdFromLines(file.lines) ?? path.basename(file.path, '.jsonl');
  const cwd = firstStringField(file.lines, ['cwd', 'workspace', 'projectPath', 'working_directory']);
  const workContextId = firstStringField(file.lines, ['workContextId', 'work_context_id']);
  const repoPath = firstStringField(file.lines, ['repoPath', 'repositoryPath']);
  const worktreePath = firstStringField(file.lines, ['worktreePath']);
  const timestamps = collectTimestamps(file.lines);
  const title = titleFromLines(file.lines);
  const preview = previewFromLines(file.lines, title ?? path.basename(file.path, '.jsonl'));

  return {
    provider: 'codex',
    nativeId,
    sourcePath: file.path,
    ...(cwd ? { cwd } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(workContextId ? { workContextId } : {}),
    ...(timestamps.first ? { createdAt: timestamps.first } : {}),
    ...(timestamps.last ? { updatedAt: timestamps.last, lastMessageAt: timestamps.last } : {}),
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
  file: CodexJsonlFile,
  sessionId: string,
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
            sourceProvider: 'codex',
            importSource: 'codex-jsonl',
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
    const blocks = messageBlocks(record);

    if (role === 'user' && isToolResultOnly(blocks)) {
      const turn: AgentTurnV2 = activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      const text = redactText(blockText(blocks));
      turn.items.push({
        id: `native-tool-result-${++extensionSeq}`,
        type: 'providerExtension',
        namespace: 'codex',
        startedAt: timestamp,
        completedAt: timestamp,
        status: 'completed',
        payload: {
          kind: 'tool_result',
          lineNumber: parsed.lineNumber,
          contentPreview: truncate(text, PREVIEW_LIMIT),
          redacted: true,
        },
      });
      continue;
    }

    if (role === 'user') {
      const text = redactText(textFromRecord(record));
      if (!text) continue;
      const turnId = `native-turn-${turns.length}`;
      const itemId = `user-${turnId}`;
      const providerItemId = stringFromRecord(record, ['uuid', 'id', 'message_id']);
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
      const turn: AgentTurnV2 = activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      appendAssistantBlocks(turn, blocks, timestamp, ++assistantSeq);
      turn.completedAt = timestamp;
      continue;
    }
  }

  for (const turn of turns) {
    turn.status = 'completed';
    turn.completedAt = turn.completedAt ?? turn.startedAt;
  }

  const truncation = trimImportedTurns(turns);

  void sessionId;
  return truncation ? { turns, truncation } : { turns };
}

function trimImportedTurns(turns: AgentTurnV2[]): NativeSessionImportTruncation | undefined {
  let approximateTranscriptBytes = transcriptBytes(turns);
  if (approximateTranscriptBytes <= MAX_IMPORT_TRANSCRIPT_BYTES) return undefined;

  const originalTurns = turns.length;
  let droppedTurns = 0;
  let droppedItems = 0;

  while (approximateTranscriptBytes > MAX_IMPORT_TRANSCRIPT_BYTES && turns.length > 1) {
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
    } else if (blockType === 'tool_use' || blockType === 'function_call') {
      extraItems.push(toolUseItem(block, timestamp, seq, extraItems.length));
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
      providerMessageId: `codex-assistant-${seq}`,
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

function toolUseItem(
  block: Record<string, unknown>,
  timestamp: string,
  seq: number,
  index: number
): AgentItemV2 {
  const toolName = stringField(block.name, 'tool');
  const input = redactJsonValue(block.input) as Record<string, unknown>;
  if (toolName === 'shell' && typeof input.command === 'string') {
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
      metadata: { sourceProvider: 'codex', readOnlyImport: true },
      ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    };
  }

  return {
    id: `assistant-tool-${seq}-${index}`,
    providerItemId: stringField(block.id),
    type: 'dynamicToolCall',
    namespace: 'codex',
    tool: toolName,
    arguments: input,
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'completed',
    metadata: { sourceProvider: 'codex', readOnlyImport: true },
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
    provider: 'codex',
    nativeId: summary.nativeId,
    sourcePath: summary.sourcePath,
    ...(summary.cwd ? { cwd: summary.cwd } : {}),
    ...(ref.stateRoot ? { stateRoot: ref.stateRoot } : {}),
  };
}

function providerSession(
  summary: NativeSessionSummary,
  file: CodexJsonlFile
): Record<string, string> {
  const providerSession: Record<string, string> = {
    nativeId: summary.nativeId,
    sourcePath: file.path,
    stateKind: 'codex-jsonl',
    hashSha256: file.hashSha256,
  };
  if (summary.cwd) providerSession.cwd = summary.cwd;
  return providerSession;
}

function nativeIdFromLines(lines: ParsedJsonlLine[]): string | null {
  for (const parsed of lines) {
    const id = stringFromRecord(parsed.value, ['session_id', 'sessionId', 'id']);
    if (id) return id;
  }
  return null;
}

function titleFromLines(lines: ParsedJsonlLine[]): string | null {
  for (const parsed of lines) {
    const summary = stringFromRecord(parsed.value, ['summary', 'title', 'name']);
    if (summary) return summary;
  }
  return null;
}

function previewFromLines(
  lines: ParsedJsonlLine[],
  fallback: string
): NativeSessionPreview {
  for (const parsed of lines) {
    const record = parsed.value;
    const role = messageRole(record);
    if (role === 'user') {
      const text = redactText(textFromRecord(record));
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

function messageRole(record: Record<string, unknown>): string | null {
  const type = stringField(record.type);
  if (type === 'user' || type === 'human' || type === 'UserPromptSubmit') return 'user';
  if (type === 'assistant' || type === 'ai' || type === 'Stop') return 'assistant';
  const role = stringField(record.role);
  if (role === 'user' || role === 'assistant') return role;
  return null;
}

function messageBlocks(record: Record<string, unknown>): Record<string, unknown>[] {
  const message = objectField(record.message);
  if (message) {
    const content = message.content;
    if (Array.isArray(content)) {
      return content.filter(isRecord) as Record<string, unknown>[];
    }
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
  }
  const content = record.content;
  if (Array.isArray(content)) {
    return content.filter(isRecord) as Record<string, unknown>[];
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  const text = stringFromRecord(record, ['text', 'content_text', 'prompt']);
  if (text) {
    return [{ type: 'text', text }];
  }
  return [];
}

function isToolResultOnly(blocks: Record<string, unknown>[]): boolean {
  if (blocks.length === 0) return false;
  return blocks.every((block) => {
    const type = stringField(block.type);
    return type === 'tool_result' || type === 'tool_use_result';
  });
}

function blockText(blocks: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const type = stringField(block.type);
    if (type === 'tool_result' || type === 'tool_use_result') {
      const content = block.content;
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) {
        for (const item of content) {
          if (isRecord(item) && typeof item.text === 'string') parts.push(item.text);
        }
      }
    }
  }
  return parts.join('\n');
}

function textFromRecord(record: Record<string, unknown>): string {
  const message = objectField(record.message);
  if (message) {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (isRecord(item) && typeof item.text === 'string') parts.push(item.text);
      }
      return parts.join('\n');
    }
  }
  return stringFromRecord(record, ['text', 'content_text', 'prompt', 'input']);
}

function timestampFromRecord(record: Record<string, unknown>): string | null {
  const ts = stringFromRecord(record, ['timestamp', 'created_at', 'time', 'ts']);
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
  { pattern: /\b(token|api[_-]?key|secret|password|credential)\s*[:=]\s*\S+/gi,
    replacement: '$1=[redacted]' },
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
        typeof item === 'string' ? redactText(item)
        : isRecord(item) ? redactJsonValue(item)
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
  return `native-codex-${slug(nativeId)}-${hash.slice(0, 12)}`;
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