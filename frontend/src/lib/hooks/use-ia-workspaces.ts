// #728: TanStack Query data layer for the IA Workspace bar. Wraps the #733
// `/hub/ia/workspaces` CRUD client fns (`api.ts`) in a single `['ia-workspaces']`
// query plus create/update/delete mutations that invalidate that key on success.
//
// Correctness-first: no optimistic cache writes. Each mutation simply
// invalidates `['ia-workspaces']` so the list refetches authoritative state
// from the store. Reorder, rename, and project-membership moves all funnel
// through `updateIaWorkspace` (the API folds them into one PATCH).
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

  const updateMutation = useMutation({
    mutationFn: (args: {
      id: string;
      patch: { name?: string; order?: number; projectIds?: string[] };
    }) => updateIaWorkspace(args.id, args.patch),
    onSuccess: invalidate,
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
    createMutation,
    updateMutation,
    deleteMutation,
  };
}
