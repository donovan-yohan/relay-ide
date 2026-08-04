import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchFileContent,
  saveFileContent,
  type SaveFileContentResult,
} from '../lib/api.js';
import type { FileContentResponse } from '../lib/types.js';

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

export interface SaveFileContentVars {
  content: string;
  /** Pin the last-read mtime for optimistic concurrency; omit to force overwrite. */
  expectedMtimeMs?: number;
}

/**
 * Mutation that writes file content. On success it primes the read query cache
 * with the saved text + new mtime/size so the editor's baseline stays in sync
 * without a refetch.
 */
export function useSaveFileContent(key: FileContentKey) {
  const queryClient = useQueryClient();
  return useMutation<SaveFileContentResult, Error, SaveFileContentVars>({
    mutationFn: (vars) =>
      saveFileContent(
        key.workspacePath,
        key.filePath,
        vars.content,
        vars.expectedMtimeMs
      ),
    onSuccess: (result, vars) => {
      queryClient.setQueryData<FileContentResponse>(
        fileContentQueryKey(key),
        (_prev) => ({
          content: vars.content,
          binary: false,
          truncated: false,
          mtimeMs: result.mtimeMs,
          sizeBytes: result.sizeBytes,
        })
      );
    },
  });
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
