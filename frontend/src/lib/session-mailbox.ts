import type { ContextPacketId } from '../../../shared/context-packet.js';
import type { DecoratedInboxMessage } from './api.js';

export type SessionMailboxMessageKind =
  | 'decision'
  | 'attention'
  | 'artifact'
  | 'message';

export type SessionMailboxPriority = 'critical' | 'attention' | 'info' | 'quiet';

export interface SessionMailboxArtifactRef {
  packetId: ContextPacketId;
  kind: string;
  path?: string;
  label: string;
}

export interface SessionMailboxMessage {
  id: string;
  state: DecoratedInboxMessage['state'];
  kind: SessionMailboxMessageKind;
  priority: SessionMailboxPriority;
  unread: boolean;
  open: boolean;
  ackable: boolean;
  resolvable: boolean;
  sender: string;
  createdAt?: string;
  title: string;
  body: string;
  attentionKind?: string;
  artifacts: SessionMailboxArtifactRef[];
  packetIds: ContextPacketId[];
}

export interface SessionMailboxSummary {
  messages: SessionMailboxMessage[];
  unreadCount: number;
  openCount: number;
  ackableCount: number;
  decisionCount: number;
  attentionCount: number;
  artifactCount: number;
  latestPreview: string | null;
  priority: SessionMailboxPriority;
}

const ATTENTION_RE = /^\[attention:([^\]\s]+)\]\s*(.*)$/i;
const DECISION_RE = /^\[decision:pending\]\s*(.*)$/i;

function messageCreatedAt(message: DecoratedInboxMessage): string | undefined {
  return (
    message.createdAt ??
    message.deliveredAt ??
    message.acknowledgedAt ??
    message.resolvedAt ??
    message.ignoredAt
  );
}

function stateIsOpen(state: DecoratedInboxMessage['state']): boolean {
  return state !== 'resolved' && state !== 'ignored';
}

function stateIsUnread(state: DecoratedInboxMessage['state']): boolean {
  return state === 'queued' || state === 'delivered';
}

function cleanBody(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function packetNotes(message: DecoratedInboxMessage): string[] {
  return (message.contextPackets ?? [])
    .map((packet) => (packet.kind === 'note' ? cleanBody(packet.note) : ''))
    .filter((note) => note.length > 0);
}

function artifactsForMessage(
  message: DecoratedInboxMessage
): SessionMailboxArtifactRef[] {
  return (message.contextPackets ?? [])
    .filter(
      (packet) =>
        packet.kind === 'log-ref' ||
        packet.kind === 'diff-ref' ||
        packet.kind === 'file-ref' ||
        packet.kind === 'file-anchor' ||
        !!packet.fileRef ||
        !!packet.anchor
    )
    .map((packet) => {
      const fileRefPath = packet.fileRef?.path;
      const anchorPath = packet.anchor?.ref?.path;
      const path = fileRefPath ?? anchorPath;
      const label = packet.note
        ? cleanBody(packet.note)
        : path
          ? path.split('/').filter(Boolean).pop() ?? path
          : packet.id;
      return {
        packetId: packet.id,
        kind: packet.kind,
        ...(path ? { path } : {}),
        label,
      };
    });
}

function classifyMessage(message: DecoratedInboxMessage): {
  kind: SessionMailboxMessageKind;
  title: string;
  body: string;
  attentionKind?: string;
} {
  const notes = packetNotes(message);
  const bodyCandidates = [message.text, ...notes]
    .map(cleanBody)
    .filter((body) => body.length > 0);

  for (const body of bodyCandidates) {
    const decisionMatch = DECISION_RE.exec(body);
    if (decisionMatch) {
      return {
        kind: 'decision',
        title: 'decision requested',
        body: cleanBody(decisionMatch[1]) || 'pending decision',
      };
    }
  }

  for (const body of bodyCandidates) {
    const attentionMatch = ATTENTION_RE.exec(body);
    if (attentionMatch) {
      const attentionKind = attentionMatch[1]?.toLowerCase() ?? 'attention';
      return {
        kind: 'attention',
        title: `${attentionKind} attention`,
        body: cleanBody(attentionMatch[2]) || 'attention requested',
        attentionKind,
      };
    }
  }

  const artifacts = artifactsForMessage(message);
  if (artifacts.length > 0) {
    const first = artifacts[0];
    return {
      kind: 'artifact',
      title: artifacts.length === 1 ? 'artifact published' : 'artifacts published',
      body: first?.label ?? message.id,
    };
  }

  return {
    kind: 'message',
    title: 'message',
    body: bodyCandidates[0] ?? 'context packet delivered',
  };
}

function priorityFor(
  kind: SessionMailboxMessageKind,
  unread: boolean,
  open: boolean
): SessionMailboxPriority {
  if (!open) return 'quiet';
  if (kind === 'decision') return 'critical';
  if (kind === 'attention') return 'attention';
  if (unread) return 'info';
  return 'quiet';
}

function compareMailboxMessages(
  a: SessionMailboxMessage,
  b: SessionMailboxMessage
): number {
  const priorityRank: Record<SessionMailboxPriority, number> = {
    critical: 0,
    attention: 1,
    info: 2,
    quiet: 3,
  };
  const byPriority = priorityRank[a.priority] - priorityRank[b.priority];
  if (byPriority !== 0) return byPriority;
  const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return bTime - aTime;
}

function summaryPriority(messages: SessionMailboxMessage[]): SessionMailboxPriority {
  if (messages.some((message) => message.priority === 'critical')) return 'critical';
  if (messages.some((message) => message.priority === 'attention')) return 'attention';
  if (messages.some((message) => message.priority === 'info')) return 'info';
  return 'quiet';
}

export function buildSessionMailboxMessage(
  message: DecoratedInboxMessage
): SessionMailboxMessage {
  const classification = classifyMessage(message);
  const unread = stateIsUnread(message.state);
  const open = stateIsOpen(message.state);
  const artifacts = artifactsForMessage(message);
  const createdAt = messageCreatedAt(message);
  return {
    id: message.id,
    state: message.state,
    kind: classification.kind,
    priority: priorityFor(classification.kind, unread, open),
    unread,
    open,
    ackable: unread && open,
    resolvable: open,
    sender: message.createdBy,
    ...(createdAt ? { createdAt } : {}),
    title: classification.title,
    body: classification.body,
    ...(classification.attentionKind
      ? { attentionKind: classification.attentionKind }
      : {}),
    artifacts,
    packetIds: message.contextPacketIds,
  };
}

export function buildSessionMailboxSummary(
  messages: DecoratedInboxMessage[]
): SessionMailboxSummary {
  const projected = messages
    .map(buildSessionMailboxMessage)
    .sort(compareMailboxMessages);
  return {
    messages: projected,
    unreadCount: projected.filter((message) => message.unread).length,
    openCount: projected.filter((message) => message.open).length,
    ackableCount: projected.filter((message) => message.ackable).length,
    decisionCount: projected.filter(
      (message) => message.open && message.kind === 'decision'
    ).length,
    attentionCount: projected.filter(
      (message) => message.open && message.kind === 'attention'
    ).length,
    artifactCount: projected.reduce(
      (total, message) => total + message.artifacts.length,
      0
    ),
    latestPreview: projected[0]?.body ?? null,
    priority: summaryPriority(projected),
  };
}
