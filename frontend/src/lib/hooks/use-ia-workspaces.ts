// #728: TanStack Query data layer for the IA Workspace bar. Wraps the #733
// `/hub/ia/workspaces` CRUD client fns (`api.ts`) in a single `['ia-workspaces']`
// query plus create/update/delete mutations.
//
// Correctness-first: no optimistic cache writes. `create`/`delete` are single
// ops and invalidate `['ia-workspaces']` on success. `update` (rename, reorder,
// project-membership) does NOT auto-invalidate (#752): reorder and project-move
// each fire TWO `update` PATCHes that must be SEQUENCED (mutateAsync) and
// reconciled with a SINGLE refetch at the end — per-mutation invalidation would
// refetch between the two PATCHes (flicker) and a partial failure would leave
// the list inconsistent. Callers own the post-sequence `refetch`/`invalidate`.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createIaWorkspace,
  deleteIaWorkspace,
  fetchIaWorkspaces,
  updateIaWorkspace,
  type IaWorkspace,
} from '../api.js';

export const IA_WORKSPACES_QUERY_KEY = ['ia-workspaces'] as const;

export function useIaWorkspacesQuery() {
  return useQuery({
    queryKey: IA_WORKSPACES_QUERY_KEY,
    queryFn: fetchIaWorkspaces,
    staleTime: 30_000,
  });
}

/** Bundle of the IA Workspace query + its mutations. The mutations invalidate
 *  the list on success so the UI re-reads authoritative store state. */
export function useIaWorkspaces() {
  const queryClient = useQueryClient();
  const query = useIaWorkspacesQuery();

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: IA_WORKSPACES_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (input: {
      name: string;
      projectIds?: string[];
      order?: number;
    }) => createIaWorkspace(input),
    onSuccess: invalidate,
  });

  // #752: NO auto-invalidate — sequenced two-PATCH ops (reorder, project move)
  // reconcile with ONE caller-driven refetch at the end. Single-op callers
  // (rename) invalidate explicitly.
  const updateMutation = useMutation({
    mutationFn: (args: {
      id: string;
      patch: { name?: string; order?: number; projectIds?: string[] };
    }) => updateIaWorkspace(args.id, args.patch),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteIaWorkspace(id),
    onSuccess: invalidate,
  });

  return {
    workspaces: (query.data ?? []) as IaWorkspace[],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    /** Mark `['ia-workspaces']` stale + refetch. Callers use this after a
     *  single-op update or to reconcile a sequenced op. */
    invalidate,
    createMutation,
    updateMutation,
    deleteMutation,
  };
}
