import { AttachedRuntimeAdapter } from './attached-runtime-adapter.js';
import type { AdapterConfig, Attachment } from '../protocol-adapter.js';
import { createLogger } from '../logger.js';

const logger = createLogger('opencode-attached');

interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * Attached runtime adapter for OpenCode.
 *
 * Connects to a running `opencode serve` or `opencode web` instance via HTTP
 * and consumes the SSE `/event` stream for real-time updates.
 */
export class OpenCodeAttachedAdapter extends AttachedRuntimeAdapter {
  readonly agentType = 'opencode';

  private _endpoint = 'http://127.0.0.1:4096';
  private _sseAbortController: AbortController | null = null;
  private _messageAbortController: AbortController | null = null;
  private _turnCounter = 0;
  private _currentTurnId: string | null = null;

  protected async onConnect(config: AdapterConfig): Promise<void> {
    const endpoint =
      typeof config.extra?.['endpoint'] === 'string'
        ? config.extra['endpoint']
        : 'http://127.0.0.1:4096';
    this._endpoint = endpoint.replace(/\/$/, '');

    // Verify the server is reachable
    const healthRes = await fetch(`${this._endpoint}/global/health`).catch(
      () => null
    );
    if (!healthRes || !healthRes.ok) {
      throw new Error(`OpenCode server not reachable at ${this._endpoint}`);
    }

    // Start SSE connection to /event using fetch streaming
    this._sseAbortController = new AbortController();
    this.consumeSse(`${this._endpoint}/event`).catch((err) => {
      if (err instanceof Error && err.name !== 'AbortError') {
        logger.warn('OpenCode SSE error:', err);
        this._status = 'error';
        this.fire({
          type: 'chat:error',
          kind: 'protocol',
          message: 'OpenCode SSE connection error',
          retryable: true,
        });
      }
    });

    logger.info('OpenCode attached adapter connected to', this._endpoint);
  }

  protected async onDetach(): Promise<void> {
    this._sseAbortController?.abort();
    this._messageAbortController?.abort();
    this._sseAbortController = null;
    this._messageAbortController = null;
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
            const data = JSON.parse(eventData) as OpenCodeEvent;
            this.mapOpenCodeEvent(data);
          } catch (err) {
            logger.debug('Failed to parse SSE event:', err);
          }
          eventData = '';
        }
      }
    }
  }

  async sendMessage(
    turnId: string,
    content: string,
    _attachments?: Attachment[]
  ): Promise<void> {
    const sessionId = this._config?.sessionId;
    if (!sessionId) throw new Error('No session ID');

    this._messageAbortController = new AbortController();
    this._currentTurnId = turnId;

    const url = `${this._endpoint}/session/${encodeURIComponent(sessionId)}/prompt_async`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content }),
      signal: this._messageAbortController.signal,
    });

    if (!res.ok) {
      throw new Error(`OpenCode sendMessage failed: ${res.status}`);
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

    const url = `${this._endpoint}/session/${encodeURIComponent(sessionId)}/abort`;
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
    const url = `${this._endpoint}/permission/${encodeURIComponent(requestId)}/${allow ? 'allow' : 'deny'}`;
    await fetch(url, {
      method: 'POST',
      ...(this._messageAbortController
        ? { signal: this._messageAbortController.signal }
        : {}),
    }).catch(() => {});
  }

  async respondToInput(
    requestId: string,
    answers: Record<string, string[]>
  ): Promise<void> {
    const firstAnswer = Object.values(answers)[0]?.[0];
    if (!firstAnswer) return;

    const url = `${this._endpoint}/question/${encodeURIComponent(requestId)}/reply`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: firstAnswer }),
      ...(this._messageAbortController
        ? { signal: this._messageAbortController.signal }
        : {}),
    }).catch(() => {});
  }

  private mapOpenCodeEvent(event: OpenCodeEvent): void {
    const handler = this._eventHandlers[event.type];
    if (handler) {
      handler.call(this, event);
    } else {
      logger.debug('Unhandled OpenCode event:', event.type);
    }
  }

  private readonly _eventHandlers: Record<
    string,
    ((event: OpenCodeEvent) => void) | undefined
  > = {
    'session.status': (event) => {
      const status = event.properties?.['status'];
      if (status === 'idle') {
        this.fire({ type: 'chat:session-status', status: 'idle' });
      } else if (status === 'active') {
        this.fire({ type: 'chat:session-status', status: 'active' });
      } else if (status === 'error') {
        this.fire({ type: 'chat:session-status', status: 'error' });
      }
    },

    'message.part.updated': (event) => {
      const delta = event.properties?.['delta'];
      const turnId = this._currentTurnId ?? 'turn-0';
      if (typeof delta === 'string') {
        this.fire({
          type: 'chat:text-delta',
          turnId,
          messageId: `msg-${turnId}`,
          delta,
        });
      }
    },

    'permission.asked': (event) => {
      const props = event.properties ?? {};
      this.fire({
        type: 'chat:approval-request',
        turnId: this._currentTurnId ?? 'turn-0',
        requestId: String(props['requestID'] ?? 'req-0'),
        kind: 'permission',
        toolName: String(props['toolName'] ?? 'unknown'),
        description: String(props['description'] ?? ''),
        target: String(props['target'] ?? ''),
      });
    },

    'question.asked': (event) => {
      const props = event.properties ?? {};
      const rawQuestions = (props['questions'] as unknown[]) ?? [];
      // Map OpenCode questions array into canonical { question, fields }
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
    },

    'tool.execute.before': (event) => {
      const props = event.properties ?? {};
      const tool = props['tool'] as Record<string, unknown> | undefined;
      this.fire({
        type: 'chat:tool-call',
        turnId: this._currentTurnId ?? 'turn-0',
        toolCallId: String(props['toolCallId'] ?? 'tool-0'),
        toolName: String(tool?.['name'] ?? 'unknown'),
        description: String(tool?.['description'] ?? ''),
        input: (tool?.['input'] ?? {}) as Record<string, unknown>,
        status: 'running',
      });
    },

    'tool.execute.after': (event) => {
      const props = event.properties ?? {};
      const result = props['result'] as Record<string, unknown> | undefined;
      this.fire({
        type: 'chat:tool-result',
        turnId: this._currentTurnId ?? 'turn-0',
        toolCallId: String(props['toolCallId'] ?? 'tool-0'),
        toolName: String(props['toolName'] ?? 'unknown'),
        status: result?.['error'] ? 'error' : 'completed',
        output: String(result?.['output'] ?? ''),
        durationMs: Number(result?.['durationMs'] ?? 0),
        ...(result?.['error'] ? { error: String(result['error']) } : {}),
      });
    },

    'session.error': (event) => {
      const error = event.properties?.['error'];
      this.fire({
        type: 'chat:error',
        kind: 'unknown',
        message: String(error ?? 'Unknown error'),
        retryable: true,
      });
    },
  };
}
