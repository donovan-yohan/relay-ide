import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchFileContent } from '../lib/api.js';

export interface FileContentKey {
  workspacePath: string;
  filePath: string;
}

export function fileContentQueryKey(k: FileContentKey) {
  return ['fileContent', k.workspacePath, k.filePath] as const;
}

export interface UseFileContentResult {
  content: string;
  mtimeMs: number | null;
  sizeBytes: number | null;
  binary: boolean;
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

export function useFileContent(
  key: FileContentKey,
  options?: { enabled?: boolean }
): UseFileContentResult {
  const enabled = options?.enabled ?? true;
  const query = useQuery({
    queryKey: fileContentQueryKey(key),
    queryFn: async () => {
      const result = await fetchFileContent(key.workspacePath, key.filePath);
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: enabled && Boolean(key.workspacePath && key.filePath),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    content: query.data?.content ?? '',
    mtimeMs: query.data?.mtimeMs ?? null,
    sizeBytes: query.data?.sizeBytes ?? null,
    binary: query.data?.binary ?? false,
    truncated: query.data?.truncated ?? false,
    loading: query.isPending && enabled,
    error: query.error ? (query.error as Error).message : null,
  };
}

export function useInvalidateFileContent() {
  const queryClient = useQueryClient();
  return useCallback(
    (key: FileContentKey) => {
      queryClient.invalidateQueries({ queryKey: fileContentQueryKey(key) });
    },
    [queryClient]
  );
}
