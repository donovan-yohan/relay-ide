import crypto from 'node:crypto';
import type { AdapterConfig } from '../protocol-adapter.js';
import { installOpenCodeRelayPlugin } from '../opencode-relay.js';
import { BaseHookAdapter } from './base-hook-adapter.js';
import type { HookEventPayload } from './base-hook-adapter.js';
import { strField, objField } from './adapter-utils.js';
import { createLogger } from '../logger.js';

const logger = createLogger('opencode-adapter');

export class OpenCodeProtocolAdapter extends BaseHookAdapter {
  readonly agentType = 'opencode';

  protected buildSpawnCommand(config: AdapterConfig): {
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    return {
      command: 'opencode',
      args: [],
      env: {
        RELAY_IDE_URL: `http://127.0.0.1:${config.port}`,
        RELAY_IDE_SESSION_ID: config.sessionId,
        RELAY_IDE_TOKEN: config.hookToken,
      },
    };
  }

  protected async setupHooks(_config: AdapterConfig): Promise<void> {
    const pluginPath = installOpenCodeRelayPlugin();
    logger.info('OpenCode relay plugin installed at', pluginPath);
  }

  protected async cleanupHooks(_config: AdapterConfig): Promise<void> {
    // Plugin persists across sessions — no cleanup needed
  }

  protected mapHookEvent(payload: HookEventPayload): void {
    switch (payload.type) {
      case 'session.started':
        logger.debug('OpenCode session.started received');
        break;
      case 'session.idle':
        this.handleIdle();
        break;
      case 'state.changed':
        this.handleStateChanged(payload);
        break;
      case 'permission.requested':
        this.handlePermissionRequested(payload);
        break;
      case 'permission.resolved':
        this.handlePermissionResolved();
        break;
      case 'tool.started':
        this.handleToolStarted(payload);
        break;
      case 'tool.finished':
        this.handleToolFinished(payload);
        break;
      case 'telemetry.updated':
        this.handleTelemetry(payload);
        break;
      default:
        logger.debug('Unhandled OpenCode hook event:', payload.type);
    }
  }

  private handleIdle(): void {
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

  private handleStateChanged(payload: HookEventPayload): void {
    if (payload.data?.['status'] !== 'error') return;
    const errorMsg = strField(payload.data, 'error', 'Unknown error');
    this.fire({
      type: 'chat:error',
      kind: 'unknown',
      message: errorMsg,
      retryable: true,
    });
    this.fire({ type: 'chat:session-status', status: 'error' });
  }

  private handlePermissionRequested(payload: HookEventPayload): void {
    const turnId = this._currentTurnId ?? 'turn-0';
    const permission = objField(payload.data, 'permission');
    this.fire({
      type: 'chat:approval-request',
      turnId,
      requestId: strField(payload.data, 'requestId', crypto.randomUUID()),
      kind: 'permission',
      toolName: String(
        permission?.['tool'] ?? strField(payload.data, 'toolName', 'unknown')
      ),
      description: String(
        permission?.['description'] ?? strField(payload.data, 'description')
      ),
      target: String(
        permission?.['target'] ?? strField(payload.data, 'target')
      ),
    });
    this.fire({
      type: 'chat:session-status',
      status: 'idle',
      waitingOn: 'approval',
    });
  }

  private handlePermissionResolved(): void {
    if (this._currentTurnId) {
      this.fire({ type: 'chat:session-status', status: 'active' });
    }
  }

  private handleToolStarted(payload: HookEventPayload): void {
    const turnId = this._currentTurnId ?? 'turn-0';
    const tool = objField(payload.data, 'tool');
    this.fire({
      type: 'chat:tool-call',
      turnId,
      toolCallId: strField(payload.data, 'toolCallId', crypto.randomUUID()),
      toolName: String(
        tool?.['name'] ?? strField(payload.data, 'toolName', 'unknown')
      ),
      description: String(tool?.['description'] ?? ''),
      input: (tool?.['input'] ?? payload.data?.['input'] ?? {}) as Record<
        string,
        unknown
      >,
      status: 'running',
    });
  }

  private handleToolFinished(payload: HookEventPayload): void {
    const turnId = this._currentTurnId ?? 'turn-0';
    const result = objField(payload.data, 'result');
    const tool = objField(payload.data, 'tool');
    const errorVal = result?.['error'] ?? payload.data?.['error'];
    this.fire({
      type: 'chat:tool-result',
      turnId,
      toolCallId: strField(payload.data, 'toolCallId'),
      toolName: String(
        tool?.['name'] ?? strField(payload.data, 'toolName', 'unknown')
      ),
      status: errorVal ? 'error' : 'completed',
      output: String(result?.['output'] ?? strField(payload.data, 'output')),
      durationMs: Number(
        result?.['durationMs'] ?? payload.data?.['durationMs'] ?? 0
      ),
      ...(errorVal ? { error: String(errorVal) } : {}),
    });
  }

  private handleTelemetry(payload: HookEventPayload): void {
    const message = objField(payload.data, 'message');
    if (!message) return;
    const tokens = objField(message, 'tokens');
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
}
