import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { ChannelAgentStatus } from '../lib/api.js';
import {
  selectCockpitAttentionRows,
  type CockpitRosterAttention,
} from '../lib/state/cockpit-attention.js';
import {
  PRESENCE_TOKENS,
  presenceStateForRow,
} from '../lib/state/cockpit-presence.js';
import type { ChannelRailTree, TopicNavItem } from '../lib/state/topic-nav.js';
import './MobileCockpitAttentionLane.css';

interface MobileCockpitAttentionLaneProps {
  tree: ChannelRailTree;
  unreadByChannel: Readonly<Record<string, boolean>>;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  mentionsMeByChannel: Readonly<Record<string, boolean>>;
  rosterAttentionBySessionKey: Readonly<Record<string, CockpitRosterAttention>>;
  onSelect: (id: string) => void;
  actionLabelForItem: (item: TopicNavItem) => string;
  statusTextForItem: (item: TopicNavItem) => string;
  onNudge: (
    channelId: string,
    text: string,
    clientMessageId: string
  ) => Promise<void>;
  onInterrupt: (channelId: string, agentId: string) => Promise<void>;
}

function displayTitle(item: TopicNavItem): string {
  const title = item.title.replace(/^[@#]/, '');
  return item.isDirectMessage ? `@${title}` : `#${title}`;
}

function interruptibleAgentId(
  item: TopicNavItem,
  statuses: Readonly<Record<string, ChannelAgentStatus>>
): string | null {
  const prefix = `${item.id} `;
  const interruptible = new Set<ChannelAgentStatus>([
    'thinking',
    'streaming',
    'waiting',
  ]);
  for (const [key, status] of Object.entries(statuses)) {
    if (key.startsWith(prefix) && interruptible.has(status)) {
      return key.slice(prefix.length) || null;
    }
  }
  return null;
}

export function CockpitPresenceChip({
  item,
  statuses,
  unread,
}: {
  item: TopicNavItem;
  statuses: Readonly<Record<string, ChannelAgentStatus>>;
  unread: boolean;
}) {
  const presence = presenceStateForRow(item, statuses, { unread });
  const token = PRESENCE_TOKENS[presence];
  const style = {
    '--cockpit-presence-color': token.colorVar,
  } as CSSProperties;
  return (
    <span
      className={`cockpit-presence cockpit-presence--${presence}`}
      style={style}
      aria-label={`${presence} presence`}
      title={presence}
    >
      {token.glyph === 'spinner' ? (
        <LoaderCircle
          className="cockpit-presence__glyph topic-status__spinner"
          aria-hidden="true"
          size={14}
        />
      ) : token.glyph === 'alert' ? (
        <CircleAlert
          className="cockpit-presence__glyph"
          aria-hidden="true"
          size={14}
        />
      ) : null}
      <span className="cockpit-presence__dot" aria-hidden="true" />
    </span>
  );
}

function AttentionRow({
  item,
  unread,
  statuses,
  onSelect,
  actionLabel,
  statusText,
  onNudge,
  onInterrupt,
}: {
  item: TopicNavItem;
  unread: boolean;
  statuses: Readonly<Record<string, ChannelAgentStatus>>;
  onSelect: (id: string) => void;
  actionLabel: string;
  statusText: string;
  onNudge: MobileCockpitAttentionLaneProps['onNudge'];
  onInterrupt: MobileCockpitAttentionLaneProps['onInterrupt'];
}) {
  const title = displayTitle(item);
  const isPrimaryAction = actionLabel === 'approve' || actionLabel === 'reply';

  return (
    <article
      className="topic-cockpit__attention-row"
      data-topic-id={item.id}
      data-unread={unread ? 'true' : 'false'}
    >
      <button
        type="button"
        className="topic-cockpit__attention-main"
        onClick={() => onSelect(item.id)}
      >
        <CockpitPresenceChip item={item} statuses={statuses} unread={unread} />
        <span className="topic-cockpit__attention-copy">
          <span className="topic-cockpit__attention-title">{title}</span>
          <span className="topic-cockpit__attention-status">{statusText}</span>
        </span>
      </button>
      <MobileCockpitRowActions
        item={item}
        statuses={statuses}
        onNudge={onNudge}
        onInterrupt={onInterrupt}
        {...(isPrimaryAction
          ? {
              primaryActionLabel: actionLabel,
              onPrimaryAction: () => onSelect(item.id),
            }
          : {})}
      />
    </article>
  );
}

export function MobileCockpitRowActions({
  item,
  statuses,
  onNudge,
  onInterrupt,
  primaryActionLabel,
  onPrimaryAction,
}: {
  item: TopicNavItem;
  statuses: Readonly<Record<string, ChannelAgentStatus>>;
  onNudge: MobileCockpitAttentionLaneProps['onNudge'];
  onInterrupt: MobileCockpitAttentionLaneProps['onInterrupt'];
  primaryActionLabel?: string | undefined;
  onPrimaryAction?: (() => void) | undefined;
}) {
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [nudgeText, setNudgeText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const attemptedDraftRef = useRef<{ text: string; id: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const title = displayTitle(item);
  const persisted = item.source === 'persisted';
  const agentId = interruptibleAgentId(item, statuses);
  const canInterrupt = persisted && agentId !== null;

  useEffect(() => {
    if (!nudgeOpen) return;
    const input = inputRef.current;
    input?.focus();
    input?.scrollIntoView({ block: 'nearest' });
  }, [nudgeOpen]);

  const toggleNudge = () => {
    if (!persisted) return;
    setSendStatus(null);
    const next = !nudgeOpen;
    if (next && !nudgeText) {
      setNudgeText(item.dmProviderId ? `@${item.dmProviderId} ` : '');
    }
    setNudgeOpen(next);
  };

  const submitNudge = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = nudgeText.trim();
    if (!persisted || !text || sending) return;
    const previousAttempt = attemptedDraftRef.current;
    const attempt =
      previousAttempt?.text === text
        ? previousAttempt
        : { text, id: crypto.randomUUID() };
    attemptedDraftRef.current = attempt;
    setSending(true);
    setSendStatus('sending…');
    try {
      await onNudge(item.id, text, attempt.id);
      // A successful idempotent post retires the key. The next draft receives
      // a new key; an ambiguous failed retry of the same draft reuses this one.
      attemptedDraftRef.current = null;
      setNudgeText('');
      setSendStatus(null);
      setNudgeOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendStatus(`failed: ${message}`);
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!agentId || sending) return;
    setSending(true);
    setSendStatus('interrupting…');
    try {
      await onInterrupt(item.id, agentId);
      setSendStatus('interrupt requested');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendStatus(`interrupt failed: ${message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <span className="topic-cockpit__attention-actions">
        {primaryActionLabel && onPrimaryAction ? (
          <button
            type="button"
            className="topic-cockpit__attention-action"
            onClick={onPrimaryAction}
          >
            {primaryActionLabel}
          </button>
        ) : null}
        {canInterrupt ? (
          <button
            type="button"
            className="topic-cockpit__attention-action topic-cockpit__attention-action--interrupt"
            aria-label={`interrupt ${title}`}
            disabled={sending}
            onClick={() => void interrupt()}
          >
            interrupt
          </button>
        ) : null}
        {persisted ? (
          <button
            type="button"
            className="topic-cockpit__attention-action"
            aria-label={`nudge ${title}`}
            aria-expanded={nudgeOpen}
            disabled={sending}
            onClick={toggleNudge}
          >
            nudge
          </button>
        ) : null}
      </span>
      {nudgeOpen ? (
        <form className="topic-cockpit__nudge" onSubmit={submitNudge}>
          <input
            ref={inputRef}
            name="nudge"
            value={nudgeText}
            onChange={(event) => setNudgeText(event.target.value)}
            disabled={sending}
            maxLength={1000}
            aria-label={`nudge ${title} message`}
            placeholder="short message or @mention"
          />
          <button
            type="submit"
            disabled={sending || nudgeText.trim().length === 0}
            aria-label={`send nudge to ${title}`}
          >
            send
          </button>
        </form>
      ) : null}
      {sendStatus ? (
        <span className="topic-cockpit__nudge-status" role="status">
          {sendStatus}
        </span>
      ) : null}
    </>
  );
}

export function MobileCockpitAttentionLane({
  tree,
  unreadByChannel,
  statusByChannelAgent,
  mentionsMeByChannel,
  rosterAttentionBySessionKey,
  onSelect,
  actionLabelForItem,
  statusTextForItem,
  onNudge,
  onInterrupt,
}: MobileCockpitAttentionLaneProps) {
  const rows = useMemo(
    () =>
      selectCockpitAttentionRows(tree, {
        unreadByChannel,
        statusByChannelAgent,
        mentionsMeByChannel,
        rosterAttentionBySessionKey,
      }),
    [
      mentionsMeByChannel,
      rosterAttentionBySessionKey,
      statusByChannelAgent,
      tree,
      unreadByChannel,
    ]
  );

  return (
    <section className="topic-cockpit__attention" aria-label="attention">
      <div className="topic-cockpit__attention-header">attention</div>
      {rows.length === 0 ? (
        <div className="topic-cockpit__attention-clear">all clear</div>
      ) : (
        <div className="topic-cockpit__attention-list">
          {rows.map((node) => (
            <AttentionRow
              key={node.item.id}
              item={node.item}
              unread={unreadByChannel[node.item.id] ?? node.unread}
              statuses={statusByChannelAgent}
              onSelect={onSelect}
              actionLabel={actionLabelForItem(node.item)}
              statusText={statusTextForItem(node.item)}
              onNudge={onNudge}
              onInterrupt={onInterrupt}
            />
          ))}
        </div>
      )}
    </section>
  );
}
