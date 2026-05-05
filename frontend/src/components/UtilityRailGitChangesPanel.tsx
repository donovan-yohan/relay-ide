import React, { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchChangedFiles } from '../lib/api.js';
import { useUiStore } from '../lib/stores/ui.js';
import type { ChangedFile, FileChangeStatus } from '../lib/types.js';
import './UtilityRailGitChangesPanel.css';

export interface UtilityRailGitChangesPanelProps {
  workspacePath: string;
}

interface ChangedFilesResponse {
  files: ChangedFile[];
  aggregate: { additions: number; deletions: number; fileCount: number };
  error?: string;
}

function workingKey(workspacePath: string) {
  return ['changedFiles', workspacePath, ''] as const;
}
function stagedKey(workspacePath: string) {
  return ['changedFiles', workspacePath, 'cached'] as const;
}

const STATUS_LETTER: Record<FileChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

const STATUS_CLASS: Record<FileChangeStatus, string> = {
  added: 'gc-status--a',
  modified: 'gc-status--m',
  deleted: 'gc-status--d',
  renamed: 'gc-status--r',
  untracked: 'gc-status--u',
};

interface RowProps {
  file: ChangedFile;
  selected: boolean;
  onClick: (file: ChangedFile) => void;
}

function FileRow({ file, selected, onClick }: RowProps) {
  const slash = file.path.lastIndexOf('/');
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const dir = slash >= 0 ? file.path.slice(0, slash) : '';
  return (
    <button
      type="button"
      className={`gc-row${selected ? ' selected' : ''}`}
      data-state={file.status}
      onClick={() => onClick(file)}
      title={file.path}
    >
      <span className={`gc-status ${STATUS_CLASS[file.status]}`}>
        {STATUS_LETTER[file.status]}
      </span>
      <span className="gc-name">{name}</span>
      {dir ? <span className="gc-dir">{dir}</span> : null}
      {file.additions > 0 || file.deletions > 0 ? (
        <span className="gc-stats">
          {file.additions > 0 && (
            <span className="gc-add">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="gc-del">−{file.deletions}</span>
          )}
        </span>
      ) : null}
    </button>
  );
}

export function UtilityRailGitChangesPanel({
  workspacePath,
}: UtilityRailGitChangesPanelProps) {
  const queryClient = useQueryClient();
  const openUtilityRailTab = useUiStore((s) => s.openUtilityRailTab);
  const openReviewWorkspace = useUiStore((s) => s.openReviewWorkspace);
  const reviewFilePath = useUiStore(
    (s) => s.utilityRailByWorkspace[workspacePath]?.review?.activeFilePath ?? null
  );

  const workingQuery = useQuery<ChangedFilesResponse>({
    queryKey: workingKey(workspacePath),
    queryFn: async () => {
      const data = await fetchChangedFiles(workspacePath);
      if (data.error) throw new Error(data.error);
      return data;
    },
    enabled: Boolean(workspacePath),
    staleTime: 2 * 1000,
    retry: false,
  });

  const stagedQuery = useQuery<ChangedFilesResponse>({
    queryKey: stagedKey(workspacePath),
    queryFn: async () => {
      const data = await fetchChangedFiles(workspacePath, 'cached');
      if (data.error) throw new Error(data.error);
      return data;
    },
    enabled: Boolean(workspacePath),
    staleTime: 2 * 1000,
    retry: false,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: workingKey(workspacePath) });
    queryClient.invalidateQueries({ queryKey: stagedKey(workspacePath) });
  }, [queryClient, workspacePath]);

  const openBranchPanel = useCallback(() => {
    openUtilityRailTab(workspacePath, 'branch');
  }, [openUtilityRailTab, workspacePath]);

  const groups = useMemo(() => {
    const working = workingQuery.data?.files ?? [];
    const staged = stagedQuery.data?.files ?? [];
    // Partially-staged files (present in both staged and working) appear in
    // both sections — matches VS Code SCM. Untracked split out separately.
    const untracked = working.filter((f) => f.status === 'untracked');
    const changes = working.filter((f) => f.status !== 'untracked');
    return { staged, changes, untracked };
  }, [workingQuery.data?.files, stagedQuery.data?.files]);

  const handleStagedClick = useCallback(
    (file: ChangedFile) => {
      openReviewWorkspace(workspacePath, { filePath: file.path, base: 'cached' });
    },
    [openReviewWorkspace, workspacePath]
  );

  const handleWorkingClick = useCallback(
    (file: ChangedFile) => {
      openReviewWorkspace(workspacePath, { filePath: file.path, base: '' });
    },
    [openReviewWorkspace, workspacePath]
  );

  const selectedPath = reviewFilePath;

  const isLoading = workingQuery.isPending && !workingQuery.data;
  const errorMsg =
    workingQuery.error instanceof Error
      ? workingQuery.error.message
      : stagedQuery.error instanceof Error
        ? stagedQuery.error.message
        : null;
  const totalCount =
    groups.staged.length + groups.changes.length + groups.untracked.length;

  return (
    <div className="gc">
      <div className="gc__hd">
        <span className="title">git changes</span>
        <span className="meta">{totalCount} files</span>
        <button
          type="button"
          className="btn"
          onClick={openBranchPanel}
          title="branch divergence"
        >
          branch
        </button>
        <button
          type="button"
          className="btn"
          onClick={refresh}
          title="refresh"
          aria-label="refresh"
        >
          ↻
        </button>
      </div>

      <div className="gc__list">
        {isLoading ? (
          <div className="gc__loading">loading…</div>
        ) : errorMsg ? (
          <div className="gc__error">
            {errorMsg}
            <button type="button" className="retry" onClick={refresh}>
              retry
            </button>
          </div>
        ) : totalCount === 0 ? (
          <div className="gc__empty">no changes</div>
        ) : (
          <>
            {groups.staged.length > 0 && (
              <section className="gc-group">
                <header className="gc-group__hd">
                  <span className="gc-group__label">staged</span>
                  <span className="gc-group__ct">{groups.staged.length}</span>
                </header>
                {groups.staged.map((f) => (
                  <FileRow
                    key={`s-${f.path}`}
                    file={f}
                    selected={selectedPath === f.path}
                    onClick={handleStagedClick}
                  />
                ))}
              </section>
            )}
            {groups.changes.length > 0 && (
              <section className="gc-group">
                <header className="gc-group__hd">
                  <span className="gc-group__label">changes</span>
                  <span className="gc-group__ct">{groups.changes.length}</span>
                </header>
                {groups.changes.map((f) => (
                  <FileRow
                    key={`c-${f.path}`}
                    file={f}
                    selected={selectedPath === f.path}
                    onClick={handleWorkingClick}
                  />
                ))}
              </section>
            )}
            {groups.untracked.length > 0 && (
              <section className="gc-group">
                <header className="gc-group__hd">
                  <span className="gc-group__label">untracked</span>
                  <span className="gc-group__ct">
                    {groups.untracked.length}
                  </span>
                </header>
                {groups.untracked.map((f) => (
                  <FileRow
                    key={`u-${f.path}`}
                    file={f}
                    selected={selectedPath === f.path}
                    onClick={handleWorkingClick}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default UtilityRailGitChangesPanel;
