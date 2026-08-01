// #1287 slice 2: turning a `POST /workspaces/bulk` response into "which lanes
// can the dialog actually reveal, and what must it tell the user instead".
//
// Pure and separate from AddWorkspaceDialog so the decision is unit-testable —
// the rules are not obvious:
//
//   - a DUPLICATE re-add is reported as an "Already exists" error but still
//     resolves a real lane, so an error does not mean there is nothing to show;
//   - an ARCHIVED lane resolves too, but `GET /hub/ia/workspaces` hides
//     archived rows, so revealing it would promise a lane that never appears;
//   - a hub predating the `workspaces` field reports nothing, and there the
//     freshly added paths are the best available answer.

import type { BulkAddResult } from './api.js';

export interface BulkAddLaneOutcome {
  /** Paths whose lane the sidebar will actually render. Safe to reveal. */
  laneReadyPaths: string[];
  /** Everything the user must be told: hub errors plus archived-lane notices.
   *  Same shape as the hub's `errors` so one list renders both. */
  blockers: Array<{ path: string; error: string }>;
}

export function resolveBulkAddLanes(
  result: Pick<BulkAddResult, 'added' | 'errors' | 'workspaces'>
): BulkAddLaneOutcome {
  const resolvedLanes = result.workspaces ?? [];
  const archivedLanes = resolvedLanes.filter((lane) => lane.archived === true);
  const laneReadyPaths =
    resolvedLanes.length > 0
      ? resolvedLanes
          .filter((lane) => lane.archived !== true)
          .map((lane) => lane.path)
      : result.added.map((entry) => entry.path);

  return {
    laneReadyPaths,
    blockers: [
      ...result.errors,
      ...archivedLanes.map((lane) => ({
        path: lane.path,
        error: `lane "${lane.name}" is archived — restore it to see this project`,
      })),
    ],
  };
}
