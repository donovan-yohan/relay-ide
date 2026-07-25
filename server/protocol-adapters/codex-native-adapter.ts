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
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexNotification,
  type CodexServerRequest,
} from '../codex-app-server-client.js';
import { createLogger } from '../logger.js';
import fs from 'node:fs';
import path from 'node:path';

const logger = createLogger('codex-native-adapter');

type CodexTurnInput =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string };

/**
 * Convert Relay's established local-path image attachment lane to the Codex
 * app-server v2 `UserInput` contract. Channel image payloads are always local
 * content-addressed files; URL fetching is deliberately out of scope here.
 * Any attachment that cannot be represented stays visible as a text note.
 */
export function buildCodexTurnInput(
  content: string,
  attachments: AgentSendMessageInputV2['attachments'] = []
): CodexTurnInput[] {
  const inputs: CodexTurnInput[] = [{ type: 'text', text: content }];
  const unavailable: string[] = [];

  for (const attachment of attachments) {
    if (attachment.type !== 'image') continue;
    const localPath = attachment.path;
    let usable = path.isAbsolute(localPath);
    if (usable) {
      try {
        usable = fs.statSync(localPath).isFile();
      } catch {
        usable = false;
      }
    }
    if (usable) {
      inputs.push({ type: 'localImage', path: localPath });
    } else {
      unavailable.push(path.basename(localPath) || 'image');
    }
  }

  if (unavailable.length > 0) {
    const text = inputs[0];
    if (text?.type === 'text') {
      text.text += unavailable
        .map(
          (name) => `\n\n[Relay image attachment unavailable to Codex: ${name}]`
        )
        .join('');
    }
  }
  return inputs;
}

// ── Web-session capability status ──────────────────────────────────────────
//
// Codex web sessions are advertised (`supportsWebSessions: true` in
// `server/types.ts`) as of #1169 (closes #301). This adapter drives the native
// `codex app-server` JSON-RPC transport (server/codex-app-server-client.ts) and
// maps assistant text end-to-end into the V2 chat protocol:
//   - `item/started` (agentMessage) → `agent-item-started-v2` (assistantMessage)
//   - `item/agentMessage/delta`     → `agent-item-delta-v2` `{ delta: { text } }`
//   - `item/completed` (agentMessage) → `agent-item-updated-v2` (final text)
//   - `turn/completed`              → `agent-turn-completed-v2`
// alongside reasoning deltas, tool/command/file-change items, and approvals.
//
// The round-trip (prompt submitted → text-delta stream → completion patch) is
// covered by the fake-app-server unit suite in
// test/server/protocol-adapters/codex-native-adapter.test.ts (no real codex
// invocations), and was validated once against the real logged-in `codex` CLI
// via test/manual/codex-live-proof.mjs. The old `chat:text-delta` gap belonged
// to the retired hook-based `codex-adapter.ts`, not this native adapter.

// ── Capability set ─────────────────────────────────────────────────────────

const CODEX_CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: true,
  plans: true,
  slashCommands: true,
  queue: true,
  cancelQueued: true,
  interrupt: true,
  resume: true,
  fork: true,
  rollback: true,
  compact: true,
  telemetry: true,
  rateLimits: true,
  streaming: true,
};

// ── Relay-owned bake-ins ───────────────────────────────────────────────────

const RELAY_CODEX_COMMANDS: AgentSlashCommandV2[] = [
  {
    id: 'relay:clear',
    name: 'new',
    aliases: ['clear', 'reset'],
    description: 'Start a fresh Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'clear',
  },
  {
    id: 'relay:resume',
    name: 'continue',
    aliases: ['resume'],
    description: 'Resume a saved Codex thread by id',
    argumentHint: '<threadId>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'resume',
  },
  {
    id: 'relay:model',
    name: 'model',
    description: 'Switch model for subsequent Codex responses',
    argumentHint: '<model>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'model',
  },
  {
    id: 'relay:compact',
    name: 'compact',
    description: 'Compact the current Codex thread context',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'compact',
  },
  {
    id: 'relay:rollback',
    name: 'rollback',
    description: 'Roll back N turns in the current thread',
    argumentHint: '<n>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'rollback',
  },
  {
    id: 'relay:archive',
    name: 'archive',
    description: 'Archive the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'archive',
  },
  {
    id: 'relay:unarchive',
    name: 'unarchive',
    description: 'Unarchive the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'unarchive',
  },
  {
    id: 'relay:goal',
    name: 'goal',
    description: 'Get, set, or clear the goal for the current thread',
    argumentHint: 'set <text> | get | clear',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'goal',
  },
  {
    id: 'relay:review',
    name: 'review',
    description: 'Enter review mode for the current thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'review',
  },
  {
    id: 'relay:fork',
    name: 'fork',
    description: 'Fork the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'fork',
  },
];

// ── Approval support shapes ────────────────────────────────────────────────

const CODEX_COMMAND_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once', 'session'],
  amendmentTypes: ['execpolicy', 'networkPolicy'],
  canCancel: true,
};

const CODEX_PATCH_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once', 'session'],
  amendmentTypes: [],
  canCancel: true,
};

const CODEX_PERMISSIONS_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['session', 'turn'],
  amendmentTypes: [],
  canCancel: true,
};

const CODEX_ELICITATION_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once'],
  amendmentTypes: [],
  canCancel: true,
};

// ── Helpers ────────────────────────────────────────────────────────────────

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

function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Flatten Codex's reasoning arrays into a single string. Current app-server
 * emits `string[]`; older versions used `{ type, text }[]` entries.
 */
function flattenReasoningTextEntries(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : isRecord(entry)
          ? stringField(entry['text'])
          : ''
    )
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function normalizeSkill(
  skill: Record<string, unknown>,
  cwd: string
): AgentSlashCommandV2 {
  const name = stringField(skill['name']);
  return {
    id: `skill:${cwd}:${name}`,
    name,
    description: stringField(skill['description'] ?? skill['description'], ''),
    ...(typeof skill['argumentHint'] === 'string' &&
    skill['argumentHint'].length > 0
      ? { argumentHint: skill['argumentHint'] }
      : {}),
    source: 'skill',
    sourceLabel: 'Codex Skill',
    dispatch: 'agent',
    collisionKey: name.toLowerCase(),
    nativePrefix: '$' as const,
  };
}

/**
 * Merge skills + relay bake-ins into one catalog.
 * Native bake-ins take precedence over skills with the same collisionKey.
 */
function mergeCodexCommandCatalog(
  skills: AgentSlashCommandV2[],
  nativeBakeIns: AgentSlashCommandV2[]
): AgentSlashCommandV2[] {
  const byKey = new Map<string, AgentSlashCommandV2>();

  // Skills first (lower priority)
  for (const skill of skills) {
    const key = (skill.collisionKey ?? skill.name).toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, skill);
    }
  }

  // Bake-ins win on collision
  for (const cmd of nativeBakeIns) {
    const key = (cmd.collisionKey ?? cmd.name).toLowerCase();
    byKey.set(key, cmd);
  }

  return [...byKey.values()];
}

/**
 * V2 decision → codex native CommandExecutionApprovalDecision wire form.
 *
 * Unit variants serialize as bare strings: "accept", "acceptForSession",
 * "decline", "cancel".
 * Data variants serialize as wrapped objects (externally tagged):
 *   { acceptWithExecpolicyAmendment: { execpolicyAmendment: payload } }
 *   { applyNetworkPolicyAmendment: { networkPolicyAmendment: payload } }
 *
 * Returns the { decision } wrapper so callers can spread it directly.
 * Throws for unsupported combinations.
 */
function codexCommandDecisionResponse(
  decision: AgentApprovalDecisionV2
): Record<string, unknown> {
  if (decision.kind === 'cancel') return { decision: 'cancel' };
  if (decision.kind === 'decline') return { decision: 'decline' };

  // kind === 'accept'
  const scope = decision.scope ?? 'once';
  const amendments =
    (decision as { amendments?: Array<{ type: string; payload?: unknown }> })
      .amendments ?? [];

  const execAmend = amendments.find((a) => a.type === 'execpolicy');
  if (execAmend) {
    return {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicyAmendment: execAmend.payload ?? {},
        },
      },
    };
  }

  const netAmend = amendments.find((a) => a.type === 'networkPolicy');
  if (netAmend) {
    return {
      decision: {
        applyNetworkPolicyAmendment: {
          networkPolicyAmendment: netAmend.payload ?? {},
        },
      },
    };
  }

  if (scope === 'session') return { decision: 'acceptForSession' };
  return { decision: 'accept' }; // 'once' or 'permanent' → accept
}

/**
 * V2 decision → codex FileChangeApprovalDecision response.
 * All variants are unit (bare strings): accept, acceptForSession, decline, cancel.
 */
function codexFileDecisionResponse(
  decision: AgentApprovalDecisionV2
): Record<string, unknown> {
  if (decision.kind === 'cancel') return { decision: 'cancel' };
  if (decision.kind === 'decline') return { decision: 'decline' };
  const scope = decision.scope ?? 'once';
  if (scope === 'session') return { decision: 'acceptForSession' };
  return { decision: 'accept' };
}

/**
 * For permissions grants, the response shape is { scope, permissions[] } rather
 * than a string decision.
 */
function codexPermissionsResponse(
  decision: AgentApprovalDecisionV2,
  originalPermissions: string[]
): Record<string, unknown> {
  if (decision.kind === 'cancel' || decision.kind === 'decline') {
    return { scope: 'turn', permissions: [] };
  }
  const scope = (decision.scope === 'session' ? 'session' : 'turn') as string;
  return { scope, permissions: originalPermissions };
}

// ── Queued message ────────────────────────────────────────────────────────

interface QueuedCodexMessage {
  input: AgentSendMessageInputV2;
  resolve: () => void;
  reject: (err: unknown) => void;
}

// ── Pending approval ──────────────────────────────────────────────────────

type ApprovalKind = 'command' | 'patch' | 'permissions' | 'elicitation';

interface PendingApproval {
  kind: ApprovalKind;
  nativeRequestId: number | string;
  permissions?: string[];
}

// ── Pending input request ─────────────────────────────────────────────────

interface PendingInputRequest {
  nativeRequestId: number | string;
}

// ── Factory type ─────────────────────────────────────────────────────────

export type CodexClientFactory = (
  options: CodexAppServerClientOptions
) => CodexAppServerClient;

/**
 * Native Codex can notify `turn/completed` before the last agentMessage's
 * `item/completed`. Keep the Relay turn alive briefly so that terminal output
 * item remains observable (and durably persisted by channel listeners) before
 * teardown clears native item identity.
 */
export const CODEX_TERMINAL_ITEM_GRACE_MS = 250;

interface DeferredTurnCompletion {
  status: 'completed';
  usage?: AgentUsageV2;
  error?: string;
  nativeDurationMs?: number;
  timer: NodeJS.Timeout;
}

// ── Main adapter class ─────────────────────────────────────────────────────

export class CodexNativeProtocolAdapter extends BaseProtocolAdapterV2 {
  readonly agentType = 'codex';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CODEX_CAPABILITIES;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: CodexAppServerClient | null = null;
  private readonly clientFactory: CodexClientFactory;

  // Provider session
  private providerSessionId: string | null = null;

  // Turn management
  private activeTurnId: string | null = null;
  private nativeActiveTurnId: string | null = null;
  private activeStartedAt: string | null = null;
  private completedActiveTurn = false;
  private readonly queue: QueuedCodexMessage[] = [];

  // Pending approvals keyed by relay item id (e.g. "approval-{requestId}")
  private readonly pendingApprovals = new Map<
    string,
    (decision: AgentApprovalDecisionV2) => void
  >();
  private readonly approvalMeta = new Map<string, PendingApproval>();

  // Pending input requests keyed by relay item id
  private readonly pendingInputRequests = new Map<
    string,
    (response: { answers: Record<string, string[]> }) => void
  >();
  private readonly inputRequestMeta = new Map<string, PendingInputRequest>();

  // Item tracking
  private providerExtensionSeq = 0;
  private readonly itemMap = new Map<string, string>(); // nativeItemId → relayItemId
  private readonly openAgentMessageNativeIds = new Set<string>();
  private readonly openReasoningByRelayId = new Map<string, string>();
  private deferredTurnCompletion: DeferredTurnCompletion | null = null;
  private readonly toolArgumentsByNativeId = new Map<
    string,
    Record<string, unknown>
  >();
  private pendingModelOverride: string | null = null;

  // Reasoning streaming buffers, keyed by relayItemId. Used to preserve the
  // accumulated text when item/completed arrives with an empty or
  // structured-but-unflattened payload (codex's ReasoningItem ships
  // `summary: Vec<{type, text}>` and optional `content: Vec<{type, text}>`).
  private readonly reasoningSummaryBuffers = new Map<string, string>();
  private readonly reasoningDetailBuffers = new Map<string, string>();

  // Token usage buffer: keyed by native turnId, from thread/tokenUsageUpdated
  private readonly tokenUsageBuffer = new Map<
    string,
    Record<string, unknown>
  >();

  // Slash commands
  private slashCommandsLoaded = false;

  constructor(clientFactory?: CodexClientFactory) {
    super();
    this.clientFactory =
      clientFactory ?? ((opts) => new CodexAppServerClient(opts));
  }

  get status(): AdapterStatus {
    return this._status;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    const client = this.createClient(config);
    this.client = client;

    this.wireClientEvents(client);

    await client.start();

    const threadResult = await client.call<{ thread: { id: string } }>(
      'thread/start',
      {
        cwd: config.cwd,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ...(config.model || this.pendingModelOverride
          ? { model: this.pendingModelOverride ?? config.model }
          : {}),
      }
    );

    this.providerSessionId = threadResult.thread.id;
    this._status = 'connected';
    this.slashCommandsLoaded = false;

    this.emitSnapshot();
    this.emitLiveState({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: 0,
      fastModeAvailable: false,
      error: null,
    });

    void this.refreshSlashCommands(config.cwd);
  }

  async resumeSession(threadId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = this.config;

    // Tear down existing state
    await this.teardownState();

    const client = this.createClient(config);
    this.client = client;
    this.wireClientEvents(client);

    await client.start();

    const threadResult = await client.call<{
      thread: { id: string; turns?: unknown[] };
    }>('thread/resume', { threadId, excludeTurns: false });

    this.providerSessionId = threadResult.thread.id ?? threadId;
    this._status = 'connected';
    this.slashCommandsLoaded = false;

    // Emit snapshot reflecting the resumed thread.
    // We materialize any turns from the response as completed items.
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: config.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: config.sessionId,
        provider: 'codex',
        cwd: config.cwd,
        capabilities: { ...this.capabilities, resume: true },
        providerSession: { threadId: this.providerSessionId },
        config: {
          ...(config.model ? { model: config.model } : {}),
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
      fastModeAvailable: false,
      error: null,
    });

    void this.refreshSlashCommands(config.cwd);
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    await this.teardownState();
  }

  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('Cannot reconnect before connect');
    const config = this.config;
    await this.disconnect();
    await this.connect(config);
  }

  // ── Message sending ───────────────────────────────────────────────────────

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    if (this._status !== 'connected') {
      throw new Error('Cannot send a Codex message before connect');
    }

    const rewritten = this.rewriteContent(input.content);

    // Check if this is a relay-control dispatch
    const controlAction = this.extractControlAction(rewritten);
    if (controlAction !== null) {
      await this.handleControlAction(controlAction.action, controlAction.arg);
      return;
    }

    const rewrittenInput: AgentSendMessageInputV2 = {
      ...input,
      content: rewritten,
    };

    if (this.activeTurnId !== null) {
      return new Promise((resolve, reject) => {
        this.queue.push({ input: rewrittenInput, resolve, reject });
        this.emitLiveState({
          status: 'working',
          activeTurnId: this.activeTurnId,
          queueLength: this.queue.length,
        });
      });
    }

    await this.startTurn(rewrittenInput);
  }

  async interrupt(_input: AgentInterruptInputV2): Promise<void> {
    if (this.nativeActiveTurnId !== null && this.client !== null) {
      try {
        await this.client.call('turn/interrupt', {
          threadId: this.providerSessionId,
          turnId: this.nativeActiveTurnId,
        });
      } catch (err) {
        logger.warn('Codex turn/interrupt failed:', err);
      }
      // turn/completed with 'interrupted' status arrives via notification
    }
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    const resolver = this.pendingApprovals.get(input.requestId);
    if (!resolver) return;
    this.pendingApprovals.delete(input.requestId);
    this.approvalMeta.delete(input.requestId);
    resolver(input.decision);
  }

  async respondToInput(input: AgentInputResponseInputV2): Promise<void> {
    const requestId = input.requestId;
    const resolver = this.pendingInputRequests.get(requestId);
    if (!resolver) return;
    this.pendingInputRequests.delete(requestId);
    this.inputRequestMeta.delete(requestId);
    resolver({ answers: input.answers });
  }

  // ── Internal: turn lifecycle ───────────────────────────────────────────────

  private async startTurn(input: AgentSendMessageInputV2): Promise<void> {
    if (!this.config || !this.client) {
      throw new Error('Cannot start Codex turn before connect');
    }

    const startedAt = nowIso();
    this.activeTurnId = input.turnId;
    this.activeStartedAt = startedAt;
    this.completedActiveTurn = false;
    this.openAgentMessageNativeIds.clear();
    this.openReasoningByRelayId.clear();
    this.clearDeferredTurnCompletion();

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

    try {
      await this.client.call('turn/start', {
        threadId: this.providerSessionId,
        input: buildCodexTurnInput(input.content, input.attachments),
        ...(this.pendingModelOverride
          ? { model: this.pendingModelOverride }
          : {}),
      });
    } catch (err) {
      logger.warn('Codex turn/start failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId: input.turnId,
        message,
      });
      this.completeActiveTurn('failed', undefined, message);
      this.drainQueue();
    }
  }

  private completeActiveTurn(
    status: 'completed' | 'interrupted' | 'failed',
    usage?: AgentUsageV2,
    error?: string,
    nativeDurationMs?: number
  ): void {
    if (this.completedActiveTurn || this.activeTurnId === null) return;
    this.clearDeferredTurnCompletion();
    this.completedActiveTurn = true;
    const turnId = this.activeTurnId;
    const completedAt = nowIso();
    this.terminalizeOpenReasoningItems(status, completedAt);
    // Prefer native durationMs if provided, else compute from startedAt
    const durationMs =
      nativeDurationMs ??
      (this.activeStartedAt
        ? Date.now() - Date.parse(this.activeStartedAt)
        : undefined);

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

    // These maps translate provider output ids only while the current turn is
    // live. The canonical V2 transcript owns completed items; retaining native
    // ids and streamed reasoning/token buffers across turns grows without bound
    // on an always-on channel binding.
    this.itemMap.clear();
    this.openAgentMessageNativeIds.clear();
    this.openReasoningByRelayId.clear();
    this.toolArgumentsByNativeId.clear();
    this.tokenUsageBuffer.clear();
    this.reasoningSummaryBuffers.clear();
    this.reasoningDetailBuffers.clear();

    this.activeTurnId = null;
    this.nativeActiveTurnId = null;
    this.activeStartedAt = null;

    this.emitLiveState({
      status: this.queue.length > 0 ? 'working' : 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
      error: error ?? null,
    });
  }

  private clearDeferredTurnCompletion(): void {
    if (!this.deferredTurnCompletion) return;
    clearTimeout(this.deferredTurnCompletion.timer);
    this.deferredTurnCompletion = null;
  }

  private flushDeferredTurnCompletion(): boolean {
    const pending = this.deferredTurnCompletion;
    if (!pending) return false;
    this.deferredTurnCompletion = null;
    clearTimeout(pending.timer);
    this.completeActiveTurn(
      pending.status,
      pending.usage,
      pending.error,
      pending.nativeDurationMs
    );
    return true;
  }

  private deferCompletedTurnUntilTerminalItems(
    usage?: AgentUsageV2,
    error?: string,
    nativeDurationMs?: number
  ): boolean {
    if (
      this.openAgentMessageNativeIds.size === 0 &&
      this.openReasoningByRelayId.size === 0
    ) {
      return false;
    }
    this.clearDeferredTurnCompletion();
    const timer = setTimeout(() => {
      if (this.flushDeferredTurnCompletion()) this.drainQueue();
    }, CODEX_TERMINAL_ITEM_GRACE_MS);
    timer.unref?.();
    this.deferredTurnCompletion = {
      status: 'completed',
      ...(usage !== undefined ? { usage } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(nativeDurationMs !== undefined ? { nativeDurationMs } : {}),
      timer,
    };
    return true;
  }

  private completeDeferredTurnIfReady(): void {
    if (
      this.openAgentMessageNativeIds.size > 0 ||
      this.openReasoningByRelayId.size > 0 ||
      !this.deferredTurnCompletion
    ) {
      return;
    }
    if (this.flushDeferredTurnCompletion()) this.drainQueue();
  }

  private terminalizeOpenReasoningItems(
    turnStatus: 'completed' | 'interrupted' | 'failed',
    completedAt: string
  ): void {
    if (!this.config || this.activeTurnId === null) return;
    const status =
      turnStatus === 'completed'
        ? 'completed'
        : turnStatus === 'failed'
          ? 'failed'
          : 'cancelled';

    for (const [relayId, nativeId] of this.openReasoningByRelayId) {
      const summary = this.reasoningSummaryBuffers.get(relayId) ?? '';
      const detail = this.reasoningDetailBuffers.get(relayId) ?? '';
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.config.sessionId,
        timestamp: completedAt,
        turnId: this.activeTurnId,
        item: {
          type: 'reasoning',
          id: relayId,
          summary,
          ...(detail ? { detail } : {}),
          visibility: 'summary',
          status,
          completedAt,
          ...(nativeId ? { providerItemId: nativeId } : {}),
        },
      });
      this.reasoningSummaryBuffers.delete(relayId);
      this.reasoningDetailBuffers.delete(relayId);
    }
    this.openReasoningByRelayId.clear();
  }

  private drainQueue(): void {
    if (this._status !== 'connected' || this.activeTurnId !== null) return;
    const queued = this.queue.shift();
    if (!queued) return;
    void this.startTurn(queued.input)
      .then(() => queued.resolve())
      .catch((err) => queued.reject(err));
  }

  private rejectQueued(err: unknown): void {
    const queued = this.queue.splice(0);
    for (const message of queued) message.reject(err);
    if (queued.length > 0) this.emitLiveState({ queueLength: 0 });
  }

  // ── Internal: client wiring ───────────────────────────────────────────────

  private createClient(config: AdapterConfig): CodexAppServerClient {
    const extra = isRecord(config.extra) ? config.extra : {};
    const opts: CodexAppServerClientOptions = {
      clientInfo: {
        name: 'relay-ide',
        title: 'Relay IDE',
        version: '0.1.0',
      },
      optOutNotificationMethods: [],
      cwd: typeof extra['cwd'] === 'string' ? extra['cwd'] : config.cwd,
    };
    if (typeof extra['command'] === 'string') opts.command = extra['command'];
    if (Array.isArray(extra['args'])) opts.args = extra['args'] as string[];
    if (typeof extra['spawn'] === 'function') {
      opts.spawn = extra['spawn'] as NonNullable<
        CodexAppServerClientOptions['spawn']
      >;
    }
    return this.clientFactory(opts);
  }

  private wireClientEvents(client: CodexAppServerClient): void {
    client.on('notification', (notification: CodexNotification) => {
      this.handleNotification(notification);
    });

    client.on('request', (request: CodexServerRequest) => {
      void this.handleServerRequest(request);
    });

    client.on('error', (err: Error) => {
      logger.error('Codex client error:', err);
      if (this._status === 'connected') {
        const turnId = this.activeTurnId;
        if (turnId !== null && !this.completedActiveTurn) {
          this.emitPatch({
            type: 'agent-error-v2',
            sessionId: this.sessionId,
            timestamp: nowIso(),
            turnId,
            message: err.message,
          });
          this.completeActiveTurn('failed', undefined, err.message);
        }
      }
    });

    client.on('close', (_code: number | null) => {
      logger.info('Codex client closed');
      if (this._status === 'connected') {
        const turnId = this.activeTurnId;
        if (turnId !== null && !this.completedActiveTurn) {
          const flushedDeferredCompletion = this.flushDeferredTurnCompletion();
          if (!flushedDeferredCompletion) {
            this.completeActiveTurn('interrupted');
          }
        }
        this._status = 'disconnected';
        this.client = null;
        this.emitLiveState({
          status: 'disconnected',
          activeTurnId: null,
          waitingOn: null,
          activeRequestIds: [],
          queueLength: 0,
        });
      }
    });
  }

  private async teardownState(): Promise<void> {
    this.rejectQueued(new Error('Codex adapter disconnecting'));
    this.pendingApprovals.clear();
    this.pendingInputRequests.clear();
    this.approvalMeta.clear();
    this.inputRequestMeta.clear();

    // A provider-completed turn waiting only on the terminal-item grace still
    // owns its authoritative usage/boundary. Publish it before client.stop()
    // can emit close and before teardown clears the deferred record. Otherwise
    // an explicitly disconnected active turn is interrupted here so open
    // reasoning cards become terminal before their identity/buffers are lost.
    const flushedDeferredCompletion = this.flushDeferredTurnCompletion();
    if (
      !flushedDeferredCompletion &&
      this.activeTurnId !== null &&
      !this.completedActiveTurn
    ) {
      this.completeActiveTurn('interrupted');
    }

    if (this.client) {
      try {
        await this.client.stop('SIGTERM');
      } catch (err) {
        logger.warn('Codex client stop error:', err);
      }
      this.client = null;
    }

    this.activeTurnId = null;
    this.nativeActiveTurnId = null;
    this.activeStartedAt = null;
    this.completedActiveTurn = false;
    this.providerSessionId = null;
    this.slashCommandsLoaded = false;
    this.itemMap.clear();
    this.openAgentMessageNativeIds.clear();
    this.openReasoningByRelayId.clear();
    this.clearDeferredTurnCompletion();
    this.toolArgumentsByNativeId.clear();
    this.tokenUsageBuffer.clear();
    this.reasoningSummaryBuffers.clear();
    this.reasoningDetailBuffers.clear();
    this._status = 'disconnected';
  }

  // ── Internal: notification dispatch ──────────────────────────────────────

  private handleNotification(notification: CodexNotification): void {
    const { method, params } = notification;
    const p = isRecord(params) ? params : {};

    logger.trace('notification %s %s', method, safeJson(params));

    switch (method) {
      case 'thread/started':
        this.handleThreadStarted(p);
        break;
      case 'thread/statusChanged':
        this.emitProviderExtension(
          { kind: 'threadStatusChanged', ...p },
          'debug'
        );
        break;
      case 'thread/archived':
      case 'thread/unarchived':
      case 'thread/closed':
        this.emitProviderExtension(
          { kind: method.replace('/', ':'), ...p },
          'debug'
        );
        break;
      case 'thread/nameUpdated':
        this.emitProviderExtension(
          { kind: 'threadNameUpdated', ...p },
          'debug'
        );
        break;
      case 'thread/goal/updated':
        this.emitProviderExtension(
          { kind: 'threadGoalUpdated', ...p },
          'debug'
        );
        break;
      case 'thread/goal/cleared':
        this.emitProviderExtension(
          { kind: 'threadGoalCleared', ...p },
          'debug'
        );
        break;
      case 'thread/tokenUsageUpdated':
        this.handleTokenUsageUpdated(p);
        break;
      case 'turn/started':
        this.handleTurnStarted(p);
        break;
      case 'turn/completed':
        this.handleTurnCompleted(p);
        break;
      case 'turn/diff/updated':
        this.handleTurnDiffUpdated(p);
        break;
      case 'turn/plan/updated':
        this.handleTurnPlanUpdated(p);
        break;
      case 'model/rerouted':
        this.handleModelRerouted(p);
        break;
      case 'model/verification':
        this.handleModelVerification(p);
        break;
      case 'item/started':
        this.handleItemStarted(p);
        break;
      case 'item/completed':
        this.handleItemCompleted(p);
        break;
      case 'item/agentMessage/delta':
        this.handleAgentMessageDelta(p);
        break;
      case 'item/plan/delta':
        this.handlePlanDelta(p);
        break;
      case 'item/reasoning/summaryTextDelta':
        this.handleReasoningSummaryDelta(p);
        break;
      case 'item/reasoning/summaryPartAdded':
        this.handleReasoningSummaryPartAdded(p);
        break;
      case 'item/reasoning/textDelta':
        this.handleReasoningTextDelta(p);
        break;
      case 'item/commandExecution/outputDelta':
        this.handleCommandExecutionOutputDelta(p);
        break;
      case 'item/fileChange/patchUpdated':
        this.handleFileChangePatchUpdated(p);
        break;
      case 'item/fileChange/outputDelta':
        this.handleFileChangeOutputDelta(p);
        break;
      case 'enteredReviewMode':
        this.emitProviderExtension({ kind: 'enteredReviewMode', ...p });
        break;
      case 'exitedReviewMode':
        this.emitProviderExtension({ kind: 'exitedReviewMode', ...p });
        break;
      case 'contextCompaction':
        this.emitProviderExtension({ kind: 'contextCompaction', ...p });
        break;
      case 'configWarning':
        this.emitProviderExtension({ kind: 'configWarning', ...p }, 'debug');
        break;
      case 'warning':
        this.emitProviderExtension({ kind: 'warning', ...p }, 'debug');
        break;
      case 'skills/changed':
        void this.refreshSlashCommands(this.config?.cwd ?? '');
        break;
      default:
        this.emitProviderExtension({ kind: method, ...p }, 'debug');
        break;
    }
  }

  private handleThreadStarted(p: Record<string, unknown>): void {
    // Authoritative shape: { thread: Thread } — read thread.id
    const thread = isRecord(p['thread']) ? p['thread'] : p;
    const threadId = stringField(thread['id'] ?? p['threadId']);
    if (threadId && threadId !== this.providerSessionId) {
      this.providerSessionId = threadId;
      this.emitSessionUpdate({ providerSession: { threadId } });
    }
  }

  private handleTokenUsageUpdated(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }
    const nativeTurnId = stringField(p['turnId']);
    const tokenUsage = isRecord(p['tokenUsage']) ? p['tokenUsage'] : null;
    if (nativeTurnId && tokenUsage) {
      this.tokenUsageBuffer.set(nativeTurnId, tokenUsage);
    }
  }

  private handleTurnStarted(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turn: Turn } — read turn.id
    const turn = isRecord(p['turn']) ? p['turn'] : p;
    const nativeTurnId = stringField(turn['id'] ?? p['turnId']);
    this.nativeActiveTurnId = nativeTurnId;

    this.emitLiveState({
      status: 'working',
      activeTurnId: this.activeTurnId,
      waitingOn: null,
      queueLength: this.queue.length,
    });
  }

  private handleTurnCompleted(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turn: Turn }
    const turn = isRecord(p['turn']) ? p['turn'] : p;
    const nativeStatus = stringField(turn['status'] ?? p['status']);
    const nativeTurnId = stringField(turn['id'] ?? p['turnId']);
    const nativeDurationMs =
      typeof turn['durationMs'] === 'number' ? turn['durationMs'] : undefined;

    // Map native status → V2 status
    let status: 'completed' | 'interrupted' | 'failed';
    if (nativeStatus === 'interrupted') {
      status = 'interrupted';
    } else if (nativeStatus === 'failed') {
      status = 'failed';
    } else if (nativeStatus === 'inProgress') {
      // Defensive: inProgress should not appear in turn/completed — no-op
      return;
    } else {
      status = 'completed';
    }

    // Extract error from turn when failed
    const turnError = isRecord(turn['error']) ? turn['error'] : null;
    const errorMessage = turnError
      ? stringField(turnError['message'])
      : undefined;

    // Retrieve stashed token usage from thread/tokenUsageUpdated buffer
    // Prefer the buffered data keyed by the native turn id
    const buffered = nativeTurnId
      ? this.tokenUsageBuffer.get(nativeTurnId)
      : null;
    let usage: AgentUsageV2 | undefined;
    if (buffered) {
      // Use the `last` breakdown if available, else `total`
      const lastBreakdown = isRecord(buffered['last'])
        ? buffered['last']
        : null;
      const totalBreakdown = isRecord(buffered['total'])
        ? buffered['total']
        : null;
      const breakdown = lastBreakdown ?? totalBreakdown;
      if (breakdown) {
        usage = {};
        if (typeof breakdown['inputTokens'] === 'number')
          usage.inputTokens = breakdown['inputTokens'];
        if (typeof breakdown['outputTokens'] === 'number')
          usage.outputTokens = breakdown['outputTokens'];
        if (typeof breakdown['cachedInputTokens'] === 'number')
          usage.cachedInputTokens = breakdown['cachedInputTokens'];
        if (typeof breakdown['reasoningOutputTokens'] === 'number')
          usage.reasoningOutputTokens = breakdown['reasoningOutputTokens'];
        if (typeof breakdown['totalTokens'] === 'number')
          usage.totalTokens = breakdown['totalTokens'];
        const mctx = buffered['modelContextWindow'];
        if (typeof mctx === 'number') usage.contextWindowSize = mctx;
        if (Object.keys(usage).length === 0) usage = undefined;
      }
      // Evict once consumed
      if (nativeTurnId) this.tokenUsageBuffer.delete(nativeTurnId);
    }

    const error = errorMessage || undefined;
    if (
      status === 'completed' &&
      this.deferCompletedTurnUntilTerminalItems(usage, error, nativeDurationMs)
    ) {
      return;
    }
    this.completeActiveTurn(status, usage, error, nativeDurationMs);
    this.drainQueue();
  }

  private handleTurnDiffUpdated(p: Record<string, unknown>): void {
    this.emitProviderExtension({
      kind: 'turnDiff',
      threadId: this.providerSessionId ?? '',
      turnId: this.nativeActiveTurnId ?? '',
      ...p,
    });
  }

  private handleTurnPlanUpdated(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turnId, explanation?, plan: { step, status }[] }
    if (this.activeTurnId === null || !this.config) return;
    const planId = `plan-${this.activeTurnId}`;
    // Build text from explanation + plan steps
    const explanation = stringField(
      p['explanation'] ?? p['text'] ?? p['content']
    );
    const rawSteps = Array.isArray(p['plan']) ? p['plan'] : [];
    const steps = rawSteps.filter(isRecord).map((s) => ({
      step: stringField(s['step'] ?? s['text']),
      status: stringField(s['status'], 'pending') as
        | 'pending'
        | 'inProgress'
        | 'completed',
    }));

    // Render text: explanation + step list
    const stepLines = steps.map((s) => {
      const marker =
        s.status === 'completed'
          ? '[x]'
          : s.status === 'inProgress'
            ? '[>]'
            : '[ ]';
      return `${marker} ${s.step}`;
    });
    const text = [explanation, ...stepLines].filter(Boolean).join('\n');

    if (!this.itemMap.has(planId)) {
      this.itemMap.set(planId, planId);
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.config.sessionId,
        timestamp: nowIso(),
        turnId: this.activeTurnId,
        item: {
          type: 'plan',
          id: planId,
          text,
          ...(steps.length > 0 ? { steps } : {}),
          status: 'running',
          startedAt: nowIso(),
        },
      });
    } else {
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.config.sessionId,
        timestamp: nowIso(),
        turnId: this.activeTurnId,
        item: {
          type: 'plan',
          id: planId,
          text,
          ...(steps.length > 0 ? { steps } : {}),
          status: 'running',
        },
      });
    }
  }

  private handleModelRerouted(p: Record<string, unknown>): void {
    this.emitProviderExtension({ kind: 'modelRerouted', ...p }, 'debug');
  }

  private handleModelVerification(p: Record<string, unknown>): void {
    this.emitProviderExtension({ kind: 'modelVerification', ...p }, 'debug');
  }

  private handleItemStarted(p: Record<string, unknown>): void {
    if (this.activeTurnId === null || !this.config) return;
    const item = isRecord(p['item']) ? p['item'] : p;
    const itemType = stringField(item['type'] ?? p['itemType']);
    const nativeId = stringField(item['id'] ?? p['itemId']);

    switch (itemType) {
      case 'agentMessage': {
        const relayId = `msg-${this.activeTurnId}-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        if (nativeId) this.openAgentMessageNativeIds.add(nativeId);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'assistantMessage',
            id: relayId,
            text: '',
            phase: 'answer',
            status: 'running',
            startedAt: nowIso(),
            ...(nativeId ? { providerItemId: nativeId } : {}),
          },
        });
        break;
      }

      case 'reasoning': {
        const relayId = `reasoning-${this.activeTurnId}-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        this.openReasoningByRelayId.set(relayId, nativeId);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'reasoning',
            id: relayId,
            summary: '',
            visibility: 'summary',
            status: 'running',
            startedAt: nowIso(),
            ...(nativeId ? { providerItemId: nativeId } : {}),
          },
        });
        break;
      }

      case 'plan': {
        const planId = `plan-${this.activeTurnId}`;
        if (!this.itemMap.has(nativeId)) {
          this.itemMap.set(nativeId, planId);
          this.emitPatch({
            type: 'agent-item-started-v2',
            sessionId: this.config.sessionId,
            timestamp: nowIso(),
            turnId: this.activeTurnId,
            item: {
              type: 'plan',
              id: planId,
              text: '',
              status: 'running',
              startedAt: nowIso(),
            },
          });
        }
        break;
      }

      case 'commandExecution': {
        const relayId = `exec-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'commandExecution',
            id: relayId,
            providerItemId: nativeId,
            command: stringField(item['command']),
            cwd: stringField(item['cwd']),
            output: '',
            status: 'running',
            startedAt: nowIso(),
          },
        });
        break;
      }

      case 'fileChange': {
        const relayId = `file-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        const changes = Array.isArray(item['changes']) ? item['changes'] : [];
        const paths = changes.filter(isRecord).map((c) => {
          // kind is a tagged union: { type: 'add'|'delete'|'update', movePath? }
          const kindObj = isRecord(c['kind']) ? c['kind'] : null;
          const kindType = kindObj
            ? stringField(kindObj['type'])
            : stringField(c['kind'] as unknown, 'edited');
          return {
            path: stringField(c['path']),
            status: kindType || 'edited',
          };
        });
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'fileChange',
            id: relayId,
            providerItemId: nativeId,
            paths:
              paths.length > 0
                ? paths
                : [{ path: 'unknown', status: 'pending' }],
            applyStatus: 'pending',
            status: 'running',
            startedAt: nowIso(),
          },
        });
        break;
      }

      case 'mcpToolCall': {
        const relayId = `mcp-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        const args = isRecord(item['arguments']) ? item['arguments'] : {};
        this.toolArgumentsByNativeId.set(nativeId, args);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'mcpToolCall',
            id: relayId,
            providerItemId: nativeId,
            server: stringField(item['server']),
            tool: stringField(item['tool']),
            arguments: args,
            status: 'running',
            startedAt: nowIso(),
          },
        });
        break;
      }

      case 'dynamicToolCall': {
        const relayId = `tool-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        const args = isRecord(item['arguments']) ? item['arguments'] : {};
        this.toolArgumentsByNativeId.set(nativeId, args);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'dynamicToolCall',
            id: relayId,
            providerItemId: nativeId,
            namespace: 'codex',
            tool: stringField(item['tool']),
            arguments: args,
            status: 'running',
            startedAt: nowIso(),
          },
        });
        break;
      }

      case 'collabAgentToolCall': {
        const relayId = `collab-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        const nativeTool = stringField(item['tool']);
        const args = isRecord(item['arguments']) ? item['arguments'] : {};
        this.toolArgumentsByNativeId.set(nativeId, args);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'dynamicToolCall',
            id: relayId,
            providerItemId: nativeId,
            namespace: 'codex',
            tool: `collab:${nativeTool}`,
            arguments: args,
            status: 'running',
            startedAt: nowIso(),
          },
        });
        break;
      }

      case 'webSearch': {
        const relayId = `search-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'webSearch',
            id: relayId,
            providerItemId: nativeId,
            query: stringField(item['query']),
            status: 'running',
            startedAt: nowIso(),
          },
        });
        break;
      }

      case 'imageView': {
        const relayId = `image-${nativeId}`;
        this.itemMap.set(nativeId, relayId);
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.config.sessionId,
          timestamp: nowIso(),
          turnId: this.activeTurnId,
          item: {
            type: 'imageView',
            id: relayId,
            providerItemId: nativeId,
            source: stringField(item['path'] ?? item['source']),
            status: 'running',
            startedAt: nowIso(),
          },
        });
        break;
      }

      default:
        this.emitProviderExtension(
          { kind: `item/started/${itemType}`, ...p },
          'debug'
        );
        break;
    }
  }

  private handleItemCompleted(p: Record<string, unknown>): void {
    if (this.activeTurnId === null || !this.config) return;
    const item = isRecord(p['item']) ? p['item'] : p;
    const nativeId = stringField(item['id'] ?? p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    const itemType = stringField(item['type'] ?? p['itemType']);
    const completedAt = nowIso();

    switch (itemType) {
      case 'agentMessage':
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.config.sessionId,
          timestamp: completedAt,
          turnId: this.activeTurnId,
          item: {
            type: 'assistantMessage',
            id: relayId,
            text: stringField(item['text'] ?? item['content']),
            phase: 'answer',
            status: 'completed',
            completedAt,
            ...(nativeId ? { providerItemId: nativeId } : {}),
          },
        });
        // Listener delivery is synchronous: only after the terminal item patch
        // is observable (and channel listeners have persisted it) may the
        // deferred turn boundary release item identity and live state.
        this.openAgentMessageNativeIds.delete(nativeId);
        this.completeDeferredTurnIfReady();
        break;

      case 'reasoning': {
        if (!this.openReasoningByRelayId.has(relayId)) break;
        // Current Codex app-server ships `summary` / `content` as string[];
        // older versions used `{ type, text }[]`. Flatten either shape and
        // fall back to streamed buffers when completion omits them.
        const summaryFromPayload = flattenReasoningTextEntries(item['summary']);
        const detailFromPayload = flattenReasoningTextEntries(item['content']);
        const summary =
          summaryFromPayload || this.reasoningSummaryBuffers.get(relayId) || '';
        const detail =
          detailFromPayload || this.reasoningDetailBuffers.get(relayId) || '';
        this.reasoningSummaryBuffers.delete(relayId);
        this.reasoningDetailBuffers.delete(relayId);
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.config.sessionId,
          timestamp: completedAt,
          turnId: this.activeTurnId,
          item: {
            type: 'reasoning',
            id: relayId,
            summary,
            ...(detail ? { detail } : {}),
            visibility: 'summary',
            status: 'completed',
            completedAt,
            ...(nativeId ? { providerItemId: nativeId } : {}),
          },
        });
        this.openReasoningByRelayId.delete(relayId);
        this.completeDeferredTurnIfReady();
        break;
      }

      case 'commandExecution': {
        const durationMs =
          typeof item['durationMs'] === 'number'
            ? item['durationMs']
            : undefined;
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.config.sessionId,
          timestamp: completedAt,
          turnId: this.activeTurnId,
          item: {
            type: 'commandExecution',
            id: relayId,
            providerItemId: nativeId,
            command: stringField(item['command']),
            cwd: stringField(item['cwd']),
            output: stringField(item['aggregatedOutput'] ?? item['output']),
            exitCode:
              typeof item['exitCode'] === 'number' ? item['exitCode'] : null,
            ...(durationMs !== undefined ? { durationMs } : {}),
            status: 'completed',
            completedAt,
          },
        });
        break;
      }

      case 'fileChange': {
        const applyStatusRaw = stringField(item['applyStatus'], 'applied');
        const applyStatus = (
          ['pending', 'applied', 'rejected', 'failed'] as const
        ).includes(
          applyStatusRaw as 'pending' | 'applied' | 'rejected' | 'failed'
        )
          ? (applyStatusRaw as 'pending' | 'applied' | 'rejected' | 'failed')
          : 'applied';
        const changes = Array.isArray(item['changes']) ? item['changes'] : [];
        const paths = changes.filter(isRecord).map((c) => {
          // kind is a tagged union: { type: 'add'|'delete'|'update', movePath? }
          const kindObj = isRecord(c['kind']) ? c['kind'] : null;
          const kindType = kindObj
            ? stringField(kindObj['type'])
            : stringField(c['kind'] as unknown, 'edited');
          return {
            path: stringField(c['path']),
            status: kindType || 'edited',
          };
        });
        // `item/completed` is authoritative and replaces the reducer entity.
        // Carry the final apply-patch payload forward; otherwise the preceding
        // patchUpdated delta is discarded and a completed diff card goes blank.
        const patch = changes
          .filter(isRecord)
          .map((change) => stringField(change['diff']))
          .filter(Boolean)
          .join('\n');
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.config.sessionId,
          timestamp: completedAt,
          turnId: this.activeTurnId,
          item: {
            type: 'fileChange',
            id: relayId,
            providerItemId: nativeId,
            paths:
              paths.length > 0
                ? paths
                : [{ path: 'unknown', status: 'edited' }],
            ...(patch ? { patch } : {}),
            applyStatus,
            status: 'completed',
            completedAt,
          },
        });
        break;
      }

      case 'mcpToolCall': {
        const args = isRecord(item['arguments'])
          ? item['arguments']
          : (this.toolArgumentsByNativeId.get(nativeId) ?? {});
        this.toolArgumentsByNativeId.delete(nativeId);
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.config.sessionId,
          timestamp: completedAt,
          turnId: this.activeTurnId,
          item: {
            type: 'mcpToolCall',
            id: relayId,
            providerItemId: nativeId,
            server: stringField(item['server']),
            tool: stringField(item['tool']),
            arguments: args,
            result: item['result'],
            status: 'completed',
            completedAt,
          },
        });
        break;
      }

      case 'dynamicToolCall':
      case 'collabAgentToolCall': {
        const tool =
          itemType === 'collabAgentToolCall'
            ? `collab:${stringField(item['tool'])}`
            : stringField(item['tool']);
        const args = isRecord(item['arguments'])
          ? item['arguments']
          : (this.toolArgumentsByNativeId.get(nativeId) ?? {});
        this.toolArgumentsByNativeId.delete(nativeId);
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.config.sessionId,
          timestamp: completedAt,
          turnId: this.activeTurnId,
          item: {
            type: 'dynamicToolCall',
            id: relayId,
            providerItemId: nativeId,
            namespace: 'codex',
            tool,
            arguments: args,
            result: item['result'],
            status: 'completed',
            completedAt,
          },
        });
        break;
      }

      default:
        this.emitProviderExtension(
          { kind: `item/completed/${itemType}`, ...p },
          'debug'
        );
        break;
    }
  }

  private handleAgentMessageDelta(p: Record<string, unknown>): void {
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    // Authoritative shape: always `delta` field, no text fallback
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: relayId,
      delta: { text: stringField(p['delta']) },
    });
  }

  private handlePlanDelta(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turnId, itemId, delta }
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId) ?? `plan-${this.activeTurnId}`;

    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: relayId,
      delta: { text: stringField(p['delta']) },
    });
  }

  private handleReasoningSummaryDelta(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turnId, itemId, delta, summaryIndex }
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    const fragment = stringField(p['delta']);
    this.reasoningSummaryBuffers.set(
      relayId,
      (this.reasoningSummaryBuffers.get(relayId) ?? '') + fragment
    );

    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: relayId,
      delta: { summary: fragment },
    });
  }

  private handleReasoningSummaryPartAdded(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turnId, itemId, summaryIndex }
    // Marks a new summary section boundary — emit update with boundary marker
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    // Emit a providerExtension boundary marker (no summary text in this notification)
    this.emitProviderExtension(
      {
        kind: 'reasoningSummaryPartAdded',
        itemId: relayId,
        summaryIndex:
          typeof p['summaryIndex'] === 'number' ? p['summaryIndex'] : 0,
      },
      'debug'
    );
  }

  private handleReasoningTextDelta(p: Record<string, unknown>): void {
    // Only for full-visibility reasoning items — emit detail delta
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    const fragment = stringField(p['delta']);
    this.reasoningDetailBuffers.set(
      relayId,
      (this.reasoningDetailBuffers.get(relayId) ?? '') + fragment
    );

    // Authoritative shape: { threadId, turnId, itemId, delta, contentIndex }
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: relayId,
      delta: { detail: fragment },
    });
  }

  private handleCommandExecutionOutputDelta(p: Record<string, unknown>): void {
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    // Authoritative shape: { threadId, turnId, itemId, delta }
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: relayId,
      delta: { output: stringField(p['delta']) },
    });
  }

  private handleFileChangePatchUpdated(p: Record<string, unknown>): void {
    // Authoritative shape: { threadId, turnId, itemId, changes: FileUpdateChange[] }
    // Each change: { path, kind: { type: 'add'|'delete'|'update', movePath? }, diff }
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    // Concatenate all diffs from changes array into a single patch string
    const changes = Array.isArray(p['changes']) ? p['changes'] : [];
    const combinedPatch = changes
      .filter(isRecord)
      .map((c) => stringField(c['diff']))
      .filter(Boolean)
      .join('\n');

    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: relayId,
      mode: 'replace',
      delta: { patch: combinedPatch, card: diffCounts(combinedPatch) },
    });
  }

  private handleFileChangeOutputDelta(p: Record<string, unknown>): void {
    if (this.activeTurnId === null || !this.config) return;
    const nativeId = stringField(p['itemId']);
    const relayId = this.itemMap.get(nativeId);
    if (!relayId) return;

    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: relayId,
      // Authoritative shape: { threadId, turnId, itemId, delta }
      delta: { content: stringField(p['delta']) },
    });
  }

  // ── Internal: server-initiated requests ───────────────────────────────────

  private async handleServerRequest(
    request: CodexServerRequest
  ): Promise<void> {
    if (!this.config || !this.client) return;
    const turnId = this.activeTurnId ?? 'turn-unknown';
    const p = isRecord(request.params) ? request.params : {};

    logger.trace('request %s %s', request.method, safeJson(request.params));

    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        await this.handleCommandApprovalRequest(request.id, turnId, p);
        break;
      case 'item/fileChange/requestApproval':
        await this.handleFileApprovalRequest(request.id, turnId, p);
        break;
      case 'item/permissions/requestApproval':
        await this.handlePermissionsApprovalRequest(request.id, turnId, p);
        break;
      case 'item/tool/requestUserInput':
        await this.handleUserInputRequest(request.id, turnId, p);
        break;
      case 'mcpServer/elicitation/request':
        await this.handleElicitationRequest(request.id, turnId, p);
        break;
      default:
        logger.warn('Codex unknown server request:', request.method);
        this.client.respondToServerRequestError(
          request.id,
          -32601,
          'Method not found'
        );
        break;
    }
  }

  private async handleCommandApprovalRequest(
    nativeRequestId: number | string,
    turnId: string,
    p: Record<string, unknown>
  ): Promise<void> {
    if (!this.config || !this.client) return;
    const requestId = `cmd-${String(nativeRequestId)}`;
    const itemId = `approval-${requestId}`;
    const command = stringField(p['command']);
    const cwd = stringField(p['cwd']);
    const commandActions = Array.isArray(p['commandActions'])
      ? p['commandActions']
      : [];

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'command',
        description: `Run command: ${command}`,
        target: command,
        details: { kind: 'command', command, cwd, commandActions },
        supported: CODEX_COMMAND_APPROVAL_SUPPORT,
        status: 'pending',
        startedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [requestId],
      queueLength: this.queue.length,
    });

    this.approvalMeta.set(requestId, {
      kind: 'command',
      nativeRequestId,
    });

    const decision = await new Promise<AgentApprovalDecisionV2>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
    });

    const nativeResponse = codexCommandDecisionResponse(decision);
    this.client.respondToServerRequest(nativeRequestId, nativeResponse);

    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'command',
        description: `Run command: ${command}`,
        target: command,
        details: { kind: 'command', command, cwd, commandActions },
        supported: CODEX_COMMAND_APPROVAL_SUPPORT,
        decision,
        respondedBy: 'user',
        status: 'completed',
        completedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'working',
      activeTurnId: turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });
  }

  private async handleFileApprovalRequest(
    nativeRequestId: number | string,
    turnId: string,
    p: Record<string, unknown>
  ): Promise<void> {
    if (!this.config || !this.client) return;
    const requestId = `file-${String(nativeRequestId)}`;
    const itemId = `approval-${requestId}`;
    const changes = Array.isArray(p['changes'])
      ? (p['changes'] as Array<{ path: string; kind: string; diff?: string }>)
      : [];

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'patch',
        description: `Apply file changes (${changes.length} file${changes.length !== 1 ? 's' : ''})`,
        target: changes.map((c) => c.path).join(', ') || 'unknown',
        details: { kind: 'patch', changes },
        supported: CODEX_PATCH_APPROVAL_SUPPORT,
        status: 'pending',
        startedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [requestId],
      queueLength: this.queue.length,
    });

    this.approvalMeta.set(requestId, { kind: 'patch', nativeRequestId });

    const decision = await new Promise<AgentApprovalDecisionV2>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
    });

    const nativeResponse = codexFileDecisionResponse(decision);
    this.client.respondToServerRequest(nativeRequestId, nativeResponse);

    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'patch',
        description: `Apply file changes (${changes.length} file${changes.length !== 1 ? 's' : ''})`,
        target: changes.map((c) => c.path).join(', ') || 'unknown',
        details: { kind: 'patch', changes },
        supported: CODEX_PATCH_APPROVAL_SUPPORT,
        decision,
        respondedBy: 'user',
        status: 'completed',
        completedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'working',
      activeTurnId: turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });
  }

  private async handlePermissionsApprovalRequest(
    nativeRequestId: number | string,
    turnId: string,
    p: Record<string, unknown>
  ): Promise<void> {
    if (!this.config || !this.client) return;
    const requestId = `perm-${String(nativeRequestId)}`;
    const itemId = `approval-${requestId}`;
    const permissions = Array.isArray(p['permissions'])
      ? (p['permissions'] as string[]).filter((x) => typeof x === 'string')
      : [];

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'permissionsGrant',
        description: `Grant permissions: ${permissions.join(', ')}`,
        target: permissions.join(', ') || 'unknown',
        details: { kind: 'permissionsGrant', permissions },
        supported: CODEX_PERMISSIONS_APPROVAL_SUPPORT,
        status: 'pending',
        startedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [requestId],
      queueLength: this.queue.length,
    });

    this.approvalMeta.set(requestId, {
      kind: 'permissions',
      nativeRequestId,
      permissions,
    });

    const decision = await new Promise<AgentApprovalDecisionV2>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
    });

    const response = codexPermissionsResponse(decision, permissions);
    this.client.respondToServerRequest(nativeRequestId, response);

    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'permissionsGrant',
        description: `Grant permissions: ${permissions.join(', ')}`,
        target: permissions.join(', ') || 'unknown',
        details: { kind: 'permissionsGrant', permissions },
        supported: CODEX_PERMISSIONS_APPROVAL_SUPPORT,
        decision,
        respondedBy: 'user',
        status: 'completed',
        completedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'working',
      activeTurnId: turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });
  }

  private async handleUserInputRequest(
    nativeRequestId: number | string,
    turnId: string,
    p: Record<string, unknown>
  ): Promise<void> {
    if (!this.config || !this.client) return;
    const requestId = `input-${String(nativeRequestId)}`;
    const itemId = `question-${requestId}`;
    const questions = Array.isArray(p['questions'])
      ? (p['questions'] as Array<{
          id: string;
          prompt: string;
          isOther?: boolean;
          options?: string[];
        }>)
      : [];

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'question',
        id: itemId,
        requestId,
        question:
          questions.map((q) => q.prompt).join(' / ') || 'Please provide input',
        fields: questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          ...(q.isOther !== undefined ? { isOther: q.isOther } : {}),
          ...(q.options !== undefined ? { options: q.options } : {}),
        })),
        status: 'pending',
        startedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'question',
      activeRequestIds: [requestId],
      queueLength: this.queue.length,
    });

    this.inputRequestMeta.set(requestId, { nativeRequestId });

    const response = await new Promise<{ answers: Record<string, string[]> }>(
      (resolve) => {
        this.pendingInputRequests.set(requestId, resolve);
      }
    );

    // Build contentItems from answers
    const contentItems = Object.entries(response.answers).map(
      ([id, values]) => ({
        id,
        value: values[0] ?? '',
      })
    );
    this.client.respondToServerRequest(nativeRequestId, {
      contentItems,
      success: true,
    });

    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'question',
        id: itemId,
        requestId,
        question:
          questions.map((q) => q.prompt).join(' / ') || 'Please provide input',
        answers: response.answers,
        status: 'completed',
        completedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'working',
      activeTurnId: turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });
  }

  private async handleElicitationRequest(
    nativeRequestId: number | string,
    turnId: string,
    p: Record<string, unknown>
  ): Promise<void> {
    if (!this.config || !this.client) return;
    const requestId = `elicit-${String(nativeRequestId)}`;
    const itemId = `approval-${requestId}`;
    const serverName = stringField(p['serverName']);
    const mode = stringField(p['mode']);
    const message = stringField(p['message']);
    const requestedSchema = p['requestedSchema'];

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'elicitation',
        description: `MCP elicitation from ${serverName}: ${message}`,
        target: serverName,
        details: {
          kind: 'elicitation',
          serverName,
          mode,
          message,
          requestedSchema,
        },
        supported: CODEX_ELICITATION_APPROVAL_SUPPORT,
        status: 'pending',
        startedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [requestId],
      queueLength: this.queue.length,
    });

    this.approvalMeta.set(requestId, { kind: 'elicitation', nativeRequestId });

    const decision = await new Promise<AgentApprovalDecisionV2>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
    });

    // Elicitation response: { action: 'accept'|'decline', content? }
    const elicitAction = decision.kind === 'accept' ? 'accept' : 'decline';
    this.client.respondToServerRequest(nativeRequestId, {
      action: elicitAction,
    });

    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: itemId,
        requestId,
        kind: 'elicitation',
        description: `MCP elicitation from ${serverName}: ${message}`,
        target: serverName,
        details: {
          kind: 'elicitation',
          serverName,
          mode,
          message,
          requestedSchema,
        },
        supported: CODEX_ELICITATION_APPROVAL_SUPPORT,
        decision,
        respondedBy: 'user',
        status: 'completed',
        completedAt: nowIso(),
      },
    });

    this.emitLiveState({
      status: 'working',
      activeTurnId: turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });
  }

  // ── Internal: relay-control dispatch ────────────────────────────────────

  /**
   * Rewrite user-typed trigger prefixes to provider-native form.
   * Codex skills expect `$`, so `/skillName` → `$skillName`.
   * relay-control tokens are left as-is (they get stripped in extractControlAction).
   */
  private rewriteContent(content: string): string {
    // Simple prefix rewrite: if content starts with /name and that name
    // maps to a skill (dispatch: 'agent', nativePrefix: '$'), rewrite to $name
    const match = content.match(/^([/$])(\S+)(.*)/s);
    if (!match) return content;

    const [, prefix, name, rest] = match;
    if (!name) return content;
    // Find in current slash commands (relay-control ones stay as-is for extractControlAction)
    // We only need to rewrite agent-dispatch skills from / → $
    if (prefix === '/') {
      const relayControlNames = new Set(
        RELAY_CODEX_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])])
      );
      if (!relayControlNames.has(name)) {
        // Assume it's a skill, rewrite / → $
        return `$${name}${rest ?? ''}`;
      }
    }
    return content;
  }

  /**
   * Extract relay-control action from content.
   * Returns { action, arg } or null if not a control token.
   */
  private extractControlAction(
    content: string
  ): { action: string; arg: string } | null {
    const match = content.match(/^([/$])(\S+)(?:\s+(.*))?/s);
    if (!match) return null;

    const [, , name, argRaw] = match;
    if (!name) return null;
    const arg = (argRaw ?? '').trim();

    const controlCommand = RELAY_CODEX_COMMANDS.find(
      (c) =>
        c.dispatch === 'relay-control' &&
        (c.name === name || (c.aliases ?? []).includes(name))
    );

    if (!controlCommand) return null;

    // Map to the collision key for routing
    const action = controlCommand.collisionKey ?? controlCommand.name;
    return { action, arg };
  }

  private async handleControlAction(
    action: string,
    arg: string
  ): Promise<void> {
    if (!this.config || !this.client) return;
    const sessionId = this.config.sessionId;

    const emitControl = (status: 'success' | 'error', details?: string) => {
      this.emitProviderExtension(
        {
          kind: 'controlAction',
          action,
          status,
          ...(details ? { details } : {}),
        },
        'debug'
      );
    };

    try {
      switch (action) {
        case 'clear': {
          await this.disconnect();
          await this.connect(this.config!);
          emitControl('success');
          break;
        }

        case 'resume': {
          if (!arg) {
            this.emitPatch({
              type: 'agent-error-v2',
              sessionId,
              timestamp: nowIso(),
              message:
                'resume requires a thread id argument: /resume <threadId>',
            });
            return;
          }
          await this.resumeSession(arg);
          emitControl('success', arg);
          break;
        }

        case 'model': {
          this.pendingModelOverride = arg || null;
          this.emitSessionUpdate({ config: arg ? { model: arg } : {} });
          emitControl('success', arg);
          break;
        }

        case 'compact': {
          await this.client.call('thread/compact/start', {
            threadId: this.providerSessionId,
          });
          emitControl('success');
          break;
        }

        case 'rollback': {
          const count = parseInt(arg, 10);
          if (!Number.isFinite(count) || count < 1) {
            this.emitPatch({
              type: 'agent-error-v2',
              sessionId,
              timestamp: nowIso(),
              message:
                'rollback requires a positive integer argument: /rollback <n>',
            });
            return;
          }
          await this.client.call('thread/rollback', {
            threadId: this.providerSessionId,
            count,
          });
          emitControl('success', String(count));
          break;
        }

        case 'archive': {
          await this.client.call('thread/archive', {
            threadId: this.providerSessionId,
          });
          emitControl('success');
          break;
        }

        case 'unarchive': {
          await this.client.call('thread/unarchive', {
            threadId: this.providerSessionId,
          });
          emitControl('success');
          break;
        }

        case 'goal': {
          const subArgs = arg.split(/\s+/);
          const subCmd = subArgs[0];
          const goalText = subArgs.slice(1).join(' ');

          if (subCmd === 'set') {
            await this.client.call('thread/goal/set', {
              threadId: this.providerSessionId,
              goal: goalText,
            });
          } else if (subCmd === 'get') {
            const result = await this.client.call<{ goal: string }>(
              'thread/goal/get',
              {
                threadId: this.providerSessionId,
              }
            );
            this.emitProviderExtension({
              kind: 'goalValue',
              goal: result.goal,
            });
          } else if (subCmd === 'clear') {
            await this.client.call('thread/goal/clear', {
              threadId: this.providerSessionId,
            });
          } else {
            this.emitPatch({
              type: 'agent-error-v2',
              sessionId,
              timestamp: nowIso(),
              message:
                'goal requires sub-command: /goal set <text> | get | clear',
            });
            return;
          }
          emitControl('success', arg);
          break;
        }

        case 'review': {
          await this.client.call('review/start', {
            threadId: this.providerSessionId,
          });
          emitControl('success');
          break;
        }

        case 'fork': {
          await this.client.call('thread/fork', {
            threadId: this.providerSessionId,
          });
          emitControl('success');
          break;
        }

        default:
          logger.warn('Unknown relay-control action:', action);
          emitControl('error', `unknown action: ${action}`);
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitControl('error', message);
      logger.warn(`Codex control action '${action}' failed:`, err);
    }
  }

  // ── Internal: slash commands ──────────────────────────────────────────────

  private async refreshSlashCommands(cwd: string): Promise<void> {
    if (this.slashCommandsLoaded || !this.client) return;

    try {
      const [skillsResult, _modelsResult] = await Promise.all([
        this.client.call<{ skills: unknown[] }>('skills/list', { cwd: [cwd] }),
        this.client.call('model/list').catch(() => null),
      ]);

      const skills: AgentSlashCommandV2[] = [];
      const rawSkills = Array.isArray(skillsResult?.skills)
        ? skillsResult.skills
        : Array.isArray(skillsResult)
          ? (skillsResult as unknown[])
          : [];

      for (const skill of rawSkills) {
        if (isRecord(skill) && typeof skill['name'] === 'string') {
          skills.push(normalizeSkill(skill, cwd));
        }
      }

      const catalog = mergeCodexCommandCatalog(skills, RELAY_CODEX_COMMANDS);
      this.slashCommandsLoaded = true;
      this.emitSessionUpdate({ slashCommands: catalog });
    } catch (err) {
      logger.warn('Codex skills/list fetch failed:', err);
    }
  }

  // ── Internal: emit helpers ────────────────────────────────────────────────

  private emitSnapshot(): void {
    if (!this.config) return;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.config.sessionId,
        provider: 'codex',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        ...(this.providerSessionId
          ? { providerSession: { threadId: this.providerSessionId } }
          : {}),
        config: {
          ...(this.config.model ? { model: this.config.model } : {}),
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

  private emitProviderExtension(
    payload: Record<string, unknown>,
    visibility: 'normal' | 'debug' = 'normal'
  ): void {
    if (this.activeTurnId === null || !this.config) return;
    const seq = ++this.providerExtensionSeq;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      item: {
        type: 'providerExtension',
        id: `ext-codex-${this.activeTurnId}-${seq}`,
        namespace: 'codex',
        payload,
        ...(visibility === 'debug'
          ? { metadata: { eventVisibility: 'debug' } }
          : {}),
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

  private get sessionId(): string {
    return this.config?.sessionId ?? 'codex-v2-session';
  }
}
