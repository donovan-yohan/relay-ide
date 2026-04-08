import crypto from 'node:crypto';
import type { AdapterConfig } from '../protocol-adapter.js';
import {
  writeCodexHooksAdapter,
  cleanupCodexHooksAdapter,
} from '../codex-hooks-adapter.js';
import { BaseHookAdapter } from './base-hook-adapter.js';
import type { HookEventPayload } from './base-hook-adapter.js';
import { createLogger } from '../logger.js';

const logger = createLogger('codex-adapter');

function strField(
  data: Record<string, unknown> | undefined,
  key: string,
  fallback = ''
): string {
  return String(data?.[key] ?? fallback);
}

export class CodexProtocolAdapter extends BaseHookAdapter {
  readonly agentType = 'codex';

  private _codexConfigDir: string | null = null;

  protected buildSpawnCommand(_config: AdapterConfig): {
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    const env: Record<string, string> = {};
    if (this._codexConfigDir) {
      env['CODEX_CONFIG_DIR'] = this._codexConfigDir;
    }
    return { command: 'codex', args: [], env };
  }

  protected async setupHooks(config: AdapterConfig): Promise<void> {
    this._codexConfigDir = writeCodexHooksAdapter(
      config.sessionId,
      config.port,
      config.hookToken,
      config.configDir
    );
    logger.info('Codex hooks adapter written to', this._codexConfigDir);
  }

  protected async cleanupHooks(config: AdapterConfig): Promise<void> {
    cleanupCodexHooksAdapter(config.sessionId);
    this._codexConfigDir = null;
  }

  protected mapHookEvent(payload: HookEventPayload): void {
    switch (payload.type) {
      case 'session.started':
        logger.debug('Codex session.started received');
        break;
      case 'session.ended':
        this.handleSessionEnded();
        break;
      case 'prompt.submitted':
        this.fire({ type: 'chat:session-status', status: 'active' });
        break;
      case 'tool.started':
        this.handleToolStarted(payload);
        break;
      case 'tool.finished':
        this.handleToolFinished(payload);
        break;
      default:
        logger.debug('Unhandled Codex hook event:', payload.type);
    }
  }

  private handleSessionEnded(): void {
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

  private handleToolStarted(payload: HookEventPayload): void {
    const turnId = this._currentTurnId ?? 'turn-0';
    const tool = payload.data?.['tool'] as Record<string, unknown> | undefined;
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
    const errorVal = payload.data?.['error'];
    this.fire({
      type: 'chat:tool-result',
      turnId,
      toolCallId: strField(payload.data, 'toolCallId'),
      toolName: strField(payload.data, 'toolName', 'unknown'),
      status: errorVal ? 'error' : 'completed',
      output: strField(payload.data, 'output'),
      durationMs: Number(payload.data?.['durationMs'] ?? 0),
      ...(errorVal ? { error: String(errorVal) } : {}),
    });
  }
}
