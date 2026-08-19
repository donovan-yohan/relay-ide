import * as fs from 'node:fs';
import * as os from 'node:os';

import { providerDescriptors } from './protocol-adapters/index.js';

export type LanguageServerKind =
  | 'tsserver'
  | 'typescript-language-server'
  | 'pyright';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  commandLine: string;
  rssBytes: number;
  /** Linux `/proc/<pid>/stat` start time, used to reject PID reuse on reap. */
  startTicks?: number;
  ageMs?: number;
  languageServerKind?: LanguageServerKind;
}

export interface ProcessTableOptions {
  procRoot?: string;
  nowMs?: number;
  uptimeSeconds?: number;
  clockTickHz?: number;
}

export interface LanguageServerDiagnostics {
  generatedAt: string;
  platform: NodeJS.Platform;
  processCount: number;
  totalRssBytes: number;
  processes: Array<{
    pid: number;
    ppid: number;
    pgid: number;
    kind: LanguageServerKind;
    command: string;
    commandLine: string;
    rssBytes: number;
    ageMs?: number;
    relayOwnedLikely: boolean;
    ancestors: Array<{
      pid: number;
      ppid: number;
      pgid: number;
      command: string;
      commandLine: string;
    }>;
  }>;
}

export interface ProcessReapSummary {
  rootPids: number[];
  descendantPids: number[];
  processGroupIds: number[];
  languageServers: Array<{
    pid: number;
    kind: LanguageServerKind;
    rssBytes: number;
    commandLine: string;
  }>;
}

/** Aggregate-only accounting for adapter-owned process roots and descendants. */
export interface OwnedProcessResourceSummary {
  rootCount: number;
  processCount: number;
  totalRssBytes: number;
}

export interface OwnedProcessTreeSnapshot {
  rootPids: number[];
  processTable: ProcessInfo[];
}

export interface ProcessReapOptions {
  rootPids: number[];
  /** Detached Linux process groups known to belong to the captured roots. */
  processGroupIds?: number[];
  reason?: string;
  procRoot?: string;
  processTable?: ProcessInfo[];
  /** Fresh table used to validate captured identities immediately before kill. */
  verifyProcessTable?: () => ProcessInfo[];
  killDelayMs?: number;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  setTimer?: (callback: () => void, delayMs: number) => { unref?: () => void };
  logger?: {
    debug?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
  };
}

const LANGUAGE_SERVER_MATCHERS: Array<{
  kind: LanguageServerKind;
  pattern: RegExp;
}> = [
  { kind: 'tsserver', pattern: /(^|[/\s])tsserver\.js(\s|$)/i },
  {
    kind: 'typescript-language-server',
    pattern: /(^|[/\s])typescript-language-server(\s|$)/i,
  },
  { kind: 'pyright', pattern: /(^|[/\s])pyright-langserver(\s|$)/i },
];

const DEFAULT_CLOCK_TICK_HZ = 100;

export function readProcessTable(
  options: ProcessTableOptions = {}
): ProcessInfo[] {
  if (process.platform !== 'linux' && options.procRoot === undefined) return [];

  const procRoot = options.procRoot ?? '/proc';
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }

  const uptimeSeconds = options.uptimeSeconds ?? safeUptimeSeconds(procRoot);
  const clockTickHz = options.clockTickHz ?? DEFAULT_CLOCK_TICK_HZ;
  const processes: ProcessInfo[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const processDir = `${procRoot}/${entry}`;
    const stat = readText(`${processDir}/stat`);
    if (!stat) continue;
    const parsed = parseProcStat(stat);
    if (!parsed) continue;

    const commandLine = readCommandLine(processDir, parsed.command);
    const languageServerKind = classifyLanguageServer(commandLine);
    const startSeconds = parsed.startTicks / clockTickHz;
    const ageMs =
      uptimeSeconds > 0 && startSeconds >= 0 && startSeconds <= uptimeSeconds
        ? Math.max(0, Math.round((uptimeSeconds - startSeconds) * 1000))
        : undefined;

    processes.push({
      pid,
      ppid: parsed.ppid,
      pgid: parsed.pgid,
      command: parsed.command,
      commandLine,
      rssBytes: readRssBytes(processDir),
      startTicks: parsed.startTicks,
      ...(ageMs !== undefined ? { ageMs } : {}),
      ...(languageServerKind ? { languageServerKind } : {}),
    });
  }

  return processes.sort((a, b) => a.pid - b.pid);
}

export function descendantsOf(
  rootPid: number,
  table: ProcessInfo[]
): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const proc of table) {
    const bucket = children.get(proc.ppid) ?? [];
    bucket.push(proc);
    children.set(proc.ppid, bucket);
  }

  const descendants: ProcessInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const proc = queue.shift()!;
    if (seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    descendants.push(proc);
    queue.push(...(children.get(proc.pid) ?? []));
  }
  return descendants;
}

export function summarizeProcessReap(
  rootPids: number[],
  table: ProcessInfo[] = readProcessTable()
): ProcessReapSummary {
  const cleanRoots = uniqueSafePids(rootPids);
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  const descendants = new Map<number, ProcessInfo>();
  const processGroupIds = new Set<number>();

  for (const rootPid of cleanRoots) {
    const root = byPid.get(rootPid);
    if (root && root.pgid === root.pid && root.pgid !== process.pid) {
      processGroupIds.add(root.pgid);
    }
    for (const child of descendantsOf(rootPid, table)) {
      descendants.set(child.pid, child);
      if (child.pgid === child.pid && child.pgid !== process.pid) {
        processGroupIds.add(child.pgid);
      }
    }
  }

  return {
    rootPids: cleanRoots,
    descendantPids: Array.from(descendants.keys()).sort((a, b) => a - b),
    processGroupIds: Array.from(processGroupIds).sort((a, b) => a - b),
    languageServers: Array.from(descendants.values())
      .filter((proc) => proc.languageServerKind)
      .map((proc) => ({
        pid: proc.pid,
        kind: proc.languageServerKind!,
        rssBytes: proc.rssBytes,
        commandLine: proc.commandLine,
      }))
      .sort((a, b) => a.pid - b.pid),
  };
}

export function summarizeOwnedProcessResources(
  rootPids: number[],
  table: ProcessInfo[] = readProcessTable()
): OwnedProcessResourceSummary {
  const roots = uniqueSafePids(rootPids);
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  const owned = new Map<number, ProcessInfo>();
  let rootCount = 0;

  for (const rootPid of roots) {
    const root = byPid.get(rootPid);
    if (!root) continue;
    rootCount += 1;
    owned.set(root.pid, root);
    for (const descendant of descendantsOf(rootPid, table)) {
      owned.set(descendant.pid, descendant);
    }
  }

  return {
    rootCount,
    processCount: owned.size,
    totalRssBytes: Array.from(owned.values()).reduce(
      (sum, proc) => sum + proc.rssBytes,
      0
    ),
  };
}

export function captureOwnedProcessTree(
  rootPids: number[],
  table: ProcessInfo[] = readProcessTable()
): OwnedProcessTreeSnapshot {
  return { rootPids: uniqueSafePids(rootPids), processTable: table };
}

export function reapOwnedProcessTree(
  snapshot: OwnedProcessTreeSnapshot,
  reason: string
): ProcessReapSummary {
  return scheduleRelayProcessTreeReap({
    ...snapshot,
    processGroupIds: process.platform === 'linux' ? snapshot.rootPids : [],
    reason,
    verifyProcessTable: readProcessTable,
  });
}

export function scheduleRelayProcessTreeReap(
  options: ProcessReapOptions
): ProcessReapSummary {
  const procRoot = options.procRoot;
  const processTableOptions = procRoot === undefined ? {} : { procRoot };
  const table = options.processTable ?? readProcessTable(processTableOptions);
  const summary = summarizeProcessReap(options.rootPids, table);
  const knownPids = new Set([...summary.rootPids, ...summary.descendantPids]);
  const processGroupIds = new Set([
    ...summary.processGroupIds,
    ...uniqueSafePids(options.processGroupIds ?? []),
  ]);
  const killProcess =
    options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const logger = options.logger;

  if (knownPids.size === 0 && processGroupIds.size === 0) return summary;

  if (summary.languageServers.length > 0) {
    logger?.warn?.(
      'session runtime reap found %d language-server descendants (%s)',
      summary.languageServers.length,
      options.reason ?? 'unspecified'
    );
  } else {
    logger?.debug?.(
      'session runtime reap found %d descendants (%s)',
      summary.descendantPids.length,
      options.reason ?? 'unspecified'
    );
  }

  const current = options.verifyProcessTable?.() ?? table;
  signalProcessGroups(
    liveProcessGroups(processGroupIds, table, current),
    'SIGTERM',
    killProcess
  );
  signalPids(
    liveCapturedPids(knownPids, table, current),
    'SIGTERM',
    killProcess
  );

  const timer = (options.setTimer ?? setTimeout)(() => {
    const refreshed =
      options.verifyProcessTable?.() ?? readProcessTable(processTableOptions);
    signalProcessGroups(
      liveProcessGroups(processGroupIds, table, refreshed),
      'SIGKILL',
      killProcess
    );
    signalPids(
      liveCapturedPids(knownPids, table, refreshed),
      'SIGKILL',
      killProcess
    );
  }, options.killDelayMs ?? 1_000) as { unref?: () => void };
  timer.unref?.();

  return summary;
}

/** Relay's own entrypoints. Provider CLI names come from the descriptors. */
const RELAY_ENTRYPOINT_COMMAND_LINE_PATTERN = /relay-ide|relayctl/i;

interface RelayOwnershipPatterns {
  commandLine: RegExp;
  commandBasename: RegExp | null;
}

let relayOwnershipPatterns: RelayOwnershipPatterns | null = null;

/**
 * Built on first use, not at module load: `claude-adapter.ts` and
 * `codex-native-adapter.ts` import THIS module, so reading the adapter registry
 * at module scope would be a temporal-dead-zone crash whenever the registry
 * happens to load first. By call time both modules are initialized.
 */
function ownershipPatterns(): RelayOwnershipPatterns {
  if (relayOwnershipPatterns) return relayOwnershipPatterns;
  const substrings = [
    RELAY_ENTRYPOINT_COMMAND_LINE_PATTERN.source,
    ...providerDescriptors().flatMap((descriptor) =>
      descriptor.processMatch.commandLineSubstrings.map(escapeForRegExp)
    ),
  ];
  const basenames = providerDescriptors().flatMap((descriptor) =>
    descriptor.processMatch.commandBasenames.map(escapeForRegExp)
  );
  relayOwnershipPatterns = {
    commandLine: new RegExp(substrings.join('|'), 'i'),
    commandBasename: basenames.length
      ? new RegExp(`(?:^|/)(?:${basenames.join('|')})$`, 'i')
      : null,
  };
  return relayOwnershipPatterns;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Heuristic: does this process look like Relay or one of its agent CLIs?
 *
 * The provider names come from `ProviderDescriptor.processMatch`
 * (`server/protocol-adapters/index.ts`), so a new provider's CLI is recognized as
 * soon as it registers. This used to be a hand-maintained regex, and a provider
 * missing from it had its language-server children silently attributed to nobody.
 * Command-line matching is substring-based on purpose (paths, wrappers, args);
 * names too short for that — `pi` — match the command basename instead.
 */
export function isRelayOwnedAgentProcess(candidate: {
  command: string;
  commandLine: string;
}): boolean {
  const patterns = ownershipPatterns();
  return (
    patterns.commandLine.test(candidate.commandLine) ||
    patterns.commandBasename?.test(candidate.command) === true
  );
}

export function collectLanguageServerDiagnostics(
  options: ProcessTableOptions = {}
): LanguageServerDiagnostics {
  const table = readProcessTable(options);
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  const processes = table
    .filter((proc) => proc.languageServerKind)
    .map((proc) => {
      const ancestors = ancestorsOf(proc, byPid);
      const relayOwnedLikely = [proc, ...ancestors].some((candidate) =>
        isRelayOwnedAgentProcess(candidate)
      );
      return {
        pid: proc.pid,
        ppid: proc.ppid,
        pgid: proc.pgid,
        kind: proc.languageServerKind!,
        command: proc.command,
        commandLine: redactCommandLine(proc.commandLine),
        rssBytes: proc.rssBytes,
        ...(proc.ageMs !== undefined ? { ageMs: proc.ageMs } : {}),
        relayOwnedLikely,
        ancestors: ancestors.map((ancestor) => ({
          pid: ancestor.pid,
          ppid: ancestor.ppid,
          pgid: ancestor.pgid,
          command: ancestor.command,
          commandLine: redactCommandLine(ancestor.commandLine),
        })),
      };
    })
    .sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);

  return {
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    platform: process.platform,
    processCount: processes.length,
    totalRssBytes: processes.reduce((sum, proc) => sum + proc.rssBytes, 0),
    processes,
  };
}

function parseProcStat(
  stat: string
):
  | { command: string; ppid: number; pgid: number; startTicks: number }
  | undefined {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close <= open) return undefined;
  const command = stat.slice(open + 1, close);
  const rest = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  const pgid = Number(rest[2]);
  const startTicks = Number(rest[19]);
  if (![ppid, pgid, startTicks].every(Number.isFinite)) return undefined;
  return { command, ppid, pgid, startTicks };
}

function readCommandLine(processDir: string, fallbackCommand: string): string {
  const cmdline = readText(`${processDir}/cmdline`);
  if (!cmdline) return fallbackCommand;
  const argv = cmdline.split('\0').filter((arg) => arg.length > 0);
  if (argv.length === 0) return fallbackCommand;
  return redactSensitiveArgvValues(argv).join(' ');
}

function redactSensitiveArgvValues(argv: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const inline = redactInlineSensitiveArg(arg);
    if (inline) {
      redacted.push(inline);
      continue;
    }

    if (isSensitiveStandaloneArg(arg) && argv[index + 1] !== undefined) {
      redacted.push(arg, '[REDACTED]');
      index += 1;
      continue;
    }

    redacted.push(arg);
  }
  return redacted;
}

function redactInlineSensitiveArg(arg: string): string | undefined {
  const optionMatch = arg.match(
    /^(--?(?:api[-_]?key|token|access[-_]?token|auth(?:orization)?|password|secret|credential|client[-_]?secret)=)(.+)$/i
  );
  if (optionMatch) return `${optionMatch[1]}[REDACTED]`;

  const envMatch = arg.match(
    /^([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY)[A-Z0-9_]*=)(.+)$/
  );
  if (envMatch) return `${envMatch[1]}[REDACTED]`;

  return undefined;
}

function isSensitiveStandaloneArg(arg: string): boolean {
  return (
    /^--?(?:api[-_]?key|token|access[-_]?token|auth(?:orization)?|password|secret|credential|client[-_]?secret)$/i.test(
      arg
    ) || /^(?:bearer|basic)$/i.test(arg)
  );
}

type CommandToken = { start: number; end: number; text: string };
type RedactionRange = { start: number; end: number };

export function redactCommandLine(commandLine: string): string {
  const tokens = tokenizeCommandLine(commandLine);
  const redactions = collectCommandLineRedactions(tokens);

  return applyRedactions(commandLine, redactions).replace(
    /([?&](?:token|access_token|api_key|key|secret|password)=)[^&\s]+/gi,
    '$1[REDACTED]'
  );
}

function collectCommandLineRedactions(
  tokens: CommandToken[]
): RedactionRange[] {
  const redactions: RedactionRange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const range =
      secretOptionRedaction(token, tokens[index + 1]) ??
      envAssignmentRedaction(token, tokens, index) ??
      credentialSchemeRedaction(token, tokens[index + 1]);
    if (range) redactions.push(range);
  }
  return redactions;
}

function secretOptionRedaction(
  token: CommandToken,
  nextToken: CommandToken | undefined
): RedactionRange | undefined {
  if (
    !/^(--?(?:api[-_]?key|token|access[-_]?token|auth(?:orization)?|password|secret|credential|client[-_]?secret))(?:=.*)?$/i.test(
      token.text
    )
  ) {
    return undefined;
  }

  if (!token.text.includes('=')) return nextToken;

  const valueStart = token.start + token.text.indexOf('=') + 1;
  return valueStart < token.end
    ? { start: valueStart, end: token.end }
    : undefined;
}

function envAssignmentRedaction(
  token: CommandToken,
  tokens: CommandToken[],
  index: number
): RedactionRange | undefined {
  const envMatch = token.text.match(
    /^([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY)[A-Z0-9_]*=)/
  );
  const envPrefix = envMatch?.[1];
  if (!envPrefix) return undefined;

  const valueStart = token.start + envPrefix.length;
  const valueText = token.text.slice(envPrefix.length);
  let valueEnd = token.end;
  if (valueText.includes('"')) {
    valueEnd = consumeUntilQuote(tokens, index, '"');
  } else if (valueText.includes("'")) {
    valueEnd = consumeUntilQuote(tokens, index, "'");
  } else {
    valueEnd = consumeFollowingQuotedFragments(tokens, index) ?? valueEnd;
  }
  return valueStart < valueEnd
    ? { start: valueStart, end: valueEnd }
    : undefined;
}

function credentialSchemeRedaction(
  token: CommandToken,
  nextToken: CommandToken | undefined
): RedactionRange | undefined {
  return /^(?:bearer|basic)$/i.test(token.text) ? nextToken : undefined;
}

function tokenizeCommandLine(
  commandLine: string
): Array<{ start: number; end: number; text: string }> {
  const tokens: Array<{ start: number; end: number; text: string }> = [];
  let index = 0;

  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index]!))
      index += 1;
    if (index >= commandLine.length) break;

    const start = index;
    let quote: '"' | "'" | undefined;
    while (index < commandLine.length) {
      const char = commandLine[index]!;
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (/\s/.test(char)) {
        break;
      }
      index += 1;
    }

    tokens.push({ start, end: index, text: commandLine.slice(start, index) });
  }

  return tokens;
}

function consumeUntilQuote(
  tokens: Array<{ start: number; end: number; text: string }>,
  startIndex: number,
  quote: '"' | "'"
): number {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.text.endsWith(quote) && !token.text.endsWith(`\\${quote}`))
      return token.end;
  }
  return tokens[startIndex]!.end;
}

function consumeFollowingQuotedFragments(
  tokens: Array<{ start: number; end: number; text: string }>,
  startIndex: number
): number | undefined {
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (/^--?\w/.test(token.text) || /^[A-Z0-9_]+=/.test(token.text))
      return undefined;
    const quoteOffset = Math.max(
      token.text.indexOf('"'),
      token.text.indexOf("'")
    );
    if (quoteOffset >= 0) return token.start + quoteOffset + 1;
    if (token.text.endsWith('"') || token.text.endsWith("'")) return token.end;
  }
  return undefined;
}

function applyRedactions(
  commandLine: string,
  redactions: Array<{ start: number; end: number }>
): string {
  const ranges = redactions
    .filter((range) => range.start < range.end)
    .sort((a, b) => b.start - a.start);
  let redacted = commandLine;
  for (const range of ranges) {
    redacted = `${redacted.slice(0, range.start)}[REDACTED]${redacted.slice(range.end)}`;
  }
  return redacted;
}

function readRssBytes(processDir: string): number {
  const status = readText(`${processDir}/status`);
  const match = status?.match(/^VmRSS:\s+(\d+)\s+kB/im);
  return match ? Number(match[1]) * 1024 : 0;
}

function readText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function safeUptimeSeconds(procRoot: string): number {
  if (procRoot === '/proc') return os.uptime();
  const uptime = readText(`${procRoot}/uptime`);
  const first = uptime?.trim().split(/\s+/)[0];
  const parsed = first ? Number(first) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function classifyLanguageServer(
  commandLine: string
): LanguageServerKind | undefined {
  for (const matcher of LANGUAGE_SERVER_MATCHERS) {
    if (matcher.pattern.test(commandLine)) return matcher.kind;
  }
  return undefined;
}

function ancestorsOf(
  proc: ProcessInfo,
  byPid: Map<number, ProcessInfo>
): ProcessInfo[] {
  const ancestors: ProcessInfo[] = [];
  const seen = new Set<number>([proc.pid]);
  let current = proc;
  while (current.ppid > 1 && !seen.has(current.ppid) && ancestors.length < 12) {
    const parent = byPid.get(current.ppid);
    if (!parent) break;
    ancestors.push(parent);
    seen.add(parent.pid);
    current = parent;
  }
  return ancestors;
}

function uniqueSafePids(pids: number[]): number[] {
  return Array.from(new Set(pids))
    .filter(
      (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
    )
    .sort((a, b) => a - b);
}

function signalProcessGroups(
  processGroupIds: Set<number>,
  signal: NodeJS.Signals,
  killProcess: (pid: number, signal: NodeJS.Signals) => void
): void {
  for (const pgid of Array.from(processGroupIds)) {
    safeSignal(-pgid, signal, killProcess);
  }
}

function signalPids(
  pids: Set<number>,
  signal: NodeJS.Signals,
  killProcess: (pid: number, signal: NodeJS.Signals) => void
): void {
  const ordered = Array.from(pids)
    .filter((pid) => pid > 1 && pid !== process.pid)
    .sort((a, b) => b - a);
  for (const pid of ordered) safeSignal(pid, signal, killProcess);
}

function liveProcessGroups(
  groupIds: Set<number>,
  captured: ProcessInfo[],
  table: ProcessInfo[]
): Set<number> {
  const currentByPid = new Map(table.map((proc) => [proc.pid, proc]));
  return new Set(
    Array.from(groupIds).filter((pgid) =>
      captured.some((before) => {
        if (before.pgid !== pgid) return false;
        const now = currentByPid.get(before.pid);
        return (
          now?.pgid === pgid &&
          (before.startTicks === undefined ||
            now.startTicks === undefined ||
            before.startTicks === now.startTicks)
        );
      })
    )
  );
}

function liveCapturedPids(
  capturedPids: Set<number>,
  captured: ProcessInfo[],
  current: ProcessInfo[]
): Set<number> {
  const capturedByPid = new Map(captured.map((proc) => [proc.pid, proc]));
  const currentByPid = new Map(current.map((proc) => [proc.pid, proc]));
  return new Set(
    Array.from(capturedPids).filter((pid) => {
      const before = capturedByPid.get(pid);
      const now = currentByPid.get(pid);
      if (!before || !now) return false;
      return (
        before.startTicks === undefined ||
        now.startTicks === undefined ||
        before.startTicks === now.startTicks
      );
    })
  );
}

function safeSignal(
  pid: number,
  signal: NodeJS.Signals,
  killProcess: (pid: number, signal: NodeJS.Signals) => void
): void {
  try {
    killProcess(pid, signal);
  } catch {
    // Already exited, not owned by this user, or no process group. Reaping is best effort.
  }
}
