import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type {
  ArtifactPacketRef,
  ContextPacket,
  SessionInboxMessageState,
} from '../../../shared/context-packet.js';
import type { SessionSummary } from '../lib/types.js';
import {
  createContextPacket,
  previewInboxMessages,
  sendInboxMessage,
  updateInboxMessageState,
  type DecoratedInboxMessage,
} from '../lib/api.js';
import {
  initialFeedbackTarget,
  resolveFeedbackTarget,
} from '../lib/feedback-target.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import TuiButton from './TuiButton.js';
import './ArtifactFeedbackPanel.css';

export interface ArtifactFeedbackPanelProps {
  /** The artifact-ref this packet will point at. Identity carrier + decorations. */
  artifactRef: ArtifactPacketRef;
  /** Human label shown in the inbox text fallback. */
  artifactLabel: string;
  sessions: SessionSummary[];
  preferredTargetSessionId: string | null;
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; packet: ContextPacket; message: DecoratedInboxMessage }
  | { kind: 'error'; message: string };

const STATE_LABELS: Record<SessionInboxMessageState, string> = {
  queued: 'queued',
  delivered: 'delivered',
  acknowledged: 'acknowledged',
  resolved: 'resolved',
  ignored: 'ignored',
};

function messageError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function stateClass(state: SessionInboxMessageState): string {
  return `artifact-feedback__state artifact-feedback__state--${state}`;
}

export function ArtifactFeedbackPanel({
  artifactRef,
  artifactLabel,
  sessions,
  preferredTargetSessionId,
}: ArtifactFeedbackPanelProps) {
  const [note, setNote] = useState('');
  const [targetSessionId, setTargetSessionId] = useState(() =>
    initialFeedbackTarget(sessions, preferredTargetSessionId)
  );
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [messages, setMessages] = useState<DecoratedInboxMessage[]>([]);

  const liveTargetSessionId = useMemo(
    () =>
      resolveFeedbackTarget(
        sessions,
        preferredTargetSessionId,
        targetSessionId
      ),
    [preferredTargetSessionId, sessions, targetSessionId]
  );
  const hasLiveTarget = liveTargetSessionId !== '';

  useEffect(() => {
    setTargetSessionId((currentTargetSessionId) =>
      resolveFeedbackTarget(
        sessions,
        preferredTargetSessionId,
        currentTargetSessionId
      )
    );
  }, [preferredTargetSessionId, sessions]);

  const refreshInbox = useCallback(async () => {
    if (!liveTargetSessionId) return;
    setInboxLoading(true);
    setInboxError(null);
    try {
      setMessages(await previewInboxMessages(liveTargetSessionId, 8));
    } catch (err) {
      setInboxError(messageError(err));
    } finally {
      setInboxLoading(false);
    }
  }, [liveTargetSessionId]);

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);

  const handleSend = useCallback(async () => {
    if (!liveTargetSessionId) return;
    setSendState({ kind: 'sending' });
    try {
      const trimmedNote = note.trim();
      // Ref-only packet (#898): we forward the artifact pointer + bounded
      // decorations the section already holds — never artifact bytes. The
      // server re-resolves the artifact under capability. createdBy matches
      // FileFeedbackPanel ('relay-web').
      const packet = await createContextPacket({
        kind: 'artifact-ref',
        artifactRef: {
          artifactId: artifactRef.artifactId,
          ...(artifactRef.workContextId
            ? { workContextId: artifactRef.workContextId }
            : {}),
          ...(artifactRef.payloadSha256
            ? { payloadSha256: artifactRef.payloadSha256 }
            : {}),
          ...(artifactRef.kind ? { kind: artifactRef.kind } : {}),
          ...(artifactRef.title ? { title: artifactRef.title } : {}),
        },
        ...(trimmedNote ? { note: trimmedNote } : {}),
        binding: { nodeId: DEFAULT_LOCAL_NODE_ID },
        createdBy: 'relay-web',
      });
      const message = await sendInboxMessage({
        targetSessionId: liveTargetSessionId,
        contextPacketIds: [packet.id],
        text: trimmedNote || artifactLabel,
        createdBy: 'relay-web',
      });
      setSendState({ kind: 'sent', packet, message });
      setMessages((prev) =>
        [message, ...prev.filter((m) => m.id !== message.id)].slice(0, 8)
      );
    } catch (err) {
      setSendState({ kind: 'error', message: messageError(err) });
    }
  }, [
    artifactLabel,
    artifactRef.artifactId,
    artifactRef.kind,
    artifactRef.payloadSha256,
    artifactRef.title,
    artifactRef.workContextId,
    liveTargetSessionId,
    note,
  ]);

  const transitionMessage = useCallback(
    async (id: string, action: 'ack' | 'resolve' | 'ignore') => {
      try {
        const updated = await updateInboxMessageState(id, action);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, ...updated } : m))
        );
        setSendState((prev) =>
          prev.kind === 'sent' && prev.message.id === id
            ? { ...prev, message: { ...prev.message, ...updated } }
            : prev
        );
      } catch (err) {
        setInboxError(messageError(err));
      }
    },
    []
  );

  const canSend = Boolean(hasLiveTarget && sendState.kind !== 'sending');

  return (
    <section
      className="artifact-feedback"
      aria-label="artifact feedback"
      data-track="evidence.artifact-feedback"
    >
      <div className="artifact-feedback__head">
        <div className="artifact-feedback__eyebrow">artifact feedback</div>
        <TuiButton
          variant="ghost"
          size="sm"
          onClick={() => void refreshInbox()}
          disabled={!hasLiveTarget || inboxLoading}
        >
          {inboxLoading ? 'refreshing' : 'refresh state'}
        </TuiButton>
      </div>

      <div className="artifact-feedback__form">
        <label>
          target
          <select
            value={liveTargetSessionId}
            onChange={(event) => setTargetSessionId(event.target.value)}
            disabled={!hasLiveTarget}
          >
            {sessions.length === 0 ? (
              <option value="">no live sessions</option>
            ) : (
              sessions.map((session) => (
                <option
                  key={scopedSessionKey(session)}
                  value={scopedSessionKey(session)}
                >
                  {session.displayName || session.id} ·{' '}
                  {session.agent || session.type}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="artifact-feedback__note">
          note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="what should the agent do with this artifact?"
            rows={2}
            disabled={!hasLiveTarget}
          />
        </label>
        <TuiButton
          variant="primary"
          size="sm"
          onClick={handleSend}
          disabled={!canSend}
        >
          {sendState.kind === 'sending' ? 'sending' : 'send feedback'}
        </TuiButton>
      </div>

      <div className="artifact-feedback__meta" aria-live="polite">
        <span>artifact {artifactRef.artifactId}</span>
        {sendState.kind === 'sent' && (
          <span className={stateClass(sendState.message.state)}>
            {STATE_LABELS[sendState.message.state]}
          </span>
        )}
        {sendState.kind === 'error' && (
          <span className="artifact-feedback__error">{sendState.message}</span>
        )}
        {inboxError && (
          <span className="artifact-feedback__error">{inboxError}</span>
        )}
      </div>

      <div className="artifact-feedback__messages">
        {messages.length === 0 ? (
          <div className="artifact-feedback__empty">
            no inbox feedback loaded for this target
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="artifact-feedback__message">
              <div className="artifact-feedback__message-main">
                <span className={stateClass(message.state)}>
                  {STATE_LABELS[message.state]}
                </span>
                <span className="artifact-feedback__message-text">
                  {message.text || message.id}
                </span>
              </div>
              <div className="artifact-feedback__message-actions">
                <button
                  onClick={() => transitionMessage(message.id, 'ack')}
                  disabled={
                    message.state !== 'delivered'
                  }
                >
                  ack
                </button>
                <button
                  onClick={() => transitionMessage(message.id, 'resolve')}
                  disabled={
                    message.state === 'resolved' || message.state === 'ignored'
                  }
                >
                  resolve
                </button>
                <button
                  onClick={() => transitionMessage(message.id, 'ignore')}
                  disabled={
                    message.state === 'resolved' || message.state === 'ignored'
                  }
                >
                  ignore
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default ArtifactFeedbackPanel;
