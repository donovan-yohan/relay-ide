import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
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
  NativeSessionListScope,
  NativeSessionPreview,
  NativeSessionRef,
  NativeSessionSummary,
  ProviderInstallStatus,
  ProviderStateSnapshot,
} from '../../shared/provider-native-session-state.js';
import type { AgentHarnessStateAdapter } from '../harness-state-adapter.js';

const CLAUDE_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
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

interface ParsedJsonlLine {
  lineNumber: number;
  value: Record<string, unknown>;
}

interface ClaudeJsonlFile {
  path: string;
  bytes: number;
  hashSha256: string;
  lines: ParsedJsonlLine[];
}

interface ClaudeAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
  maxFiles?: number;
}

export class ClaudeJsonlStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'claude' as const;
  readonly capabilities = CLAUDE_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxFiles: number;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.stateRoot = options.stateRoot ?? path.join(homedir(), '.claude');
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
                code: 'CLAUDE_STATE_READABLE',
                message: 'Claude state root is readable.',
                severity: 'info',
              },
            ]
          : [
              {
                code: 'CLAUDE_STATE_EMPTY',
                message: 'Claude state root is readable but no JSONL sessions were found.',
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
            code: 'CLAUDE_STATE_UNREADABLE',
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
      const parsed = await readClaudeJsonl(filePath);
      const summary = summarizeClaudeJsonl(parsed, this.capabilities);
      if (scope.cwd && summary.cwd !== scope.cwd) continue;
      if (scope.workContextId && summary.workContextId !== scope.workContextId)
        continue;
      summaries.push(summary);
    }

    return summaries.sort((a, b) => {
      const aTime = a.updatedAt ?? a.lastMessageAt ?? a.createdAt ?? '';
      const bTime = b.updatedAt ?? b.lastMessageAt ?? b.createdAt ?? '';
      return bTime.localeCompare(aTime);
    });
  }

  async readProviderState(ref: NativeSessionRef): Promise<ProviderStateSnapshot> {
    const file = await this.readRef(ref);
    const summary = summarizeClaudeJsonl(file, this.capabilities);
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
    const summary = summarizeClaudeJsonl(file, this.capabilities);
    const importedAt = this.nowIso();
    const sessionId = relaySessionId(summary.nativeId, file.hashSha256);
    const session = emptyAgentSessionV2({
      id: sessionId,
      provider: 'claude',
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
          importSource: 'claude-jsonl',
          readOnly: true,
        },
      },
    });

    session.turns = buildTurns(file, sessionId, importedAt);

    const patches: AgentPatchV2[] = [
      {
        type: 'agent-session-snapshot-v2',
        sessionId,
        timestamp: importedAt,
        session,
      },
    ];

    return {
      provider: this.provider,
      nativeId: summary.nativeId,
      importedAt,
      sourcePath: file.path,
      session,
      patches,
    };
  }

  resumeCommand(ref: NativeSessionRef): string[] {
    return ['claude', '--resume', ref.nativeId];
  }

  private async readRef(ref: NativeSessionRef): Promise<ClaudeJsonlFile> {
    if (ref.provider !== this.provider) {
      throw new Error(`Claude adapter cannot read provider '${ref.provider}'.`);
    }
    if (ref.sourcePath) {
      return readClaudeJsonl(ref.sourcePath);
    }

    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (!found) {
      throw new Error(`Claude native session '${ref.nativeId}' was not found.`);
    }
    return readClaudeJsonl(found.sourcePath);
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

async function readClaudeJsonl(filePath: string): Promise<ClaudeJsonlFile> {
  const [content, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
  const hashSha256 = createHash('sha256').update(content).digest('hex');
  const lines: ParsedJsonlLine[] = [];

  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) lines.push({ lineNumber: index + 1, value });
    } catch {
      // Ignore corrupt lines during read-only listing/import. The snapshot hash
      // still covers them, and future diagnostics can surface parse errors.
    }
  });

  return {
    path: filePath,
    bytes: info.size,
    hashSha256,
    lines,
  };
}

function summarizeClaudeJsonl(
  file: ClaudeJsonlFile,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  const nativeId = nativeIdFromLines(file.lines) ?? path.basename(file.path, '.jsonl');
  const cwd = firstStringField(file.lines, ['cwd', 'workspace', 'projectPath']);
  const workContextId = firstStringField(file.lines, ['workContextId', 'work_context_id']);
  const repoPath = firstStringField(file.lines, ['repoPath', 'repositoryPath']);
  const worktreePath = firstStringField(file.lines, ['worktreePath']);
  const timestamps = collectTimestamps(file.lines);
  const title = titleFromLines(file.lines);
  const preview = previewFromLines(file.lines, title ?? path.basename(file.path, '.jsonl'));

  return {
    provider: 'claude',
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
    },
    capabilities,
  };
}

function buildTurns(
  file: ClaudeJsonlFile,
  sessionId: string,
  importedAt: string
): AgentTurnV2[] {
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
            sourceProvider: 'claude',
            importSource: 'claude-jsonl',
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
      const turn = activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      const text = redactText(blockText(blocks));
      turn.items.push({
        id: `native-tool-result-${++extensionSeq}`,
        type: 'providerExtension',
        namespace: 'claude',
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
      const providerItemId = stringFromRecord(record, ['uuid', 'id']);
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
      const turn = activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      appendAssistantBlocks(turn, blocks, timestamp, ++assistantSeq);
      turn.completedAt = timestamp;
      continue;
    }
  }

  for (const turn of turns) {
    turn.status = 'completed';
    turn.completedAt = turn.completedAt ?? turn.startedAt;
  }

  // sessionId is passed so future patch-based import helpers can keep stable
  // IDs without changing this reducer path. Keep the invariant alive, crab tax.
  void sessionId;
  return turns;
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
    } else if (blockType === 'tool_use') {
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
      providerMessageId: `claude-assistant-${seq}`,
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
  if (toolName === 'Bash' && typeof input.command === 'string') {
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
      metadata: { sourceProvider: 'claude', readOnlyImport: true },
      ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    };
  }

  return {
    id: `assistant-tool-${seq}-${index}`,
    providerItemId: stringField(block.id),
    type: 'dynamicToolCall',
    namespace: 'claude',
    tool: toolName,
    arguments: isRecord(input) ? input : {},
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'completed',
    metadata: { sourceProvider: 'claude', readOnlyImport: true },
  };
}

function createSyntheticTurn(
  turns: AgentTurnV2[],
  timestamp: string,
  importedAt: string
): AgentTurnV2 {
  const turnId = `native-turn-${turns.length}`;
  const itemId = `provider-${turnId}`;
  const turn: AgentTurnV2 = {
    id: turnId,
    status: 'completed',
    inputMessageId: itemId,
    startedAt: timestamp,
    completedAt: timestamp,
    items: [
      {
        id: itemId,
        type: 'providerExtension',
        namespace: 'provider-state-import',
        startedAt: importedAt,
        completedAt: importedAt,
        status: 'completed',
        payload: { event: 'synthetic-turn', reason: 'assistant-without-user' },
      },
    ],
  };
  turns.push(turn);
  return turn;
}

function normalizeRef(
  ref: NativeSessionRef,
  summary: NativeSessionSummary
): NativeSessionRef {
  return {
    provider: 'claude',
    nativeId: summary.nativeId,
    sourcePath: summary.sourcePath,
    ...(summary.cwd ? { cwd: summary.cwd } : {}),
    ...(ref.stateRoot ? { stateRoot: ref.stateRoot } : {}),
  };
}

function providerSession(
  summary: NativeSessionSummary,
  file: ClaudeJsonlFile
): Record<string, string> {
  const providerSession: Record<string, string> = {
    nativeId: summary.nativeId,
    sourcePath: file.path,
    stateKind: 'claude-jsonl',
    hashSha256: file.hashSha256,
  };
  if (summary.cwd) providerSession.cwd = summary.cwd;
  return providerSession;
}

function nativeIdFromLines(lines: ParsedJsonlLine[]): string | null {
  return firstStringField(lines, [
    'sessionId',
    'session_id',
    'conversationId',
    'conversation_id',
  ]) ?? null;
}

function collectTimestamps(lines: ParsedJsonlLine[]): { first?: string; last?: string } {
  const timestamps = lines
    .map((line) => timestampFromRecord(line.value))
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    ...(timestamps[0] ? { first: timestamps[0] } : {}),
    ...(timestamps[timestamps.length - 1]
      ? { last: timestamps[timestamps.length - 1] }
      : {}),
  };
}

function collectEventTypes(lines: ParsedJsonlLine[]): string[] {
  return [
    ...new Set(
      lines
        .map((line) => stringField(line.value.type) || messageRole(line.value))
        .filter(Boolean)
    ),
  ];
}

function titleFromLines(lines: ParsedJsonlLine[]): string | undefined {
  for (const line of lines) {
    const summary = stringFromRecord(line.value, ['summary', 'title']);
    if (summary) return truncate(redactText(summary), PREVIEW_LIMIT);
  }
  return undefined;
}

function previewFromLines(lines: ParsedJsonlLine[], fallback: string): NativeSessionPreview {
  for (const line of lines) {
    const text = textFromRecord(line.value);
    if (!text) continue;
    const redacted = redactText(text);
    return {
      text: truncate(redacted, PREVIEW_LIMIT),
      source: 'transcript',
      redacted: redacted !== text,
      charCount: redacted.length,
    };
  }
  return {
    text: truncate(redactText(fallback), PREVIEW_LIMIT),
    source: fallback ? 'filename' : 'none',
    redacted: false,
    charCount: fallback.length,
  };
}

function firstStringField(
  lines: ParsedJsonlLine[],
  keys: string[]
): string | undefined {
  for (const line of lines) {
    const value = stringFromRecord(line.value, keys);
    if (value) return value;
  }
  return undefined;
}

function timestampFromRecord(record: Record<string, unknown>): string | undefined {
  const raw = stringFromRecord(record, ['timestamp', 'createdAt', 'created_at']);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function messageRole(record: Record<string, unknown>): string {
  const message = objectField(record.message);
  return stringField(message.role) || stringField(record.role) || stringField(record.type);
}

function messageBlocks(record: Record<string, unknown>): Record<string, unknown>[] {
  const message = objectField(record.message);
  const content = message.content ?? record.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function textFromRecord(record: Record<string, unknown>): string {
  return blockText(messageBlocks(record));
}

function blockText(blocks: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const type = stringField(block.type);
    if (type === 'text') parts.push(stringField(block.text));
    if (type === 'tool_result') parts.push(stringField(block.content));
    if (type === 'thinking') parts.push(stringField(block.thinking));
  }
  return parts.filter(Boolean).join('\n');
}

function isToolResultOnly(blocks: Record<string, unknown>[]): boolean {
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_result');
}

function stringFromRecord(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
    const nested = objectField(record.message)[key];
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  return undefined;
}

function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[redacted-depth]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry, depth + 1));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key|authorization/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactJsonValue(entry, depth + 1);
    }
  }
  return out;
}

function redactText(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[redacted-secret]')
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/g, '[redacted-credential]@')
    .replace(
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    );
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function relaySessionId(nativeId: string, hash: string): string {
  return `native-claude-${slug(nativeId)}-${hash.slice(0, 12)}`;
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

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
