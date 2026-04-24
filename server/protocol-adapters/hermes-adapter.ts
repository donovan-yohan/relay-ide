import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import getPort from 'get-port';
import { BaseProtocolAdapter } from '../protocol-adapter.js';
import type {
  AdapterConfig,
  AdapterStatus,
  Attachment,
  SessionOptions,
} from '../protocol-adapter.js';
import { createLogger } from '../logger.js';

const logger = createLogger('hermes-adapter');

interface HermesEvent {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Hermes protocol adapter.
 *
 * Spawns `hermes gateway run` as a per-session lightweight daemon,
 * discovers the gateway port, then consumes the SSE event stream
 * and drives the agent via REST calls.
 */
export class HermesProtocolAdapter extends BaseProtocolAdapter {
  readonly agentType = 'hermes';
  readonly runtimeOwnership = 'spawned' as const;

  private _status: AdapterStatus = 'disconnected';
  private _config: AdapterConfig | null = null;
  private _process: ChildProcess | null = null;
  private _gatewayPort = 0;
  private _gatewayHost = '127.0.0.1';
  private _sseAbortController: AbortController | null = null;
  private _messageAbortController: AbortController | null = null;
  private _turnCounter = 0;
  private _currentTurnId: string | null = null;
  private _apiToken: string | null = null;

  get status(): AdapterStatus {
    return this._status;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(config: AdapterConfig): Promise<void> {
    this._config = config;
    this._status = 'connecting';

    // Resolve auth token from framework override or extra config
    this._apiToken =
      (config.extra?.['apiToken'] as string | undefined) ?? null;

    // Find an open port for the gateway
    this._gatewayPort = await getPort();

    // Build spawn command — allow commandOverride via extra config for tests
    const command =
      (config.extra?.['command'] as string | undefined) ?? 'hermes';
    const defaultArgs = ['gateway', 'run', '--port', String(this._gatewayPort)];
    const args = ((config.extra?.['args'] as string[] | undefined) ?? defaultArgs).map(
      (arg) => arg.replace(/\{\{PORT\}\}/g, String(this._gatewayPort))
    );
    const env: Record<string, string> = {};
    if (this._apiToken) {
      env['HERMES_API_TOKEN'] = this._apiToken;
    }

    this._process = spawn(command, args, {
      cwd: config.cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._process.on('exit', (code) => {
      logger.info(`[hermes] process exited with code ${code}`);
      if (this._status === 'connected') {
        this._status = 'error';
        this.fire({
          type: 'chat:error',
          kind: 'protocol',
          message: `Hermes gateway exited with code ${code}`,
          retryable: true,
        });
        this.fire({ type: 'chat:session-status', status: 'disconnected' });
      }
    });

    this._process.on('error', (err) => {
      logger.error('[hermes] process error:', err);
      this._status = 'error';
      this.fire({
        type: 'chat:error',
        kind: 'protocol',
        message: err.message,
        retryable: false,
      });
    });

    // Wait for gateway HTTP health endpoint to become available
    await this.waitForGateway();

    // Start SSE consumer
    this._sseAbortController = new AbortController();
    this.consumeSse().catch((err) => {
      if (err instanceof Error && err.name !== 'AbortError') {
        logger.error('Hermes SSE error:', err);
        if (this._status === 'connected') {
          this._status = 'error';
          this.fire({
            type: 'chat:error',
            kind: 'protocol',
            message: 'Hermes SSE connection error',
            retryable: true,
          });
        }
      }
    });

    this._status = 'connected';
    this.fire({
      type: 'chat:session-started',
      sessionId: config.sessionId,
      agentType: 'hermes',
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
    if (!this._config)
      throw new Error('Cannot reconnect before initial connect');
    const config = this._config;
    await this.disconnect();
    await this.connect(config);
  }

  // ── User Actions ──────────────────────────────────────────────────────────

  async sendMessage(
    turnId: string,
    content: string,
    _attachments?: Attachment[]
  ): Promise<void> {
    const sessionId = this._config?.sessionId;
    if (!sessionId) throw new Error('No session ID');

    this._messageAbortController = new AbortController();
    this._currentTurnId = turnId;

    const url = `${this.baseUrl()}/session/${encodeURIComponent(sessionId)}/prompt`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this._apiToken ? { Authorization: `Bearer ${this._apiToken}` } : {}),
      },
      body: JSON.stringify({ text: content }),
      signal: this._messageAbortController.signal,
    });

    if (!res.ok) {
      throw new Error(`Hermes sendMessage failed: ${res.status}`);
    }

    this.fire({ type: 'chat:session-status', status: 'active' });
    this.fire({
      type: 'chat:turn-started',
      turnId,
      turnIndex: this._turnCounter++,
    });
  }

  async interrupt(_turnId: string): Promise<void> {
    const sessionId = this._config?.sessionId;
    if (!sessionId) return;

    const url = `${this.baseUrl()}/session/${encodeURIComponent(sessionId)}/abort`;
    await fetch(url, {
      method: 'POST',
      ...(this._messageAbortController
        ? { signal: this._messageAbortController.signal }
        : {}),
    }).catch(() => {});
  }

  async respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void> {
    const allow = decision === 'allow' || decision === 'allow-always';
    const url = `${this.baseUrl()}/permission/${encodeURIComponent(requestId)}/${allow ? 'allow' : 'deny'}`;
    await fetch(url, {
      method: 'POST',
      ...(this._messageAbortController
        ? { signal: this._messageAbortController.signal }
        : {}),
    }).catch(() => {});
  }

  async respondToInput(
    _requestId: string,
    answers: Record<string, string[]>
  ): Promise<void> {
    const firstAnswer = Object.values(answers)[0]?.[0];
    if (!firstAnswer) return;
    // Hermes gateway does not currently support structured input questions
    // via REST; this is a no-op.
  }

  // ── Session Management ────────────────────────────────────────────────────

  async createSession(
    _cwd: string,
    _options?: SessionOptions
  ): Promise<string> {
    return this._config?.sessionId ?? crypto.randomBytes(8).toString('hex');
  }

  async resumeSession(_sessionId: string): Promise<void> {
    // no-op — resume handled by spawn args if supported
  }

  async forkSession(_sessionId: string): Promise<string> {
    return crypto.randomBytes(8).toString('hex');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private baseUrl(): string {
    return `http://${this._gatewayHost}:${this._gatewayPort}`;
  }

  private async waitForGateway(): Promise<void> {
    const healthUrl = `${this.baseUrl()}/health`;
    const deadline = Date.now() + 10000; // 10s timeout

    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          logger.info('Hermes gateway ready on port', this._gatewayPort);
          return;
        }
      } catch {
        // expected while gateway is starting
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(
      `Hermes gateway did not become ready within 10s (tried ${healthUrl})`
    );
  }

  private async consumeSse(): Promise<void> {
    const url = `${this.baseUrl()}/events`;
    const res = await fetch(url, {
      ...(this._sseAbortController
        ? { signal: this._sseAbortController.signal }
        : {}),
    });

    if (!res.ok) {
      throw new Error(`Hermes SSE endpoint returned ${res.status}`);
    }
    if (!res.body) throw new Error('SSE response has no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let eventData = '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const dataLine = line.slice(5).trim();
          eventData = eventData ? eventData + '\n' + dataLine : dataLine;
        } else if (line.trim() === '' && eventData) {
          try {
            const data = JSON.parse(eventData) as HermesEvent;
            this.mapHermesEvent(data);
          } catch (err) {
            logger.debug('Failed to parse Hermes SSE event:', err);
          }
          eventData = '';
        }
      }
    }
  }

  private mapHermesEvent(event: HermesEvent): void {
    const handler = this._eventHandlers[event.type];
    if (handler) {
      handler.call(this, event);
    } else {
      logger.debug('Unhandled Hermes event:', event.type);
    }
  }

  private readonly _eventHandlers: Record<
    string,
    ((event: HermesEvent) => void) | undefined
  > = {
    token: (event) => {
      const turnId = this._currentTurnId ?? 'turn-0';
      const token = String(event.data?.['token'] ?? '');
      if (!token) return;
      this.fire({
        type: 'chat:text-delta',
        turnId,
        messageId: `msg-${turnId}`,
        delta: token,
      });
    },

    thinking: (event) => {
      const turnId = this._currentTurnId ?? 'turn-0';
      const content = String(event.data?.['content'] ?? '');
      if (!content) return;
      this.fire({
        type: 'chat:reasoning',
        turnId,
        messageId: `msg-${turnId}`,
        content,
        isDelta: Boolean(event.data?.['isDelta'] ?? true),
      });
    },

    tool_start: (event) => {
      const turnId = this._currentTurnId ?? 'turn-0';
      const tool = event.data?.['tool'] as Record<string, unknown> | undefined;
      this.fire({
        type: 'chat:tool-call',
        turnId,
        toolCallId: String(event.data?.['toolCallId'] ?? crypto.randomUUID()),
        toolName: String(tool?.['name'] ?? event.data?.['toolName'] ?? 'unknown'),
        description: String(tool?.['description'] ?? ''),
        input: (tool?.['input'] ?? event.data?.['input'] ?? {}) as Record<
          string,
          unknown
        >,
        status: 'running',
      });
    },

    tool_end: (event) => {
      const turnId = this._currentTurnId ?? 'turn-0';
      const result = event.data?.['result'] as Record<string, unknown> | undefined;
      const errorVal = result?.['error'] ?? event.data?.['error'];
      this.fire({
        type: 'chat:tool-result',
        turnId,
        toolCallId: String(event.data?.['toolCallId'] ?? 'tool-0'),
        toolName: String(
          event.data?.['toolName'] ?? result?.['toolName'] ?? 'unknown'
        ),
        status: errorVal ? 'error' : 'completed',
        output: String(result?.['output'] ?? event.data?.['output'] ?? ''),
        durationMs: Number(result?.['durationMs'] ?? event.data?.['durationMs'] ?? 0),
        ...(errorVal ? { error: String(errorVal) } : {}),
      });
    },

    approval_request: (event) => {
      const turnId = this._currentTurnId ?? 'turn-0';
      this.fire({
        type: 'chat:approval-request',
        turnId,
        requestId: String(event.data?.['requestId'] ?? 'req-0'),
        kind: 'permission',
        toolName: String(event.data?.['toolName'] ?? 'unknown'),
        description: String(event.data?.['description'] ?? ''),
        target: String(event.data?.['target'] ?? ''),
      });
      this.fire({
        type: 'chat:session-status',
        status: 'idle',
        waitingOn: 'approval',
      });
    },

    done: () => {
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
    },

    apperror: (event) => {
      const message = String(event.data?.['message'] ?? 'Unknown error');
      this.fire({
        type: 'chat:error',
        kind: 'unknown',
        message,
        retryable: true,
      });
      this.fire({ type: 'chat:session-status', status: 'error' });
    },

    compressed: (event) => {
      this.fire({
        type: 'chat:compaction',
        turnId: this._currentTurnId ?? undefined,
        summary: String(event.data?.['summary'] ?? ''),
        tokensBefore: Number(event.data?.['tokensBefore'] ?? 0),
        tokensAfter: Number(event.data?.['tokensAfter'] ?? 0),
      });
    },
  };

  /** Helper to build full ChatEvent from partial fields. */
  private fire(
    partial: { type: import('../../shared/chat-events.js').ChatEvent['type'] } & Record<string, unknown>
  ): void {
    const sessionId = this._config?.sessionId ?? '';
    this.emit({
      ...partial,
      sessionId,
      timestamp: new Date().toISOString(),
      source: this
        .agentType as import('../../shared/chat-events.js').ChatEvent['source'],
    } as import('../../shared/chat-events.js').ChatEvent);
  }
}
