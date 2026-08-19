import { AttachedRuntimeAdapter } from './attached-runtime-adapter.js';
import type { AdapterConfig, Attachment } from '../protocol-adapter.js';
import { openCodeStatusType } from './opencode-shared.js';
import { createLogger } from '../logger.js';

const logger = createLogger('opencode-attached');
const DEFAULT_OPENCODE_ATTACHED_ENDPOINT = 'http://127.0.0.1:4096';

export interface OpenCodeAttachedProbeResult {
  available: boolean;
  endpoint: string;
  reason?: string;
}

function resolveOpenCodeAttachedEndpoint(
  extra: Record<string, unknown> | undefined
): string {
  const endpoint =
    typeof extra?.['endpoint'] === 'string'
      ? extra['endpoint']
      : DEFAULT_OPENCODE_ATTACHED_ENDPOINT;
  return endpoint.replace(/\/$/, '');
}

/** Probe the same HTTP health endpoint used when the attached adapter connects. */
export async function probeOpenCodeAttachedApi(
  extra: Record<string, unknown> | undefined,
  timeoutMs = 500
): Promise<OpenCodeAttachedProbeResult> {
  const endpoint = resolveOpenCodeAttachedEndpoint(extra);
  try {
    const response = await fetch(`${endpoint}/global/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        available: false,
        endpoint,
        reason: `OpenCode server health check failed at ${endpoint}: HTTP ${response.status}`,
      };
    }
    return { available: true, endpoint };
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      endpoint,
      reason: `OpenCode server is not reachable at ${endpoint}. Start opencode serve or opencode web there and try again. Last error: ${lastError}`,
    };
  }
}

interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/** Why the active turn stopped, in this adapter's own vocabulary. */
type OpenCodeTurnEndReason = 'completed' | 'failed' | 'interrupted';

/**
 * Attached runtime adapter for OpenCode.
 *
 * Connects to a running `opencode serve` or `opencode web` instance via HTTP
 * and consumes the SSE `/event` stream for real-time updates.
 *
 * Turn lifecycle (#1412). This adapter used to start turns and never end them:
 * no handler fired `chat:turn-completed`, so `agent-turn-completed-v2` was
 * unreachable in `completed`, `failed`, and `interrupted` form alike and the
 * channel binder had to finalize every turn from a bare idle live-state — a
 * compensation it deliberately skips while an approval is outstanding. The turn
 * now ends from three places, all of them local QUIRK (this harness's own event
 * vocabulary and abort semantics):
 *
 *  - `session.status` idle/error — the server told us the run stopped.
 *  - `session.error` — carried on the `chat:error` as a turnId so the failure
 *    binds to the turn instead of floating at session level.
 *  - `interrupt()` — `prompt_async` returns immediately, so unlike the spawned
 *    `OpenCodeProtocolAdapter` there is no in-flight POST whose `AbortError`
 *    could signal the stop; a SUCCESSFUL abort ack is the evidence, and an
 *    abort the server refused ends nothing.
 *
 * "Exactly one terminal per turn" is CHOREOGRAPHY and stays where #1411 put it,
 * in `LegacyProtocolAdapterV2Bridge`: this adapter only has to end the turn
 * honestly, and a redundant completion is deduped one layer up.
 */
export class OpenCodeAttachedAdapter extends AttachedRuntimeAdapter {
  readonly agentType = 'opencode';

  private _endpoint = DEFAULT_OPENCODE_ATTACHED_ENDPOINT;
  private _sseAbortController: AbortController | null = null;
  private _messageAbortController: AbortController | null = null;
  private _turnCounter = 0;
  private _currentTurnId: string | null = null;
  /**
   * Turn the operator asked to abort. Read when the server settles back to
   * idle, so a stop is reported as `interrupted` rather than `completed` even
   * when the idle beats the abort POST's own ack.
   */
  private _interruptedTurnId: string | null = null;
  /**
   * Turn each outstanding approval was asked in, keyed by the provider's
   * request id. Recorded when the request arrives rather than read back at
   * response time: now that idle closes the turn and clears `_currentTurnId`
   * (#1412), an approval answered after that idle would otherwise bind its
   * response to the fabricated `turn-0` while its card lives in the real turn,
   * leaving the card pending forever in the reduced session.
   */
  private readonly _approvalTurnIds = new Map<string, string>();

  protected async onConnect(config: AdapterConfig): Promise<void> {
    this._endpoint = resolveOpenCodeAttachedEndpoint(config.extra);
    // A re-attach starts from no turn: leaving a stale id here would let the
    // first `session.status` of the new stream close a turn that is gone.
    this._currentTurnId = null;
    this._interruptedTurnId = null;
    // Approvals belong to the session that asked them; a re-attach replaces it.
    this._approvalTurnIds.clear();

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

  /**
   * `config.systemPromptAppendix` is NOT delivered here, and cannot be on this
   * transport (#1409, documented impossibility). The attached adapter owns no
   * session: `opencode serve` / `opencode web` created it, with whatever agent
   * instructions that process was started with, and the only route this adapter
   * has into it is `POST /session/<id>/prompt_async { text }` — a user turn,
   * not a system region. Folding the appendix into `text` would put Relay's
   * runtime contract in the operator's message on every turn, which is both a
   * lie about who said it and outside the system region the prefix-cache
   * invariant is stated over. Delivering it would need an instructions field on
   * the prompt route or a session-create route this adapter never calls.
   */
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

    // Record the intent before the await: the server may emit `session.status`
    // idle while the abort POST is still in flight, and that idle must close
    // the turn as `interrupted`, not `completed`.
    this._interruptedTurnId = this._currentTurnId;

    const url = `${this._endpoint}/session/${encodeURIComponent(sessionId)}/abort`;
    const res = await fetch(url, {
      method: 'POST',
      ...(this._messageAbortController
        ? { signal: this._messageAbortController.signal }
        : {}),
    }).catch(() => null);

    // `prompt_async` left no in-flight request to abort, so the ack is the only
    // synchronous evidence the run stopped — and it has to be a real ack. An
    // abort the server refused or never received leaves the run going, so
    // completing here would close a live turn and strand every later
    // `message.part.updated` on a finished one. The intent recorded above still
    // stands: whenever the server does settle, that idle reports `interrupted`.
    if (!res || !res.ok) {
      logger.warn(
        `OpenCode abort for session ${sessionId} was not accepted${
          res ? `: HTTP ${res.status}` : ''
        }; leaving the turn for the server's own idle or error to end`
      );
      return;
    }

    // If the idle already closed the turn this is a no-op; if the server never
    // idles, the turn still ends here on the ack.
    this.completeCurrentTurn('interrupted');
  }

  async respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void> {
    const allow = decision === 'allow' || decision === 'allow-always';
    const url = `${this._endpoint}/permission/${encodeURIComponent(requestId)}/${allow ? 'allow' : 'deny'}`;
    const res = await fetch(url, {
      method: 'POST',
      ...(this._messageAbortController
        ? { signal: this._messageAbortController.signal }
        : {}),
    }).catch(() => null);

    // Only claim the approval resolved when the server accepted the decision;
    // announcing it on a failed POST would strand the UI on a lie. On success
    // the response patch is what moves the approval item out of `pending` and
    // drains `live.activeRequestIds` (#1412).
    if (!res || !res.ok) {
      logger.warn(
        `OpenCode permission ${decision} for ${requestId} was not accepted${
          res ? `: HTTP ${res.status}` : ''
        }`
      );
      return;
    }
    // The turn the request was ASKED in, not whatever turn is live now: the
    // approval may well be answered after the idle that closed its turn, and
    // the response has to land on the same turn as the card it resolves.
    const turnId =
      this._approvalTurnIds.get(requestId) ?? this._currentTurnId ?? 'turn-0';
    this._approvalTurnIds.delete(requestId);
    this.fire({
      type: 'chat:approval-response',
      requestId,
      decision,
      respondedBy: 'user',
      turnId,
    });
  }

  /**
   * Resume honesty (#1409). The base attached adapter treats `resumeSession`
   * as a silent success, which reads as "the conversation is restored" to every
   * caller. It is not: this adapter addresses the external server's session by
   * `config.sessionId`, handed to it at connect, and Relay never learns an
   * OpenCode-side conversation id it could rebind to later. That is why
   * `PROVIDER_DESCRIPTORS['opencode-attached'].resumeStateKey` is `null` and
   * `bridgedCapabilities.resume` is `false` — and why `providerResumeId()`
   * returns nothing for this provider, so `channel-agent-binder` re-orients a
   * respawned runtime from its bounded context window (#1408) instead of
   * assuming provider memory it does not have.
   *
   * Failing loudly keeps that ladder honest: a caller that reaches here has
   * bypassed the capability flag, and a silent no-op would hide the bypass.
   */
  override async resumeSession(sessionId: string): Promise<void> {
    throw new Error(
      `opencode-attached cannot resume session ${sessionId}: the attached session id comes from connect() and the server exposes no route to rebind a prior conversation (capabilities.resume is false).`
    );
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

  /**
   * End the active turn, once. Clearing `_currentTurnId` first makes every
   * caller idempotent, so the abort ack and a racing idle cannot both fire.
   */
  private completeCurrentTurn(reason: OpenCodeTurnEndReason): void {
    const turnId = this._currentTurnId;
    this._currentTurnId = null;
    this._interruptedTurnId = null;
    if (!turnId) return;
    this.fire({
      type: 'chat:turn-completed',
      turnId,
      reason,
      durationMs: 0,
      toolCallCount: 0,
      messageCount: 0,
    });
  }

  private readonly _eventHandlers: Record<
    string,
    ((event: OpenCodeEvent) => void) | undefined
  > = {
    'session.status': (event) => {
      // Decoded by the shared OpenCode helper, not a local copy: both lanes read
      // the same server's `{ type: 'idle' }` / bare-string encoding, and the
      // #1412 defect was this lane's copy drifting from it.
      const status = openCodeStatusType(event.properties?.['status']);
      if (status === 'active' || status === 'busy') {
        this.fire({ type: 'chat:session-status', status: 'active' });
        return;
      }
      if (status === 'error') {
        this.completeCurrentTurn('failed');
        this.fire({ type: 'chat:session-status', status: 'error' });
        return;
      }
      if (status === 'idle') {
        // A stop the operator asked for reports as `interrupted`; anything else
        // reaching idle ran to the end.
        const interrupted =
          this._currentTurnId !== null &&
          this._interruptedTurnId === this._currentTurnId;
        this.completeCurrentTurn(interrupted ? 'interrupted' : 'completed');
        this.fire({ type: 'chat:session-status', status: 'idle' });
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
      const requestId = String(props['requestID'] ?? 'req-0');
      const turnId = this._currentTurnId ?? 'turn-0';
      // Remember which turn owns this card, so the eventual response binds to
      // the same turn even if the turn has closed by then.
      this._approvalTurnIds.set(requestId, turnId);
      this.fire({
        type: 'chat:approval-request',
        turnId,
        requestId,
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
      const turnId = this._currentTurnId;
      this.fire({
        type: 'chat:error',
        kind: 'unknown',
        message: String(error ?? 'Unknown error'),
        retryable: true,
        // Bind the failure to the turn it killed. Without this the bridge sees
        // a session-level error it cannot attribute, and the failed terminal
        // below would carry no message (#1412).
        ...(turnId ? { turnId } : {}),
      });
      this.completeCurrentTurn('failed');
    },
  };
}
