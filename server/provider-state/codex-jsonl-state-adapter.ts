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

const CODEX_STATE_CAPABILITIES: AgentHarnessStateCapabilities = {
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
// #1449: bound the in-flight transcript reads on the list path.
const LIST_READ_CONCURRENCY = 8;
const SUMMARY_CACHE_ENTRIES = 4_000;

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
  /** #1449: bound on the per-file summary cache (tests use small values). */
  summaryCacheEntries?: number;
}

export class CodexJsonlStateAdapter implements AgentHarnessStateAdapter {
  readonly provider = 'codex' as const;
  readonly capabilities = CODEX_STATE_CAPABILITIES;

  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxFiles: number;
  /**
   * #1449: per-file summary cache keyed on `(mtimeMs, size)`. Unchanged
   * transcripts are never re-read, re-hashed or re-parsed; changed ones miss
   * the stamp and are re-derived.
   */
  private readonly summaryCache: FileDerivedCache<NativeSessionSummary>;
  /** Shares one in-flight read per path across concurrent list calls. */
  private readonly summaryReads = new SingleFlight<NativeSessionSummary>();
  private directIdHits = 0;
  private directIdFallbacks = 0;

  constructor(options: CodexAdapterOptions = {}) {
    this.stateRoot =
      options.stateRoot ?? path.join(homedir(), '.codex', 'sessions');
    this.now = options.now ?? (() => new Date());
    this.maxFiles = options.maxFiles ?? MAX_LIST_FILES;
    this.summaryCache = new FileDerivedCache<NativeSessionSummary>(
      options.summaryCacheEntries ?? SUMMARY_CACHE_ENTRIES
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
                  code: 'CODEX_STATE_READABLE',
                  message: 'Codex state root is readable.',
                  severity: 'info',
                },
              ]
            : [
                {
                  code: 'CODEX_STATE_EMPTY',
                  message:
                    'Codex state root is readable but no JSONL sessions were found.',
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

    // #1449: derive each summary behind an (mtimeMs, size) cache with bounded
    // concurrency. Results come back in input order, so the stable sort below
    // produces the same list as the previous serial walk.
    const derived = await runWithConcurrency(
      files,
      LIST_READ_CONCURRENCY,
      async (filePath) => {
        try {
          return await this.summarizeFile(filePath);
        } catch {
          // Skip unreadable or over-limit provider files during discovery.
          return undefined;
        }
      }
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
   * is unchanged. The stamp is re-checked after the read so a transcript
   * appended to mid-parse is never cached under its pre-read stamp.
   */
  private async summarizeFile(filePath: string): Promise<NativeSessionSummary> {
    let info;
    try {
      info = await statCodexSource(filePath);
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
      const summary = await summarizeCodexJsonlFile(
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
    const facts = codexFactsFromFile(file);
    const summary = buildCodexSummary(facts, this.capabilities);

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
    return ['codex', '--resume', ref.nativeId];
  }

  private async readRef(ref: NativeSessionRef): Promise<CodexJsonlFile> {
    if (ref.provider !== this.provider) {
      throw new Error(`Codex adapter cannot read provider '${ref.provider}'.`);
    }
    if (ref.sourcePath) {
      return readCodexJsonl(await this.resolveSafeSourcePath(ref.sourcePath));
    }

    // #1449: Codex names each rollout file after its session id, so resolve the
    // id to a path with a readdir-only walk before falling back to reading
    // every transcript. `resolveSafeSourcePath` still guards containment.
    const direct = await this.resolveNativeIdPath(ref.nativeId);
    if (direct) {
      try {
        const file = await readCodexJsonl(direct);
        const summary = summarizeCodexJsonl(file, this.capabilities);
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
      throw new Error(`Codex native session '${ref.nativeId}' was not found.`);
    }
    return readCodexJsonl(await this.resolveSafeSourcePath(found.sourcePath));
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
        'Codex native session sourcePath must point to a .jsonl file.'
      );
    }

    const sourceInfo = await lstat(candidatePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error('Codex native session sourcePath must not be a symlink.');
    }
    if (!sourceInfo.isFile()) {
      throw new Error(
        'Codex native session sourcePath must point to a regular .jsonl file.'
      );
    }

    const sourceRealPath = await realpath(candidatePath);
    if (path.extname(sourceRealPath) !== '.jsonl') {
      throw new Error(
        'Codex native session sourcePath must resolve to a .jsonl file.'
      );
    }
    if (!isPathInside(rootRealPath, sourceRealPath)) {
      throw new Error(
        'Codex native session sourcePath must resolve under the configured state root.'
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

async function statCodexSource(filePath: string): Promise<Stats> {
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
  return info;
}

interface CodexJsonlScan {
  bytes: number;
  hashSha256: string;
  readTruncation?: NativeSessionJsonlReadTruncation;
}

/**
 * Stream one transcript, hashing it and handing every parsed record to
 * `onLine`. Callers that only need summary facts never materialize the record
 * array, which is what makes the cold list path affordable (#1449).
 */
async function scanCodexJsonl(
  filePath: string,
  byteCount: number,
  onLine: (line: ParsedJsonlLine) => void
): Promise<CodexJsonlScan> {
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
      // Ignore corrupt lines during read-only listing/import.
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

async function readCodexJsonl(filePath: string): Promise<CodexJsonlFile> {
  const info = await statCodexSource(filePath);
  const lines: ParsedJsonlLine[] = [];
  const scan = await scanCodexJsonl(filePath, info.size, (line) => {
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
 * an already-parsed `CodexJsonlFile` (import/read paths) or incrementally while
 * streaming a transcript (the list path, #1449). Both routes feed
 * `buildCodexSummary`, so the two can never drift.
 */
interface CodexSummaryFacts {
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
  /** First user-message text, already redacted (preview pass 1). */
  previewUserText?: string | undefined;
  /** First `summary`/`title` value (preview pass 2). */
  previewMetaSummary?: string | undefined;
  readTruncation?: NativeSessionJsonlReadTruncation;
}

const CODEX_NATIVE_ID_KEYS = ['session_id', 'sessionId', 'id'];
const CODEX_CWD_KEYS = ['cwd', 'workspace', 'projectPath', 'working_directory'];
const CODEX_WORK_CONTEXT_KEYS = ['workContextId', 'work_context_id'];
const CODEX_REPO_PATH_KEYS = ['repoPath', 'repositoryPath'];
const CODEX_WORKTREE_PATH_KEYS = ['worktreePath'];
const CODEX_TITLE_KEYS = ['summary', 'title', 'name'];
const CODEX_PREVIEW_SUMMARY_KEYS = ['summary', 'title'];

/** Incremental collector mirroring the whole-array helpers below. */
class CodexFactCollector {
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
    previewUserText?: string | undefined;
    previewMetaSummary?: string | undefined;
  } = {};

  observe(line: ParsedJsonlLine): void {
    const record = line.value;
    this.lineCount += 1;

    const eventType = stringField(record.type);
    if (eventType) this.eventTypes.add(eventType);

    this.facts.nativeSessionId ||= stringFromRecord(
      record,
      CODEX_NATIVE_ID_KEYS
    );
    this.facts.cwd ||= firstOwnStringField(record, CODEX_CWD_KEYS);
    this.facts.workContextId ||= firstOwnStringField(
      record,
      CODEX_WORK_CONTEXT_KEYS
    );
    this.facts.repoPath ||= firstOwnStringField(record, CODEX_REPO_PATH_KEYS);
    this.facts.worktreePath ||= firstOwnStringField(
      record,
      CODEX_WORKTREE_PATH_KEYS
    );
    this.facts.title ||= stringFromRecord(record, CODEX_TITLE_KEYS);
    this.facts.previewMetaSummary ||= stringFromRecord(
      record,
      CODEX_PREVIEW_SUMMARY_KEYS
    );

    // Codex reports first/last in document order, not sorted order.
    const timestamp = timestampFromRecord(record);
    if (timestamp) {
      this.facts.firstTimestamp ||= timestamp;
      this.facts.lastTimestamp = timestamp;
    }

    if (!this.facts.previewUserText && messageRole(record) === 'user') {
      const text = redactText(textFromRecord(record));
      if (text) this.facts.previewUserText = text;
    }
  }

  toFacts(scan: CodexJsonlScan & { path: string }): CodexSummaryFacts {
    return {
      path: scan.path,
      bytes: scan.bytes,
      hashSha256: scan.hashSha256,
      lineCount: this.lineCount,
      eventTypes: [...this.eventTypes].sort(),
      ...this.facts,
      ...(scan.readTruncation ? { readTruncation: scan.readTruncation } : {}),
    };
  }
}

function codexFactsFromFile(file: CodexJsonlFile): CodexSummaryFacts {
  const collector = new CodexFactCollector();
  for (const line of file.lines) collector.observe(line);
  return collector.toFacts({
    path: file.path,
    bytes: file.bytes,
    hashSha256: file.hashSha256,
    ...(file.readTruncation ? { readTruncation: file.readTruncation } : {}),
  });
}

function buildCodexSummary(
  facts: CodexSummaryFacts,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  const fallbackId = path.basename(facts.path, '.jsonl');
  const nativeId = facts.nativeSessionId || fallbackId;
  const cwd = facts.cwd;
  const workContextId = facts.workContextId;
  const repoPath = facts.repoPath;
  const worktreePath = facts.worktreePath;
  const title = facts.title;
  const preview = buildPreview(
    facts.previewUserText,
    facts.previewMetaSummary,
    title || fallbackId
  );

  return {
    provider: 'codex',
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

function summarizeCodexJsonl(
  file: CodexJsonlFile,
  capabilities: AgentHarnessStateCapabilities
): NativeSessionSummary {
  return buildCodexSummary(codexFactsFromFile(file), capabilities);
}

/**
 * Stream-and-summarize: derives the same summary as `summarizeCodexJsonl`
 * without ever holding the parsed record array (#1449).
 */
async function summarizeCodexJsonlFile(
  filePath: string,
  byteCount: number,
  capabilities: AgentHarnessStateCapabilities
): Promise<NativeSessionSummary> {
  const collector = new CodexFactCollector();
  const scan = await scanCodexJsonl(filePath, byteCount, (line) => {
    collector.observe(line);
  });
  return buildCodexSummary(
    collector.toFacts({ ...scan, path: filePath }),
    capabilities
  );
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
      const turn: AgentTurnV2 =
        activeTurn ?? createSyntheticTurn(turns, timestamp, importedAt);
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
      const providerItemId = stringFromRecord(record, [
        'uuid',
        'id',
        'message_id',
      ]);
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

function buildPreview(
  userText: string | undefined,
  metaSummary: string | undefined,
  fallback: string
): NativeSessionPreview {
  if (userText) {
    return {
      text: truncate(userText, PREVIEW_LIMIT),
      source: 'transcript',
      redacted: true,
      charCount: Math.min(userText.length, PREVIEW_LIMIT),
    };
  }
  if (metaSummary) {
    return {
      text: truncate(metaSummary, PREVIEW_LIMIT),
      source: 'metadata',
      redacted: false,
      charCount: Math.min(metaSummary.length, PREVIEW_LIMIT),
    };
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
  if (type === 'user' || type === 'human' || type === 'UserPromptSubmit')
    return 'user';
  if (type === 'assistant' || type === 'ai' || type === 'Stop')
    return 'assistant';
  const role = stringField(record.role);
  if (role === 'user' || role === 'assistant') return role;
  return null;
}

function messageBlocks(
  record: Record<string, unknown>
): Record<string, unknown>[] {
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

function appendBlockContentText(content: unknown, parts: string[]): void {
  if (typeof content === 'string') {
    parts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (isRecord(item) && typeof item.text === 'string') parts.push(item.text);
  }
}

function blockText(blocks: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const type = stringField(block.type);
    if (type === 'tool_result' || type === 'tool_use_result') {
      appendBlockContentText(block.content, parts);
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
        if (isRecord(item) && typeof item.text === 'string')
          parts.push(item.text);
      }
      return parts.join('\n');
    }
  }
  return stringFromRecord(record, ['text', 'content_text', 'prompt', 'input']);
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

/**
 * Own-key lookup used by the summary facts. Unlike `stringFromRecord` this is
 * the shape `firstStringField` used before #1449 — same keys, same order, one
 * record at a time.
 */
function firstOwnStringField(
  record: Record<string, unknown>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value) return value;
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
