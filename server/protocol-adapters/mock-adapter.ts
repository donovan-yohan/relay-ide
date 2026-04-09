import crypto from 'node:crypto';
import { BaseProtocolAdapter } from '../protocol-adapter.js';
import type {
  AdapterConfig,
  AdapterStatus,
  SessionOptions,
} from '../protocol-adapter.js';
import type { ChatEvent } from '../chat-events.js';
import { createLogger } from '../logger.js';

const logger = createLogger('mock-adapter');

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

interface ScenarioResult {
  toolCallCount: number;
  messageCount: number;
  durationMs: number;
}

/** Configurable delays for mock scenarios — pass zeros in tests for instant playback */
export interface MockAdapterDelays {
  wordMs: number;
  toolMs: number;
  connectMs: number;
  errorMs: number;
}

const DEFAULT_DELAYS: MockAdapterDelays = {
  wordMs: 50,
  toolMs: 100,
  connectMs: 150,
  errorMs: 500,
};

// ── MockProtocolAdapter ───────────────────────────────────────────────────────

export class MockProtocolAdapter extends BaseProtocolAdapter {
  readonly agentType = 'mock';

  _status: AdapterStatus = 'disconnected';
  _config: AdapterConfig | null = null;
  _abortController: AbortController | null = null;
  _pendingApprovals: Map<
    string,
    (decision: 'allow' | 'allow-always' | 'deny') => void
  > = new Map();

  private readonly delays: MockAdapterDelays;

  constructor(delays: Partial<MockAdapterDelays> = {}) {
    super();
    this.delays = { ...DEFAULT_DELAYS, ...delays };
  }

  get status(): AdapterStatus {
    return this._status;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(config: AdapterConfig): Promise<void> {
    this._config = config;
    this._status = 'connecting';
    await sleep(this.delays.connectMs);
    this._status = 'connected';
    this.fire({
      type: 'chat:session-started',
      sessionId: config.sessionId,
      agentType: 'mock',
    });
    this.fire({
      type: 'chat:session-status',
      status: 'idle',
    });
  }

  protected async onDisconnect(): Promise<void> {
    this._abortController?.abort();
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
    _attachments?: import('../protocol-adapter.js').Attachment[]
  ): Promise<void> {
    // Abort any in-flight turn before starting a new one
    this._abortController?.abort();
    const controller = new AbortController();
    this._abortController = controller;
    const signal = controller.signal;

    const scenarioMatch = /scenario:(\S+)/i.exec(content);
    const scenarioName = scenarioMatch?.[1] ?? 'happy-path';

    const startMs = Date.now();

    this.fire({ type: 'chat:session-status', status: 'active' });
    this.fire({ type: 'chat:turn-started', turnId, turnIndex: 0 });

    try {
      const result = await this.runScenario(scenarioName, turnId, signal);
      this.fire({
        type: 'chat:turn-completed',
        turnId,
        reason: 'completed',
        durationMs: result.durationMs,
        toolCallCount: result.toolCallCount,
        messageCount: result.messageCount,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.fire({
          type: 'chat:turn-completed',
          turnId,
          reason: 'interrupted',
          durationMs: 0,
          toolCallCount: 0,
          messageCount: 0,
        });
      } else {
        this.fire({
          type: 'chat:turn-completed',
          turnId,
          reason: 'failed',
          durationMs: Date.now() - startMs,
          toolCallCount: 0,
          messageCount: 0,
        });
      }
    }

    this.fire({ type: 'chat:session-status', status: 'idle' });
  }

  async interrupt(_turnId: string): Promise<void> {
    this._abortController?.abort();
  }

  async respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void> {
    const resolver = this._pendingApprovals.get(requestId);
    if (resolver) {
      resolver(decision);
      this._pendingApprovals.delete(requestId);
    }
  }

  async respondToInput(
    _requestId: string,
    _answers: Record<string, string[]>
  ): Promise<void> {
    // no-op for mock
  }

  async createSession(
    _cwd: string,
    _options?: SessionOptions
  ): Promise<string> {
    return 'mock-session-' + crypto.randomBytes(4).toString('hex');
  }

  async resumeSession(_sessionId: string): Promise<void> {
    // no-op for mock
  }

  async forkSession(_sessionId: string): Promise<string> {
    return 'mock-fork-' + crypto.randomBytes(4).toString('hex');
  }

  // ── Event Helper ──────────────────────────────────────────────────────────

  private fire(
    partial: { type: ChatEvent['type'] } & Record<string, unknown>
  ): void {
    const sessionId = this._config?.sessionId ?? 'mock';
    this.emit({
      ...partial,
      sessionId,
      timestamp: nowIso(),
      source: 'mock',
    } as ChatEvent);
  }

  /** Stream text word-by-word, then emit a MessageCompleteEvent */
  private async streamText(
    turnId: string,
    messageId: string,
    text: string,
    signal: AbortSignal
  ): Promise<void> {
    for (const word of text.split(' ')) {
      await sleep(this.delays.wordMs, signal);
      this.fire({
        type: 'chat:text-delta',
        turnId,
        messageId,
        delta: word + ' ',
      });
    }
    this.fire({
      type: 'chat:message-complete',
      turnId,
      messageId,
      role: 'assistant',
      content: text,
    });
  }

  // ── Scenarios ─────────────────────────────────────────────────────────────

  private async runScenario(
    name: string,
    turnId: string,
    signal: AbortSignal
  ): Promise<ScenarioResult> {
    switch (name) {
      case 'happy-path':
        return this.scenarioHappyPath(turnId, signal);
      case 'tool-chain':
        return this.scenarioToolChain(turnId, signal);
      case 'approval-flow':
        return this.scenarioApprovalFlow(turnId, signal);
      case 'file-changes':
        return this.scenarioFileChanges(turnId, signal);
      case 'error-recovery':
        return this.scenarioErrorRecovery(turnId, signal);
      default:
        logger.warn('Unknown mock scenario, falling back to happy-path', {
          name,
        });
        return this.scenarioHappyPath(turnId, signal);
    }
  }

  private async scenarioHappyPath(
    turnId: string,
    signal: AbortSignal
  ): Promise<ScenarioResult> {
    await this.streamText(
      turnId,
      'msg-happy-1',
      'hello! this is a mock response.',
      signal
    );
    return { toolCallCount: 0, messageCount: 1, durationMs: 500 };
  }

  private async scenarioToolChain(
    turnId: string,
    signal: AbortSignal
  ): Promise<ScenarioResult> {
    const messageId = 'msg-toolchain-1';

    // Tool 1: Read
    this.fire({
      type: 'chat:tool-call',
      turnId,
      toolCallId: 'tool-1',
      toolName: 'Read',
      description: 'Reading server/index.ts',
      input: { file_path: 'server/index.ts' },
      status: 'running',
    });
    await sleep(this.delays.toolMs, signal);
    for (const line of ['line 1\n', 'line 2\n', 'line 3\n']) {
      this.fire({
        type: 'chat:tool-output-delta',
        turnId,
        toolCallId: 'tool-1',
        delta: line,
      });
    }
    this.fire({
      type: 'chat:tool-result',
      turnId,
      toolCallId: 'tool-1',
      toolName: 'Read',
      status: 'completed',
      durationMs: 200,
    });

    // Tool 2: Bash
    this.fire({
      type: 'chat:tool-call',
      turnId,
      toolCallId: 'tool-2',
      toolName: 'Bash',
      description: 'Running git status',
      input: { command: 'git status' },
      status: 'running',
    });
    await sleep(this.delays.toolMs, signal);
    this.fire({
      type: 'chat:tool-result',
      turnId,
      toolCallId: 'tool-2',
      toolName: 'Bash',
      status: 'completed',
      output: 'On branch main\nnothing to commit',
      durationMs: 150,
    });

    await this.streamText(
      turnId,
      messageId,
      'done! read the file and checked git status.',
      signal
    );
    return { toolCallCount: 2, messageCount: 1, durationMs: 800 };
  }

  private async scenarioApprovalFlow(
    turnId: string,
    signal: AbortSignal
  ): Promise<ScenarioResult> {
    const messageId = 'msg-approval-1';

    this.fire({
      type: 'chat:tool-call',
      turnId,
      toolCallId: 'tool-1',
      toolName: 'Bash',
      description: 'Running dangerous command',
      input: { command: 'rm -rf /tmp/test' },
      status: 'pending',
    });
    this.fire({
      type: 'chat:approval-request',
      turnId,
      requestId: 'req-1',
      kind: 'command',
      toolName: 'Bash',
      description: 'Run: rm -rf /tmp/test',
      target: 'rm -rf /tmp/test',
      timeoutMs: 30000,
    });

    const decision = await new Promise<'allow' | 'allow-always' | 'deny'>(
      (resolve, reject) => {
        this._pendingApprovals.set('req-1', resolve);
        signal.addEventListener(
          'abort',
          () => {
            this._pendingApprovals.delete('req-1');
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true }
        );
      }
    );

    this.fire({
      type: 'chat:approval-response',
      turnId,
      requestId: 'req-1',
      decision,
      respondedBy: 'user',
    });

    let responseText: string;
    if (decision === 'allow' || decision === 'allow-always') {
      this.fire({
        type: 'chat:tool-call',
        turnId,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        description: 'Running dangerous command',
        input: { command: 'rm -rf /tmp/test' },
        status: 'running',
      });
      await sleep(this.delays.toolMs * 2, signal);
      this.fire({
        type: 'chat:tool-result',
        turnId,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        status: 'completed',
        durationMs: 200,
      });
      responseText = 'ok, done.';
    } else {
      this.fire({
        type: 'chat:tool-call',
        turnId,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        description: 'Running dangerous command',
        input: { command: 'rm -rf /tmp/test' },
        status: 'declined',
      });
      this.fire({
        type: 'chat:tool-result',
        turnId,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        status: 'declined',
        durationMs: 0,
      });
      responseText = 'understood, skipping.';
    }

    await this.streamText(turnId, messageId, responseText, signal);
    return { toolCallCount: 1, messageCount: 1, durationMs: 500 };
  }

  private async scenarioFileChanges(
    turnId: string,
    signal: AbortSignal
  ): Promise<ScenarioResult> {
    const files = ['server/index.ts', 'server/ws.ts', 'server/sessions.ts'];

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const toolCallId = `tool-${i + 1}`;
      this.fire({
        type: 'chat:tool-call',
        turnId,
        toolCallId,
        toolName: 'Edit',
        description: `Editing ${file}`,
        input: { file_path: file },
        status: 'running',
      });
      await sleep(this.delays.toolMs, signal);
      this.fire({
        type: 'chat:file-change',
        turnId,
        toolCallId,
        path: file,
        kind: 'modified',
        additions: 5,
        deletions: 2,
      });
      this.fire({
        type: 'chat:tool-result',
        turnId,
        toolCallId,
        toolName: 'Edit',
        status: 'completed',
        durationMs: 100,
      });
    }

    await this.streamText(
      turnId,
      'msg-filechange-1',
      'updated 3 files.',
      signal
    );
    return { toolCallCount: 3, messageCount: 1, durationMs: 600 };
  }

  private async scenarioErrorRecovery(
    turnId: string,
    signal: AbortSignal
  ): Promise<ScenarioResult> {
    const messageId = 'msg-error-1';

    this.fire({
      type: 'chat:text-delta',
      turnId,
      messageId,
      delta: 'starting task...',
    });
    await sleep(this.delays.toolMs * 2, signal);

    this.fire({
      type: 'chat:error',
      kind: 'network',
      message: 'connection to model timed out',
      retryable: true,
      turnId,
    });

    await sleep(this.delays.errorMs, signal);

    await this.streamText(
      turnId,
      messageId,
      'retrying... success! task complete.',
      signal
    );
    return { toolCallCount: 0, messageCount: 1, durationMs: 1000 };
  }
}
