import * as fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { BaseProtocolAdapterV2 } from '../protocol-adapter-v2.js';
import type {
  AdapterConfig,
  AdapterStatus,
  AgentApprovalResponseInputV2,
  AgentInputResponseInputV2,
  AgentInterruptInputV2,
  AgentSendMessageInputV2,
} from '../protocol-adapter-v2.js';
import type {
  AgentApprovalDecisionV2,
  AgentApprovalSupportV2,
  AgentCapabilitySetV2,
  AgentSessionLiveStateV2,
  AgentSessionUpdatedPatchV2,
  AgentSlashCommandV2,
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import { cleanEnv } from '../utils.js';
import { createLogger } from '../logger.js';
import {
  ClaudeStreamClient,
  type ClaudeSpawnFn,
  type ClaudeStreamCloseEvent,
} from '../claude-stream-client.js';

const logger = createLogger('claude-adapter');

// ── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  // Ships gated off until the AskUserQuestion wire payload is pinned live (§13).
  questions: false,
  plans: false,
  // SDK `supportedCommands` is gone; only a relay-owned catalog (+ any names the
  // init line advertises) is emitted, so the slash-command menu stays off.
  slashCommands: false,
  queue: true,
  interrupt: true,
  cancelQueued: false,
  resume: true,
  fork: false,
  rollback: false,
  compact: true,
  telemetry: true,
  rateLimits: true,
  streaming: true,
};

const RELAY_CLAUDE_COMMANDS: AgentSlashCommandV2[] = [
  {
    id: 'relay:clear',
    name: 'clear',
    description: 'Start a new session with empty context',
    aliases: ['reset', 'new'],
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'clear',
  },
  {
    id: 'relay:resume',
    name: 'resume',
    description: 'Resume a saved Claude session',
    aliases: ['continue'],
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'resume',
  },
  {
    id: 'relay:model',
    name: 'model',
    description: 'Switch model for subsequent Claude responses',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'model',
  },
];

/** Claude supports only once/permanent accept and deny — no cancel, no amendments. */
const CLAUDE_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once', 'permanent'],
  amendmentTypes: [],
  canCancel: false,
};

/** Images: base64 payloads carried inline in the user-turn content array (§8). */
const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
/** Base64 bytes per image (§8). */
const MAX_IMAGE_BASE64_BYTES = 20 * 1024 * 1024;
/** Whole stdin line cap — the CLI pipes stdin capped at 10MB since 2.1.128 (§8). */
const MAX_STDIN_LINE_BYTES = Math.floor(9.5 * 1024 * 1024);

// GC / lifecycle defaults (§6). Overridable via config.extra.
const DEFAULT_IDLE_TTL_MS = 900_000; // 15 min
const DEFAULT_TURN_TIMEOUT_MS = 600_000; // 10 min
const DEFAULT_APPROVAL_STALL_MS = 600_000;
const DEFAULT_INTERRUPT_ACK_MS = 5_000;
const DEFAULT_GC_INTERVAL_MS = 30_000;

// Crash-loop breaker (§6): max 3 respawns per 5 min per session.
const CRASH_BREAKER_WINDOW_MS = 5 * 60_000;
const CRASH_BREAKER_MAX_RESPAWNS = 3;

// stream-json reserved flags claudeArgs may never inject (the codex claudeArgs
// leak bug class). Value-taking flags also consume the following token. Short
// aliases the claude CLI accepts (`-c` = --continue, `-r` = --resume, `-p` =
// --print) are denied alongside their long forms — otherwise an operator could
// smuggle a conflicting continue/resume target past the long-flag denylist.
const RESERVED_BOOL_FLAGS = new Set([
  '-p',
  '--print',
  '--verbose',
  '-c',
  '--continue',
  '--include-partial-messages',
]);
const RESERVED_VALUE_FLAGS = new Set([
  '--input-format',
  '--output-format',
  '-r',
  '--resume',
  '--session-id',
  '--permission-prompt-tool',
]);

/**
 * Behind a single constant: the reference proved multi-turn persistence without
 * `-p` on CLI 2.1.183. If a newer CLI kills the process after the first result
 * under `-p`, flip this to false (§2.1, Risk 2).
 */
const USE_PRINT_FLAG = true;

type ClaudeEventVisibility = 'normal' | 'debug' | 'trace';

/** Inner `control_response.response.response` payload written to the CLI (§7). */
interface ClaudePermissionResponse {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
}

interface QueuedClaudeMessage {
  input: AgentSendMessageInputV2;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface PendingApproval {
  turnId: string;
  toolName: string;
  target: string;
  detail?: string;
  suggestions?: unknown[];
}

// ── Pure helpers (ported verbatim / near-verbatim from the SDK adapter) ───────

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

function permissionMode(value: string | undefined): string | undefined {
  if (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan' ||
    value === 'dontAsk' ||
    value === 'auto'
  ) {
    return value;
  }
  return undefined;
}

/**
 * Translate a normalized V2 approval decision into the inner Claude permission
 * response written on the wire. Throws for decisions Claude does not support so
 * the UI gates them via `supported` and the adapter never emits a bad frame.
 */
function claudeDecisionFromV2(
  decision: AgentApprovalDecisionV2,
  suggestions: unknown[] | undefined
): ClaudePermissionResponse {
  if (decision.kind === 'decline') {
    return { behavior: 'deny', message: 'Denied by user' };
  }
  if (decision.kind === 'cancel') {
    throw new Error(
      'Claude does not support cancel decisions. UI must gate cancel using supported.canCancel.'
    );
  }
  const scope = decision.scope ?? 'once';
  if (scope === 'session' || scope === 'turn') {
    throw new Error(
      `Claude does not support scope '${scope}'. UI must gate this using supported.scopes.`
    );
  }
  if (decision.amendments && decision.amendments.length > 0) {
    throw new Error(
      'Claude does not support amendments. UI must gate amendments using supported.amendmentTypes.'
    );
  }
  return {
    behavior: 'allow',
    ...(scope === 'permanent' && suggestions && suggestions.length > 0
      ? { updatedPermissions: suggestions }
      : {}),
  };
}

function claudeEventVisibility(
  message: Record<string, unknown>
): ClaudeEventVisibility {
  if (message.type === 'stream_event') return 'trace';
  if (message.type === 'rate_limit_event') {
    const info = objectField(message.rate_limit_info);
    return info.status === 'allowed' ? 'trace' : 'debug';
  }
  if (message.type === 'control_response') return 'trace';
  if (message.type === 'system') {
    const subtype = stringField(message.subtype);
    if (subtype === 'hook_started') return 'trace';
    if (subtype === 'hook_response') {
      const outcome = stringField(message.outcome);
      const stdout = stringField(message.stdout);
      const stderr = stringField(message.stderr);
      return outcome === 'success' && stdout.length === 0 && stderr.length === 0
        ? 'trace'
        : 'debug';
    }
    if (subtype.startsWith('hook_')) return 'debug';
  }
  return 'debug';
}

function contentBlocks(
  message: Record<string, unknown>
): Record<string, unknown>[] {
  const nativeMessage = objectField(message.message);
  const content = nativeMessage.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

/** Sum per-model-iteration token usage; top-level usage covers only the last. */
function usageFromResult(message: Record<string, unknown>): AgentUsageV2 {
  const usage = objectField(message.usage);
  const iterations = Array.isArray(usage.iterations)
    ? usage.iterations
    : Array.isArray(message.iterations)
      ? message.iterations
      : null;

  const readTokens = (
    source: Record<string, unknown>
  ): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } => ({
    input: Number(source.input_tokens ?? source.inputTokens),
    output: Number(source.output_tokens ?? source.outputTokens),
    cacheRead: Number(
      source.cache_read_input_tokens ?? source.cacheReadInputTokens
    ),
    cacheWrite: Number(
      source.cache_creation_input_tokens ?? source.cacheCreationInputTokens
    ),
  });

  let inputTokens = NaN;
  let outputTokens = NaN;
  let cacheReadTokens = NaN;
  let cacheWriteTokens = NaN;

  if (iterations && iterations.length > 0) {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let seen = false;
    for (const raw of iterations) {
      if (!isRecord(raw)) continue;
      const source = isRecord(raw.usage) ? raw.usage : raw;
      const t = readTokens(source);
      if (Number.isFinite(t.input)) {
        input += t.input;
        seen = true;
      }
      if (Number.isFinite(t.output)) {
        output += t.output;
        seen = true;
      }
      if (Number.isFinite(t.cacheRead)) {
        cacheRead += t.cacheRead;
        seen = true;
      }
      if (Number.isFinite(t.cacheWrite)) {
        cacheWrite += t.cacheWrite;
        seen = true;
      }
    }
    if (seen) {
      inputTokens = input;
      outputTokens = output;
      cacheReadTokens = cacheRead;
      cacheWriteTokens = cacheWrite;
    }
  } else {
    const t = readTokens(usage);
    inputTokens = t.input;
    outputTokens = t.output;
    cacheReadTokens = t.cacheRead;
    cacheWriteTokens = t.cacheWrite;
  }

  const costUsd = Number(message.total_cost_usd ?? message.totalCostUsd);

  return {
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(cacheReadTokens) ? { cacheReadTokens } : {}),
    ...(Number.isFinite(cacheWriteTokens) ? { cacheWriteTokens } : {}),
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

function targetFromToolInput(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === 'Bash')
    return stringField(input.command, JSON.stringify(input));
  return stringField(input.file_path ?? input.path, JSON.stringify(input));
}

function filePathsFromToolInput(
  input: Record<string, unknown>
): Array<{ path: string; status?: string }> {
  const paths: Array<{ path: string; status?: string }> = [];
  const filePath = input.file_path ?? input.path;
  if (typeof filePath === 'string')
    paths.push({ path: filePath, status: 'edited' });
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (isRecord(edit) && typeof edit.file_path === 'string') {
        paths.push({ path: edit.file_path, status: 'edited' });
      }
    }
  }
  return paths.length > 0 ? paths : [{ path: 'unknown', status: 'pending' }];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (stringField(block.type) === 'text') {
      const text = stringField(block.text);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

function patchFromFileResult(result: Record<string, unknown>): string {
  const gitDiff = objectField(result.gitDiff);
  const gitPatch = stringField(gitDiff.patch);
  if (gitPatch) return gitPatch;

  // Some persistent-subprocess builds surface the unified patch directly on
  // tool_use_result instead of nesting it under gitDiff.
  const directPatch = stringField(result.patch);
  if (directPatch) return directPatch;

  const hunks = result.structuredPatch;
  if (!Array.isArray(hunks)) return '';
  const out: string[] = [];
  for (const hunk of hunks) {
    if (!isRecord(hunk)) continue;
    const oldStart = Number(hunk.oldStart) || 0;
    const oldLines = Number(hunk.oldLines) || 0;
    const newStart = Number(hunk.newStart) || 0;
    const newLines = Number(hunk.newLines) || 0;
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    const lines = hunk.lines;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        if (typeof line === 'string') out.push(line);
      }
    }
  }
  return out.join('\n');
}

function pathsFromFileResult(
  result: Record<string, unknown>,
  fallback: Array<{ path: string; status?: string }>
): Array<{ path: string; status?: string }> {
  const filePath = stringField(result.filePath);
  if (!filePath) return fallback;
  const gitDiff = objectField(result.gitDiff);
  const status = stringField(gitDiff.status);
  return [{ path: filePath, ...(status ? { status } : { status: 'edited' }) }];
}

/** Build the slash-command catalog from an init line's `slash_commands`. */
function slashCommandsFromInit(raw: unknown): AgentSlashCommandV2[] {
  const byKey = new Map<string, AgentSlashCommandV2>();
  const entries = Array.isArray(raw) ? raw : [];
  for (const entry of entries) {
    const name =
      typeof entry === 'string'
        ? entry
        : isRecord(entry)
          ? stringField(entry.name)
          : '';
    const normalized = normalizeCommandName(name);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (byKey.has(key)) continue;
    const relayOverride = RELAY_CLAUDE_COMMANDS.find((c) => c.name === key);
    byKey.set(key, {
      id: `claude:${normalized}`,
      name: normalized,
      source: 'sdk',
      sourceLabel: 'Claude',
      dispatch: 'agent',
      collisionKey: key,
      ...(relayOverride?.aliases ? { aliases: relayOverride.aliases } : {}),
    });
  }
  for (const relay of RELAY_CLAUDE_COMMANDS) {
    const key = relay.name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, relay);
  }
  return [...byKey.values()];
}

/** Strip reserved stream-json flags from operator-supplied claudeArgs. */
function filterClaudeArgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (typeof token !== 'string') continue;
    const eq = token.indexOf('=');
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    if (RESERVED_BOOL_FLAGS.has(flag)) continue;
    if (RESERVED_VALUE_FLAGS.has(flag)) {
      if (eq < 0) i++; // skip the space-separated value token too
      continue;
    }
    out.push(token);
  }
  return out;
}

function mimeForAttachment(path: string, declared: string | undefined): string {
  if (declared) return declared;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return EXT_MIME[path.slice(dot).toLowerCase()] ?? '';
}

// ── Process registry (cross-cutting: GC sweep + shutdown kill-all) ───────────

interface ClaudeRegistryEntry {
  readonly registrySessionId: string;
  gcSweep(now: number): void;
  forceStop(): Promise<void>;
}

/**
 * Module-level registry (§6). The adapter owns its child 1:1; the registry only
 * drives the periodic GC sweep (idle eviction + turn timeout) and relay-shutdown
 * kill-all. The interval is unref'd and started on first insert, stopped when
 * empty.
 */
export class ClaudeProcessRegistry {
  private readonly entries = new Map<string, ClaudeRegistryEntry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly gcIntervalMs: number = DEFAULT_GC_INTERVAL_MS) {}

  register(entry: ClaudeRegistryEntry): void {
    this.entries.set(entry.registrySessionId, entry);
    this.ensureTimer();
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId);
    if (this.entries.size === 0) this.stopTimer();
  }

  size(): number {
    return this.entries.size;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.gcIntervalMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const entry of [...this.entries.values()]) {
      try {
        entry.gcSweep(now);
      } catch (err) {
        logger.warn('claude registry gc sweep failed:', err);
      }
    }
  }

  /** Relay shutdown: tear every child down via the ladder. */
  async killAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.stopTimer();
    await Promise.all(entries.map((e) => e.forceStop().catch(() => undefined)));
  }
}

export const claudeProcessRegistry = new ClaudeProcessRegistry();

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * ClaudeProtocolAdapter — persistent-subprocess adapter over stream-json.
 *
 * One `claude` child per web session (lazy: `connect()` never spawns, the first
 * `sendMessage` does). Warm-idle eviction kills the child while the adapter
 * stays `connected`; the next send respawns with `--resume <claudeSessionId>` —
 * the same mechanism serves crash recovery and relay-restart cold recovery
 * (#1168, refs #300). No `@anthropic-ai/claude-agent-sdk`.
 */
export class ClaudeProtocolAdapter
  extends BaseProtocolAdapterV2
  implements ClaudeRegistryEntry
{
  readonly agentType = 'claude';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: ClaudeStreamClient | null = null;
  private claudeSessionId: string | null = null;

  private activeTurnId: string | null = null;
  private activeStartedAt: string | null = null;
  private turnStartedAtMs: number | null = null;
  private completedActiveTurn = false;
  private lastActivityAt = Date.now();

  private slashCommandsEmitted = false;
  private providerExtensionSeq = 0;
  private interruptSeq = 0;

  private readonly queue: QueuedClaudeMessage[] = [];
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly approvalStallTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingInterrupts = new Map<string, () => void>();

  // Wall-clock start of the current waiting-approval sub-state (null when no
  // approval is outstanding). Its elapsed time is excluded from the turn-timeout
  // budget so a human deliberating on an approval never trips the stuck-turn
  // kill (§3, §6).
  private approvalWaitStartedMs: number | null = null;

  // Set after an interrupt ack keeps the child warm while a follow-up turn is
  // queued: the aborted turn's trailing wire lines must be dropped so they are
  // not misattributed to the next drained turn (§3, §14).
  private suppressInterruptedTail = false;

  private readonly streamedTextItems = new Set<string>();
  private readonly streamedReasoningItems = new Set<string>();
  private readonly streamTextBuffers = new Map<string, string>();
  private readonly streamReasoningBuffers = new Map<string, string>();
  private streamProviderMessageId: string | null = null;

  private readonly activeToolUses = new Map<
    string,
    {
      kind: 'file' | 'exec' | 'dynamic' | 'mcp';
      toolName: string;
      input: Record<string, unknown>;
      command?: string;
      paths?: Array<{ path: string; status?: string }>;
      server?: string;
      tool?: string;
    }
  >();

  // Crash-loop breaker state: timestamps of *unexpected* child exits / spawn
  // failures only. Initial spawns and deliberate kills (interrupt ladder, turn
  // timeout, idle eviction) never land here (§6).
  private readonly crashTimestamps: number[] = [];

  // Tunables (defaults from §6, overridable via config.extra).
  private idleTtlMs = DEFAULT_IDLE_TTL_MS;
  private turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS;
  private approvalStallMs = DEFAULT_APPROVAL_STALL_MS;
  private interruptAckMs = DEFAULT_INTERRUPT_ACK_MS;
  private teardownDelays:
    | { afterStdinMs?: number; afterSigtermMs?: number }
    | undefined;

  private readonly spawnFn: ClaudeSpawnFn;
  private readonly registry: ClaudeProcessRegistry;

  constructor(
    spawnFn: ClaudeSpawnFn = nodeSpawn as unknown as ClaudeSpawnFn,
    registry: ClaudeProcessRegistry = claudeProcessRegistry
  ) {
    super();
    this.spawnFn = spawnFn;
    this.registry = registry;
  }

  get status(): AdapterStatus {
    return this._status;
  }

  get registrySessionId(): string {
    return this.sessionId;
  }

  /**
   * A live adapter transitively holds JSON-hostile references — the shared
   * registry's `setInterval` handle and, once spawned, a `ChildProcess`. The
   * session-create route serializes the whole WebSession (adapter included) into
   * its HTTP response, so expose only a safe summary rather than the live graph.
   */
  toJSON(): Record<string, unknown> {
    return {
      agentType: this.agentType,
      runtimeOwnership: this.runtimeOwnership,
      status: this._status,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.applyRuntimeParams(config);
    this._status = 'connected';
    this.claudeSessionId = null;
    this.slashCommandsEmitted = false;
    this.lastActivityAt = Date.now();
    this.crashTimestamps.length = 0;
    this.approvalWaitStartedMs = null;
    this.suppressInterruptedTail = false;

    this.registry.register(this);

    this.emitSnapshot();
    this.emitLiveState({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: 0,
      fastModeAvailable: true,
      error: null,
    });
    // Relay-owned controls are available immediately; the init line later
    // merges any CLI-advertised commands on top.
    this.emitSessionUpdate({ slashCommands: RELAY_CLAUDE_COMMANDS });
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    this.registry.unregister(this.registrySessionId);

    this.rejectQueued(new Error('Claude adapter disconnected'));

    // Auto-deny outstanding approvals before the child is killed (§7.4).
    for (const requestId of [...this.pendingApprovals.keys()]) {
      this.writeControlResponse(requestId, {
        behavior: 'deny',
        message: 'Denied (session closing)',
      });
    }
    this.clearPendingApprovals();
    this.approvalWaitStartedMs = null;
    this.suppressInterruptedTail = false;
    this.pendingInterrupts.clear();
    this.activeToolUses.clear();

    const dead = this.client;
    this.client = null;
    this.activeTurnId = null;
    this.activeStartedAt = null;
    this.turnStartedAtMs = null;
    this.completedActiveTurn = false;
    this.claudeSessionId = null;
    this.slashCommandsEmitted = false;
    this.streamedTextItems.clear();
    this.streamedReasoningItems.clear();
    this.streamTextBuffers.clear();
    this.streamReasoningBuffers.clear();
    this.streamProviderMessageId = null;

    if (dead) await dead.stop().catch(() => undefined);
  }

  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('Cannot reconnect before connect');
    const config = this.config;
    await this.disconnect();
    await this.connect(config);
  }

  /**
   * Provider-level reattach (relay restart / transport drop with a stored id).
   * Stores the id and emits a resumed snapshot; the `--resume` respawn is lazy —
   * it happens on the next `sendMessage` (§3, §10). No spawn here.
   */
  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = this.config;

    this.rejectQueued(new Error('Claude adapter resuming'));
    this.clearPendingApprovals();
    this.approvalWaitStartedMs = null;
    this.suppressInterruptedTail = false;
    this.pendingInterrupts.clear();
    this.activeToolUses.clear();

    const dead = this.client;
    this.client = null;
    this.activeTurnId = null;
    this.activeStartedAt = null;
    this.turnStartedAtMs = null;
    this.completedActiveTurn = false;
    this.slashCommandsEmitted = false;
    this.streamedTextItems.clear();
    this.streamedReasoningItems.clear();
    this.streamTextBuffers.clear();
    this.streamReasoningBuffers.clear();
    this.streamProviderMessageId = null;

    this.claudeSessionId = sessionId;
    this._status = 'connected';
    this.lastActivityAt = Date.now();
    if (dead) await dead.stop().catch(() => undefined);

    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: config.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: config.sessionId,
        provider: 'claude',
        cwd: config.cwd,
        capabilities: { ...this.capabilities, resume: true },
        providerSession: { claudeSessionId: sessionId },
        config: {
          ...(config.model ? { model: config.model } : {}),
          ...(config.permissionMode
            ? { permissionMode: config.permissionMode }
            : {}),
        },
      }),
    });
    this.emitLiveState({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: 0,
      fastModeAvailable: true,
      error: null,
    });
    this.emitSessionUpdate({ slashCommands: RELAY_CLAUDE_COMMANDS });
  }

  // ── User actions ─────────────────────────────────────────────────────────

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    if (this._status !== 'connected') {
      throw new Error('Cannot send a Claude message before connect');
    }
    this.lastActivityAt = Date.now();

    if (this.activeTurnId !== null) {
      return new Promise<void>((resolve, reject) => {
        this.queue.push({ input, resolve, reject });
        this.emitLiveState({
          status: 'working',
          activeTurnId: this.activeTurnId,
          queueLength: this.queue.length,
        });
      });
    }

    this.startTurn(input);
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (this.activeTurnId === null) return;
    if (input.turnId !== undefined && input.turnId !== this.activeTurnId)
      return;

    // Capture the turn this interrupt targets. The ack/timeout race below spans
    // an await; during that window the CLI's own `result` line for this turn can
    // land first (→ completeActiveTurn('completed') → drainQueue starts the next
    // queued turn), reassigning activeTurnId. Never complete or kill a turn this
    // interrupt did not target (§3).
    const targetTurnId = this.activeTurnId;
    const client = this.client;
    if (client && client.running) {
      const requestId = `relay-int-${++this.interruptSeq}`;
      const acked = new Promise<void>((resolve) => {
        this.pendingInterrupts.set(requestId, resolve);
      });
      client.write({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'interrupt' },
      });

      const outcome = await Promise.race([
        acked.then(() => 'ack' as const),
        this.delay(this.interruptAckMs).then(() => 'timeout' as const),
      ]);
      this.pendingInterrupts.delete(requestId);

      // The targeted turn already ended on its own during the ack window — the
      // warm child (and any newly drained turn) must be left untouched.
      if (this.activeTurnId !== targetTurnId) return;

      if (outcome === 'timeout') {
        // No receipt — fall back to the SIGTERM ladder and evict (§3).
        const dead = this.client;
        this.client = null;
        if (dead) await dead.stop().catch(() => undefined);
        if (this.activeTurnId !== targetTurnId) return;
        this.completeActiveTurn('interrupted');
        this.drainQueue();
        return;
      }
    }

    // Acked (or no live child): complete as interrupted, stay warm.
    if (this.activeTurnId !== targetTurnId) return;
    const hasQueuedFollowUp = this.queue.length > 0;
    this.completeActiveTurn('interrupted');
    // The warm child may still flush this turn's trailing lines (its `result`,
    // buffered assistant/stream_event lines) after the ack. When a queued turn
    // is about to drain onto the same child, suppress that stale tail so it is
    // not attributed to the next turn (§14).
    if (hasQueuedFollowUp) this.suppressInterruptedTail = true;
    this.drainQueue();
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    const pending = this.pendingApprovals.get(input.requestId);
    if (!pending) return;
    this.pendingApprovals.delete(input.requestId);
    this.clearStallTimer(input.requestId);
    this.settleApprovalWait();

    let inner: ClaudePermissionResponse;
    try {
      inner = claudeDecisionFromV2(input.decision, pending.suggestions);
    } catch (err) {
      logger.warn('Claude approval decision rejected, denying instead:', err);
      inner = { behavior: 'deny', message: 'Denied by user' };
    }
    this.writeControlResponse(input.requestId, inner);
    this.emitApprovalUpdated(pending, input.requestId, input.decision, 'user');
    this.emitLiveState({
      status: 'working',
      activeTurnId: pending.turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });
  }

  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    // AskUserQuestion is auto-denied on arrival while questions capability is
    // gated off (§4). No pending question resolver exists to drive here.
  }

  // ── Registry entry (GC sweep + shutdown) ───────────────────────────────────

  gcSweep(now: number): void {
    if (this._status !== 'connected') return;

    // Stuck turn → kill + error + fail (§3, §6). A turn parked in the
    // waiting-approval sub-state is NOT stuck: the approval-stall timer owns that
    // deadline (auto-deny keeps the child warm and the turn continues). Killing
    // here would preempt that graceful path, so skip while an approval is
    // outstanding — waiting time is later excluded from the budget via
    // settleApprovalWait().
    if (
      this.activeTurnId !== null &&
      this.turnStartedAtMs !== null &&
      this.pendingApprovals.size === 0 &&
      now - this.turnStartedAtMs > this.turnTimeoutMs
    ) {
      const turnId = this.activeTurnId;
      const message = `Claude turn exceeded ${this.turnTimeoutMs}ms without completing; the subprocess was terminated.`;
      const dead = this.client;
      this.client = null;
      void (dead ? dead.stop().catch(() => undefined) : Promise.resolve());
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        message,
      });
      this.completeActiveTurn('failed', undefined, message);
      this.drainQueue();
      return;
    }

    // Warm-idle eviction: kill the child, keep the adapter `connected` and the
    // claudeSessionId, emit no UI-visible patch (§3, §6).
    if (
      this.activeTurnId === null &&
      this.client &&
      this.client.running &&
      now - this.lastActivityAt > this.idleTtlMs
    ) {
      const dead = this.client;
      this.client = null;
      void dead.stop().catch(() => undefined);
    }
  }

  async forceStop(): Promise<void> {
    const dead = this.client;
    this.client = null;
    if (dead) await dead.stop().catch(() => undefined);
  }

  // ── Turn lifecycle ─────────────────────────────────────────────────────────

  private startTurn(input: AgentSendMessageInputV2): void {
    if (!this.config) {
      throw new Error('Cannot start Claude turn before connect');
    }

    // Lazy spawn / respawn (with crash-loop breaker).
    try {
      this.ensureClient();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
        message,
      });
      throw err instanceof Error ? err : new Error(message);
    }

    const startedAt = nowIso();
    this.activeTurnId = input.turnId;
    this.activeStartedAt = startedAt;
    this.turnStartedAtMs = Date.now();
    this.completedActiveTurn = false;
    this.lastActivityAt = Date.now();

    const attachmentMeta = (input.attachments ?? []).map((a) => ({
      type: a.type,
      path: a.path,
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
    }));

    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.config.sessionId,
      timestamp: startedAt,
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `user-${input.turnId}`,
        items: [],
        startedAt,
      },
    });
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: startedAt,
      turnId: input.turnId,
      item: {
        id: `user-${input.turnId}`,
        type: 'userMessage',
        text: input.content,
        ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
        status: 'completed',
        completedAt: startedAt,
      },
    });
    this.emitLiveState({
      status: 'working',
      activeTurnId: input.turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
      error: null,
    });

    const content = this.buildUserContent(input);
    this.client?.write({
      type: 'user',
      message: { role: 'user', content },
    });
  }

  /**
   * Build the user-turn content: a plain string, or an interleaved
   * text/image content-block array when image attachments are present (§8).
   * Oversized / wrong-mime images are rejected loudly with an errorMessage item;
   * remaining valid blocks still send.
   */
  private buildUserContent(
    input: AgentSendMessageInputV2
  ): string | Array<Record<string, unknown>> {
    const images = (input.attachments ?? []).filter((a) => a.type === 'image');
    if (images.length === 0) return input.content;

    const turnId = input.turnId;
    const blocks: Array<Record<string, unknown>> = [];
    if (input.content) blocks.push({ type: 'text', text: input.content });

    let lineBudget =
      MAX_STDIN_LINE_BYTES - Buffer.byteLength(input.content ?? '');
    for (const image of images) {
      const mime = mimeForAttachment(image.path, image.mimeType);
      if (!ALLOWED_IMAGE_MIMES.has(mime)) {
        this.emitErrorMessage(
          turnId,
          `Image "${image.path}" was not attached — unsupported type ${mime || 'unknown'} (allowed: png, jpeg, gif, webp).`
        );
        continue;
      }
      let base64: string;
      try {
        base64 = fs.readFileSync(image.path).toString('base64');
      } catch (err) {
        this.emitErrorMessage(
          turnId,
          `Image "${image.path}" could not be read: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      const bytes = Buffer.byteLength(base64);
      if (bytes > MAX_IMAGE_BASE64_BYTES) {
        this.emitErrorMessage(
          turnId,
          `Image "${image.path}" was not attached — exceeds the 20MB per-image limit.`
        );
        continue;
      }
      if (bytes > lineBudget) {
        this.emitErrorMessage(
          turnId,
          `Image "${image.path}" was not attached — the message would exceed the ~9.5MB stdin limit.`
        );
        continue;
      }
      lineBudget -= bytes;
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: base64 },
      });
    }

    const hasImage = blocks.some((b) => b.type === 'image');
    if (!hasImage) return input.content; // all rejected → degrade to plain string
    return blocks;
  }

  private ensureClient(): void {
    if (this.client && this.client.running) return;

    this.pruneCrashWindow(Date.now());
    if (this.crashTimestamps.length >= CRASH_BREAKER_MAX_RESPAWNS) {
      throw new Error(
        'Claude subprocess is crash-looping (3 respawns within 5 minutes); not respawning. Use "Continue here" to start a fresh session.'
      );
    }
    this.spawnClient();
  }

  private pruneCrashWindow(now: number): void {
    const windowStart = now - CRASH_BREAKER_WINDOW_MS;
    while (
      this.crashTimestamps.length > 0 &&
      this.crashTimestamps[0]! < windowStart
    ) {
      this.crashTimestamps.shift();
    }
  }

  /**
   * Record an *unexpected* child failure for the crash-loop breaker. Only
   * reached from `handleClientClose`/`handleSpawnError`, which fire solely when
   * `this.client` still points at the failing child — deliberate kills detach
   * first, so interrupt-ladder/turn-timeout/idle evictions never count here.
   */
  private recordCrash(): void {
    const now = Date.now();
    this.pruneCrashWindow(now);
    this.crashTimestamps.push(now);
  }

  private spawnClient(): void {
    if (!this.config) throw new Error('Cannot spawn Claude before connect');
    const args = this.composeArgs();
    logger.info('spawning claude subprocess', {
      sessionId: this.sessionId,
      resume: Boolean(this.claudeSessionId),
    });

    const client = new ClaudeStreamClient({
      command: 'claude',
      args,
      cwd: this.config.cwd,
      env: this.buildEnv(),
      spawn: this.spawnFn,
      ...(this.teardownDelays ? { teardownDelays: this.teardownDelays } : {}),
    });
    this.client = client;

    client.on('message', (msg: Record<string, unknown>) => {
      if (this.client !== client) return;
      try {
        this.handleWireMessage(msg);
      } catch (err) {
        logger.warn('Claude wire message handling failed:', err);
      }
    });
    client.on('close', (evt: ClaudeStreamCloseEvent) => {
      if (this.client !== client) return; // deliberate teardown detaches first
      this.handleClientClose(evt, client);
    });
    client.on('spawn-error', (err: Error) => {
      if (this.client !== client) return;
      this.handleSpawnError(err);
    });
    client.on('oversized-line', (dropped: number) => {
      logger.warn(
        'claude stdout line exceeded cap and was skipped (%d chars)',
        dropped
      );
    });

    client.start();
  }

  private composeArgs(): string[] {
    const config = this.config!;
    const args: string[] = [];
    if (USE_PRINT_FLAG) args.push('-p');
    args.push('--input-format', 'stream-json');
    args.push('--output-format', 'stream-json');
    args.push('--verbose');
    args.push('--include-partial-messages');
    args.push('--permission-prompt-tool', 'stdio');

    const mode = permissionMode(config.permissionMode) ?? 'default';
    args.push('--permission-mode', mode);

    if (config.model) args.push('--model', config.model);

    const extra = isRecord(config.extra) ? config.extra : {};
    const additionalDirs = extra.additionalDirectories;
    if (Array.isArray(additionalDirs)) {
      for (const dir of additionalDirs) {
        if (typeof dir === 'string' && dir) args.push('--add-dir', dir);
      }
    }

    if (this.claudeSessionId) args.push('--resume', this.claudeSessionId);

    args.push(...filterClaudeArgs(extra.claudeArgs));

    if (this.isYolo()) args.push('--dangerously-skip-permissions');

    return args;
  }

  private isYolo(): boolean {
    const config = this.config;
    if (!config) return false;
    if (config.permissionMode === 'bypassPermissions') return true;
    const extra = isRecord(config.extra) ? config.extra : {};
    return extra.yolo === true;
  }

  private buildEnv(): Record<string, string> {
    const env = cleanEnv(); // strips CLAUDECODE (nesting rule)
    delete env.CLAUDE_CODE_ENTRYPOINT; // avoid inheriting a stale value
    return env;
  }

  // ── Close / crash handling ─────────────────────────────────────────────────

  private handleClientClose(
    evt: ClaudeStreamCloseEvent,
    client: ClaudeStreamClient
  ): void {
    const stderrTail = client.stderrTail;
    this.client = null;
    // This handler only runs for an unexpected exit (deliberate kills detach
    // `this.client` first and are filtered out by the caller's identity guard),
    // so every close reaching here is a crash for the breaker.
    this.recordCrash();

    if (this.activeTurnId !== null && !this.completedActiveTurn) {
      const turnId = this.activeTurnId;
      const exit = evt.signal
        ? `signal ${evt.signal}`
        : `code ${evt.code ?? 'unknown'}`;
      const tail = stderrTail ? `\n${stderrTail}` : '';
      const message = `Claude subprocess exited (${exit}) before completing the turn.${tail}`;
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        message,
      });
      this.completeActiveTurn('failed', undefined, message);
      this.drainQueue();
      return;
    }
    // Idle close (process died on its own) — silent; next send respawns with
    // --resume against the stored claudeSessionId.
  }

  private handleSpawnError(err: Error): void {
    this.client = null;
    this.recordCrash();
    const enoent =
      /ENOENT/.test(err.message) ||
      (err as NodeJS.ErrnoException).code === 'ENOENT';
    const message = enoent
      ? 'claude CLI not found on PATH — install Claude Code and run `claude login`.'
      : `Failed to spawn claude: ${err.message}`;

    if (this.activeTurnId !== null && !this.completedActiveTurn) {
      const turnId = this.activeTurnId;
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        message,
      });
      this.completeActiveTurn('failed', undefined, message);
      this.drainQueue();
    } else {
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        message,
      });
    }
  }

  // ── Wire message router (stdout line → AgentPatchV2) ───────────────────────

  private handleWireMessage(message: Record<string, unknown>): void {
    logger.trace('claude wire %s', safeJson(message));

    const type = stringField(message.type);

    // Drain an interrupted turn's stale tail off the warm child (§14). The tail
    // ends at the aborted turn's terminal `result` (dropped) or, defensively, at
    // the next turn's fresh `init` (which belongs to the drained turn and is
    // processed normally). Everything between is the aborted turn's leftovers and
    // must not bleed into the turn now active.
    if (this.suppressInterruptedTail) {
      if (type === 'system' && message.subtype === 'init') {
        this.suppressInterruptedTail = false;
        // fall through — this init belongs to the newly drained turn.
      } else if (type === 'result') {
        this.suppressInterruptedTail = false;
        return; // aborted turn's terminal result — drop it.
      } else if (
        type === 'assistant' ||
        type === 'user' ||
        type === 'stream_event'
      ) {
        return; // aborted turn's buffered content tail — drop it.
      }
    }

    if (type === 'system' && message.subtype === 'init') {
      this.handleInit(message);
      return;
    }
    if (type === 'system' && message.subtype === 'compact_boundary') {
      this.emitCompaction(message);
      return;
    }
    if (type === 'control_request') {
      this.handleControlRequest(message);
      return;
    }
    if (type === 'control_response') {
      this.handleControlResponse(message);
      return;
    }
    if (type === 'assistant') {
      if (this.activeTurnId === null) return;
      this.handleAssistantMessage(this.activeTurnId, message);
      return;
    }
    if (type === 'user') {
      if (this.activeTurnId === null) return;
      this.handleUserToolResults(this.activeTurnId, message);
      return;
    }
    if (type === 'result') {
      this.handleResult(message);
      return;
    }
    if (type === 'stream_event') {
      if (this.activeTurnId !== null) {
        this.handleStreamEvent(this.activeTurnId, message);
      }
      return;
    }

    if (this.activeTurnId !== null) {
      this.emitProviderExtension(
        this.activeTurnId,
        message,
        claudeEventVisibility(message)
      );
    }
  }

  private handleInit(message: Record<string, unknown>): void {
    const sessionId = stringField(message.session_id);
    if (sessionId && sessionId !== this.claudeSessionId) {
      this.claudeSessionId = sessionId;
      this.emitSessionUpdate({
        providerSession: { claudeSessionId: sessionId },
      });
    }
    // init is re-emitted every turn — only surface slash commands once.
    if (!this.slashCommandsEmitted && Array.isArray(message.slash_commands)) {
      this.slashCommandsEmitted = true;
      this.emitSessionUpdate({
        slashCommands: slashCommandsFromInit(message.slash_commands),
      });
    }
  }

  private handleResult(message: Record<string, unknown>): void {
    if (this.activeTurnId === null) return;
    const turnId = this.activeTurnId;

    const sessionId = stringField(message.session_id);
    if (sessionId && sessionId !== this.claudeSessionId) {
      this.claudeSessionId = sessionId;
      this.emitSessionUpdate({
        providerSession: { claudeSessionId: sessionId },
      });
    }

    const usage = usageFromResult(message);
    if (message.subtype !== 'success' || message.is_error === true) {
      const errors = Array.isArray(message.errors)
        ? message.errors.join('\n')
        : stringField(message.error, 'Claude turn failed');
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        message: errors,
      });
      this.completeActiveTurn('failed', usage, errors);
    } else {
      this.completeActiveTurn('completed', usage);
    }
    this.lastActivityAt = Date.now();
    this.drainQueue();
  }

  /**
   * Compose a text/thinking stream-item id that folds in the per-API-message
   * provider message id. The Anthropic content_block `index` restarts at 0 on
   * every `message_start`, so a turn with two assistant messages (the normal
   * text → tool_use → tool_result → text shape) would otherwise reuse
   * `msg-<turnId>-0`; the reducer upserts by id and the first message's text
   * would be destroyed. The message id disambiguates. When no message id was
   * captured (non-streaming path) it falls back to the bare index — a single
   * assistant message per turn never collides. handleStreamEvent passes the
   * live `streamProviderMessageId`; handleAssistantMessage passes the echo
   * message's own id, so the two id schemes align for echo-drop.
   */
  private streamItemId(
    prefix: 'msg' | 'thinking',
    turnId: string,
    messageId: string | null,
    index: number
  ): string {
    return messageId
      ? `${prefix}-${turnId}-${messageId}-${index}`
      : `${prefix}-${turnId}-${index}`;
  }

  /**
   * Echo-drop guard for `handleAssistantMessage`: has this content block already
   * been streamed? Checks the provider-id-keyed id AND the bare `${prefix}-
   * ${turnId}-${index}` id. The bare form matters when the streamed item's
   * `message_start` carried no message id (`streamProviderMessageId` null): the
   * streamed item is keyed bare while this echo carries the message's real id,
   * so the two ids diverge and — without the bare check — the echo would open a
   * SECOND channel row for one assistant message (bridge opens per item id;
   * store dedupes per source-triple), the #1181 duplicate-row defect.
   */
  private echoAlreadyStreamed(
    streamed: Set<string>,
    prefix: 'msg' | 'thinking',
    turnId: string,
    id: string,
    index: number
  ): boolean {
    if (streamed.has(id)) return true;
    const bareId = this.streamItemId(prefix, turnId, null, index);
    return streamed.has(bareId);
  }

  private handleStreamEvent(
    turnId: string,
    message: Record<string, unknown>
  ): void {
    const event = objectField(message.event);
    const eventType = stringField(event.type);

    logger.trace('stream_event %s %s', eventType, safeJson(event));

    if (eventType === 'message_start') {
      const innerMessage = objectField(event.message);
      const id = stringField(innerMessage.id);
      this.streamProviderMessageId = id || null;
      return;
    }

    if (eventType === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const block = objectField(event.content_block);
      const blockType = stringField(block.type);
      if (blockType === 'text') {
        const itemId = this.streamItemId(
          'msg',
          turnId,
          this.streamProviderMessageId,
          index
        );
        this.streamedTextItems.add(itemId);
        this.streamTextBuffers.set(itemId, '');
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id: itemId,
            text: '',
            phase: 'answer',
            status: 'running',
            startedAt: nowIso(),
            ...(this.streamProviderMessageId
              ? { providerMessageId: this.streamProviderMessageId }
              : {}),
          },
        });
      } else if (blockType === 'thinking') {
        const itemId = this.streamItemId(
          'thinking',
          turnId,
          this.streamProviderMessageId,
          index
        );
        this.streamedReasoningItems.add(itemId);
        this.streamReasoningBuffers.set(itemId, '');
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'reasoning',
            id: itemId,
            summary: '',
            visibility: 'summary',
            status: 'running',
            startedAt: nowIso(),
          },
        });
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const delta = objectField(event.delta);
      const deltaType = stringField(delta.type);
      if (deltaType === 'text_delta') {
        const itemId = this.streamItemId(
          'msg',
          turnId,
          this.streamProviderMessageId,
          index
        );
        if (!this.streamedTextItems.has(itemId)) return;
        const text = stringField(delta.text);
        const current = this.streamTextBuffers.get(itemId) ?? '';
        this.streamTextBuffers.set(itemId, current + text);
        this.emitPatch({
          type: 'agent-item-delta-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          itemId,
          delta: { text },
        });
      } else if (deltaType === 'thinking_delta') {
        const itemId = this.streamItemId(
          'thinking',
          turnId,
          this.streamProviderMessageId,
          index
        );
        if (!this.streamedReasoningItems.has(itemId)) return;
        const text = stringField(delta.thinking);
        const current = this.streamReasoningBuffers.get(itemId) ?? '';
        this.streamReasoningBuffers.set(itemId, current + text);
        this.emitPatch({
          type: 'agent-item-delta-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          itemId,
          delta: { summary: text },
        });
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const textItemId = this.streamItemId(
        'msg',
        turnId,
        this.streamProviderMessageId,
        index
      );
      const reasoningItemId = this.streamItemId(
        'thinking',
        turnId,
        this.streamProviderMessageId,
        index
      );
      if (this.streamedTextItems.has(textItemId)) {
        const text = this.streamTextBuffers.get(textItemId) ?? '';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id: textItemId,
            text,
            phase: 'answer',
            status: 'completed',
            completedAt: nowIso(),
            ...(this.streamProviderMessageId
              ? { providerMessageId: this.streamProviderMessageId }
              : {}),
          },
        });
      } else if (this.streamedReasoningItems.has(reasoningItemId)) {
        const text = this.streamReasoningBuffers.get(reasoningItemId) ?? '';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'reasoning',
            id: reasoningItemId,
            summary: text,
            visibility: 'summary',
            status: 'completed',
            completedAt: nowIso(),
          },
        });
      }
      return;
    }
  }

  private handleAssistantMessage(
    turnId: string,
    message: Record<string, unknown>
  ): void {
    // Key echo-drop by this echo message's own provider id so it matches the
    // streamed items' ids (both fold in the same message id + content-block
    // index). Without it, a turn's second assistant message would reuse the
    // first's `msg-<turnId>-0` and clobber it (§ stream item ids).
    const providerMessageId =
      stringField(objectField(message.message).id) || null;
    let blockIndex = 0;
    for (const block of contentBlocks(message)) {
      const type = block.type;
      const itemIndex = blockIndex++;
      if (type === 'text') {
        const text = stringField(block.text);
        const id = this.streamItemId(
          'msg',
          turnId,
          providerMessageId,
          itemIndex
        );
        if (
          this.echoAlreadyStreamed(
            this.streamedTextItems,
            'msg',
            turnId,
            id,
            itemIndex
          )
        ) {
          // Stream already emitted start/deltas/stop — echo-drop the duplicate.
          continue;
        }
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id,
            text: '',
            phase: 'answer',
            status: 'running',
            startedAt: nowIso(),
            providerMessageId: stringField(objectField(message.message).id),
          },
        });
        this.emitPatch({
          type: 'agent-item-delta-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          itemId: id,
          delta: { text },
        });
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id,
            text,
            phase: 'answer',
            status: 'completed',
            completedAt: nowIso(),
            providerMessageId: stringField(objectField(message.message).id),
          },
        });
      } else if (type === 'thinking') {
        const id = this.streamItemId(
          'thinking',
          turnId,
          providerMessageId,
          itemIndex
        );
        if (
          this.echoAlreadyStreamed(
            this.streamedReasoningItems,
            'thinking',
            turnId,
            id,
            itemIndex
          )
        ) {
          continue;
        }
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'reasoning',
            id,
            summary: stringField(block.thinking ?? block.text ?? block.summary),
            visibility: 'summary',
            status: 'completed',
            completedAt: nowIso(),
          },
        });
      } else if (type === 'tool_use') {
        this.emitToolUse(turnId, block);
      } else {
        this.emitProviderExtension(turnId, block, 'debug');
      }
    }
  }

  private handleUserToolResults(
    turnId: string,
    message: Record<string, unknown>
  ): void {
    const toolUseResult = message.tool_use_result;
    for (const block of contentBlocks(message)) {
      if (stringField(block.type) !== 'tool_result') continue;
      const toolUseId = stringField(block.tool_use_id);
      if (!toolUseId) continue;
      const tracked = this.activeToolUses.get(toolUseId);
      if (!tracked) {
        this.emitProviderExtension(turnId, block, 'debug');
        continue;
      }
      this.activeToolUses.delete(toolUseId);
      const isError = block.is_error === true;
      const completedAt = nowIso();
      const resultText = toolResultText(block.content);

      if (tracked.kind === 'file') {
        const result = isRecord(toolUseResult) ? toolUseResult : {};
        const patch = patchFromFileResult(result);
        const paths = pathsFromFileResult(result, tracked.paths ?? []);
        const applyStatus = isError ? 'failed' : 'applied';
        const status = isError ? 'failed' : 'completed';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: completedAt,
          turnId,
          item: {
            type: 'fileChange',
            id: `file-${toolUseId}`,
            providerItemId: toolUseId,
            paths,
            ...(patch ? { patch } : {}),
            applyStatus,
            status,
            completedAt,
          },
        });
        continue;
      }

      if (tracked.kind === 'exec') {
        const result = isRecord(toolUseResult) ? toolUseResult : {};
        const stdout = stringField(result.stdout);
        const stderr = stringField(result.stderr);
        const output = stdout || stderr || resultText;
        const status = isError ? 'failed' : 'completed';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: completedAt,
          turnId,
          item: {
            type: 'commandExecution',
            id: `exec-${toolUseId}`,
            providerItemId: toolUseId,
            command: tracked.command ?? '',
            output,
            ...(typeof result.interrupted === 'boolean'
              ? { interactive: result.interrupted }
              : {}),
            status,
            completedAt,
          },
        });
        continue;
      }

      if (tracked.kind === 'mcp') {
        const status = isError ? 'failed' : 'completed';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: completedAt,
          turnId,
          item: {
            type: 'mcpToolCall',
            id: `mcp-${toolUseId}`,
            providerItemId: toolUseId,
            server: tracked.server ?? 'unknown',
            tool: tracked.tool ?? tracked.toolName,
            arguments: tracked.input,
            ...(toolUseResult !== undefined ? { result: toolUseResult } : {}),
            ...(resultText ? { progress: resultText } : {}),
            status,
            completedAt,
          },
        });
        continue;
      }

      const status = isError ? 'failed' : 'completed';
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.sessionId,
        timestamp: completedAt,
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: `tool-${toolUseId}`,
          providerItemId: toolUseId,
          namespace: 'claude',
          tool: tracked.toolName,
          arguments: tracked.input,
          ...(toolUseResult !== undefined ? { result: toolUseResult } : {}),
          ...(resultText ? { content: resultText } : {}),
          status,
          completedAt,
        },
      });
    }
  }

  private emitToolUse(turnId: string, block: Record<string, unknown>): void {
    const toolUseId = stringField(block.id, `unknown-${Date.now()}`);
    const name = stringField(block.name, 'unknown');
    const input = objectField(block.input);

    if (name === 'Bash') {
      const command = stringField(input.command, JSON.stringify(input));
      this.activeToolUses.set(toolUseId, {
        kind: 'exec',
        toolName: name,
        input,
        command,
      });
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        item: {
          type: 'commandExecution',
          id: `exec-${toolUseId}`,
          providerItemId: toolUseId,
          command,
          output: '',
          status: 'running',
          startedAt: nowIso(),
        },
      });
      return;
    }

    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
      const paths = filePathsFromToolInput(input);
      this.activeToolUses.set(toolUseId, {
        kind: 'file',
        toolName: name,
        input,
        paths,
      });
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        item: {
          type: 'fileChange',
          id: `file-${toolUseId}`,
          providerItemId: toolUseId,
          paths,
          applyStatus: 'pending',
          status: 'pending',
          startedAt: nowIso(),
        },
      });
      return;
    }

    const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
    if (mcpMatch) {
      const server = mcpMatch[1] ?? 'unknown';
      const tool = mcpMatch[2] ?? name;
      this.activeToolUses.set(toolUseId, {
        kind: 'mcp',
        toolName: name,
        input,
        server,
        tool,
      });
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        item: {
          type: 'mcpToolCall',
          id: `mcp-${toolUseId}`,
          providerItemId: toolUseId,
          server,
          tool,
          arguments: input,
          status: 'running',
          startedAt: nowIso(),
        },
      });
      return;
    }

    this.activeToolUses.set(toolUseId, {
      kind: 'dynamic',
      toolName: name,
      input,
    });
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'dynamicToolCall',
        id: `tool-${toolUseId}`,
        providerItemId: toolUseId,
        namespace: 'claude',
        tool: name,
        arguments: input,
        status: 'running',
        startedAt: nowIso(),
      },
    });
  }

  // ── Approvals / questions / dialogs (control_request) ──────────────────────

  private handleControlRequest(message: Record<string, unknown>): void {
    const requestId = stringField(message.request_id);
    if (!requestId) return;
    const request = objectField(message.request);
    const subtype = stringField(request.subtype);

    if (subtype === 'can_use_tool') {
      const toolName = stringField(request.tool_name ?? request.toolName);
      const input = objectField(request.input ?? request.tool_input);
      const suggestions = Array.isArray(request.permission_suggestions)
        ? request.permission_suggestions
        : Array.isArray(request.suggestions)
          ? request.suggestions
          : undefined;
      if (toolName === 'AskUserQuestion') {
        this.handleAskUserQuestion(requestId, request);
        return;
      }
      this.emitApprovalRequest(requestId, toolName, input, suggestions);
      return;
    }

    // Unanswered dialogs/elicitations wedge the subprocess — always auto-cancel
    // in slice 1 while the payloads are unproven (§4).
    if (subtype === 'request_user_dialog') {
      if (this.activeTurnId !== null)
        this.emitProviderExtension(this.activeTurnId, message, 'debug');
      this.writeControlResponse(requestId, 'cancelled');
      return;
    }
    if (subtype === 'elicitation') {
      if (this.activeTurnId !== null)
        this.emitProviderExtension(this.activeTurnId, message, 'debug');
      this.writeControlResponse(requestId, 'cancel');
      return;
    }

    if (this.activeTurnId !== null) {
      this.emitProviderExtension(this.activeTurnId, message, 'debug');
    }
  }

  private handleControlResponse(message: Record<string, unknown>): void {
    const response = objectField(message.response);
    const requestId =
      stringField(message.request_id) || stringField(response.request_id);
    if (requestId && this.pendingInterrupts.has(requestId)) {
      const resolve = this.pendingInterrupts.get(requestId)!;
      this.pendingInterrupts.delete(requestId);
      resolve();
      return;
    }
    if (this.activeTurnId !== null) {
      this.emitProviderExtension(this.activeTurnId, message, 'trace');
    }
  }

  private emitApprovalRequest(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    suggestions: unknown[] | undefined
  ): void {
    const turnId = this.activeTurnId ?? 'turn-unknown';
    const target = targetFromToolInput(toolName, input);
    const startedAt = nowIso();

    // Entering the waiting-approval sub-state — start the wait clock on the
    // transition from zero outstanding approvals so its elapsed time can later be
    // excluded from the turn-timeout budget (§6).
    if (
      this.pendingApprovals.size === 0 &&
      this.approvalWaitStartedMs === null
    ) {
      this.approvalWaitStartedMs = Date.now();
    }
    this.pendingApprovals.set(requestId, {
      turnId,
      toolName,
      target,
      ...(suggestions ? { suggestions } : {}),
    });

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: startedAt,
      turnId,
      item: {
        type: 'approval',
        id: `approval-${requestId}`,
        requestId,
        kind: 'permission',
        description: `Claude wants to use ${toolName}`,
        target,
        supported: CLAUDE_APPROVAL_SUPPORT,
        status: 'pending',
        startedAt,
      },
    });
    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [requestId],
      queueLength: this.queue.length,
    });

    const timer = setTimeout(
      () => this.autoDenyApproval(requestId),
      this.approvalStallMs
    );
    timer.unref?.();
    this.approvalStallTimers.set(requestId, timer);
  }

  private autoDenyApproval(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    this.clearStallTimer(requestId);
    this.settleApprovalWait();
    this.writeControlResponse(requestId, {
      behavior: 'deny',
      message: 'Approval request timed out',
    });
    this.emitApprovalUpdated(
      pending,
      requestId,
      { kind: 'decline' },
      'timeout'
    );
    this.emitLiveState({
      status: 'working',
      activeTurnId: pending.turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });
  }

  private handleAskUserQuestion(
    requestId: string,
    request: Record<string, unknown>
  ): void {
    const turnId = this.activeTurnId ?? 'turn-unknown';
    const questionText = stringField(
      request.question,
      'Claude asked a question'
    );
    const startedAt = nowIso();
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: startedAt,
      turnId,
      item: {
        type: 'question',
        id: `question-${requestId}`,
        requestId,
        question: questionText,
        status: 'completed',
        startedAt,
        completedAt: startedAt,
      },
    });
    // Questions are gated off in slice 1 — deny so the subprocess is not wedged.
    this.writeControlResponse(requestId, {
      behavior: 'deny',
      message: 'Interactive questions are not yet supported in web sessions.',
    });
  }

  private emitApprovalUpdated(
    pending: PendingApproval,
    requestId: string,
    decision: AgentApprovalDecisionV2,
    respondedBy: 'user' | 'timeout'
  ): void {
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId: pending.turnId,
      item: {
        type: 'approval',
        id: `approval-${requestId}`,
        requestId,
        kind: 'permission',
        description: `Claude wants to use ${pending.toolName}`,
        target: pending.target,
        ...(pending.detail ? { detail: pending.detail } : {}),
        supported: CLAUDE_APPROVAL_SUPPORT,
        decision,
        respondedBy,
        status: 'completed',
        completedAt: nowIso(),
      },
    });
  }

  /**
   * Write a control_response. WIRE INVARIANT: `request_id` nests inside
   * `response`; top-level placement is silently ignored and stalls the turn
   * forever (§4). Never move it out.
   */
  private writeControlResponse(requestId: string, inner: unknown): void {
    this.client?.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: inner,
      },
    });
  }

  private clearStallTimer(requestId: string): void {
    const timer = this.approvalStallTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.approvalStallTimers.delete(requestId);
    }
  }

  private clearPendingApprovals(): void {
    for (const timer of this.approvalStallTimers.values()) clearTimeout(timer);
    this.approvalStallTimers.clear();
    this.pendingApprovals.clear();
  }

  /**
   * Close out the waiting-approval sub-state once the last outstanding approval
   * resolves: roll the turn-start clock forward by the time spent waiting on a
   * human so that deliberation never counts against the turn-timeout budget
   * (§6). No-op while approvals are still outstanding.
   */
  private settleApprovalWait(): void {
    if (this.approvalWaitStartedMs === null) return;
    if (this.pendingApprovals.size > 0) return;
    if (this.turnStartedAtMs !== null) {
      this.turnStartedAtMs += Date.now() - this.approvalWaitStartedMs;
    }
    this.approvalWaitStartedMs = null;
  }

  /**
   * Resolve any approval cards still outstanding when a turn ends abnormally
   * (crash / timeout / interrupt). Without this the started `approval` item stays
   * `status:'pending'` forever, showing live-looking Allow/Deny controls inside a
   * dead turn whose respondToApproval would no-op (§7). Emits a terminal update
   * per item before the pending map is cleared; a no-op on a clean completion
   * (approvals always resolve before a successful `result`).
   */
  private cancelPendingApprovalItems(): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId: pending.turnId,
        item: {
          type: 'approval',
          id: `approval-${requestId}`,
          requestId,
          kind: 'permission',
          description: `Claude wants to use ${pending.toolName}`,
          target: pending.target,
          ...(pending.detail ? { detail: pending.detail } : {}),
          supported: CLAUDE_APPROVAL_SUPPORT,
          decision: { kind: 'decline' },
          respondedBy: 'timeout',
          status: 'cancelled',
          completedAt: nowIso(),
        },
      });
    }
  }

  // ── Turn completion / queue ────────────────────────────────────────────────

  private completeActiveTurn(
    status: 'completed' | 'interrupted' | 'failed',
    usage?: AgentUsageV2,
    error?: string
  ): void {
    if (this.completedActiveTurn || this.activeTurnId === null) return;
    this.completedActiveTurn = true;
    // Mark any still-pending approval cards resolved BEFORE the turn-completed
    // frame and the pending-map clear, so no live-looking Allow/Deny controls
    // linger inside a turn that has ended (§7).
    this.cancelPendingApprovalItems();
    const turnId = this.activeTurnId;
    const completedAt = nowIso();
    const durationMs = this.activeStartedAt
      ? Date.now() - Date.parse(this.activeStartedAt)
      : undefined;

    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sessionId,
      timestamp: completedAt,
      turnId,
      status,
      completedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(error !== undefined ? { error } : {}),
    });

    this.activeTurnId = null;
    this.activeStartedAt = null;
    this.turnStartedAtMs = null;
    this.streamedTextItems.clear();
    this.streamedReasoningItems.clear();
    this.streamTextBuffers.clear();
    this.streamReasoningBuffers.clear();
    this.streamProviderMessageId = null;
    this.activeToolUses.clear();
    this.clearPendingApprovals();
    this.approvalWaitStartedMs = null;

    this.emitLiveState({
      status: this.queue.length > 0 ? 'working' : 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
      error: error ?? null,
    });
  }

  private drainQueue(): void {
    if (this._status !== 'connected' || this.activeTurnId !== null) return;
    const queued = this.queue.shift();
    if (!queued) return;
    try {
      this.startTurn(queued.input);
      queued.resolve();
    } catch (err) {
      queued.reject(err);
      // A crash-loop breaker trip fails this turn; try the next queued one so a
      // single poisoned message does not wedge the queue.
      this.drainQueue();
    }
  }

  private rejectQueued(err: unknown): void {
    const queued = this.queue.splice(0);
    for (const message of queued) message.reject(err);
    if (queued.length > 0) this.emitLiveState({ queueLength: 0 });
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  private emitSnapshot(): void {
    if (!this.config) return;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.config.sessionId,
        provider: 'claude',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        config: {
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(this.config.permissionMode
            ? { permissionMode: this.config.permissionMode }
            : {}),
        },
      }),
    });
  }

  private emitSessionUpdate(update: {
    providerSession?: Record<string, string>;
    capabilities?: AgentCapabilitySetV2;
    config?: AgentSessionUpdatedPatchV2['config'];
    slashCommands?: AgentSlashCommandV2[];
  }): void {
    this.emitPatch({
      type: 'agent-session-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      ...(update.providerSession !== undefined
        ? { providerSession: update.providerSession }
        : {}),
      ...(update.capabilities !== undefined
        ? { capabilities: update.capabilities }
        : {}),
      ...(update.config !== undefined ? { config: update.config } : {}),
      ...(update.slashCommands !== undefined
        ? { slashCommands: update.slashCommands }
        : {}),
    });
  }

  private emitCompaction(message: Record<string, unknown>): void {
    const turnId = this.activeTurnId ?? 'turn-unknown';
    const summary =
      stringField(message.summary) ||
      stringField(objectField(message.compact_metadata).trigger) ||
      'Context compacted';
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'compaction',
        id: `compaction-${turnId}-${++this.providerExtensionSeq}`,
        summary,
        status: 'completed',
        startedAt: nowIso(),
        completedAt: nowIso(),
      },
    });
  }

  private emitErrorMessage(turnId: string, message: string): void {
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'errorMessage',
        id: `error-${turnId}-${++this.providerExtensionSeq}`,
        message,
        source: 'agent',
        status: 'completed',
        startedAt: nowIso(),
        completedAt: nowIso(),
      },
    });
  }

  private emitProviderExtension(
    turnId: string,
    payload: Record<string, unknown>,
    visibility: ClaudeEventVisibility = 'normal'
  ): void {
    const seq = ++this.providerExtensionSeq;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'providerExtension',
        id: `ext-claude-${turnId}-${seq}`,
        namespace: 'claude',
        payload,
        ...(visibility === 'normal'
          ? {}
          : { metadata: { eventVisibility: visibility } }),
        status: 'completed',
        startedAt: nowIso(),
        completedAt: nowIso(),
      },
    });
  }

  private emitLiveState(live: Partial<AgentSessionLiveStateV2>): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      live,
    });
  }

  private applyRuntimeParams(config: AdapterConfig): void {
    const extra = isRecord(config.extra) ? config.extra : {};
    this.idleTtlMs = numberOr(extra.idleTtlMs, DEFAULT_IDLE_TTL_MS);
    this.turnTimeoutMs = numberOr(extra.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.approvalStallMs = numberOr(
      extra.approvalStallMs,
      DEFAULT_APPROVAL_STALL_MS
    );
    this.interruptAckMs = numberOr(
      extra.interruptAckMs,
      DEFAULT_INTERRUPT_ACK_MS
    );
    const afterStdinMs = extra.teardownAfterStdinMs;
    const afterSigtermMs = extra.teardownAfterSigtermMs;
    this.teardownDelays =
      typeof afterStdinMs === 'number' || typeof afterSigtermMs === 'number'
        ? {
            ...(typeof afterStdinMs === 'number' ? { afterStdinMs } : {}),
            ...(typeof afterSigtermMs === 'number' ? { afterSigtermMs } : {}),
          }
        : undefined;
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? 'claude-v2-session';
  }
}
