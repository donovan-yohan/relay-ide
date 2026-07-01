import { useState } from 'react';
import type { SessionInboxMessageId } from '../../../shared/context-packet.js';
import type { SessionMailboxAction } from '../hooks/useSessionMailbox.js';
import { useSessionMailbox } from '../hooks/useSessionMailbox.js';
import type {
  SessionMailboxMessage,
  SessionMailboxSummary,
} from '../lib/session-mailbox.js';
import { sendInboxMessage } from '../lib/api.js';
import { TuiButton } from './TuiButton.js';
import './SessionMailboxPanel.css';

interface MailboxComposerProps {
  targetSessionId: string;
  onSent: () => void;
}

type ComposeMode = 'friend' | 'mail';

/**
 * Compose a message with an explicit local-vs-remote boundary:
 * - **friend**: a direct message to the LOCAL agent that owns this mailbox
 *   (same workspace), routed by `targetSessionId`.
 * - **mail**: cross-workspace MAIL to another work context, routed by
 *   `targetWorkContextId`.
 * Both go through the same inbox send contract.
 */
function MailboxComposer({ targetSessionId, onSent }: MailboxComposerProps) {
  const [mode, setMode] = useState<ComposeMode>('friend');
  const [draft, setDraft] = useState('');
  const [mailTarget, setMailTarget] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetReady = mode === 'friend' || mailTarget.trim().length > 0;
  const canSend = draft.trim().length > 0 && targetReady && !sending;

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !targetReady || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendInboxMessage(
        mode === 'mail'
          ? {
              targetWorkContextId: mailTarget.trim(),
              text,
              contextPacketIds: [],
            }
          : { targetSessionId, text, contextPacketIds: [] }
      );
      setDraft('');
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send message');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="session-mailbox-compose">
      <div
        className="session-mailbox-compose__mode"
        role="group"
        aria-label="message target"
      >
        <button
          type="button"
          className={`session-mailbox-compose__tab${mode === 'friend' ? ' is-active' : ''}`}
          aria-pressed={mode === 'friend'}
          onClick={() => setMode('friend')}
        >
          friend
        </button>
        <button
          type="button"
          className={`session-mailbox-compose__tab${mode === 'mail' ? ' is-active' : ''}`}
          aria-pressed={mode === 'mail'}
          onClick={() => setMode('mail')}
        >
          mail
        </button>
      </div>
      {mode === 'mail' && (
        <input
          className="session-mailbox-compose__target"
          value={mailTarget}
          placeholder="work-context id…"
          aria-label="mail target work context"
          disabled={sending}
          onChange={(e) => setMailTarget(e.target.value)}
        />
      )}
      <div className="session-mailbox-compose__row">
        <input
          className="session-mailbox-compose__input"
          value={draft}
          placeholder={
            mode === 'mail' ? 'mail another workspace…' : 'message this agent…'
          }
          aria-label={
            mode === 'mail' ? 'mail another workspace' : 'message this agent'
          }
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
        />
        <TuiButton
          size="sm"
          variant="info"
          disabled={!canSend}
          onClick={() => void send()}
        >
          {sending ? 'sending' : 'send'}
        </TuiButton>
      </div>
      {error && (
        <span className="session-mailbox-compose__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

interface SessionMailboxBadgeProps {
  targetSessionId: string;
  label?: string;
}

function priorityLabel(summary: SessionMailboxSummary): string {
  if (summary.decisionCount > 0) return `${summary.decisionCount} decision`;
  if (summary.attentionCount > 0) return `${summary.attentionCount} attention`;
  if (summary.unreadCount > 0) return `${summary.unreadCount} unread`;
  if (summary.artifactCount > 0) return `${summary.artifactCount} artifact`;
  return 'clear';
}

export function SessionMailboxBadge({
  targetSessionId,
  label,
}: SessionMailboxBadgeProps) {
  const mailbox = useSessionMailbox(targetSessionId, {
    mode: 'preview',
    limit: 6,
  });
  const summary = mailbox.summary;
  const visible =
    mailbox.isLoading ||
    mailbox.isError ||
    summary.openCount > 0 ||
    summary.artifactCount > 0;

  if (!visible) return null;

  return (
    <span
      className={`session-mailbox-badge session-mailbox-badge--${summary.priority}`}
      title={
        mailbox.isError
          ? (mailbox.error?.message ?? 'mailbox failed')
          : (summary.latestPreview ?? 'mailbox clear')
      }
    >
      <span className="session-mailbox-badge__label">{label ?? 'mail'}</span>
      <span>{mailbox.isLoading ? 'loading' : priorityLabel(summary)}</span>
    </span>
  );
}

interface SessionMailboxPanelProps {
  targetSessionId: string | null | undefined;
  title?: string;
  compact?: boolean;
}

function actionForMessage(
  message: SessionMailboxMessage
): SessionMailboxAction[] {
  if (!message.open) return [];
  const actions: SessionMailboxAction[] = [];
  if (message.ackable) actions.push('ack');
  actions.push(message.kind === 'decision' ? 'resolve' : 'resolve');
  actions.push('ignore');
  return actions;
}

function actionLabel(action: SessionMailboxAction): string {
  switch (action) {
    case 'ack':
      return 'ack';
    case 'resolve':
      return 'resolve';
    case 'ignore':
      return 'ignore';
  }
}

interface SessionMailboxCardProps {
  message: SessionMailboxMessage;
  isUpdating: boolean;
  onAction: (id: SessionInboxMessageId, action: SessionMailboxAction) => void;
}

function SessionMailboxCard({
  message,
  isUpdating,
  onAction,
}: SessionMailboxCardProps) {
  return (
    <article
      className={`session-mailbox-card session-mailbox-card--${message.priority}`}
      data-state={message.state}
    >
      <div className="session-mailbox-card__header">
        <span className="session-mailbox-card__title">{message.title}</span>
        <span className="session-mailbox-card__state">{message.state}</span>
      </div>
      <p className="session-mailbox-card__body">{message.body}</p>
      <div className="session-mailbox-card__meta">
        <span>{message.kind}</span>
        <span>{message.sender}</span>
        {message.createdAt && <span>{message.createdAt}</span>}
      </div>
      {message.artifacts.length > 0 && (
        <div
          className="session-mailbox-card__artifacts"
          aria-label="artifact refs"
        >
          {message.artifacts.map((artifact) => (
            <span key={artifact.packetId} className="session-mailbox-artifact">
              {artifact.kind} · {artifact.label}
              {artifact.path ? ` · ${artifact.path}` : ''}
            </span>
          ))}
        </div>
      )}
      {message.open && (
        <div className="session-mailbox-card__actions">
          {actionForMessage(message).map((action) => (
            <TuiButton
              key={action}
              size="sm"
              variant={action === 'ignore' ? 'ghost' : 'info'}
              disabled={isUpdating}
              onClick={() => onAction(message.id, action)}
            >
              {actionLabel(action)}
            </TuiButton>
          ))}
        </div>
      )}
    </article>
  );
}

export default function SessionMailboxPanel({
  targetSessionId,
  title = 'mailbox',
  compact = false,
}: SessionMailboxPanelProps) {
  const mailbox = useSessionMailbox(targetSessionId, {
    mode: 'preview',
    limit: compact ? 5 : 12,
    enabled: !!targetSessionId,
  });

  if (!targetSessionId) {
    return (
      <section className="session-mailbox-panel session-mailbox-panel--empty">
        <div className="session-mailbox-panel__header">
          <span>{title}</span>
          <span>no session</span>
        </div>
        <p>select a live session to read its mailroom inbox.</p>
      </section>
    );
  }

  return (
    <section
      className={`session-mailbox-panel${compact ? ' session-mailbox-panel--compact' : ''}`}
      aria-label={`${title} for ${targetSessionId}`}
    >
      <div className="session-mailbox-panel__header">
        <span>{title}</span>
        <span>
          {mailbox.isLoading
            ? 'loading'
            : `${mailbox.summary.unreadCount} unread / ${mailbox.summary.openCount} open`}
        </span>
      </div>
      {mailbox.isError ? (
        <div className="session-mailbox-state session-mailbox-state--error">
          <span>
            mailbox failed: {mailbox.error?.message ?? 'unknown error'}
          </span>
          <TuiButton
            size="sm"
            variant="ghost"
            onClick={() => void mailbox.refetch()}
          >
            retry
          </TuiButton>
        </div>
      ) : mailbox.isLoading ? (
        <div className="session-mailbox-state">
          loading mailroom messages...
        </div>
      ) : mailbox.summary.messages.length === 0 ? (
        <div className="session-mailbox-state">
          mailbox clear · no session mail
        </div>
      ) : (
        <div className="session-mailbox-list">
          {mailbox.summary.messages.map((message) => (
            <SessionMailboxCard
              key={message.id}
              message={message}
              isUpdating={mailbox.isUpdating}
              onAction={(id, action) => void mailbox.updateMessage(id, action)}
            />
          ))}
        </div>
      )}
      {!compact && (
        <MailboxComposer
          targetSessionId={targetSessionId}
          onSent={() => void mailbox.refetch()}
        />
      )}
    </section>
  );
}
