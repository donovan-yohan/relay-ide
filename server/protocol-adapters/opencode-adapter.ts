import { OPENCODE_CHANNEL_COMMAND } from './launch-commands.js';
import {
  buildChildEnv,
  readSseStream,
  reconnectWithStoredConfig,
} from './adapter-utils.js';
import { OPENCODE_EXTRA_ENV_DENYLIST } from './provider-env.js';
import { openCodeStatusType } from './opencode-shared.js';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import getPort from 'get-port';
import { BaseProtocolAdapter } from '../protocol-adapter.js';
import type {
  AdapterConfig,
  AdapterStatus,
  SessionOptions,
  Attachment,
} from '../protocol-adapter.js';
import type { ChatEvent, ChatEventSource } from '../../shared/chat-events.js';
import { createLogger } from '../logger.js';

const logger = createLogger('opencode-adapter');
const MAX_TRACKED_USER_MESSAGES = 100;

interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface OpenCodeSseEnvelope {
  payload?: unknown;
}

interface LegacyHookEventPayload {
  type: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

interface TextPart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
}

interface OpenCodePromptResponse {
  info?: {
    id?: string;
    role?: string;
  };
  parts?: TextPart[];
}

function textPartId(part: TextPart): string {
  return String(part.id ?? `${part.messageID ?? 'message'}:text`);
}

/**
 * OpenCode web protocol adapter.
 *
 * OpenCode's own web UI talks to the headless HTTP server, not stdin on the TUI:
 * create a session over REST, send `{ parts: [...] }` prompts, and subscribe to
 * `/global/event` for streamed message part updates.
 */
export class OpenCodeProtocolAdapter extends BaseProtocolAdapter {
  readonly agentType = 'opencode';

  constructor(private readonly spawnFn: typeof spawn = spawn) {
    super();
  }

  private _status: AdapterStatus = 'disconnected';
  private _config: AdapterConfig | null = null;
  private _process: ChildProcess | null = null;
  private _processExitCode: number | null = null;
  private _processOutputBuffer = '';
  private _apiPort = 0;
  private _apiHost = '127.0.0.1';
  private _endpoint = '';
  private _sseAbortController: AbortController | null = null;
  private _messageAbortController: AbortController | null = null;
  private _turnCounter = 0;
  private _currentTurnId: string | null = null;
  private _openCodeSessionId: string | null = null;
  private _partText = new Map<string, string>();
  private _userMessageIds = new Set<string>();

  readonly runtimeOwnership = 'spawned' as const;

  get status(): AdapterStatus {
    return this._status;
  }

  get process(): ChildProcess | null {
    return this._process;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this._config = config;
    this._status = 'connecting';
    this._processExitCode = null;
    this._processOutputBuffer = '';
    this._currentTurnId = null;
    this._openCodeSessionId = null;
    this._partText.clear();
    this._userMessageIds.clear();

    this._apiPort = await getPort();
    this._apiHost =
      (config.extra?.['host'] as string | undefined) ?? '127.0.0.1';
    this._endpoint = `http://${this._apiHost}:${this._apiPort}`;

    const command = OPENCODE_CHANNEL_COMMAND;
    const defaultArgs = [
      'serve',
      '--hostname',
      this._apiHost,
      '--port',
      String(this._apiPort),
    ];
    const args = (
      (config.extra?.['args'] as string[] | undefined) ?? defaultArgs
    ).map((arg) => arg.replace(/\{\{PORT\}\}/g, String(this._apiPort)));

    const env = buildChildEnv({
      processEnv: config.processEnv,
      denylist: OPENCODE_EXTRA_ENV_DENYLIST,
    });

    this._process = this.spawnFn(command, args, {
      cwd: config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const captureProcessOutput = (chunk: Buffer): void => {
      this._processOutputBuffer = (
        this._processOutputBuffer + chunk.toString()
      ).slice(-2000);
    };
    this._process.stdout?.on('data', captureProcessOutput);
    this._process.stderr?.on('data', captureProcessOutput);

    this._process.on('exit', (code) => {
      this._processExitCode = code;
      logger.info(`[opencode] process exited with code ${code}`);
      if (this._status === 'connected') {
        this._status = 'error';
        this.fire({
          type: 'chat:error',
          kind: 'protocol',
          message: `OpenCode server exited with code ${code}`,
          retryable: true,
        });
        this.fire({ type: 'chat:session-status', status: 'disconnected' });
      }
    });

    this._process.on('error', (err) => {
      logger.error('[opencode] process error:', err);
      this._status = 'error';
      this.fire({
        type: 'chat:error',
        kind: 'protocol',
        message: err.message,
        retryable: false,
      });
    });

    await this.waitForServer();
    this._openCodeSessionId = await this.createOpenCodeSession();
    this.startEventStream();

    this._status = 'connected';
    this.fire({
      type: 'chat:session-started',
      sessionId: config.sessionId,
      agentType: this.agentType,
    });
    this.fire({ type: 'chat:session-status', status: 'idle' });
  }

  protected async onDisconnect(): Promise<void> {
    this._sseAbortController?.abort();
    this._messageAbortController?.abort();
    this._sseAbortController = null;
    this._messageAbortController = null;

    if (this._process) {
      try {
        this._process.kill('SIGTERM');
      } catch {
        /* may already be dead */
      }
      this._process = null;
    }
    this._status = 'disconnected';
  }

  async reconnect(): Promise<void> {
    await reconnectWithStoredConfig({
      config: this._config,
      notConnectedMessage: 'Cannot reconnect before initial connect',
      disconnect: () => this.disconnect(),
      connect: (config) => this.connect(config),
    });
  }

  /**
   * Compatibility path for plugin-style hook events. Private channel runtimes
   * use OpenCode's HTTP/SSE server transport, while the runtime hook router can
   * still deliver these events directly.
   */
  handleHookEvent(payload: LegacyHookEventPayload): void {
    switch (payload.type) {
      case 'session.idle':
        this.handleSessionStatus({
          type: 'session.status',
          properties: { status: 'idle' },
        });
        break;
      case 'state.changed':
        if (payload.data?.['status'] === 'error') {
          this.fire({
            type: 'chat:error',
            kind: 'unknown',
            message: String(payload.data['error'] ?? 'OpenCode session error'),
            retryable: true,
          });
          this.fire({ type: 'chat:session-status', status: 'error' });
        }
        break;
      case 'permission.requested':
        this.handlePermissionAsked({
          type: 'permission.asked',
          properties: payload.data ?? {},
        });
        break;
      case 'permission.resolved':
        this.handlePermissionReplied();
        break;
      case 'tool.started':
        this.handleToolStarted({
          type: 'tool.execute.before',
          properties: payload.data ?? {},
        });
        break;
      case 'tool.finished':
        this.handleToolFinished({
          type: 'tool.execute.after',
          properties: payload.data ?? {},
        });
        break;
      case 'telemetry.updated':
        this.handleTelemetry(payload.data);
        break;
      default:
        logger.debug('Unhandled legacy OpenCode hook event:', payload.type);
    }
  }

  async sendMessage(
    turnId: string,
    content: string,
    _attachments?: Attachment[]
  ): Promise<void> {
    if (!this._openCodeSessionId) throw new Error('No OpenCode session ID');

    this._messageAbortController = new AbortController();
    this._currentTurnId = turnId;

    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: content }],
    };
    if (this._config?.model) {
      const [providerID, modelID] = this._config.model.split('/', 2);
      if (providerID && modelID) {
        body['model'] = { providerID, modelID };
      }
    }

    this.fire({ type: 'chat:session-status', status: 'active' });
    this.fire({
      type: 'chat:turn-started',
      turnId,
      turnIndex: this._turnCounter++,
    });
    this.fire({
      type: 'chat:message-complete',
      turnId,
      messageId: `user-${turnId}`,
      role: 'user',
      content,
    });

    try {
      const url = new URL(
        `/session/${encodeURIComponent(this._openCodeSessionId)}/message`,
        this._endpoint
      );
      if (this._config?.cwd) {
        url.searchParams.set('directory', this._config.cwd);
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this._messageAbortController.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `OpenCode sendMessage failed: ${res.status}${text ? ` ${text}` : ''}`
        );
      }

      const response = (await res
        .json()
        .catch(() => null)) as OpenCodePromptResponse | null;
      this.emitAssistantMessageFromPromptResponse(turnId, response);
      this.fire({
        type: 'chat:turn-completed',
        turnId,
        reason: 'completed',
        durationMs: 0,
        toolCallCount: 0,
        messageCount: 1,
      });
      this._currentTurnId = null;
      this.fire({ type: 'chat:session-status', status: 'idle' });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        if (!this._currentTurnId) {
          return;
        }
        if (this._currentTurnId) {
          this.fire({
            type: 'chat:turn-completed',
            turnId: this._currentTurnId,
            reason: 'interrupted',
            durationMs: 0,
            toolCallCount: 0,
            messageCount: 0,
          });
        }
        this._currentTurnId = null;
        this.fire({ type: 'chat:session-status', status: 'idle' });
        return;
      }
      this._currentTurnId = null;
      this.fire({
        type: 'chat:error',
        kind: 'protocol',
        message:
          err instanceof Error ? err.message : 'OpenCode sendMessage failed',
        retryable: true,
        turnId,
      });
      this.fire({ type: 'chat:session-status', status: 'error' });
      throw err;
    } finally {
      this._messageAbortController = null;
    }
  }

  async interrupt(_turnId: string): Promise<void> {
    if (!this._openCodeSessionId) return;
    this._messageAbortController?.abort();
    await fetch(
      `${this._endpoint}/session/${encodeURIComponent(
        this._openCodeSessionId
      )}/abort`,
      { method: 'POST' }
    ).catch(() => {});
  }

  async respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void> {
    if (!this._openCodeSessionId) {
      throw new Error(
        'Cannot respond to approval before OpenCode session exists'
      );
    }
    const response =
      decision === 'deny'
        ? 'reject'
        : decision === 'allow-always'
          ? 'always'
          : 'once';
    const res = await fetch(
      `${this._endpoint}/session/${encodeURIComponent(
        this._openCodeSessionId
      )}/permissions/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      }
    );
    if (!res.ok) {
      throw new Error(`OpenCode approval response failed: ${res.status}`);
    }
    this.fire({
      type: 'chat:approval-response',
      requestId,
      decision,
      respondedBy: 'user',
      turnId: this._currentTurnId ?? 'turn-0',
    });
  }

  async respondToInput(
    requestId: string,
    answers: Record<string, string[]>
  ): Promise<void> {
    const firstAnswer = Object.values(answers)[0]?.[0];
    if (!firstAnswer) return;
    await fetch(
      `${this._endpoint}/question/${encodeURIComponent(requestId)}/reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: firstAnswer }),
      }
    ).catch(() => {});
  }

  async createSession(
    _cwd: string,
    _options?: SessionOptions
  ): Promise<string> {
    // OpenCode REST sessions are created in connect() via createOpenCodeSession().
    // This returns only Relay's placeholder id for generic session APIs.
    return this._config?.sessionId ?? crypto.randomBytes(8).toString('hex');
  }

  /**
   * Resume honesty (#1409). This used to be a silent no-op, which reads as
   * "the prior conversation is restored" to every caller. It never was: the
   * OpenCode REST session is created in `connect()` via `createOpenCodeSession`
   * (`POST /session`), and the surface this adapter speaks —
   * `/session/<id>/message`, `/session/<id>/abort`,
   * `/session/<id>/permissions/<id>`, `/question/<id>/reply`, `/global/health`,
   * `/global/event` — has no route to rebind a session id from a previous
   * process. A resumed runtime is therefore amnesiac.
   *
   * That is why `PROVIDER_DESCRIPTORS.opencode.resumeStateKey` is `null` and
   * `bridgedCapabilities.resume` is `false`. Because `providerResumeId()` reads
   * that same key, `channel-agent-binder` classifies a respawned opencode
   * runtime as holding nothing and re-orients it from cursor 0 — the bounded
   * root-plus-window packet from #1408, never a history dump — instead of
   * withholding rows a fresh session was assumed to remember.
   *
   * Failing loudly keeps the ladder honest: reaching here means a caller
   * bypassed the capability flag, and a silent success would hide the bypass.
   */
  async resumeSession(sessionId: string): Promise<void> {
    throw new Error(
      `opencode cannot resume session ${sessionId}: the REST transport creates a fresh session in connect() and exposes no rebind route (capabilities.resume is false).`
    );
  }

  async forkSession(_sessionId: string): Promise<string> {
    // Forking is not exposed by the OpenCode REST transport here; return a
    // placeholder id for callers that require one.
    return crypto.randomBytes(8).toString('hex');
  }

  private async waitForServer(): Promise<void> {
    const healthUrl = `${this._endpoint}/global/health`;
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) return;
      } catch {
        // expected while server is starting
      }
      if (this._processExitCode !== null) {
        const output = this._processOutputBuffer.trim();
        if (output.includes('EADDRINUSE')) {
          throw new Error(
            `OpenCode server failed to bind port ${this._apiPort}: ${output}`
          );
        }
        throw new Error(
          `OpenCode server exited before becoming ready (code ${this._processExitCode})${
            output ? `: ${output}` : ''
          }`
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(`OpenCode server did not become ready within 10s`);
  }

  /**
   * `config.systemPromptAppendix` is NOT delivered to OpenCode, and cannot be
   * on this transport (#1409, documented impossibility). The two routes that
   * could carry it take neither an instructions nor a system field: session
   * create is `POST /session { title }`, and a prompt is
   * `POST /session/<id>/message { parts, model? }` where every part is a user
   * part. OpenCode takes its agent instructions from `AGENTS.md` and its own
   * config files in the working directory, which Relay must not write into a
   * user's repo. Folding the appendix into `parts` would move Relay's runtime
   * contract into the operator's message on every turn — outside the system
   * region the prefix-cache invariant is stated over, and misattributed.
   * Delivering it needs a system/instructions field on one of those two routes.
   */
  private async createOpenCodeSession(): Promise<string> {
    const title = this._config?.sessionId
      ? `Relay ${this._config.sessionId}`
      : 'Relay channel agent';
    const res = await fetch(`${this._endpoint}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new Error(`OpenCode session create failed: ${res.status}`);
    }
    const session = (await res.json()) as Record<string, unknown>;
    const id = session['id'];
    if (typeof id !== 'string' || !id) {
      throw new Error('OpenCode session create failed: response missing id');
    }
    return id;
  }

  private startEventStream(): void {
    this._sseAbortController = new AbortController();
    this.consumeSse(`${this._endpoint}/global/event`).catch((err) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      logger.warn('OpenCode SSE error:', err);
      if (this._status === 'connected') {
        this._status = 'error';
        this.fire({
          type: 'chat:error',
          kind: 'protocol',
          message: 'OpenCode SSE connection error',
          retryable: true,
        });
        this.fire({ type: 'chat:session-status', status: 'error' });
      }
    });
  }

  private async consumeSse(url: string): Promise<void> {
    const res = await fetch(url, {
      ...(this._sseAbortController
        ? { signal: this._sseAbortController.signal }
        : {}),
    });
    if (!res.ok) {
      throw new Error(
        `OpenCode SSE endpoint returned ${res.status} ${res.statusText}`
      );
    }
    if (!res.body) throw new Error('SSE response has no body');

    // Framing belongs to `readSseStream`; OpenCode sends no `event:` field, so
    // only the data payload is meaningful here.
    await readSseStream(res.body, (record) =>
      this.handleSseEventData(record.data)
    );
  }

  private handleSseEventData(eventData: string): void {
    try {
      const data = JSON.parse(eventData) as OpenCodeEvent | OpenCodeSseEnvelope;
      const event = this.normalizeOpenCodeEvent(data);
      if (event) this.mapOpenCodeEvent(event);
    } catch (err) {
      logger.debug('Failed to parse OpenCode SSE event:', err);
    }
  }

  private normalizeOpenCodeEvent(
    raw: OpenCodeEvent | OpenCodeSseEnvelope
  ): OpenCodeEvent | null {
    if (
      raw &&
      typeof raw === 'object' &&
      'payload' in raw &&
      raw.payload &&
      typeof raw.payload === 'object'
    ) {
      const payload = raw.payload as Record<string, unknown>;
      return typeof payload['type'] === 'string'
        ? (payload as unknown as OpenCodeEvent)
        : null;
    }
    return raw &&
      typeof raw === 'object' &&
      'type' in raw &&
      typeof raw.type === 'string'
      ? raw
      : null;
  }

  private mapOpenCodeEvent(event: OpenCodeEvent): void {
    if (!this.isCurrentSessionEvent(event)) return;

    switch (event.type) {
      case 'message.updated':
        this.handleMessageUpdated(event);
        break;
      case 'session.status':
        this.handleSessionStatus(event);
        break;
      case 'session.error':
        this.handleSessionError(event);
        break;
      case 'tui.toast.show':
        this.handleToast(event);
        break;
      case 'message.part.updated':
        this.handleMessagePartUpdated(event);
        break;
      case 'permission.asked':
        this.handlePermissionAsked(event);
        break;
      case 'permission.replied':
        this.handlePermissionReplied();
        break;
      case 'tool.execute.before':
        this.handleToolStarted(event);
        break;
      case 'tool.execute.after':
        this.handleToolFinished(event);
        break;
      case 'question.asked':
        this.handleQuestionAsked(event);
        break;
      default:
        logger.debug('Unhandled OpenCode event:', event.type);
    }
  }

  private isCurrentSessionEvent(event: OpenCodeEvent): boolean {
    const sessionId = this.sessionIdFromEvent(event);
    return !sessionId || sessionId === this._openCodeSessionId;
  }

  private sessionIdFromEvent(event: OpenCodeEvent): string | undefined {
    const props = event.properties ?? {};
    const direct = props['sessionID'];
    if (typeof direct === 'string') return direct;
    const part = props['part'] as Record<string, unknown> | undefined;
    if (typeof part?.['sessionID'] === 'string') return part['sessionID'];
    const info = props['info'] as Record<string, unknown> | undefined;
    if (typeof info?.['sessionID'] === 'string') return info['sessionID'];
    const message = props['message'] as Record<string, unknown> | undefined;
    if (typeof message?.['sessionID'] === 'string') return message['sessionID'];
    return undefined;
  }

  private handleSessionStatus(event: OpenCodeEvent): void {
    const status = openCodeStatusType(event.properties?.['status']);
    if (status === 'active' || status === 'busy') {
      this.fire({ type: 'chat:session-status', status: 'active' });
      return;
    }
    if (status === 'error') {
      if (this._currentTurnId) {
        this.fire({
          type: 'chat:turn-completed',
          turnId: this._currentTurnId,
          reason: 'failed',
          durationMs: 0,
          toolCallCount: 0,
          messageCount: 0,
        });
        this._currentTurnId = null;
      }
      this.fire({ type: 'chat:session-status', status: 'error' });
      return;
    }
    if (status === 'retry') {
      const rawStatus = event.properties?.['status'];
      const message =
        rawStatus && typeof rawStatus === 'object'
          ? (rawStatus as Record<string, unknown>)['message']
          : undefined;
      if (message) {
        this.failCurrentTurn(String(message));
        return;
      }
      this.fire({
        type: 'chat:session-status',
        status: 'retry',
        waitingOn: 'network',
      });
      return;
    }
    if (status !== 'idle') return;
    if (this._currentTurnId) {
      this.fire({
        type: 'chat:turn-completed',
        turnId: this._currentTurnId,
        reason: 'completed',
        durationMs: 0,
        toolCallCount: 0,
        messageCount: 1,
      });
      this._currentTurnId = null;
    }
    this.fire({ type: 'chat:session-status', status: 'idle' });
  }

  private handleMessageUpdated(event: OpenCodeEvent): void {
    const info = event.properties?.['info'] as
      | Record<string, unknown>
      | undefined;
    const messageId = info?.['id'];
    const role = info?.['role'];
    if (typeof messageId === 'string' && typeof role === 'string') {
      if (role === 'user') {
        this.trackUserMessageId(messageId);
      } else {
        this._userMessageIds.delete(messageId);
      }
    }
  }

  private emitAssistantMessageFromPromptResponse(
    turnId: string,
    response: OpenCodePromptResponse | null
  ): void {
    if (!response || !Array.isArray(response.parts)) {
      return;
    }

    const text = response.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');

    if (!text) {
      return;
    }

    this.fire({
      type: 'chat:message-complete',
      turnId,
      messageId: response.info?.id ?? `assistant-${turnId}`,
      role: 'assistant',
      content: text,
    });
  }

  private trackUserMessageId(messageId: string): void {
    if (this._userMessageIds.has(messageId)) {
      this._userMessageIds.delete(messageId);
    }
    this._userMessageIds.add(messageId);
    while (this._userMessageIds.size > MAX_TRACKED_USER_MESSAGES) {
      const oldest = this._userMessageIds.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this._userMessageIds.delete(oldest);
    }
  }

  private handleSessionError(event: OpenCodeEvent): void {
    const rawError = event.properties?.['error'];
    const message =
      rawError && typeof rawError === 'object'
        ? ((rawError as Record<string, unknown>)['message'] ??
          (rawError as Record<string, unknown>)['name'])
        : rawError;
    this.fire({
      type: 'chat:error',
      kind: 'unknown',
      message: String(message ?? 'OpenCode session error'),
      retryable: true,
      turnId: this._currentTurnId ?? undefined,
    });
    if (this._currentTurnId) {
      this.fire({
        type: 'chat:turn-completed',
        turnId: this._currentTurnId,
        reason: 'failed',
        durationMs: 0,
        toolCallCount: 0,
        messageCount: 0,
      });
      this._currentTurnId = null;
    }
    this.fire({ type: 'chat:session-status', status: 'error' });
  }

  private handleToast(event: OpenCodeEvent): void {
    const props = event.properties ?? {};
    if (props['variant'] !== 'error') return;

    const title = typeof props['title'] === 'string' ? props['title'] : '';
    const message =
      typeof props['message'] === 'string'
        ? props['message']
        : 'OpenCode session error';
    const text = title ? `${title}: ${message}` : message;

    this.failCurrentTurn(text);
  }

  private failCurrentTurn(message: string): void {
    const turnId = this._currentTurnId ?? undefined;
    this.fire({
      type: 'chat:error',
      kind: message.toLowerCase().includes('quota') ? 'rate-limit' : 'unknown',
      message,
      retryable: true,
      ...(turnId ? { turnId } : {}),
    });
    this.fire({
      type: 'chat:session-status',
      status: 'error',
      error: message,
    });
    this._currentTurnId = null;
    this._messageAbortController?.abort();
  }

  private handleMessagePartUpdated(event: OpenCodeEvent): void {
    const part = event.properties?.['part'] as TextPart | undefined;
    if (!part || part.type !== 'text') return;
    // OpenCode sends message.updated before message.part.updated, so a bounded
    // set of recent user message ids is enough to suppress echoed user text.
    if (part.messageID && this._userMessageIds.has(part.messageID)) {
      return;
    }
    const turnId = this._currentTurnId ?? 'turn-0';
    const messageId = part.messageID ?? `msg-${turnId}`;
    const delta = this.deltaForPart(part, event.properties?.['delta']);
    if (!delta) return;
    this.fire({
      type: 'chat:text-delta',
      turnId,
      messageId,
      delta,
    });
  }

  private deltaForPart(part: TextPart, rawDelta: unknown): string {
    const id = textPartId(part);
    const next = typeof part.text === 'string' ? part.text : '';
    if (typeof rawDelta === 'string') {
      this._partText.set(id, next);
      return rawDelta;
    }
    const prev = this._partText.get(id) ?? '';
    this._partText.set(id, next);
    return next.startsWith(prev) ? next.slice(prev.length) : next;
  }

  private handlePermissionAsked(event: OpenCodeEvent): void {
    const props = event.properties ?? {};
    const permission = props['permission'] as
      | Record<string, unknown>
      | undefined;
    this.fire({
      type: 'chat:approval-request',
      turnId: this._currentTurnId ?? 'turn-0',
      requestId: String(
        props['requestID'] ?? props['requestId'] ?? props['id'] ?? 'req-0'
      ),
      kind: 'permission',
      toolName: String(permission?.['tool'] ?? props['toolName'] ?? 'unknown'),
      description: String(
        permission?.['description'] ?? props['description'] ?? ''
      ),
      target: String(permission?.['target'] ?? props['target'] ?? ''),
    });
    this.fire({
      type: 'chat:session-status',
      status: 'idle',
      waitingOn: 'approval',
    });
  }

  private handlePermissionReplied(): void {
    if (this._currentTurnId) {
      this.fire({ type: 'chat:session-status', status: 'active' });
    }
  }

  private handleToolStarted(event: OpenCodeEvent): void {
    const props = event.properties ?? {};
    const tool = props['tool'] as Record<string, unknown> | undefined;
    this.fire({
      type: 'chat:tool-call',
      turnId: this._currentTurnId ?? 'turn-0',
      toolCallId: String(props['toolCallId'] ?? crypto.randomUUID()),
      toolName: String(tool?.['name'] ?? props['toolName'] ?? 'unknown'),
      description: String(tool?.['description'] ?? ''),
      input: (tool?.['input'] ?? props['input'] ?? {}) as Record<
        string,
        unknown
      >,
      status: 'running',
    });
  }

  private handleToolFinished(event: OpenCodeEvent): void {
    const props = event.properties ?? {};
    const result = props['result'] as Record<string, unknown> | undefined;
    const tool = props['tool'] as Record<string, unknown> | undefined;
    const errorVal = result?.['error'] ?? props['error'];
    this.fire({
      type: 'chat:tool-result',
      turnId: this._currentTurnId ?? 'turn-0',
      toolCallId: String(props['toolCallId'] ?? 'tool-0'),
      toolName: String(tool?.['name'] ?? props['toolName'] ?? 'unknown'),
      status: errorVal ? 'error' : 'completed',
      output: String(result?.['output'] ?? props['output'] ?? ''),
      durationMs: Number(result?.['durationMs'] ?? props['durationMs'] ?? 0),
      ...(errorVal ? { error: String(errorVal) } : {}),
    });
  }

  private handleQuestionAsked(event: OpenCodeEvent): void {
    const props = event.properties ?? {};
    const rawQuestions = (props['questions'] as unknown[]) ?? [];
    const questionText =
      typeof rawQuestions[0] === 'string'
        ? String(rawQuestions[0])
        : 'Agent is asking a question';
    const fields = rawQuestions.map((q, idx) => ({
      id: `q${idx}`,
      label: typeof q === 'string' ? q : String(q),
      type: 'text' as const,
    }));
    this.fire({
      type: 'chat:input-request',
      turnId: this._currentTurnId ?? 'turn-0',
      requestId: String(props['requestID'] ?? 'req-0'),
      question: questionText,
      fields,
    });
  }

  private handleTelemetry(data: Record<string, unknown> | undefined): void {
    const message = data?.['message'] as Record<string, unknown> | undefined;
    if (!message) return;
    const tokens = message['tokens'] as Record<string, unknown> | undefined;
    if (!tokens) return;
    this.fire({
      type: 'chat:telemetry',
      turnId: this._currentTurnId ?? undefined,
      model: String(message['model'] ?? ''),
      inputTokens: Number(tokens['input'] ?? 0),
      outputTokens: Number(tokens['output'] ?? 0),
      cacheReadTokens: Number(tokens['cache_read'] ?? 0),
      cacheWriteTokens: Number(tokens['cache_write'] ?? 0),
      costUsd: tokens['cost'] != null ? Number(tokens['cost']) : null,
      contextPercent: 0,
      contextWindowSize: 0,
    });
  }

  /** Helper to build full ChatEvent from partial fields. */
  private fire(
    partial: { type: ChatEvent['type'] } & Record<string, unknown>
  ): void {
    const sessionId = this._config?.sessionId ?? '';
    this.emit({
      ...partial,
      sessionId,
      timestamp: new Date().toISOString(),
      source: this.agentType as ChatEventSource,
    } as ChatEvent);
  }
}
