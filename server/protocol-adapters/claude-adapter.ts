import crypto from 'node:crypto';
import type { AdapterConfig } from '../protocol-adapter.js';
import { BaseHookAdapter } from './base-hook-adapter.js';
import type { HookEventPayload } from './base-hook-adapter.js';
import { strField } from './adapter-utils.js';
import { createLogger } from '../logger.js';

const logger = createLogger('claude-adapter');

export class ClaudeProtocolAdapter extends BaseHookAdapter {
  readonly agentType = 'claude';

  protected buildSpawnCommand(config: AdapterConfig): {
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    const args = ['--output-format', 'stream-json'];
    if (config.permissionMode) {
      args.push('--allowedTools', config.permissionMode);
    }
    return {
      command: 'claude',
      args,
      env: {
        CLAUDE_CODE_NO_FLICKER: '1',
        CLAUDE_CODE_HOOKS_URL: `http://127.0.0.1:${config.port}/hooks/agent-event`,
        CLAUDE_CODE_HOOKS_TOKEN: config.hookToken,
        CLAUDE_CODE_SESSION_ID: config.sessionId,
      },
    };
  }

  protected async setupHooks(_config: AdapterConfig): Promise<void> {
    logger.info('Claude hooks configured via environment variables');
  }

  protected async cleanupHooks(_config: AdapterConfig): Promise<void> {
    // No temp files to clean up for Claude
  }

  protected mapHookEvent(payload: HookEventPayload): void {
    switch (payload.type) {
      case 'assistant':
        this.handleAssistant(payload);
        break;
      case 'tool.started':
      case 'PreToolUse':
        this.handleToolStarted(payload);
        break;
      case 'tool.finished':
      case 'PostToolUse':
        this.handleToolFinished(payload);
        break;
      case 'session.idle':
      case 'Stop':
        this.handleIdle();
        break;
      case 'permission.requested':
      case 'notification':
        this.handlePermission(payload);
        break;
      default:
        logger.debug('Unhandled Claude hook event:', payload.type);
    }
  }

  private handleAssistant(payload: HookEventPayload): void {
    const content = payload.data?.['content'] as string | undefined;
    if (!content) return;
    const turnId = this._currentTurnId ?? 'turn-0';
    this.fire({
      type: 'chat:text-delta',
      turnId,
      messageId: `msg-${turnId}`,
      delta: content,
    });
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

  private handlePermission(payload: HookEventPayload): void {
    if (
      payload.data?.['type'] !== 'permission' &&
      !payload.data?.['permission']
    )
      return;
    const turnId = this._currentTurnId ?? 'turn-0';
    this.fire({
      type: 'chat:approval-request',
      turnId,
      requestId: strField(payload.data, 'requestId', crypto.randomUUID()),
      kind: 'permission',
      toolName: strField(payload.data, 'toolName', 'unknown'),
      description: strField(payload.data, 'description'),
      target: strField(payload.data, 'target'),
    });
    this.fire({
      type: 'chat:session-status',
      status: 'idle',
      waitingOn: 'approval',
    });
  }
}
