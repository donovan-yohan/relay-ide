import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type {
  ControlActor,
  ControlFreshness,
  ControlMode,
  InterventionRecord,
} from '../../../shared/control-state.js';
import type { NodeBadge } from './workspace-summary.js';
import type { SessionSummary } from './types.js';

export type ControlDisplayMode = ControlMode | 'stale' | 'unknown';

export interface ControlBadgeView {
  mode: ControlDisplayMode;
  label: 'agent' | 'human' | 'co' | 'stale' | 'unknown';
  ariaLabel: string;
  title: string;
  actorSummary: string;
  nodeSummary: string;
  lastTouchSummary: string;
  reason?: string;
}

export const CONTROL_BADGE_LABEL: Record<ControlDisplayMode, ControlBadgeView['label']> = {
  'agent-driven': 'agent',
  'human-driven': 'human',
  'co-driven': 'co',
  stale: 'stale',
  unknown: 'unknown',
};

export function actorLabel(actor: ControlActor | null | undefined): string {
  if (!actor) return 'none';
  return actor.displayName ?? actor.id ?? actor.kind;
}

export function actorListLabel(actors: ControlActor[] | undefined): string {
  if (!actors || actors.length === 0) return 'none';
  return actors.map(actorLabel).join(', ');
}

function displayModeFor(
  mode: ControlMode | undefined,
  freshness: ControlFreshness | undefined
): ControlDisplayMode {
  if (!mode || !freshness) return 'unknown';
  if (freshness === 'stale') return 'stale';
  if (freshness === 'unknown') return 'unknown';
  return mode;
}

function nodeLabelFor(session: SessionSummary | undefined, nodeBadge?: NodeBadge): string {
  const nodeId = session?.nodeId;
  if (!nodeId || nodeId === DEFAULT_LOCAL_NODE_ID) return 'this host';
  return nodeBadge ? `${nodeBadge.label} (${nodeBadge.status})` : nodeId;
}

export function formatControlTimestamp(value: string | null | undefined): string {
  if (!value) return 'none';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

export function controlBadgeView(
  session: SessionSummary | undefined,
  nodeBadge?: NodeBadge
): ControlBadgeView {
  const mode = displayModeFor(session?.controlMode, session?.controlFreshness);
  const label = CONTROL_BADGE_LABEL[mode];
  const actorSummary = actorListLabel(session?.activeActors);
  const nodeSummary = nodeLabelFor(session, nodeBadge);
  const lastTouchSummary = session?.lastInterventionAt
    ? `${actorLabel(session.lastInterventionBy)} @ ${formatControlTimestamp(session.lastInterventionAt)}`
    : 'none';
  const reason = session?.controlReason;
  const titleParts = [
    `control: ${label}`,
    `actors: ${actorSummary}`,
    `node: ${nodeSummary}`,
    `freshness: ${session?.controlFreshness ?? 'unknown'}`,
    `last human touch: ${lastTouchSummary}`,
  ];
  if (reason) titleParts.push(`reason: ${reason}`);
  return {
    mode,
    label,
    ariaLabel: `control mode ${label}`,
    title: titleParts.join('\n'),
    actorSummary,
    nodeSummary,
    lastTouchSummary,
    ...(reason ? { reason } : {}),
  };
}

export function canHandBackToAgent(session: SessionSummary | undefined): boolean {
  if (!session) return false;
  if (session.status === 'disconnected') return false;
  if (session.controlFreshness !== 'fresh') return false;
  if (!session.lastInterventionEventId) return false;
  return session.controlMode === 'human-driven' || session.controlMode === 'co-driven';
}

export function interventionLabel(record: InterventionRecord): string {
  if (record.kind === 'human-input') return 'input';
  if (record.kind === 'take-over') return 'take-over';
  if (record.kind === 'hand-back') return 'hand-back';
  if (record.kind === 'auto-revert') return 'auto-revert';
  return 'join';
}

export function interventionTitle(record: InterventionRecord): string {
  const parts = [
    `${interventionLabel(record)} by ${actorLabel(record.author)}`,
    `${record.modeBefore}${record.modeAfter ? ` -> ${record.modeAfter}` : ''}`,
    `at ${formatControlTimestamp(record.timestamp)}`,
  ];
  if (record.payloadPreview) parts.push(`preview: ${record.payloadPreview}`);
  if (record.redaction.redacted) parts.push('payload redacted');
  return parts.join('\n');
}

export function mergeInterventions(
  primary: InterventionRecord[],
  secondary: InterventionRecord[]
): InterventionRecord[] {
  const byId = new Map<string, InterventionRecord>();
  for (const record of [...primary, ...secondary]) byId.set(record.id, record);
  return Array.from(byId.values()).sort((a, b) => {
    const bTime = Date.parse(b.timestamp);
    const aTime = Date.parse(a.timestamp);
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
}
