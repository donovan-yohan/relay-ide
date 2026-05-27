// #730: TanStack Query data layer for Bench overlays (#735 `/hub/ia/benches`).
// Mirrors `use-ia-workspaces.ts`: a list query plus create/delete mutations that
// invalidate the bench cache on success.
//
// #773 fan-out fix: the tree fetches ALL overlays ONCE (`useIaBenchesAll`, an
// unfiltered `GET /hub/ia/benches`) and groups by instanceId client-side,
// replacing the previous N per-instance GETs (one per `InstanceRow`). Mutations
// now invalidate the WHOLE `['ia-benches']` family so both the unfiltered list
// and any legacy per-instance reader stay coherent.
//
// Correctness-first: no optimistic cache writes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createIaBench,
  deleteIaBench,
  fetchIaBenches,
  type IaBench,
} from '../api.js';

/** Root key for the bench-overlay cache family. Invalidating it refetches both
 *  the unfiltered list and any per-instance query. */
export const IA_BENCHES_QUERY_KEY = ['ia-benches'] as const;

/** Query key for an instance's bench overlays. A blank instanceId disables the
 *  query. Retained for callers that still want a single-instance read. */
export function iaBenchesQueryKey(instanceId: string) {
  return ['ia-benches', instanceId] as const;
}

/** Query key for the unfiltered (all-instances) bench-overlay list. */
export function iaBenchesAllQueryKey() {
  return ['ia-benches', 'all'] as const;
}

export function useIaBenchesQuery(instanceId: string) {
  return useQuery({
    queryKey: iaBenchesQueryKey(instanceId),
    queryFn: () => fetchIaBenches(instanceId),
    enabled: instanceId.length > 0,
    staleTime: 30_000,
  });
}

/** #773: a SINGLE unfiltered `GET /hub/ia/benches` for the whole tree. The
 *  caller groups the flat list by `instanceId` (no per-instance fan-out). */
export function useIaBenchesAll() {
  return useQuery({
    queryKey: iaBenchesAllQueryKey(),
    queryFn: () => fetchIaBenches(),
    staleTime: 30_000,
  });
}

/** Create/delete mutations for bench overlays. Each invalidates the entire
 *  `['ia-benches']` family so the unfiltered list (and any per-instance reader)
 *  re-reads authoritative store state. Scoped per-instance so error/in-flight
 *  state stays local to the owning row. */
export function useIaBenchMutations(_instanceId: string) {
  const queryClient = useQueryClient();

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: IA_BENCHES_QUERY_KEY });

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

  return { createMutation, deleteMutation };
}

/** Bundle of one instance's bench-overlay query + its mutations. The mutations
 *  invalidate the bench cache on success so the UI re-reads the store. Retained
 *  for any caller wanting a self-contained per-instance reader; the tree itself
 *  now uses `useIaBenchesAll` + `useIaBenchMutations` to avoid query fan-out. */
export function useIaBenches(instanceId: string) {
  const query = useIaBenchesQuery(instanceId);
  const { createMutation, deleteMutation } = useIaBenchMutations(instanceId);

  return {
    benches: (query.data ?? []) as IaBench[],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    createMutation,
    deleteMutation,
  };
}
