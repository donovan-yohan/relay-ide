import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
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
import {
  FileDerivedCache,
  SingleFlight,
  runWithConcurrency,
  sameStamp,
  stampFromStats,
  type FileDerivedCacheStats,
} from './file-summary-cache.js';
import {
  nativeSummaryCachePersistence,
  type NativeSummaryCacheStore,
} from './summary-cache-store.js';

const CLAUDE_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
  canImportTranscript: true,
  canReadProviderState: true,
  canResumeNative: true,
  // #1428: JSONL live tail is implemented and exercised end-to-end by the
  // native-sessions gateway topic + `sessions native watch` verb.
  canStreamLiveEvents: true,
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
// #1449: the list path fans out over up to MAX_LIST_FILES transcripts. Bound
// the in-flight reads so a cold walk overlaps I/O without exhausting handles.
const LIST_READ_CONCURRENCY = 8;
const SUMMARY_CACHE_ENTRIES = 4_000;
/**
 * #1459: bump when a change to this adapter alters the *shape or content* of a
 * summary in a way the fingerprint inputs below do not already cover, so a hub
 * upgrade retires the persisted rows instead of serving summaries this build
 * would never produce. `test/server/provider-state/summary-cache-persistence.test.ts`
 * pins the summary field set and fails when a field is added or removed.
 */
const SUMMARY_CACHE_FORMAT_VERSION = 1;

interface ParsedJsonlLine {
  lineNumber: number;
  value: Record<string, unknown>;
}

interface ClaudeJsonlFile {
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

interface ClaudeAdapterOptions {
  stateRoot?: string;
  now?: () => Date;
  maxFiles?: number;
  /** #1449: bound on the per-file summary cache (tests use small values). */
  summaryCacheEntries?: number;
  /**
   * #1459: durable backing for the summary cache. Without it the cache is
   * memory-only and a fresh process re-reads the whole store once, as before.
   */
  summaryCacheStore?: NativeSummaryCacheStore;
}

export class ClaudeJsonlStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'claude' as const;
  readonly capabilities = CLAUDE_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxFiles: number;
  /**
   * #1449: per-file summary cache keyed on `(mtimeMs, size)`. A transcript that
   * has not changed since the last list is never re-read, re-hashed or
   * re-parsed; a transcript that has changed misses the stamp and is re-derived.
   */
  private readonly summaryCache: FileDerivedCache<NativeSessionSummary>;
  /** Shares one in-flight read per path across concurrent list calls. */
  private readonly summaryReads = new SingleFlight<NativeSessionSummary>();
  private directIdHits = 0;
  private directIdFallbacks = 0;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.stateRoot = options.stateRoot ?? path.join(homedir(), '.claude');
    this.now = options.now ?? (() => new Date());
    this.maxFiles = options.maxFiles ?? MAX_LIST_FILES;
    this.summaryCache = new FileDerivedCache<NativeSessionSummary>(
      options.summaryCacheEntries ?? SUMMARY_CACHE_ENTRIES,
      options.summaryCacheStore
        ? nativeSummaryCachePersistence({
            provider: this.provider,
            store: options.summaryCacheStore,
            // Everything outside the transcript's own bytes that changes a
            // summary. Tuning any of these retires the persisted rows.
            fingerprintInput: {
              version: SUMMARY_CACHE_FORMAT_VERSION,
              capabilities: CLAUDE_STATE_CAPABILITIES,
              limits: {
                previewLimit: PREVIEW_LIMIT,
                textLimit: TEXT_LIMIT,
                maxBytes: MAX_JSONL_BYTES,
                maxLines: MAX_JSONL_LINES,
                maxEvents: MAX_JSONL_EVENTS,
              },
            },
          })
        : undefined
    );
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
        diagnostics:
          files.length > 0
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
                  message:
                    'Claude state root is readable but no JSONL sessions were found.',
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

    // #1449: summaries are derived per file behind an (mtimeMs, size) cache and
    // fanned out with bounded concurrency. `runWithConcurrency` returns results
    // in input order, so the pre-sort order — and therefore the stable sort
    // below — matches the previous serial walk exactly.
    const derived = await runWithConcurrency(
      files,
      LIST_READ_CONCURRENCY,
      async (filePath) => {
        try {
          return await this.summarizeFile(filePath);
        } catch {
          // Skip unreadable or over-limit provider files during discovery.
          // Direct reads still fail closed with the precise error.
          return undefined;
        }
      }
    );

    // #1459: durably record what this walk derived, and prune rows for files the
    // walk no longer sees. Pruning is only safe when the walk was not truncated
    // by `maxFiles` — a capped walk would evict rows for transcripts it never
    // reached. `files` is the raw walk, independent of `scope`, so a scoped
    // request prunes exactly as an unscoped one would.
    this.summaryCache.persistWalk(
      files.length < this.maxFiles ? new Set(files) : undefined
    );

    const summaries: NativeSessionSummary[] = [];
    for (const summary of derived) {
      if (!summary) continue;
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

  /**
   * Derive one file's summary, serving the (mtimeMs, size) cache when the file
   * is unchanged. The stamp is re-checked after the read so a transcript that
   * was appended to mid-parse is never cached under its pre-read stamp.
   */
  private async summarizeFile(filePath: string): Promise<NativeSessionSummary> {
    let info;
    try {
      info = await statClaudeSource(filePath);
    } catch (error) {
      // Deleted, replaced by a symlink, or grown past the read limit: drop any
      // entry we were still holding for this path rather than orphan it.
      this.summaryCache.delete(filePath);
      throw error;
    }

    const stamp = stampFromStats(info);
    const cached = this.summaryCache.get(filePath, stamp);
    if (cached) return cached;

    // Keyed on the stamp too: two callers that stat different versions of the
    // same path must not share one derivation.
    const flightKey = `${filePath}\u0000${stamp.ino}:${stamp.size}:${stamp.mtimeMs}:${stamp.ctimeMs}`;
    return this.summaryReads.run(flightKey, async () => {
      const summary = await summarizeClaudeJsonlFile(
        filePath,
        info.size,
        this.capabilities
      );

      try {
        const after = await lstat(filePath);
        if (sameStamp(stampFromStats(after), stamp)) {
          this.summaryCache.set(filePath, stamp, summary);
        }
      } catch {
        // File vanished between read and re-stat: return what we read, cache
        // nothing.
      }
      return summary;
    });
  }

  /**
   * Read-path counters (#1449). Not part of `AgentHarnessStateAdapter`; used by
   * tests and diagnostics to prove the cache and the direct-id resolver are
   * actually doing work rather than silently falling back.
   */
  nativeSessionReadStats(): {
    summaryCache: FileDerivedCacheStats;
    directIdHits: number;
    directIdFallbacks: number;
  } {
    return {
      summaryCache: this.summaryCache.stats(),
      directIdHits: this.directIdHits,
      directIdFallbacks: this.directIdFallbacks,
    };
  }

  async readProviderState(
    ref: NativeSessionRef
  ): Promise<ProviderStateSnapshot> {
    const file = await this.readRef(ref);
    const facts = claudeFactsFromFile(file);
    const summary = buildClaudeSummary(facts, this.capabilities);

    return {
      ref: normalizeRef(ref, summary),
      capturedAt: this.nowIso(),
      sourcePath: file.path,
      summary: {
        lineCount: file.lines.length,
        byteCount: file.bytes,
        hashSha256: file.hashSha256,
        eventTypes: facts.eventTypes,
        ...(facts.firstTimestamp
          ? { firstTimestamp: facts.firstTimestamp }
          : {}),
        ...(facts.lastTimestamp ? { lastTimestamp: facts.lastTimestamp } : {}),
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
    return ['claude', '--resume', ref.nativeId];
  }

  private async readRef(ref: NativeSessionRef): Promise<ClaudeJsonlFile> {
    if (ref.provider !== this.provider) {
      throw new Error(`Claude adapter cannot read provider '${ref.provider}'.`);
    }
    if (ref.sourcePath) {
      return readClaudeJsonl(await this.resolveSafeSourcePath(ref.sourcePath));
    }

    // #1449: Claude names a session's canonical transcript `<sessionId>.jsonl`
    // inside its project directory, so resolve the id to a path with a
    // readdir-only walk before falling back to reading every transcript. The
    // `resolveSafeSourcePath` containment guard still runs on the hit.
    const direct = await this.resolveNativeIdPath(ref.nativeId);
    if (direct) {
      try {
        const file = await readClaudeJsonl(direct);
        const summary = summarizeClaudeJsonl(file, this.capabilities);
        // `ref.cwd` scoped the fallback walk before #1449, so the fast path has
        // to honour it too: a same-id transcript under a different cwd was not
        // a match then and must not become one now.
        const cwdMatches = !ref.cwd || summary.cwd === ref.cwd;
        if (summary.nativeId === ref.nativeId && cwdMatches) {
          this.directIdHits += 1;
          return file;
        }
      } catch {
        // The canonically named file exists but is unreadable or over the size
        // limit. Fall through to the full walk, which is what resolved the id
        // before #1449 — the fast path must never turn a hit into an error.
      }
    }

    this.directIdFallbacks += 1;
    const sessions = await this.listNativeSessions(
      ref.cwd ? { cwd: ref.cwd } : {}
    );
    const found = sessions.find((session) => session.nativeId === ref.nativeId);
    if (!found) {
      throw new Error(`Claude native session '${ref.nativeId}' was not found.`);
    }
    return readClaudeJsonl(await this.resolveSafeSourcePath(found.sourcePath));
  }

  /**
   * Resolve `<nativeId>.jsonl` under the state root without reading any file
   * contents. Returns the containment-checked real path, or `undefined` when
   * the id does not name a transcript file.
   */
  private async resolveNativeIdPath(
    nativeId: string
  ): Promise<string | undefined> {
    const fileName = `${nativeId}.jsonl`;
    // Reject anything that could escape the state root before it reaches the
    // filesystem; `resolveSafeSourcePath` is the second line of defence.
    if (!nativeId || path.basename(fileName) !== fileName) return undefined;

    const match = await findJsonlFileByName(this.stateRoot, fileName, {
      maxFiles: this.maxFiles,
      maxDepth: MAX_SCAN_DEPTH,
    });
    if (!match) return undefined;
    try {
      return await this.resolveSafeSourcePath(match);
    } catch {
      return undefined;
    }
  }

  private async resolveSafeSourcePath(sourcePath: string): Promise<string> {
    const rootRealPath = await realpath(this.stateRoot);
    const candidatePath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(rootRealPath, sourcePath);
    if (path.extname(candidatePath) !== '.jsonl') {
      throw new Error(
        'Claude native session sourcePath must point to a .jsonl file.'
      );
    }

    const sourceInfo = await lstat(candidatePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error(
        'Claude native session sourcePath must not be a symlink.'
      );
    }
    if (!sourceInfo.isFile()) {
      throw new Error(
        'Claude native session sourcePath must point to a regular .jsonl file.'
      );
    }

    const sourceRealPath = await realpath(candidatePath);
    if (path.extname(sourceRealPath) !== '.jsonl') {
      throw new Error(
        'Claude native session sourcePath must resolve to a .jsonl file.'
      );
    }
    if (!isPathInside(rootRealPath, sourceRealPath)) {
      throw new Error(
        'Claude native session sourcePath must resolve under the configured state root.'
      );
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

/**
 * #1449: readdir-only search for one transcript by file name.
 *
 * This walks the tree in exactly the order `findJsonlFiles` does - depth-first,
 * entries in readdir order, directories and files interleaved - and consumes
 * the same `maxFiles` budget, so it can only reach transcripts the list walk
 * could also have reached. It opens nothing, so resolving a nativeId costs a
 * directory scan instead of a full parse of every transcript.
 *
 * Both properties are load-bearing: a different traversal order would resolve a
 * duplicated session id to a different transcript than the list did, and an
 * unbounded walk would resolve ids the capped list can never return.
 */
async function findJsonlFileByName(
  root: string,
  fileName: string,
  opts: { maxFiles: number; maxDepth: number }
): Promise<string | undefined> {
  let seenFiles = 0;

  async function walk(dir: string, depth: number): Promise<string | undefined> {
    if (seenFiles >= opts.maxFiles || depth > opts.maxDepth) return undefined;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (seenFiles >= opts.maxFiles) return undefined;
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = await walk(entryPath, depth + 1);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Counted whether or not it matches: this is the same budget the list
        // walk spends, so both stop at the same point in the tree.
        seenFiles += 1;
        if (entry.name === fileName) return entryPath;
      }
    }
    return undefined;
  }

  return walk(root, 0);
}

async function statClaudeSource(filePath: string): Promise<Stats> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error('Claude JSONL source must not be a symlink.');
  }
  if (!info.isFile()) {
    throw new Error('Claude JSONL source must be a regular file.');
  }
  if (info.size > MAX_JSONL_BYTES) {
    throw new Error(`Claude JSONL source exceeds ${MAX_JSONL_BYTES} bytes.`);
  }
  return info;
}

interface ClaudeJsonlScan {
  bytes: number;
  hashSha256: string;
  readTruncation?: NativeSessionJsonlReadTruncation;
}

/**
 * Stream one transcript, hashing it and handing every parsed record to
 * `onLine`. Callers that only need summary facts never materialize the record
 * array, which is what makes the cold list path affordable (#1449).
 */
async function scanClaudeJsonl(
  filePath: string,
  byteCount: number,
  onLine: (line: ParsedJsonlLine) => void
): Promise<ClaudeJsonlScan> {
  const hash = createHash('sha256');
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
        onLine({ lineNumber: seenLines, value });
      }
    } catch {
      // Ignore corrupt lines during read-only listing/import. The bounded hash
      // still covers the file, and future diagnostics can surface parse errors.
    }
  };

  for await (const chunk of createReadStream(filePath, { encoding: 'utf8' })) {
    hash.update(chunk, 'utf8');
    pending += chunk;
    let searchFrom = 0;
    let newlineIndex = pending.indexOf('\n', searchFrom);
    while (newlineIndex !== -1) {
      processLine(pending.slice(searchFrom, newlineIndex).replace(/\r$/, ''));
      searchFrom = newlineIndex + 1;
      newlineIndex = pending.indexOf('\n', searchFrom);
    }
    pending = searchFrom > 0 ? pending.slice(searchFrom) : pending;
  }
  if (pending.length > 0) processLine(pending.replace(/\r$/, ''));

  return {
    bytes: byteCount,
    hashSha256: hash.digest('hex'),
    ...(readTruncation ? { readTruncation } : {}),
  };
}

async function readClaudeJsonl(filePath: string): Promise<ClaudeJsonlFile> {
  const info = await statClaudeSource(filePath);
  const lines: ParsedJsonlLine[] = [];
  const scan = await scanClaudeJsonl(filePath, info.size, (line) => {
    lines.push(line);
  });
  return {
    path: filePath,
    bytes: scan.bytes,
    hashSha256: scan.hashSha256,
    lines,
    ...(scan.readTruncation ? { readTruncation: scan.readTruncation } : {}),
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
 * The facts a `NativeSessionSummary` is built from. Collected either by walking
 * an already-parsed `ClaudeJsonlFile` (import/read paths) or incrementally
 * while streaming a transcript (the list path, #1449). Both routes feed
 * `buildClaudeSummary` so the two can never drift.
 */
interface ClaudeSummaryFacts {
  path: string;
  bytes: number;
  hashSha256: string;
  lineCount: number;
  eventTypes: string[];
  nativeSessionId?: string | undefined;
  cwd?: string | undefined;
  workContextId?: string | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | undefined;
  firstTimestamp?: string | undefined;
  lastTimestamp?: string | undefined;
  title?: string | undefined;
  previewText?: string | undefined;
  readTruncation?: NativeSessionJsonlReadTruncation;
}

const CLAUDE_NATIVE_ID_KEYS = [
  'sessionId',
  'session_id',
  'conversationId',
  'conversation_id',
];
const CLAUDE_CWD_KEYS = ['cwd', 'workspace', 'projectPath'];
const CLAUDE_WORK_CONTEXT_KEYS = ['workContextId', 'work_context_id'];
const CLAUDE_REPO_PATH_KEYS = ['repoPath', 'repositoryPath'];
const CLAUDE_WORKTREE_PATH_KEYS = ['worktreePath'];
const CLAUDE_TITLE_KEYS = ['summary', 'title'];

/** Incremental collector mirroring the whole-array helpers below. */
class ClaudeFactCollector {
  lineCount = 0;
  private readonly eventTypes = new Set<string>();
  private facts: {
    nativeSessionId?: string | undefined;
    cwd?: string | undefined;
    workContextId?: string | undefined;
    repoPath?: string | undefined;
    worktreePath?: string | undefined;
    firstTimestamp?: string | undefined;
    lastTimestamp?: string | undefined;
    title?: string | undefined;
    previewText?: string | undefined;
  } = {};

  observe(line: ParsedJsonlLine): void {
    const record = line.value;
    this.lineCount += 1;

    const eventType = stringField(record.type) || messageRole(record);
    if (eventType) this.eventTypes.add(eventType);

    this.facts.nativeSessionId ??= stringFromRecord(
      record,
      CLAUDE_NATIVE_ID_KEYS
    );
    this.facts.cwd ??= stringFromRecord(record, CLAUDE_CWD_KEYS);
    this.facts.workContextId ??= stringFromRecord(
      record,
      CLAUDE_WORK_CONTEXT_KEYS
    );
    this.facts.repoPath ??= stringFromRecord(record, CLAUDE_REPO_PATH_KEYS);
    this.facts.worktreePath ??= stringFromRecord(
      record,
      CLAUDE_WORKTREE_PATH_KEYS
    );
    this.facts.title ??= stringFromRecord(record, CLAUDE_TITLE_KEYS);

    const timestamp = timestampFromRecord(record);
    if (timestamp) {
      // Timestamps are normalized to ISO-8601, so lexicographic min/max matches
      // the sorted-array first/last the array helper produces.
      if (!this.facts.firstTimestamp || timestamp < this.facts.firstTimestamp) {
        this.facts.firstTimestamp = timestamp;
      }
      if (!this.facts.lastTimestamp || timestamp > this.facts.lastTimestamp) {
        this.facts.lastTimestamp = timestamp;
      }
    }

    if (this.facts.previewText === undefined) {
      const text = textFromRecord(record);
      if (text) this.facts.previewText = text;
    }
  }

  toFacts(scan: ClaudeJsonlScan & { path: string }): ClaudeSummaryFacts {
    return {
      path: scan.path,
      bytes: scan.bytes,
      hashSha256: scan.hashSha256,
      lineCount: this.lineCount,
      eventTypes: [...this.eventTypes],
      ...this.facts,
      ...(scan.readTruncation ? { readTruncation: scan.readTruncation } : {}),
    };
  }
}

function claudeFactsFromFile(file: ClaudeJsonlFile): ClaudeSummaryFacts {
  const collector = new ClaudeFactCollector();
  for (const line of file.lines) collector.observe(line);
  return collector.toFacts({
    path: file.path,
    bytes: file.bytes,
    hashSha256: file.hashSha256,
    ...(file.readTruncation ? { readTruncation: file.readTruncation } : {}),
  });
}

function buildClaudeSummary(
  facts: ClaudeSummaryFacts,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  const fallbackId = path.basename(facts.path, '.jsonl');
  const nativeId = facts.nativeSessionId ?? fallbackId;
  const cwd = facts.cwd;
  const workContextId = facts.workContextId;
  const repoPath = facts.repoPath;
  const worktreePath = facts.worktreePath;
  const title = facts.title
    ? truncate(redactText(facts.title), PREVIEW_LIMIT)
    : undefined;
  const preview = buildPreview(facts.previewText, title ?? fallbackId);

  return {
    provider: 'claude',
    nativeId,
    sourcePath: facts.path,
    ...(cwd ? { cwd } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(workContextId ? { workContextId } : {}),
    ...(facts.firstTimestamp ? { createdAt: facts.firstTimestamp } : {}),
    ...(facts.lastTimestamp
      ? { updatedAt: facts.lastTimestamp, lastMessageAt: facts.lastTimestamp }
      : {}),
    ...(title ? { title } : {}),
    preview,
    metadata: {
      lineCount: facts.lineCount,
      byteCount: facts.bytes,
      hashSha256: facts.hashSha256,
      nativeSessionId: nativeId,
      eventTypes: facts.eventTypes,
      ...(facts.readTruncation ? { readTruncation: facts.readTruncation } : {}),
    },
    capabilities,
  };
}

function summarizeClaudeJsonl(
  file: ClaudeJsonlFile,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  return buildClaudeSummary(claudeFactsFromFile(file), capabilities);
}

/**
 * Stream-and-summarize: derives the same summary as `summarizeClaudeJsonl`
 * without ever holding the parsed record array (#1449).
 */
async function summarizeClaudeJsonlFile(
  filePath: string,
  byteCount: number,
  capabilities: AgentHarnessStateCapabilities
): Promise<NativeSessionSummary> {
  const collector = new ClaudeFactCollector();
  const scan = await scanClaudeJsonl(filePath, byteCount, (line) => {
    collector.observe(line);
  });
  return buildClaudeSummary(
    collector.toFacts({ ...scan, path: filePath }),
    capabilities
  );
}

function buildTurns(
  file: ClaudeJsonlFile,
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
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
      activeTurn = turn;
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
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
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

  // sessionId is passed so future patch-based import helpers can keep stable
  // IDs without changing this reducer path. Keep the invariant alive, crab tax.
  void sessionId;
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

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
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

function buildPreview(
  transcriptText: string | undefined,
  fallback: string
): NativeSessionPreview {
  if (transcriptText) {
    const redacted = redactText(transcriptText);
    return {
      text: truncate(redacted, PREVIEW_LIMIT),
      source: 'transcript',
      redacted: redacted !== transcriptText,
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

function timestampFromRecord(
  record: Record<string, unknown>
): string | undefined {
  const raw = stringFromRecord(record, [
    'timestamp',
    'createdAt',
    'created_at',
  ]);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function messageRole(record: Record<string, unknown>): string {
  const message = objectField(record.message);
  return (
    stringField(message.role) ||
    stringField(record.role) ||
    stringField(record.type)
  );
}

function messageBlocks(
  record: Record<string, unknown>
): Record<string, unknown>[] {
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
  return (
    blocks.length > 0 && blocks.every((block) => block.type === 'tool_result')
  );
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
  if (Array.isArray(value))
    return value.map((entry) => redactJsonValue(entry, depth + 1));
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
    .replace(
      /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/g,
      '[redacted-credential]@'
    )
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
