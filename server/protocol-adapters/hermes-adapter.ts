import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export interface HermesGatewaySettings {
  endpoint: string;
  apiKey: string | null;
  source: string;
}

export interface HermesGatewayProbeResult {
  available: boolean;
  endpoint: string;
  source: string;
  retryable: boolean;
  reason?: string;
}

const DEFAULT_HERMES_ENDPOINT = 'http://127.0.0.1:8642';
const ENDPOINT_ENV_KEYS = [
  'HERMES_API_ENDPOINT',
  'HERMES_API_BASE_URL',
  'HERMES_API_URL',
];
const TOKEN_ENV_KEYS = [
  'HERMES_API_TOKEN',
  'HERMES_API_KEY',
  'HERMES_GATEWAY_API_KEY',
  'API_SERVER_KEY',
];

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const result: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      if (!key) continue;
      let value = (match[2] ?? '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function stripYamlInlineComment(value: string): string {
  let quote: 'single' | 'double' | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
    } else if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
    } else if (char === '#' && quote === null) {
      if (i === 0 || /\s/.test(value[i - 1] ?? '')) {
        return value.slice(0, i).trim();
      }
    }
  }
  return value.trim();
}

function parseYamlScalar(value: string): string {
  let parsed = stripYamlInlineComment(value).trim();
  if (
    (parsed.startsWith('"') && parsed.endsWith('"')) ||
    (parsed.startsWith("'") && parsed.endsWith("'"))
  ) {
    parsed = parsed.slice(1, -1);
  }
  return parsed;
}

function readSimpleYamlScalars(filePath: string): Map<string, string> {
  const values = new Map<string, string>();
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stack: Array<{ indent: number; key: string }> = [];
    for (const rawLine of content.split(/\r?\n/)) {
      if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
      const match = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
      if (!match) continue;
      const indent = match[1]?.length ?? 0;
      const key = match[2];
      const rawValue = match[3] ?? '';
      if (!key) continue;
      while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
        stack.pop();
      }
      const pathParts = [...stack.map((entry) => entry.key), key];
      const value = parseYamlScalar(rawValue);
      if (value === '') {
        stack.push({ indent, key });
      } else {
        values.set(pathParts.join('.'), value);
      }
    }
  } catch {
    // Missing or malformed config is fine; fall back to env/defaults.
  }
  return values;
}

function firstConfigValue(
  values: Map<string, string>,
  prefixes: string[],
  keys: string[]
): string | null {
  for (const prefix of prefixes) {
    for (const key of keys) {
      const value = nonEmpty(values.get(`${prefix}.${key}`));
      if (value) return value;
    }
  }
  return null;
}

function configBoolean(value: string | null): boolean | null {
  if (value == null) return null;
  const normalized = value.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function firstConfigBoolean(
  values: Map<string, string>,
  prefixes: string[],
  keys: string[]
): boolean | null {
  for (const prefix of prefixes) {
    const value = configBoolean(firstConfigValue(values, [prefix], keys));
    if (value !== null) return value;
  }
  return null;
}

interface HermesConfigApiServerSettings {
  endpoint: string | null;
  apiKey: string | null;
  disabled: boolean;
}

function readHermesConfigApiServerFile(
  filePath: string
): HermesConfigApiServerSettings {
  const values = readSimpleYamlScalars(filePath);
  const prefixes = [
    'api_server',
    'platforms.api_server',
    'gateway.platforms.api_server',
    'gateway.api_server',
  ];
  const enabled = firstConfigBoolean(values, prefixes, [
    'enabled',
    'extra.enabled',
  ]);
  const host = firstConfigValue(values, prefixes, ['host', 'extra.host']);
  const port = firstConfigValue(values, prefixes, ['port', 'extra.port']);
  const apiKey = firstConfigValue(values, prefixes, [
    'key',
    'extra.key',
    'api_key',
    'apiKey',
    'token',
  ]);

  const disabled = enabled === false;
  const endpoint = disabled
    ? null
    : enabled === true || host || port
      ? `http://${host ?? '127.0.0.1'}:${port ?? '8642'}`
      : null;

  return {
    endpoint,
    apiKey: disabled ? null : apiKey,
    disabled,
  };
}

function readHermesConfigApiServer(): HermesConfigApiServerSettings {
  const merged: HermesConfigApiServerSettings = {
    endpoint: null,
    apiKey: null,
    disabled: false,
  };
  for (const home of candidateHermesHomes()) {
    const settings = readHermesConfigApiServerFile(
      path.join(home, 'config.yaml')
    );
    if (settings.disabled) {
      merged.endpoint = null;
      merged.apiKey = null;
      merged.disabled = true;
      continue;
    }
    if (settings.endpoint) {
      merged.endpoint = settings.endpoint;
      merged.disabled = false;
    }
    if (settings.apiKey) merged.apiKey = settings.apiKey;
  }
  return merged;
}

function addCandidate(candidates: string[], value: string | null): void {
  if (value && !candidates.includes(value)) candidates.push(value);
}

function addHomeWithActiveProfile(
  candidates: string[],
  home: string | null
): void {
  if (!home) return;
  addCandidate(candidates, home);
  try {
    const activeProfile = fs
      .readFileSync(path.join(home, 'active_profile'), 'utf8')
      .trim();
    if (activeProfile) {
      addCandidate(candidates, path.join(home, 'profiles', activeProfile));
    }
  } catch {
    // No active profile marker for this home.
  }
}

function candidateHermesHomes(): string[] {
  const home = os.homedir();
  const root = path.join(home, '.hermes');
  const candidates: string[] = [];

  // Merge from broadest to most specific so profile/env homes win.
  addHomeWithActiveProfile(candidates, root);
  addHomeWithActiveProfile(candidates, nonEmpty(process.env['HERMES_HOME']));
  return candidates;
}

function readHermesEnv(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const home of candidateHermesHomes()) {
    Object.assign(merged, parseEnvFile(path.join(home, '.env')));
  }
  return merged;
}

function firstEnvValue(
  keys: string[],
  fileEnv: Record<string, string>
): string | null {
  for (const key of keys) {
    const value = nonEmpty(process.env[key]) ?? nonEmpty(fileEnv[key]);
    if (value) return value;
  }
  return null;
}

function endpointFromApiServerEnv(
  fileEnv: Record<string, string>
): string | null {
  const port =
    nonEmpty(process.env['API_SERVER_PORT']) ??
    nonEmpty(fileEnv['API_SERVER_PORT']);
  if (!port) return null;
  const host =
    nonEmpty(process.env['API_SERVER_HOST']) ??
    nonEmpty(fileEnv['API_SERVER_HOST']) ??
    '127.0.0.1';
  return `http://${host}:${port}`;
}

export function resolveHermesGatewaySettings(
  extra: Record<string, unknown> | undefined
): HermesGatewaySettings {
  const fileEnv = readHermesEnv();
  const configApiServer = readHermesConfigApiServer();
  const explicitEndpoint = nonEmpty(extra?.['endpoint']);
  const envEndpoint =
    firstEnvValue(ENDPOINT_ENV_KEYS, fileEnv) ??
    endpointFromApiServerEnv(fileEnv);
  const configEndpoint = configApiServer.endpoint;
  const endpoint = (
    explicitEndpoint ??
    envEndpoint ??
    configEndpoint ??
    DEFAULT_HERMES_ENDPOINT
  ).replace(/\/+$/, '');
  const apiKey =
    nonEmpty(extra?.['apiToken']) ??
    nonEmpty(extra?.['apiKey']) ??
    firstEnvValue(TOKEN_ENV_KEYS, fileEnv) ??
    configApiServer.apiKey;

  return {
    endpoint,
    apiKey,
    source: explicitEndpoint
      ? 'adapter config'
      : envEndpoint
        ? 'environment'
        : configEndpoint
          ? 'Hermes config'
          : 'default',
  };
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Response> {
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function gatewayHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function probeHermesGatewayApi(
  extra: Record<string, unknown> | undefined,
  timeoutMs = 500
): Promise<HermesGatewayProbeResult> {
  const settings = resolveHermesGatewaySettings(extra);
  const headers = gatewayHeaders(settings.apiKey);

  try {
    const health = await fetchWithTimeout(
      `${settings.endpoint}/health`,
      headers,
      timeoutMs
    );
    if (health.status === 401 || health.status === 403) {
      return {
        available: false,
        endpoint: settings.endpoint,
        source: settings.source,
        retryable: false,
        reason: `Hermes gateway at ${settings.endpoint} rejected Relay authentication. Set HERMES_API_TOKEN to the gateway API_SERVER_KEY.`,
      };
    }
    if (!health.ok) {
      return {
        available: false,
        endpoint: settings.endpoint,
        source: settings.source,
        retryable: health.status >= 500,
        reason: `Hermes gateway health check failed at ${settings.endpoint}: HTTP ${health.status}`,
      };
    }

    const models = await fetchWithTimeout(
      `${settings.endpoint}/v1/models`,
      headers,
      timeoutMs
    );
    if (models.status === 401 || models.status === 403) {
      return {
        available: false,
        endpoint: settings.endpoint,
        source: settings.source,
        retryable: false,
        reason: `Hermes API server at ${settings.endpoint} rejected Relay authentication. Set HERMES_API_TOKEN to the gateway API_SERVER_KEY.`,
      };
    }
    if (models.status === 404) {
      return {
        available: false,
        endpoint: settings.endpoint,
        source: settings.source,
        retryable: false,
        reason: `Hermes gateway is reachable at ${settings.endpoint}, but the Responses API is not enabled there. Start the host Hermes gateway with API_SERVER_ENABLED=1, or set HERMES_API_ENDPOINT to the Hermes API server.`,
      };
    }
    if (!models.ok) {
      return {
        available: false,
        endpoint: settings.endpoint,
        source: settings.source,
        retryable: models.status >= 500,
        reason: `Hermes API server probe failed at ${settings.endpoint}: HTTP ${models.status}`,
      };
    }

    return {
      available: true,
      endpoint: settings.endpoint,
      source: settings.source,
      retryable: false,
    };
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      endpoint: settings.endpoint,
      source: settings.source,
      retryable: true,
      reason: `Hermes gateway API is not reachable at ${settings.endpoint} (${settings.source}). Start the host Hermes gateway with API_SERVER_ENABLED=1, or set HERMES_API_ENDPOINT for relay-ide. Last error: ${lastError}`,
    };
  }
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
 * Attaches to the host Hermes gateway API server and drives the agent through
 * Hermes' OpenAI-compatible Responses streaming endpoint.
 */
export class HermesProtocolAdapter extends BaseProtocolAdapter {
  readonly agentType = 'hermes';
  readonly runtimeOwnership = 'attached' as const;

  private _status: AdapterStatus = 'disconnected';
  private _config: AdapterConfig | null = null;
  private _endpoint = DEFAULT_HERMES_ENDPOINT;
  private _settingsSource = 'default';
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
    this._messageAbortController = null;
    this._currentTurnId = null;
    this._lastResponseId = null;
    this._turnCounter = 0;

    const settings = resolveHermesGatewaySettings(config.extra);
    this._endpoint = settings.endpoint;
    this._apiKey = settings.apiKey;
    this._settingsSource = settings.source;

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
        headers: this.headers({ 'Content-Type': 'application/json' }),
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
        { method: 'POST', headers: this.headers() }
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
      { method: 'POST', headers: this.headers() }
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
    return this._endpoint;
  }

  private headers(
    headers: Record<string, string> = {}
  ): Record<string, string> {
    return {
      ...headers,
      ...gatewayHeaders(this._apiKey),
    };
  }

  private async waitForGateway(): Promise<void> {
    const deadline = Date.now() + 3000;
    let lastReason: string | undefined;

    while (Date.now() < deadline) {
      const probe = await probeHermesGatewayApi(this._config?.extra, 500);
      lastReason = probe.reason;
      if (probe.available) {
        logger.info('Hermes API server reachable at', this._endpoint);
        return;
      }
      if (!probe.retryable) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(
      lastReason ??
        `Hermes gateway API is not reachable at ${this._endpoint} (${this._settingsSource}). Start the host Hermes gateway with API_SERVER_ENABLED=1, or set HERMES_API_ENDPOINT for relay-ide.`
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
