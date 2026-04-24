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

interface SseEvent {
  event?: string;
  data: Record<string, unknown>;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { raw: value };
  }
}

/**
 * Hermes protocol adapter.
 *
 * Spawns `hermes gateway run` with its local API server enabled, then drives
 * the agent through Hermes' OpenAI-compatible Responses streaming endpoint.
 */
export class HermesProtocolAdapter extends BaseProtocolAdapter {
  readonly agentType = 'hermes';
  readonly runtimeOwnership = 'spawned' as const;

  private _status: AdapterStatus = 'disconnected';
  private _config: AdapterConfig | null = null;
  private _process: ChildProcess | null = null;
  private _processExitCode: number | null = null;
  private _processOutputBuffer = '';
  private _apiPort = 0;
  private _apiHost = '127.0.0.1';
  private _messageAbortController: AbortController | null = null;
  private _turnCounter = 0;
  private _currentTurnId: string | null = null;
  private _apiKey: string | null = null;
  private _lastResponseId: string | null = null;

  get status(): AdapterStatus {
    return this._status;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(config: AdapterConfig): Promise<void> {
    this._config = config;
    this._status = 'connecting';
    this._processExitCode = null;
    this._processOutputBuffer = '';
    this._messageAbortController = null;
    this._currentTurnId = null;
    this._lastResponseId = null;
    this._turnCounter = 0;

    this._apiKey =
      (config.extra?.['apiToken'] as string | undefined) ??
      crypto.randomBytes(24).toString('hex');

    this._apiPort = await getPort();
    this._apiHost =
      (config.extra?.['host'] as string | undefined) ?? '127.0.0.1';

    // Build spawn command — allow commandOverride via extra config for tests
    const command =
      (config.extra?.['command'] as string | undefined) ?? 'hermes';
    const defaultArgs = ['gateway', 'run', '--accept-hooks', '--replace'];
    const args = (
      (config.extra?.['args'] as string[] | undefined) ?? defaultArgs
    ).map((arg) => arg.replace(/\{\{PORT\}\}/g, String(this._apiPort)));
    const env: Record<string, string> = {
      API_SERVER_ENABLED: '1',
      API_SERVER_HOST: this._apiHost,
      API_SERVER_PORT: String(this._apiPort),
      API_SERVER_KEY: this._apiKey,
      HERMES_ACCEPT_HOOKS: '1',
    };

    this._process = spawn(command, args, {
      cwd: config.cwd,
      env: { ...process.env, ...env },
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

    await this.waitForGateway();

    this._status = 'connected';
    this.fire({
      type: 'chat:session-started',
      sessionId: config.sessionId,
      agentType: 'hermes',
    });
    this.fire({ type: 'chat:session-status', status: 'idle' });
  }

  protected async onDisconnect(): Promise<void> {
    this._messageAbortController?.abort();
    this._messageAbortController = null;
    this._currentTurnId = null;
    this._lastResponseId = null;

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

    this.fire({ type: 'chat:session-status', status: 'active' });
    this.fire({
      type: 'chat:turn-started',
      turnId,
      turnIndex: this._turnCounter++,
    });

    const body: Record<string, unknown> = {
      input: content,
      stream: true,
      store: true,
      session_id: sessionId,
    };
    if (this._lastResponseId) {
      body['previous_response_id'] = this._lastResponseId;
    }

    try {
      const url = `${this.baseUrl()}/v1/responses`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this._apiKey ? { Authorization: `Bearer ${this._apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: this._messageAbortController.signal,
      });

      if (!res.ok) {
        throw new Error(`Hermes sendMessage failed: ${res.status}`);
      }
      if (!res.body) {
        throw new Error(
          'Hermes sendMessage failed: streaming response has no body'
        );
      }

      await this.consumeResponsesSse(res.body);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        this._lastResponseId = null;
        this.fire({
          type: 'chat:turn-completed',
          turnId,
          reason: 'interrupted',
          durationMs: 0,
          toolCallCount: 0,
          messageCount: 0,
        });
        this.fire({ type: 'chat:session-status', status: 'idle' });
        this._currentTurnId = null;
        return;
      } else {
        this.fire({
          type: 'chat:error',
          kind: 'protocol',
          message:
            err instanceof Error ? err.message : 'Hermes sendMessage failed',
          retryable: true,
          turnId,
        });
        this.fire({
          type: 'chat:turn-completed',
          turnId,
          reason: 'failed',
          durationMs: 0,
          toolCallCount: 0,
          messageCount: 0,
        });
        this.fire({ type: 'chat:session-status', status: 'error' });
      }
      this._currentTurnId = null;
      throw err;
    } finally {
      this._messageAbortController = null;
    }
  }

  async interrupt(_turnId: string): Promise<void> {
    this._messageAbortController?.abort();
    const sessionId = this._config?.sessionId;
    if (!sessionId) return;
    try {
      await fetch(
        `${this.baseUrl()}/session/${encodeURIComponent(sessionId)}/abort`,
        { method: 'POST' }
      );
    } catch (err) {
      logger.warn('Failed to send Hermes abort request:', err);
    }
  }

  async respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void> {
    const action = decision === 'deny' ? 'deny' : 'allow';
    const res = await fetch(
      `${this.baseUrl()}/permission/${encodeURIComponent(requestId)}/${action}`,
      { method: 'POST' }
    );
    if (!res.ok) {
      throw new Error(`Hermes approval response failed: ${res.status}`);
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
    _requestId: string,
    _answers: Record<string, string[]>
  ): Promise<void> {
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
    return `http://${this._apiHost}:${this._apiPort}`;
  }

  private async waitForGateway(): Promise<void> {
    const healthUrl = `${this.baseUrl()}/health`;
    const deadline = Date.now() + 10000; // 10s timeout

    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          logger.info('Hermes API server ready on port', this._apiPort);
          return;
        }
      } catch {
        // expected while gateway is starting
      }
      if (this._processExitCode !== null) {
        const output = this._processOutputBuffer.trim();
        throw new Error(
          `Hermes gateway exited before API server became ready (code ${this._processExitCode})${
            output ? `: ${output}` : ''
          }`
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(
      `Hermes gateway did not become ready within 10s (tried ${healthUrl})`
    );
  }

  private async consumeResponsesSse(
    body: ReadableStream<Uint8Array>
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName: string | undefined;
    let eventData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataLine = line.slice(5).trim();
          eventData = eventData ? eventData + '\n' + dataLine : dataLine;
        } else if (line.trim() === '' && eventData) {
          try {
            const data = JSON.parse(eventData) as Record<string, unknown>;
            this.mapResponsesEvent(
              eventName ? { event: eventName, data } : { data }
            );
          } catch (err) {
            logger.debug('Failed to parse Hermes SSE event:', err);
          }
          eventName = undefined;
          eventData = '';
        }
      }
    }
  }

  private mapResponsesEvent(event: SseEvent): void {
    const type =
      typeof event.data['type'] === 'string' ? event.data['type'] : event.event;
    const turnId = this._currentTurnId ?? 'turn-0';

    switch (type) {
      case 'response.created': {
        const response = event.data['response'] as
          | Record<string, unknown>
          | undefined;
        const responseId = response?.['id'];
        if (typeof responseId === 'string') {
          this._lastResponseId = responseId;
        }
        break;
      }
      case 'response.output_text.delta': {
        const delta = event.data['delta'];
        if (typeof delta === 'string' && delta) {
          this.fire({
            type: 'chat:text-delta',
            turnId,
            messageId: `msg-${turnId}`,
            delta,
          });
        }
        break;
      }
      case 'response.output_item.added': {
        const item = event.data['item'] as Record<string, unknown> | undefined;
        if (item?.['type'] !== 'function_call') break;
        this.fire({
          type: 'chat:tool-call',
          turnId,
          toolCallId: String(
            item['call_id'] ?? item['id'] ?? crypto.randomUUID()
          ),
          toolName: String(item['name'] ?? 'unknown'),
          description: '',
          input: parseToolArguments(item['arguments']),
          status: 'running',
        });
        break;
      }
      case 'response.completed': {
        const response = event.data['response'] as
          | Record<string, unknown>
          | undefined;
        const responseId = response?.['id'];
        if (typeof responseId === 'string') {
          this._lastResponseId = responseId;
        }
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
        break;
      }
      case 'response.failed': {
        const response = event.data['response'] as
          | Record<string, unknown>
          | undefined;
        const error = response?.['error'] as
          | Record<string, unknown>
          | undefined;
        this._lastResponseId = null;
        this.fire({
          type: 'chat:error',
          kind: 'protocol',
          message: String(error?.['message'] ?? 'Hermes response failed'),
          retryable: true,
          turnId,
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
        break;
      }
      case 'permission.requested':
      case 'permission.asked': {
        this.handlePermissionRequested(event);
        break;
      }
      default:
        logger.debug('Unhandled Hermes Responses event:', type);
    }
  }

  private handlePermissionRequested(event: SseEvent): void {
    const props = event.data;
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

  /** Helper to build full ChatEvent from partial fields. */
  private fire(
    partial: {
      type: import('../../shared/chat-events.js').ChatEvent['type'];
    } & Record<string, unknown>
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
