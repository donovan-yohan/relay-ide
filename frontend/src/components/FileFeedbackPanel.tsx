import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type {
  ContextPacket,
  SessionInboxMessageState,
} from '../../../shared/context-packet.js';
import type { SessionSummary } from '../lib/types.js';
import {
  createContextPacket,
  fetchInboxMessages,
  sendInboxMessage,
  updateInboxMessageState,
  type DecoratedInboxMessage,
} from '../lib/api.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import TuiButton from './TuiButton.js';
import './FileFeedbackPanel.css';

interface FileFeedbackPanelProps {
  filePath: string;
  workspacePath: string;
  content: string;
  language: string;
  sessions: SessionSummary[];
  preferredTargetSessionId: string | null;
  selectedLine: number | null;
  onSelectedLineConsumed: () => void;
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

function absoluteFilePath(workspacePath: string, filePath: string): string {
  if (filePath.startsWith('/')) return filePath;
  return `${workspacePath.replace(/\/+$/u, '')}/${filePath.replace(/^\/+/, '')}`;
}

function initialTarget(
  sessions: SessionSummary[],
  preferredTargetSessionId: string | null
): string {
  if (preferredTargetSessionId) return preferredTargetSessionId;
  const firstAgent = sessions.find((session) => session.type === 'agent');
  return firstAgent
    ? scopedSessionKey(firstAgent)
    : sessions[0]
      ? scopedSessionKey(sessions[0])
      : '';
}

function quoteForRange(
  content: string,
  startLine: number,
  endLine: number
): string {
  const lines = content.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

function messageError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function stateClass(state: SessionInboxMessageState): string {
  return `file-feedback__state file-feedback__state--${state}`;
}

export function FileFeedbackPanel({
  filePath,
  workspacePath,
  content,
  language,
  sessions,
  preferredTargetSessionId,
  selectedLine,
  onSelectedLineConsumed,
}: FileFeedbackPanelProps) {
  const [startLine, setStartLine] = useState('1');
  const [endLine, setEndLine] = useState('1');
  const [note, setNote] = useState('');
  const [targetSessionId, setTargetSessionId] = useState(() =>
    initialTarget(sessions, preferredTargetSessionId)
  );
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [messages, setMessages] = useState<DecoratedInboxMessage[]>([]);

  const totalLines = useMemo(
    () => Math.max(content.split('\n').length, 1),
    [content]
  );
  const isMarkdown = language === 'markdown' || /\.mdx?$/iu.test(filePath);

  useEffect(() => {
    if (targetSessionId) return;
    setTargetSessionId(initialTarget(sessions, preferredTargetSessionId));
  }, [preferredTargetSessionId, sessions, targetSessionId]);

  useEffect(() => {
    if (selectedLine === null) return;
    const line = String(Math.min(Math.max(selectedLine, 1), totalLines));
    setStartLine(line);
    setEndLine(line);
    onSelectedLineConsumed();
  }, [onSelectedLineConsumed, selectedLine, totalLines]);

  const range = useMemo(() => {
    const start = Number.parseInt(startLine, 10);
    const end = Number.parseInt(endLine, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 1 || end < start || end > totalLines) return null;
    return { startLine: start, endLine: end };
  }, [endLine, startLine, totalLines]);

  const refreshInbox = useCallback(async () => {
    if (!targetSessionId) return;
    setInboxLoading(true);
    setInboxError(null);
    try {
      setMessages(await fetchInboxMessages(targetSessionId, 8));
    } catch (err) {
      setInboxError(messageError(err));
    } finally {
      setInboxLoading(false);
    }
  }, [targetSessionId]);

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);

  const handleSend = useCallback(async () => {
    if (!range || !targetSessionId) return;
    setSendState({ kind: 'sending' });
    try {
      const trimmedNote = note.trim();
      const packet = await createContextPacket({
        kind: 'file-anchor',
        anchor: {
          ref: {
            nodeId: DEFAULT_LOCAL_NODE_ID,
            path: absoluteFilePath(workspacePath, filePath),
            capturedAt: new Date().toISOString(),
            intent: 'read',
            repoBinding: {
              repoPath: workspacePath,
              worktreePath: workspacePath,
            },
          },
          lineRange: range,
          quote: quoteForRange(content, range.startLine, range.endLine),
        },
        ...(trimmedNote ? { note: trimmedNote } : {}),
        binding: { nodeId: DEFAULT_LOCAL_NODE_ID },
        createdBy: 'relay-web',
      });
      const message = await sendInboxMessage({
        targetSessionId,
        contextPacketIds: [packet.id],
        text:
          trimmedNote || `${filePath}#L${range.startLine}-L${range.endLine}`,
        createdBy: 'relay-web',
      });
      setSendState({ kind: 'sent', packet, message });
      setMessages((prev) =>
        [message, ...prev.filter((m) => m.id !== message.id)].slice(0, 8)
      );
    } catch (err) {
      setSendState({ kind: 'error', message: messageError(err) });
    }
  }, [content, filePath, note, range, targetSessionId, workspacePath]);

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

  const canSend = Boolean(
    range && targetSessionId && sendState.kind !== 'sending'
  );

  return (
    <section className="file-feedback" aria-label="file feedback">
      <div className="file-feedback__head">
        <div>
          <div className="file-feedback__eyebrow">
            {isMarkdown ? 'markdown source feedback' : 'file feedback'}
          </div>
          <div className="file-feedback__copy">
            create a context packet, then queue it through the session inbox
          </div>
        </div>
        <TuiButton
          variant="ghost"
          size="sm"
          onClick={refreshInbox}
          disabled={!targetSessionId || inboxLoading}
        >
          {inboxLoading ? 'refreshing' : 'refresh state'}
        </TuiButton>
      </div>

      <div className="file-feedback__form">
        <label>
          target
          <select
            value={targetSessionId}
            onChange={(event) => setTargetSessionId(event.target.value)}
            disabled={sessions.length === 0}
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
        <label>
          start
          <input
            type="number"
            min={1}
            max={totalLines}
            value={startLine}
            onChange={(event) => setStartLine(event.target.value)}
          />
        </label>
        <label>
          end
          <input
            type="number"
            min={1}
            max={totalLines}
            value={endLine}
            onChange={(event) => setEndLine(event.target.value)}
          />
        </label>
        <label className="file-feedback__note">
          note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="what should the agent review here?"
            rows={2}
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

      <div className="file-feedback__meta" aria-live="polite">
        {range ? (
          <span>
            selected {filePath}#L{range.startLine}
            {range.endLine === range.startLine ? '' : `-L${range.endLine}`}
          </span>
        ) : (
          <span className="file-feedback__error">
            range must be within 1-{totalLines}
          </span>
        )}
        {sendState.kind === 'sent' && (
          <span className={stateClass(sendState.message.state)}>
            {STATE_LABELS[sendState.message.state]}
          </span>
        )}
        {sendState.kind === 'error' && (
          <span className="file-feedback__error">{sendState.message}</span>
        )}
        {inboxError && (
          <span className="file-feedback__error">{inboxError}</span>
        )}
      </div>

      <div className="file-feedback__messages">
        {messages.length === 0 ? (
          <div className="file-feedback__empty">
            no inbox feedback loaded for this target
          </div>
        ) : (
          messages.map((message) => {
            const anchorState = message.contextPackets?.find(
              (packet) => packet.anchorState
            )?.anchorState;
            return (
              <div key={message.id} className="file-feedback__message">
                <div className="file-feedback__message-main">
                  <span className={stateClass(message.state)}>
                    {STATE_LABELS[message.state]}
                  </span>
                  {anchorState && (
                    <span
                      className={`file-feedback__anchor file-feedback__anchor--${anchorState}`}
                    >
                      {anchorState}
                    </span>
                  )}
                  <span className="file-feedback__message-text">
                    {message.text || message.id}
                  </span>
                </div>
                <div className="file-feedback__message-actions">
                  <button onClick={() => transitionMessage(message.id, 'ack')}>
                    ack
                  </button>
                  <button
                    onClick={() => transitionMessage(message.id, 'resolve')}
                  >
                    resolve
                  </button>
                  <button
                    onClick={() => transitionMessage(message.id, 'ignore')}
                  >
                    ignore
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export default FileFeedbackPanel;
