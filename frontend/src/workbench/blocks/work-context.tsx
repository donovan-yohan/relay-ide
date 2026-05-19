/**
 * WorkContextBlock — Workbench slice 2 of epic #612.
 *
 * Status/control/artifact view for a WorkContext envelope.
 * Pulls current state via TanStack Query (fetchActiveWork API), matching the
 * existing pattern in ActiveWorkSurface.tsx.
 *
 * The workContextRef from the descriptor is used to identify the target
 * WorkContext from the active-work read model. If the context is not yet
 * hydrated (offline node, loading), a loading/empty state is shown.
 *
 * No raw filesystem paths are used; all data flows through the WorkContext
 * refs returned by the hub.
 */

import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import { fetchActiveWork } from '../../lib/api.js';

import './work-context.css';

const _fmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

function formatTimestamp(iso: string): string {
  try {
    return _fmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Refetch interval — matches ActiveWorkSurface.tsx polling cadence.
 * TODO: Replace with a server-push channel once WorkContext has a WebSocket
 * or SSE event feed (no such channel exists yet). Precedent: ActiveWorkSurface.tsx
 * also polls at 15 s. Track at: https://github.com/donovan-yohan/relay-ide
 */
const REFETCH_MS = 15_000;

export const WorkContextBlock: WorkbenchBlockRenderer<'work-context'> = ({
  descriptor,
  context: _context,
}) => {
  const { workContextRef } = descriptor.meta;

  const {
    data: groups,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['active-work'],
    queryFn: fetchActiveWork,
    refetchInterval: REFETCH_MS,
    staleTime: REFETCH_MS / 2,
  });

  const workContext = useMemo(() => {
    if (!groups) return null;
    for (const group of groups) {
      if (group.context?.id === workContextRef || group.id === workContextRef) {
        return group.context;
      }
    }
    return null;
  }, [groups, workContextRef]);

  if (isLoading) {
    return (
      <div
        className="block-work-context block-work-context--loading"
        aria-label="loading work context"
      >
        <span className="block-work-context__spinner">&#x280B;</span>
        <span className="block-work-context__status">
          loading work context…
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="block-work-context block-work-context--error"
        role="alert"
        aria-label="work context error"
      >
        <div className="block-work-context__heading">
          work context unavailable
        </div>
        <div className="block-work-context__detail">{String(error)}</div>
      </div>
    );
  }

  if (!workContext) {
    return (
      <div
        className="block-work-context block-work-context--empty"
        aria-label="work context not found"
      >
        <div className="block-work-context__heading">
          work context not found
        </div>
        <div className="block-work-context__detail">ref: {workContextRef}</div>
      </div>
    );
  }

  const firstTask = workContext.tasks[0];
  const taskLabel =
    workContext.title ?? firstTask?.title ?? firstTask?.id ?? 'no task';

  return (
    <div
      className="block-work-context"
      aria-label={`work context: ${descriptor.title}`}
    >
      <div className="block-work-context__header">
        <div className="block-work-context__kind">work-context</div>
        <div className="block-work-context__title">{descriptor.title}</div>
      </div>

      <div className="block-work-context__section">
        <div className="block-work-context__label">task</div>
        <div className="block-work-context__value">{taskLabel}</div>
      </div>

      {workContext.actors.length > 0 && (
        <div className="block-work-context__section">
          <div className="block-work-context__label">actors</div>
          <div className="block-work-context__list">
            {workContext.actors.map((actor) => (
              <div key={actor.id} className="block-work-context__list-item">
                <span className="block-work-context__actor-kind">
                  {actor.kind}
                </span>
                <span className="block-work-context__actor-name">
                  {actor.displayName ?? actor.providerId ?? actor.id}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {workContext.artifacts.length > 0 && (
        <div className="block-work-context__section">
          <div className="block-work-context__label">artifacts</div>
          <div className="block-work-context__list">
            {workContext.artifacts.map((artifact) => (
              <div key={artifact.id} className="block-work-context__list-item">
                <span className="block-work-context__artifact-kind">
                  {artifact.kind}
                </span>
                <span className="block-work-context__artifact-title">
                  {artifact.title ?? artifact.id}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="block-work-context__section block-work-context__section--meta">
        <div className="block-work-context__detail">id: {workContext.id}</div>
        <div className="block-work-context__detail">
          updated: {formatTimestamp(workContext.updatedAt)}
        </div>
      </div>
    </div>
  );
};

export default WorkContextBlock;
