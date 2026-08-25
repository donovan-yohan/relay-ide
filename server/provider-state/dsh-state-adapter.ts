import { createHash } from 'node:crypto';
import { constants, readdirSync } from 'node:fs';
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
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

const logger = createLogger('provider-state:dsh-state');

/**
 * Read-only adapter over the DeepSeek Harness (DSH) local session store
 * (#1426). Ground truth verified against real `~/.dsh/sessions` stores and the
 * harness source (`packages/session/session-persistence-jsonl`):
 *
 * - Layout: `~/.dsh/sessions/<project-slug>/session-<uuid>/session.jsonl.zstd`
 *   where `<project-slug>` is the cwd with `/` mapped to `-` (leading slash
 *   dropped, trailing `-` appended), e.g.
 *   `--home-donovanyohan-Documents-Programs-personal-deepseek-harness--`.
 * - The log is CONCATENATED zstd FRAMES of JSONL. Each frame carries one batch
 *   of newline-delimited records; frames are written incrementally so a torn
 *   (structurally incomplete) final frame is possible. Frame boundaries are
 *   found by structural scan (magic `28 B5 2F FD` + frame-header/block walk);
 *   each complete frame decodes independently via `zstdDecompressSync`.
 * - Record 1 is a `type:"session"` header `{ id, createdAt (epoch-ms), cwd,
 *   delegationDepth, ... }`; later records are typed events with `seq` and
 *   epoch-ms `time`: user/message, assistant/chunk (stream deltas),
 *   reasoning-chunks (thinking deltas), assistant/message (consolidated), plus
 *   operational metadata (permission/preset, sandbox/mode, approval/policy,
 *   turn/start, step/start|end, request/header|context, session/title, ...).
 *
 * Observation only: this adapter never mutates the store. `resumeCommand`
 * returns copyable argv data; callers decide whether to run it. Resume flag
 * semantics are launcher-level (`dsh --profile tui --resume <id>`, apps/cli):
 * the inner app parses its own `--resume <id>`, so bare `['dsh', '--resume',
 * <id>]` relies on the default profile accepting that flag family — noted as a
 * caveat in the handoff.
 */

const DSH_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: true,
  canReadProviderState: true,
  canResumeNative: true,
  // Wired through NativeSessionLiveTailManager via the framed-zstd tailer.
  canStreamLiveEvents: true,
  canRespondToApprovals: false,
  canExposeToolCalls: false,
  readOnly: true,
};

const MAX_LIST_SESSIONS = 500;
const PREVIEW_LIMIT = 240;
const TEXT_LIMIT = 32_000;
const MAX_LOG_BYTES = 5_000_000;
const MAX_LOG_LINES = 20_000;
const MAX_LOG_EVENTS = 5_000;
const MAX_IMPORT_TRANSCRIPT_BYTES = 256_000;

interface ParsedRecord {
  /** 1-based line number within the decompressed JSONL stream. */
  lineNumber: number;
  value: Record<string, unknown>;
}

interface DecodedDshLog {
  path: string;
  bytes: number;
  hashSha256: string;
  header: Record<string, unknown> | null;
  records: ParsedRecord[];
  /** Complete frames consumed; torn trailing-frame bytes are excluded. */
  completeFrameCount: number;
  tornTrailingBytes: number;
  readTruncation?: NativeSessionJsonlReadTruncation;
}

export interface DshStateAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
  maxSessions?: number;
}

export class DshStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'dsh' as const;
  readonly capabilities = DSH_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxSessions: number;

  constructor(options: DshStateAdapterOptions = {}) {
    this.stateRoot =
      options.stateRoot ?? path.join(homedir(), '.dsh', 'sessions');
    this.now = options.now ?? (() => new Date());
    this.maxSessions = options.maxSessions ?? MAX_LIST_SESSIONS;
  }

  async detectInstall(): Promise<ProviderInstallStatus> {
    const detectedAt = this.nowIso();
    try {
      await access(this.stateRoot, constants.R_OK);
      const dirs = await listDshProjectDirs(this.stateRoot);
      const sessionDirs = dirs.flatMap((dir) =>
        readdirSyncSafe(dir).map((name) => path.join(dir, name))
      );
      return {
        provider: this.provider,
        status: 'installed',
        detectedAt,
        stateRoots: [this.stateRoot],
        diagnostics: [
          {
            code:
              sessionDirs.length > 0 ? 'DSH_STATE_READABLE' : 'DSH_STATE_EMPTY',
            message:
              sessionDirs.length > 0
                ? 'DeepSeek Harness sessions directory is readable.'
                : 'DeepSeek Harness sessions directory is readable but contains no session directories yet.',
            severity: sessionDirs.length > 0 ? 'info' : 'warning',
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
            code: 'DSH_STATE_ROOT_NOT_FOUND',
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
    // DSH buckets sessions by project slug; a cwd/repoPath scope only walks the
    // matching bucket. Header cwd is re-checked below so slug drift can never
    // surface a session from the wrong working directory.
    // Layout: <stateRoot>/<project-slug>/session-<uuid>/session.jsonl.zstd.
    // Without a cwd/repoPath scope the walk starts at the state root and must
    // descend through BOTH levels (bucket dir, then session dir); with a scope
    // it starts at the matching bucket and descends one level. A small helper
    // keeps that uniform: given a directory, yield every
    // `<dir>/*/session.jsonl.zstd` log path, plus (at the root only)
    // `<dir>/*/*/session.jsonl.zstd`.
    const roots = await sessionDirRoots(this.stateRoot, scope);
    const summaries: NativeSessionSummary[] = [];

    for (const dirRoot of roots) {
      const candidates = readdirSyncSafe(dirRoot).flatMap((levelOne) =>
        candidateLogPaths(dirRoot, levelOne)
      );
      for (const candidate of candidates) {
        if (summaries.length >= this.maxSessions) break;
        try {
          const parsed = await readDshLog(candidate);
          const summary = summarizeDshLog(parsed, this.capabilities);
          if (
            !matchesCwdScope(summary, scope) ||
            (scope.workContextId &&
              summary.workContextId !== scope.workContextId)
          ) {
            continue;
          }
          summaries.push(summary);
        } catch {
          // Skip unreadable or over-limit provider files during discovery.
        }
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
    const summary = summarizeDshLog(file, this.capabilities);
    const timestamps = collectTimestamps(file.records);

    return {
      ref: normalizeRef(ref, summary),
      capturedAt: this.nowIso(),
      sourcePath: file.path,
      summary: {
        lineCount: file.records.length,
        byteCount: file.bytes,
        hashSha256: file.hashSha256,
        eventTypes: collectEventTypes(file.records),
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
    const summary = summarizeDshLog(file, this.capabilities);
    const importedAt = this.nowIso();
    const sessionId = relaySessionId(summary.nativeId, file.hashSha256);
    const session = emptyAgentSessionV2({
      id: sessionId,
      provider: 'dsh',
      cwd: summary.cwd ?? ref.cwd ?? '',
      capabilities: {
        text: true,
        reasoning: true,
        tools: false,
        commandExecution: false,
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
          importSource: 'dsh-jsonl-zstd',
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

  resumeCommand(ref: NativeSessionRef): string[] {
    return ['dsh', '--resume', ref.nativeId];
  }

  private async readRef(ref: NativeSessionRef): Promise<DecodedDshLog> {
    if (ref.provider !== this.provider) {
      throw new Error(`DSH adapter cannot read provider '${ref.provider}'.`);
    }
    if (ref.sourcePath) {
      return readDshLog(await this.resolveSafeSourcePath(ref.sourcePath));
    }

    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (!found) {
      throw new Error(`DSH native session '${ref.nativeId}' was not found.`);
    }
    return readDshLog(await this.resolveSafeSourcePath(found.sourcePath));
  }

  private async resolveSafeSourcePath(sourcePath: string): Promise<string> {
    const rootRealPath = await realpath(this.stateRoot);
    const candidatePath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(rootRealPath, sourcePath);
    if (path.extname(candidatePath) !== '.zstd') {
      throw new Error(
        'DSH native session sourcePath must point to a .jsonl.zstd file.'
      );
    }

    const sourceInfo = await lstat(candidatePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error('DSH native session sourcePath must not be a symlink.');
    }
    if (!sourceInfo.isFile()) {
      throw new Error(
        'DSH native session sourcePath must point to a regular .jsonl.zstd file.'
      );
    }

    const sourceRealPath = await realpath(candidatePath);
    if (path.extname(sourceRealPath) !== '.zstd') {
      throw new Error(
        'DSH native session sourcePath must resolve to a .jsonl.zstd file.'
      );
    }
    if (!isPathInside(rootRealPath, sourceRealPath)) {
      throw new Error(
        'DSH native session sourcePath must resolve under the configured state root.'
      );
    }

    return sourceRealPath;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

/** Directory buckets to walk for a listing (mirrors the Pi adapter's scoping). */
async function sessionDirRoots(
  stateRoot: string,
  scope: NativeSessionListScope
): Promise<string[]> {
  const cwd = scope.cwd ?? scope.repoPath;
  if (!cwd) return [stateRoot];

  const slugDir = path.join(stateRoot, dshProjectSlug(cwd));
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
 * DSH's cwd -> project-directory rule, verified against real stores (#1426):
 * strip leading/trailing slashes, map every interior `/` to `-`. Matches the
 * observed `--home-donovanyohan-Documents-Programs-personal-deepseek-harness--`
 * bucket naming family shared with `~/.pi`.
 */
export function dshProjectSlug(cwd: string): string {
  return `--${cwd.replace(/^\/+/, '').replace(/\/+$/, '').replaceAll('/', '-')}--`;
}

function listDshProjectDirs(root: string): Promise<string[]> {
  return readdir(root, { withFileTypes: true }).then((entries) =>
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name))
  );
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** True when the summary's cwd satisfies a cwd/repoPath listing scope. */
function matchesCwdScope(
  summary: NativeSessionSummary,
  scope: NativeSessionListScope
): boolean {
  const cwd = scope.cwd ?? scope.repoPath;
  return !cwd || summary.cwd === cwd;
}

/**
 * Candidate log paths under one walked directory entry. From the state root,
 * `<root>/<bucket>/<sessionDir>/session.jsonl.zstd` needs two descents; from a
 * scoped bucket, one. Probing both shapes is harmless — the missing shape
 * simply fails the read and is skipped.
 */
function candidateLogPaths(dirRoot: string, levelOne: string): string[] {
  const levelOnePath = path.join(dirRoot, levelOne);
  return [
    path.join(levelOnePath, 'session.jsonl.zstd'),
    ...readdirSyncSafe(levelOnePath).map((levelTwo) =>
      path.join(levelOnePath, levelTwo, 'session.jsonl.zstd')
    ),
  ];
}

/**
 * Structural scan of concatenated zstd frames (magic `28 B5 2F FD`). Mirrors
 * the harness's own `scanZstdFrames` (session-persistence-jsonl/zstd.ts):
 * walks frame headers and block headers without decompressing, returning
 * complete-frame byte ranges plus the start of an incomplete final frame when
 * EOF interrupts it. Invalid structure throws; torn EOF never does.
 */
export function scanZstdFrames(
  buffer: Buffer,
  maxFrames = Number.POSITIVE_INFINITY
): {
  frames: { start: number; end: number }[];
  tornStart?: number;
} {
  const ZSTD_MAGIC = 0xfd2fb528;
  const frames: { start: number; end: number }[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(
        `corrupt Zstandard session log: invalid frame magic at byte ${offset}`
      );
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(
        `corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`
      );
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) {
      return { frames, tornStart: start };
    }
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(
          `corrupt Zstandard session log: reserved block type at byte ${offset - 3}`
        );
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        return { frames, tornStart: start };
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/**
 * Decode one complete frame. Node's `zstdDecompressSync` decodes exactly one
 * frame per call, which is precisely what the concatenated-frame container
 * needs here; checksum failures surface as thrown errors per frame.
 */
function decodeFrame(
  buffer: Buffer,
  range: { start: number; end: number }
): Buffer {
  return zstdDecompressSync(buffer.subarray(range.start, range.end));
}

async function readDshLog(filePath: string): Promise<DecodedDshLog> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error('DSH session log must not be a symlink.');
  }
  if (!info.isFile()) {
    throw new Error('DSH session log must be a regular file.');
  }
  if (info.size > MAX_LOG_BYTES) {
    throw new Error(`DSH session log exceeds ${MAX_LOG_BYTES} bytes.`);
  }

  const raw = await readFile(filePath);
  const hash = createHash('sha256').update(raw).digest('hex');

  let scan: ReturnType<typeof scanZstdFrames>;
  try {
    scan = scanZstdFrames(raw);
  } catch (error) {
    throw new Error(safeErrorMessage(error), { cause: error });
  }

  const records: ParsedRecord[] = [];
  let readTruncation: NativeSessionJsonlReadTruncation | undefined;
  let header: Record<string, unknown> | null = null;
  let seenLines = 0;
  let parsedEvents = 0;
  let plaintext = '';

  for (let index = 0; index < scan.frames.length; index++) {
    let decoded: Buffer;
    try {
      decoded = decodeFrame(raw, scan.frames[index]!);
    } catch (error) {
      // A complete-looking frame that fails checksum/corruption validation is
      // skipped as a gap; the listing/import never fails wholesale on one bad
      // frame (read-only tolerance, mirrors corrupt-line handling in siblings).
      logger.warn(
        `DSH session log ${path.basename(filePath)}: frame ${index} failed to decode; counted as gap.`,
        error
      );
      continue;
    }
    plaintext = `${plaintext}${decoded.toString('utf8')}`;
  }

  const lines = plaintext.split('\n');
  // The final split element after a trailing newline is '' — not a line.
  const meaningfulLines = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  for (const line of meaningfulLines) {
    seenLines += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (seenLines > MAX_LOG_LINES) {
      readTruncation =
        readTruncation ??
        logReadTruncation('line-limit', seenLines, parsedEvents);
      continue;
    }
    if (parsedEvents >= MAX_LOG_EVENTS) {
      readTruncation =
        readTruncation ??
        logReadTruncation('event-limit', seenLines, parsedEvents);
      continue;
    }
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) {
        parsedEvents += 1;
        if (!header && value['type'] === 'session') {
          header = value;
        }
        records.push({ lineNumber: seenLines, value });
      }
    } catch {
      // Ignore corrupt lines during read-only listing/import.
    }
  }

  return {
    path: filePath,
    bytes: info.size,
    hashSha256: hash,
    header,
    records,
    completeFrameCount: scan.frames.length,
    tornTrailingBytes:
      scan.tornStart !== undefined ? info.size - scan.tornStart : 0,
    ...(readTruncation ? { readTruncation } : {}),
  };
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

function summarizeDshLog(
  file: DecodedDshLog,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  const nativeId =
    (file.header ? stringFromRecord(file.header, ['id']) : '') ||
    path.basename(path.dirname(file.path));
  const headerCwd = file.header ? stringFromRecord(file.header, ['cwd']) : '';
  const createdAtMs = file.header
    ? numberField(file.header, 'createdAt')
    : undefined;
  const createdAt =
    typeof createdAtMs === 'number' && Number.isFinite(createdAtMs)
      ? new Date(createdAtMs).toISOString()
      : undefined;
  const timestamps = collectTimestamps(file.records);
  const title = titleFromRecords(file.records);
  const preview = previewFromRecords(file.records, nativeId);

  return {
    provider: 'dsh',
    nativeId,
    sourcePath: file.path,
    ...(headerCwd ? { cwd: headerCwd } : {}),
    ...(createdAt !== undefined
      ? { createdAt }
      : timestamps.first
        ? { createdAt: timestamps.first }
        : {}),
    ...(timestamps.last
      ? { updatedAt: timestamps.last, lastMessageAt: timestamps.last }
      : {}),
    ...(title ? { title } : {}),
    preview,
    metadata: {
      lineCount: file.records.length,
      byteCount: file.bytes,
      hashSha256: file.hashSha256,
      nativeSessionId: nativeId,
      eventTypes: collectEventTypes(file.records),
      ...(file.readTruncation ? { readTruncation: file.readTruncation } : {}),
    },
    capabilities,
  };
}

interface ImportedTurns {
  turns: AgentTurnV2[];
  truncation?: NativeSessionImportTruncation;
}

/**
 * Turn assembly follows the prime-agent/pi mapping approach: audit-marker turn
 * first, then one turn per `user/message` with `source.kind === 'user'`,
 * folding subsequent assistant consolidation (`assistant/message`) and thinking
 * evidence (`reasoning-chunks`) into it. Harness-internal user-role injections
 * (plugin snapshots, agent-instructions, skill catalogs) are logged gaps, not
 * fabricated turns. Deterministic; FIFO truncation identical to siblings.
 */
function buildTurns(file: DecodedDshLog, importedAt: string): ImportedTurns {
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
            sourceProvider: 'dsh',
            importSource: 'dsh-jsonl-zstd',
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

  for (const parsed of file.records) {
    const record = parsed.value;
    const type = stringField(record.type);
    const timestamp = timestampFromRecord(record) ?? importedAt;
    const data = objectField(record.data);

    if (type === 'session') continue; // Consumed via `file.header`.

    if (type === 'user/message') {
      const turn = userMessageTurn(record, turns.length, timestamp);
      if (typeof turn === 'string') {
        noteUnmapped(unmappedEventTypes, turn);
        continue;
      }
      activeTurn = turn;
      turns.push(turn);
      continue;
    }

    if (type === 'assistant/message') {
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      const message = objectField(data.message);
      const text = redactText(textFromContent(message.content));
      assistantSeq += 1;
      if (text) {
        turn.items.push({
          id: `assistant-message-${assistantSeq}`,
          ...(stringField(message.id)
            ? { providerMessageId: stringField(message.id) }
            : {}),
          type: 'assistantMessage',
          text: truncate(text, TEXT_LIMIT),
          phase: 'answer',
          startedAt: timestamp,
          completedAt: timestamp,
          status: 'completed',
        });
      }
      turn.completedAt = timestamp;
      continue;
    }

    if (type === 'reasoning-chunks') {
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      const texts = Array.isArray(data.texts)
        ? data.texts.filter((t): t is string => typeof t === 'string')
        : [];
      const joined = texts.join('');
      if (joined) {
        turn.items.push({
          id: `assistant-reasoning-${++assistantSeq}`,
          type: 'reasoning',
          summary: truncate(redactText(joined), PREVIEW_LIMIT),
          visibility: 'summary',
          startedAt: timestamp,
          completedAt: timestamp,
          status: 'completed',
        });
      } else {
        noteUnmapped(unmappedEventTypes, `${type}:empty`);
      }
      continue;
    }

    if (type === 'assistant/chunk') {
      // Streaming deltas are superseded by the consolidated assistant/message;
      // attributing them separately would double-count text. Known-but-folded.
      noteUnmapped(unmappedEventTypes, `${type}:folded-into-assistant-message`);
      continue;
    }

    if (type === 'command/run' || type === 'command/done') {
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
      turn.items.push({
        id: `native-extension-${++extensionSeq}`,
        type: 'providerExtension',
        namespace: 'dsh',
        startedAt: timestamp,
        completedAt: timestamp,
        status: 'completed',
        payload: {
          kind: type,
          lineNumber: parsed.lineNumber,
          ...(stringField(data.name) ? { name: stringField(data.name) } : {}),
          ...(stringField(data.args) ? { args: stringField(data.args) } : {}),
          ...(stringField(data.text)
            ? {
                textPreview: truncate(
                  redactText(stringField(data.text)),
                  PREVIEW_LIMIT
                ),
                redacted: true,
              }
            : {}),
        },
      });
      continue;
    }

    if (
      type === 'permission/preset' ||
      type === 'sandbox/mode' ||
      type === 'approval/policy' ||
      type === 'agent-preset/selected'
    ) {
      // Pre-turn policy metadata: attribute to the active turn when one is
      // open, but never fabricate a synthetic turn for it (these records
      // typically precede the first real user turn).
      if (activeTurn) {
        activeTurn.items.push({
          id: `native-extension-${++extensionSeq}`,
          type: 'providerExtension',
          namespace: 'dsh',
          startedAt: timestamp,
          completedAt: timestamp,
          status: 'completed',
          payload: {
            kind: type,
            lineNumber: parsed.lineNumber,
          },
        });
      } else {
        noteUnmapped(unmappedEventTypes, `${type}:pre-turn`);
      }
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
  return truncation ? { turns, truncation } : { turns };
}

/**
 * Map one `user/message` record. Returns a gap-attribution string when the
 * record is a harness-internal injection or carries no text; otherwise the
 * assembled turn opening a new conversation turn.
 */
function userMessageTurn(
  record: Record<string, unknown>,
  turnCount: number,
  timestamp: string
): AgentTurnV2 | string {
  const data = objectField(record.data);
  const type = 'user/message';
  const sourceKind = stringField(objectField(data.source).kind, 'user');
  if (sourceKind !== 'user') {
    return `${type}:${sourceKind}`;
  }
  const text = redactText(textFromContent(data.content));
  if (!text) {
    return `${type}:user(empty)`;
  }
  const turnId = `native-turn-${turnCount}`;
  const itemId = `user-${turnId}`;
  const userItem: AgentItemV2 = {
    id: itemId,
    type: 'userMessage',
    text: truncate(text, TEXT_LIMIT),
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'completed',
    ...(stringField(data.id) ? { providerItemId: stringField(data.id) } : {}),
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

function noteUnmapped(seen: Map<string, number>, eventType: string): void {
  seen.set(eventType, (seen.get(eventType) ?? 0) + 1);
  logger.info(
    `Unmapped native DSH session event '${eventType}' reported as import gap.`
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

function normalizeRef(
  ref: NativeSessionRef,
  summary: NativeSessionSummary
): NativeSessionRef {
  return {
    provider: 'dsh',
    nativeId: summary.nativeId,
    sourcePath: summary.sourcePath,
    ...(summary.cwd ? { cwd: summary.cwd } : {}),
    ...(ref.stateRoot ? { stateRoot: ref.stateRoot } : {}),
  };
}

function providerSession(
  summary: NativeSessionSummary,
  file: DecodedDshLog
): Record<string, string> {
  const providerSession: Record<string, string> = {
    nativeId: summary.nativeId,
    sourcePath: file.path,
    stateKind: 'dsh-jsonl-zstd',
    hashSha256: file.hashSha256,
  };
  if (summary.cwd) providerSession.cwd = summary.cwd;
  return providerSession;
}

function titleFromRecords(records: ParsedRecord[]): string | null {
  // Latest session/title wins; fall back to nothing (preview covers first
  // user text).
  let title: string | null = null;
  for (const parsed of records) {
    if (stringField(parsed.value.type) !== 'session/title') continue;
    const candidate = stringFromRecord(objectField(parsed.value.data), [
      'title',
    ]);
    if (candidate) title = candidate;
  }
  return title;
}

/**
 * Preview prefers the latest session/title (metadata source), then the first
 * real user message text (transcript source), then the session id.
 */
function previewFromRecords(
  records: ParsedRecord[],
  fallback: string
): NativeSessionPreview {
  for (const parsed of [...records].reverse()) {
    if (stringField(parsed.value.type) !== 'session/title') continue;
    const title = stringFromRecord(objectField(parsed.value.data), ['title']);
    if (title) {
      return {
        text: truncate(title, PREVIEW_LIMIT),
        source: 'metadata',
        redacted: false,
        charCount: Math.min(title.length, PREVIEW_LIMIT),
      };
    }
  }

  for (const parsed of records) {
    if (stringField(parsed.value.type) !== 'user/message') continue;
    const data = objectField(parsed.value.data);
    if (stringField(objectField(data.source).kind, 'user') !== 'user') continue;
    const text = redactText(textFromContent(data.content));
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

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && stringField(block.type) === 'text') {
      const text = stringField(block.text);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

function timestampFromRecord(record: Record<string, unknown>): string | null {
  const epoch = record.time;
  if (typeof epoch === 'number' && Number.isFinite(epoch)) {
    try {
      return new Date(epoch).toISOString();
    } catch {
      return null;
    }
  }
  const ts = stringFromRecord(record, ['timestamp', 'time', 'ts']);
  return ts || null;
}

function collectTimestamps(records: ParsedRecord[]): {
  first: string | null;
  last: string | null;
} {
  let first: string | null = null;
  let last: string | null = null;
  for (const parsed of records) {
    const ts = timestampFromRecord(parsed.value);
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

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function relaySessionId(nativeId: string, hash: string): string {
  return `native-dsh-${slug(nativeId)}-${hash.slice(0, 12)}`;
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

function numberField(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
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
