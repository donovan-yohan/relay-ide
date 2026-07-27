import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type { InterventionRecord } from '../../../shared/control-state.js';
import {
  interventionLabel,
  interventionTitle,
  mergeInterventions,
} from '../lib/control-display.js';
import { fetchSessionInterventions } from '../lib/api.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import type { SessionSummary } from '../lib/types.js';
import './InterventionStrip.css';

const EMPTY_INTERVENTIONS: InterventionRecord[] = [];

export interface InterventionStripProps {
  session?: SessionSummary | undefined;
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
  return (
    session.globalSessionId ??
    `${session.nodeId ?? DEFAULT_LOCAL_NODE_ID}:${session.id}`
  );
}

function InterventionItem({ record }: { record: InterventionRecord }) {
  const label = interventionLabel(record);
  return (
    <span
      className={`intervention-strip__event intervention-strip__event--${record.kind}`}
      title={interventionTitle(record)}
    >
      <span className="intervention-strip__event-time">
        {shortTime(record.timestamp)}
      </span>
      <span className="intervention-strip__event-label">{label}</span>
    </span>
  );
}

export function InterventionStrip({ session }: InterventionStripProps) {
  const cacheKey = sessionCacheKey(session);
  const cachedRecords = useSessionsStore((state) =>
    cacheKey
      ? (state.interventionsBySession[cacheKey] ?? EMPTY_INTERVENTIONS)
      : EMPTY_INTERVENTIONS
  );
  const remote = isRemoteSession(session);

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

  return (
    <div
      className="intervention-strip"
      aria-label="recent terminal interventions"
    >
      <span className="intervention-strip__heading">recent input</span>
      <div
        className="intervention-strip__events"
        aria-label="recent human touch"
      >
        {interventionsQuery.isLoading && !remote && records.length === 0 ? (
          <span className="intervention-strip__empty">
            loading touch events
          </span>
        ) : records.length > 0 ? (
          records.map((record) => (
            <InterventionItem key={record.id} record={record} />
          ))
        ) : remote ? (
          <span className="intervention-strip__empty">
            remote touch history unavailable until node intervention rpc lands
          </span>
        ) : (
          <span className="intervention-strip__empty">
            no recent human touch
          </span>
        )}
      </div>
    </div>
  );
}

export default InterventionStrip;
