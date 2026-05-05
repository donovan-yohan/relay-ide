import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangedFile } from '../lib/types.js';
import { fetchChangedFiles, fetchDefaultBranch } from '../lib/api.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import { generateFileSummary } from '../lib/diff-summary.js';
import { useFileDiff } from '../hooks/useFileDiff.js';
import {
  useUiStore,
  type DiffSource,
  type WorkspaceReviewState,
} from '../lib/stores/ui.js';
import DiffSourceToggle from './DiffSourceToggle.js';
import DiffViewer from './DiffViewer.js';
import { DiffFileSidebar, type DiffFileSidebarHandle } from './DiffFileSidebar.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailReviewPanelProps {
  workspacePath: string;
  reviewState?: WorkspaceReviewState | undefined;
  onRequestClose?: (() => void) | undefined;
}

interface ChangedFilesResponse {
  files: ChangedFile[];
  aggregate: { additions: number; deletions: number; fileCount: number };
  error?: string;
}

const EMPTY_CHANGED_FILES: ChangedFile[] = [];

function changedFilesQueryKey(workspacePath: string, base: string) {
  return ['changedFiles', workspacePath, base] as const;
}

function defaultBranchQueryKey(workspacePath: string) {
  return ['defaultBranch', workspacePath] as const;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    Boolean(target.closest('[role="textbox"], [data-terminal-root], .xterm'))
  );
}

function sourceLabel(source: DiffSource, defaultBranch: string): string {
  if (source === 'staged') return 'staged';
  if (source === 'branch') return `vs ${defaultBranch}`;
  return 'working tree';
}

export function UtilityRailReviewPanel({
  workspacePath,
  reviewState,
  onRequestClose,
}: UtilityRailReviewPanelProps) {
  const queryClient = useQueryClient();
  const storeReviewState = useUiStore(
    (s) => s.utilityRailByWorkspace[workspacePath]?.review
  );
  const fileDiffViewMode = useUiStore((s) => s.fileDiffViewMode);
  const setFileDiffViewMode = useUiStore((s) => s.setFileDiffViewMode);
  const openUtilityRailTab = useUiStore((s) => s.openUtilityRailTab);
  const openReviewWorkspace = useUiStore((s) => s.openReviewWorkspace);
  const setReviewActiveFile = useUiStore((s) => s.setReviewActiveFile);
  const setReviewDiffSource = useUiStore((s) => s.setReviewDiffSource);
  const setReviewDefaultBranch = useUiStore((s) => s.setReviewDefaultBranch);
  const setReviewCurrentHunkIndex = useUiStore(
    (s) => s.setReviewCurrentHunkIndex
  );
  const sidebarRef = useRef<DiffFileSidebarHandle>(null);
  const diffScrollerRef = useRef<HTMLDivElement | null>(null);

  const review = reviewState ??
    storeReviewState ?? {
      activeFilePath: null,
      diffSource: 'working' as const,
      defaultBranch: 'main',
      currentHunkIndex: -1,
    };
  const activeFilePath = review.activeFilePath;
  const base = useMemo(
    () => diffSourceToBase(review.diffSource, review.defaultBranch) ?? '',
    [review.diffSource, review.defaultBranch]
  );

  useEffect(() => {
    if (!workspacePath) return;
    openReviewWorkspace(workspacePath, { preserveSelectedTab: true });
  }, [openReviewWorkspace, workspacePath]);

  const defaultBranchQuery = useQuery<string>({
    queryKey: defaultBranchQueryKey(workspacePath),
    queryFn: () => fetchDefaultBranch(workspacePath),
    enabled: Boolean(workspacePath),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    const branch = defaultBranchQuery.data;
    if (!workspacePath || !branch) return;
    if (review.defaultBranch === 'main' || review.defaultBranch === '') {
      setReviewDefaultBranch(workspacePath, branch);
    }
  }, [defaultBranchQuery.data, review.defaultBranch, setReviewDefaultBranch, workspacePath]);

  const filesQuery = useQuery<ChangedFilesResponse>({
    queryKey: changedFilesQueryKey(workspacePath, base),
    queryFn: async () => {
      const data = await fetchChangedFiles(workspacePath, base || undefined);
      if (data.error) throw new Error(data.error);
      return data;
    },
    enabled: Boolean(workspacePath),
    staleTime: 2 * 1000,
    retry: false,
  });

  const files = filesQuery.data?.files ?? EMPTY_CHANGED_FILES;
  const activeFile = useMemo(
    () => files.find((file) => file.path === activeFilePath),
    [activeFilePath, files]
  );

  useEffect(() => {
    if (!workspacePath || filesQuery.isPending || filesQuery.isError) return;
    if (activeFilePath && files.some((file) => file.path === activeFilePath)) {
      return;
    }
    setReviewActiveFile(workspacePath, files[0]?.path ?? null);
  }, [activeFilePath, files, filesQuery.isError, filesQuery.isPending, setReviewActiveFile, workspacePath]);

  const {
    diff: fileDiff,
    loading: diffLoading,
    error: diffError,
  } = useFileDiff(
    {
      workspacePath,
      filePath: activeFilePath ?? '',
      base: base || null,
    },
    { enabled: Boolean(activeFilePath) }
  );

  const summary = useMemo(() => {
    if (!activeFilePath || !activeFile || !fileDiff) return '';
    return generateFileSummary(fileDiff, activeFilePath, activeFile.status);
  }, [activeFile, activeFilePath, fileDiff]);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: changedFilesQueryKey(workspacePath, base),
    });
    if (activeFilePath) {
      queryClient.invalidateQueries({
        queryKey: ['fileDiff', workspacePath, activeFilePath, base || null],
      });
    }
  }, [activeFilePath, base, queryClient, workspacePath]);

  const handleSelectFile = useCallback(
    (file: ChangedFile) => {
      setReviewActiveFile(workspacePath, file.path);
    },
    [setReviewActiveFile, workspacePath]
  );

  const handleSourceChange = useCallback(
    (source: DiffSource) => {
      setReviewDiffSource(workspacePath, source);
    },
    [setReviewDiffSource, workspacePath]
  );

  const handleModeToggle = useCallback(() => {
    setFileDiffViewMode(
      fileDiffViewMode === 'unified' ? 'side-by-side' : 'unified'
    );
  }, [fileDiffViewMode, setFileDiffViewMode]);

  const branchBase = review.diffSource === 'branch' ? base : null;
  const openBranchPanel = useCallback(() => {
    openUtilityRailTab(workspacePath, 'branch', {
      branchBase,
    });
  }, [branchBase, openUtilityRailTab, workspacePath]);

  const scrollToHunk = useCallback(
    (delta: number) => {
      const root = diffScrollerRef.current;
      if (!root) return;
      const hunks = root.querySelectorAll('.hunk-header');
      if (hunks.length === 0) return;
      const target = Math.max(
        0,
        Math.min(hunks.length - 1, review.currentHunkIndex + delta)
      );
      setReviewCurrentHunkIndex(workspacePath, target);
      hunks[target]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    [review.currentHunkIndex, setReviewCurrentHunkIndex, workspacePath]
  );

  useEffect(() => {
    setReviewCurrentHunkIndex(workspacePath, -1);
  }, [activeFilePath, base, setReviewCurrentHunkIndex, workspacePath]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        sidebarRef.current?.moveFocus(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        sidebarRef.current?.moveFocus(-1);
      } else if (event.key === 'n') {
        event.preventDefault();
        scrollToHunk(1);
      } else if (event.key === 'p') {
        event.preventDefault();
        scrollToHunk(-1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (onRequestClose) {
          onRequestClose();
        } else {
          useUiStore.getState().setSelectedUtilityRailTab(workspacePath, null);
        }
      }
    },
    [onRequestClose, scrollToHunk, workspacePath]
  );

  const filesError =
    filesQuery.error instanceof Error ? filesQuery.error.message : null;
  const emptyLabel =
    review.diffSource === 'staged'
      ? 'no staged changes'
      : review.diffSource === 'branch'
        ? `no changes against ${review.defaultBranch}`
        : 'no changed files';

  return (
    <div
      className="utility-review-panel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="review workspace"
    >
      <div className="utility-panel-toolbar">
        <div className="utility-review-source">
          <DiffSourceToggle
            value={review.diffSource}
            onchange={handleSourceChange}
            defaultBranch={review.defaultBranch}
          />
          <span className="utility-review-source-label">
            {sourceLabel(review.diffSource, review.defaultBranch)}
          </span>
        </div>
        <button
          className="utility-panel-btn"
          onClick={openBranchPanel}
          type="button"
        >
          [branch]
        </button>
        <button
          className="utility-panel-btn"
          onClick={handleModeToggle}
          type="button"
          aria-label="toggle diff view mode"
        >
          {fileDiffViewMode === 'unified' ? '[split]' : '[unified]'}
        </button>
        <button
          className="utility-panel-btn"
          onClick={refresh}
          type="button"
          aria-label="retry review load"
        >
          retry
        </button>
      </div>
      <div className="utility-review-body">
        <div className="utility-review-files">
          {filesQuery.isPending ? (
            <div className="utility-empty">loading files...</div>
          ) : filesError ? (
            <div className="utility-empty utility-error">
              {filesError}
              <button type="button" className="utility-panel-btn" onClick={refresh}>
                retry
              </button>
            </div>
          ) : files.length === 0 ? (
            <div className="utility-empty">{emptyLabel}</div>
          ) : (
            <DiffFileSidebar
              ref={sidebarRef}
              files={files}
              activeFile={activeFilePath}
              onSelectFile={handleSelectFile}
            />
          )}
        </div>
        <div className="utility-review-diff" ref={diffScrollerRef}>
          {activeFilePath ? (
            <>
              <div className="utility-review-title">
                <span>{activeFilePath}</span>
                <span className="utility-review-title-meta">
                  {summary ? (
                    <span className="utility-muted">{summary}</span>
                  ) : null}
                  <span className="utility-muted">
                    {fileDiffViewMode} · {sourceLabel(review.diffSource, review.defaultBranch)}
                  </span>
                </span>
              </div>
              {diffError ? (
                <div className="utility-empty utility-error">
                  {diffError}
                  <button type="button" className="utility-panel-btn" onClick={refresh}>
                    retry
                  </button>
                </div>
              ) : (
                <DiffViewer
                  diff={fileDiff}
                  filePath={activeFilePath}
                  loading={diffLoading}
                  mode={fileDiffViewMode}
                />
              )}
            </>
          ) : filesQuery.isPending ? (
            <div className="utility-empty">loading diff...</div>
          ) : (
            <div className="utility-empty">select a file</div>
          )}
        </div>
      </div>
      <div className="utility-review-footer" aria-label="review keyboard shortcuts">
        <span>j/k or arrows files</span>
        <span>n/p hunks</span>
        <span>esc close pane</span>
      </div>
    </div>
  );
}

export default UtilityRailReviewPanel;
