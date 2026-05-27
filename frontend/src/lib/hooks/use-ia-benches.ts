// #730: TanStack Query data layer for Bench overlays (#735 `/hub/ia/benches`).
// Mirrors `use-ia-workspaces.ts`: a per-instance list query plus create/delete
// mutations that invalidate that instance's key on success.
//
// Correctness-first: no optimistic cache writes. Each mutation invalidates the
// relevant `['ia-benches', instanceId]` key so the list refetches authoritative
// state from the store and the new overlay appears under its Instance.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createIaBench,
  deleteIaBench,
  fetchIaBenches,
  type IaBench,
} from '../api.js';

/** Query key for an instance's bench overlays. A blank instanceId disables the
 *  query (the hook is always mounted per-instance, but guards anyway). */
export function iaBenchesQueryKey(instanceId: string) {
  return ['ia-benches', instanceId] as const;
}

export function useIaBenchesQuery(instanceId: string) {
  return useQuery({
    queryKey: iaBenchesQueryKey(instanceId),
    queryFn: () => fetchIaBenches(instanceId),
    enabled: instanceId.length > 0,
    staleTime: 30_000,
  });
}

/** Bundle of one instance's bench-overlay query + its mutations. The mutations
 *  invalidate that instance's list on success so the UI re-reads the store. */
export function useIaBenches(instanceId: string) {
  const queryClient = useQueryClient();
  const query = useIaBenchesQuery(instanceId);

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: iaBenchesQueryKey(instanceId),
    });

  const createMutation = useMutation({
    mutationFn: (input: {
      instanceId: string;
      cwd: string;
      label?: string;
      envOverrides?: Record<string, string>;
    }) => createIaBench(input),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteIaBench(id),
    onSuccess: invalidate,
  });

  return {
    benches: (query.data ?? []) as IaBench[],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    createMutation,
    deleteMutation,
  };
}
