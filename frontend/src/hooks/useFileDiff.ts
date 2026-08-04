import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchFileDiff } from '../lib/api.js';

export type FileDiffBase = string | null;

export interface FileDiffKey {
  workspacePath: string;
  filePath: string;
  base: FileDiffBase;
}

export function fileDiffQueryKey(k: FileDiffKey) {
  return ['fileDiff', k.workspacePath, k.filePath, k.base ?? null] as const;
}

export interface UseFileDiffResult {
  diff: string;
  loading: boolean;
  error: string | null;
}

export function useFileDiff(
  key: FileDiffKey,
  options?: { enabled?: boolean }
): UseFileDiffResult {
  const enabled = options?.enabled ?? true;
  const query = useQuery({
    queryKey: fileDiffQueryKey(key),
    queryFn: async () => {
      const result = await fetchFileDiff(
        key.workspacePath,
        key.filePath,
        key.base ?? undefined
      );
      if (result.error) throw new Error(result.error);
      return result.diff;
    },
    enabled: enabled && Boolean(key.workspacePath && key.filePath),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    diff: query.data ?? '',
    loading: query.isPending && enabled,
    error: query.error ? (query.error as Error).message : null,
  };
}

export function useInvalidateFileDiff() {
  const queryClient = useQueryClient();
  return useCallback(
    (key: FileDiffKey) => {
      queryClient.invalidateQueries({ queryKey: fileDiffQueryKey(key) });
    },
    [queryClient]
  );
}
