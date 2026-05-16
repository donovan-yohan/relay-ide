import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type { InterventionRecord } from '../../../shared/control-state.js';
import {
  canHandBackToAgent,
  controlBadgeView,
  interventionLabel,
  interventionTitle,
  mergeInterventions,
} from '../lib/control-display.js';
import { fetchSessionInterventions, handBackSessionControl } from '../lib/api.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import type { NodeBadge } from '../lib/workspace-summary.js';
import type { SessionSummary } from '../lib/types.js';
import TabControlBadge from './TabControlBadge.js';
import './InterventionStrip.css';

export interface InterventionStripProps {
  session?: SessionSummary | undefined;
  nodeBadge?: NodeBadge | undefined;
}

function isRemoteSession(session: SessionSummary | undefined): boolean {
  return !!session?.nodeId && session.nodeId !== DEFAULT_LOCAL_NODE_ID;
}

function shortTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sessionCacheKey(session: SessionSummary | undefined): string | null {
  if (!session) return null;
  return session.globalSessionId ?? `${session.nodeId ?? DEFAULT_LOCAL_NODE_ID}:${session.id}`;
}

function shouldConfirmHandBack(session: SessionSummary): boolean {
  if (!session.lastInterventionAt) return false;
  const touchedAt = Date.parse(session.lastInterventionAt);
  if (!Number.isFinite(touchedAt)) return true;
  return Date.now() - touchedAt < 5 * 60_000;
}

function InterventionItem({ record }: { record: InterventionRecord }) {
  const label = interventionLabel(record);
  return (
    <span
      className={`intervention-strip__event intervention-strip__event--${record.kind}`}
      title={interventionTitle(record)}
    >
      <span className="intervention-strip__event-time">{shortTime(record.timestamp)}</span>
      <span className="intervention-strip__event-label">{label}</span>
      {record.modeAfter && record.modeAfter !== record.modeBefore && (
        <span className="intervention-strip__event-mode">
          {record.modeBefore.replace('-driven', '')}→{record.modeAfter.replace('-driven', '')}
        </span>
      )}
    </span>
  );
}

export function InterventionStrip({ session, nodeBadge }: InterventionStripProps) {
  const cacheKey = sessionCacheKey(session);
  const cachedRecords = useSessionsStore((state) =>
    cacheKey ? (state.interventionsBySession[cacheKey] ?? []) : []
  );
  const refreshAll = useSessionsStore((state) => state.refreshAll);
  const queryClient = useQueryClient();
  const remote = isRemoteSession(session);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const interventionsQuery = useQuery({
    queryKey: [
      'session-interventions',
      session?.id ?? null,
      session?.lastInterventionEventId ?? null,
    ],
    queryFn: () => fetchSessionInterventions(session!.id, 12),
    enabled: !!session && !remote,
    staleTime: 15_000,
  });

  const records = useMemo(
    () =>
      mergeInterventions(
        cachedRecords,
        interventionsQuery.data?.interventions ?? []
      ).slice(0, 4),
    [cachedRecords, interventionsQuery.data?.interventions]
  );

  if (!session) return null;

  const view = controlBadgeView(session, nodeBadge);
  const canHandBack = canHandBackToAgent(session) && !remote;
  const detailParts = [
    `actors ${view.actorSummary}`,
    `node ${view.nodeSummary}`,
    `last touch ${view.lastTouchSummary}`,
  ];
  if (view.reason) detailParts.push(view.reason);

  const handleHandBack = async () => {
    if (!session.lastInterventionEventId) return;
    if (
      shouldConfirmHandBack(session) &&
      !window.confirm(
        'hand control back to the agent after the latest human input?'
      )
    ) {
      return;
    }
    setActionMessage('handing back...');
    try {
      await handBackSessionControl({
        sessionId: session.id,
        latestSeenInterventionEventId: session.lastInterventionEventId,
        actor: { kind: 'human', id: 'browser-user', displayName: 'browser user' },
      });
      setActionMessage('handed back');
      await queryClient.invalidateQueries({ queryKey: ['session-interventions'] });
      void refreshAll();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'hand-back failed');
    }
  };

  return (
    <div className="intervention-strip" aria-label="tab control and interventions">
      <div className="intervention-strip__state">
        <TabControlBadge session={session} nodeBadge={nodeBadge} />
        <span className="intervention-strip__detail" title={view.title}>
          {detailParts.join(' · ')}
        </span>
      </div>
      <div className="intervention-strip__events" aria-label="recent human touch">
        {interventionsQuery.isLoading && !remote && records.length === 0 ? (
          <span className="intervention-strip__empty">loading touch events</span>
        ) : records.length > 0 ? (
          records.map((record) => <InterventionItem key={record.id} record={record} />)
        ) : remote ? (
          <span className="intervention-strip__empty">
            remote touch history unavailable until node intervention rpc lands
          </span>
        ) : (
          <span className="intervention-strip__empty">no recent human touch</span>
        )}
      </div>
      <div className="intervention-strip__actions">
        {canHandBack && (
          <button
            type="button"
            className="intervention-strip__action"
            onClick={handleHandBack}
          >
            hand back
          </button>
        )}
        {remote && session.controlFreshness !== 'fresh' && (
          <span className="intervention-strip__note">controls unavailable while remote state is {session.controlFreshness ?? 'unknown'}</span>
        )}
        {actionMessage && (
          <span className="intervention-strip__note">{actionMessage}</span>
        )}
      </div>
    </div>
  );
}

export default InterventionStrip;
