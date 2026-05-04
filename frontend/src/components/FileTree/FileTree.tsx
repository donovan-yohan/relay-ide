import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  buildChangedFilesTree,
  flattenVisibleNodes,
  type FileTreeNode,
} from '../../lib/file-tree-utils.js';
import { diffSourceToBase } from '../../lib/diff-utils.js';
import {
  browseFsDirectory,
  fetchChangedFiles,
  fetchDefaultBranch,
  type BrowseEntry,
} from '../../lib/api.js';
import { useUiStore, type RightSidebarTab } from '../../lib/stores/ui.js';
import type { ChangedFile, FileChangeStatus } from '../../lib/types.js';
import { FileTreeRow } from './FileTreeRow.js';
import './file-tree.css';

const ROW_HEIGHT = 20;

export interface FileTreeHandle {
  refresh: () => void;
}

export interface FileTreeProps {
  workspacePath: string;
  changedFilesData?: string[];
}

type Chip = 'all' | 'modified' | 'added' | 'untracked' | 'deleted';
const CHIPS: { id: Chip; label: string; status?: FileChangeStatus }[] = [
  { id: 'all', label: 'all' },
  { id: 'modified', label: 'modified', status: 'modified' },
  { id: 'added', label: 'added', status: 'added' },
  { id: 'untracked', label: 'untracked', status: 'untracked' },
  { id: 'deleted', label: 'deleted', status: 'deleted' },
];

const FILE_TABS: Array<{ id: RightSidebarTab; label: string }> = [
  { id: 'changes', label: 'changes' },
  { id: 'all-files', label: 'all files' },
  { id: 'checks', label: 'checks' },
];

interface ChangedFilesResponse {
  files: ChangedFile[];
  aggregate: { additions: number; deletions: number; fileCount: number };
  error?: string;
}

function changedFilesQueryKey(workspacePath: string, base: string) {
  return ['changedFiles', workspacePath, base] as const;
}

function defaultBranchQueryKey(workspacePath: string) {
  return ['defaultBranch', workspacePath] as const;
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(
  function FileTree({ workspacePath }, ref) {
    const rightSidebarTab = useUiStore((s) => s.rightSidebarTab);
    const setRightSidebarTab = useUiStore((s) => s.setRightSidebarTab);
    const fileDiffSource = useUiStore((s) => s.fileDiffSource);
    const fileDiffDefaultBranch = useUiStore((s) => s.fileDiffDefaultBranch);
    const setFileDiffDefaultBranch = useUiStore(
      (s) => s.setFileDiffDefaultBranch
    );
    const openFileTab = useUiStore((s) => s.openFileTab);
    const queryClient = useQueryClient();

    const base = useMemo(
      () => diffSourceToBase(fileDiffSource, fileDiffDefaultBranch) ?? '',
      [fileDiffSource, fileDiffDefaultBranch]
    );

    const defaultBranchQuery = useQuery<string>({
      queryKey: defaultBranchQueryKey(workspacePath),
      queryFn: () => fetchDefaultBranch(workspacePath),
      enabled: Boolean(workspacePath),
      staleTime: 5 * 60 * 1000,
      retry: false,
    });

    useEffect(() => {
      if (defaultBranchQuery.data) {
        setFileDiffDefaultBranch(defaultBranchQuery.data);
      }
    }, [defaultBranchQuery.data, setFileDiffDefaultBranch]);

    const query = useQuery<ChangedFilesResponse>({
      queryKey: changedFilesQueryKey(workspacePath, base),
      queryFn: async () => {
        const data = await fetchChangedFiles(workspacePath, base);
        if (data.error) throw new Error(data.error);
        return data;
      },
      enabled: Boolean(workspacePath),
      staleTime: 2 * 1000,
      retry: false,
    });

    // ── All files tab state ──
    const [allFilesTree, setAllFilesTree] = useState<BrowseEntry[]>([]);
    const [allFilesExpanded, setAllFilesExpanded] = useState<Set<string>>(
      new Set()
    );
    const [allFilesChildren, setAllFilesChildren] = useState<
      Map<string, BrowseEntry[]>
    >(new Map());
    const [allFilesLoading, setAllFilesLoading] = useState(false);
    const [allFilesError, setAllFilesError] = useState<string | null>(null);

    useEffect(() => {
      setAllFilesTree([]);
      setAllFilesExpanded(new Set());
      setAllFilesChildren(new Map());
      setAllFilesError(null);
    }, [workspacePath]);

    const loadAllFiles = useCallback(async () => {
      if (!workspacePath) return;
      setAllFilesLoading(true);
      setAllFilesError(null);
      try {
        const data = await browseFsDirectory(workspacePath, {
          includeFiles: true,
          showHidden: true,
        });
        setAllFilesTree(data.entries);
      } catch (err) {
        setAllFilesError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setAllFilesLoading(false);
      }
    }, [workspacePath]);

    useEffect(() => {
      if (
        rightSidebarTab === 'all-files' &&
        allFilesTree.length === 0 &&
        !allFilesLoading
      ) {
        void loadAllFiles();
      }
    }, [allFilesLoading, allFilesTree.length, loadAllFiles, rightSidebarTab]);

    const refresh = useCallback(() => {
      queryClient.invalidateQueries({
        queryKey: changedFilesQueryKey(workspacePath, base),
      });
      queryClient.invalidateQueries({
        queryKey: defaultBranchQueryKey(workspacePath),
      });
      if (rightSidebarTab === 'all-files') void loadAllFiles();
    }, [base, loadAllFiles, queryClient, rightSidebarTab, workspacePath]);

    useImperativeHandle(ref, () => ({ refresh }), [refresh]);

    const files = useMemo(() => query.data?.files ?? [], [query.data?.files]);
    const aggregate = query.data?.aggregate ?? {
      additions: 0,
      deletions: 0,
      fileCount: 0,
    };

    // ── Filter + tree-state ──
    const [filterText, setFilterText] = useState('');
    const [activeChip, setActiveChip] = useState<Chip>('all');
    const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
    const [focusedIndex, setFocusedIndex] = useState(-1);

    const filteredFiles = useMemo(() => {
      const q = filterText.trim().toLowerCase();
      const chip = CHIPS.find((c) => c.id === activeChip);
      return files.filter((f) => {
        if (chip?.status && f.status !== chip.status) return false;
        if (q && !f.path.toLowerCase().includes(q)) return false;
        return true;
      });
    }, [files, filterText, activeChip]);

    const baseTree = useMemo(
      () => buildChangedFilesTree(filteredFiles),
      [filteredFiles]
    );

    // Apply collapsed-dir overrides.
    const tree = useMemo(() => {
      function apply(nodes: FileTreeNode[]): FileTreeNode[] {
        return nodes.map((n) => {
          if (!n.isDirectory) return n;
          const expanded = !collapsedDirs.has(n.path);
          return { ...n, expanded, children: apply(n.children) };
        });
      }
      return apply(baseTree);
    }, [baseTree, collapsedDirs]);

    const visibleNodes = useMemo(() => flattenVisibleNodes(tree), [tree]);

    const chipCounts = useMemo(() => {
      const counts: Record<Chip, number> = {
        all: files.length,
        modified: 0,
        added: 0,
        untracked: 0,
        deleted: 0,
      };
      for (const f of files) {
        if (f.status === 'modified') counts.modified++;
        else if (f.status === 'added') counts.added++;
        else if (f.status === 'untracked') counts.untracked++;
        else if (f.status === 'deleted') counts.deleted++;
      }
      return counts;
    }, [files]);

    // ── Virtualizer ──
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const virtualizer = useVirtualizer({
      count: visibleNodes.length,
      getScrollElement: () => scrollerRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 12,
    });

    const activeFileTabKey = useUiStore((s) => s.activeFileTabKey);
    const selectedPath = useMemo(() => {
      if (!activeFileTabKey) return null;
      const idx = activeFileTabKey.indexOf('::');
      return idx >= 0 ? activeFileTabKey.slice(idx + 2) : activeFileTabKey;
    }, [activeFileTabKey]);

    // ── Click ──
    const handleNodeClick = useCallback(
      (node: FileTreeNode) => {
        if (node.isDirectory) {
          setCollapsedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(node.path)) next.delete(node.path);
            else next.add(node.path);
            return next;
          });
          return;
        }
        const isChanged = files.some((f) => f.path === node.path);
        openFileTab(node.path, isChanged);
      },
      [files, openFileTab]
    );

    const toggleAllFilesDir = useCallback(
      async (entryPath: string) => {
        if (allFilesExpanded.has(entryPath)) {
          setAllFilesExpanded((prev) => {
            const next = new Set(prev);
            next.delete(entryPath);
            return next;
          });
          return;
        }

        setAllFilesExpanded((prev) => new Set([...prev, entryPath]));
        if (allFilesChildren.has(entryPath)) return;

        try {
          const data = await browseFsDirectory(entryPath, {
            includeFiles: true,
            showHidden: true,
          });
          setAllFilesChildren(
            (prev) => new Map([...prev, [entryPath, data.entries]])
          );
        } catch {
          // best-effort expansion; root-level errors are shown by loadAllFiles.
        }
      },
      [allFilesChildren, allFilesExpanded]
    );

    const handleAllFilesClick = useCallback(
      (entry: BrowseEntry) => {
        if (entry.isDirectory !== false) {
          void toggleAllFilesDir(entry.path);
          return;
        }
        const prefix = `${workspacePath}/`;
        const relativePath = entry.path.startsWith(prefix)
          ? entry.path.slice(prefix.length)
          : entry.path;
        const isChanged = files.some((f) => f.path === relativePath);
        openFileTab(relativePath, isChanged);
      },
      [files, openFileTab, toggleAllFilesDir, workspacePath]
    );

    // ── Keyboard nav ──
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (visibleNodes.length === 0) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFocusedIndex((i) => Math.min(i + 1, visibleNodes.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFocusedIndex((i) => Math.max(i - 1, 0));
        } else if (
          e.key === 'Enter' &&
          focusedIndex >= 0 &&
          focusedIndex < visibleNodes.length
        ) {
          e.preventDefault();
          handleNodeClick(visibleNodes[focusedIndex]!.node);
        }
      },
      [visibleNodes, focusedIndex, handleNodeClick]
    );

    const isLoading = query.isPending && files.length === 0;
    const errorMsg = query.error instanceof Error ? query.error.message : null;

    function renderAllFilesNode(
      entries: BrowseEntry[],
      depth: number
    ): React.ReactNode {
      return entries.map((entry) => {
        const expanded = allFilesExpanded.has(entry.path);
        const isDirectory = entry.isDirectory !== false;
        const prefix = `${workspacePath}/`;
        const relativePath = entry.path.startsWith(prefix)
          ? entry.path.slice(prefix.length)
          : entry.path;
        return (
          <React.Fragment key={entry.path}>
            <button
              type="button"
              className="fb-node fb-node--browse"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={isDirectory ? expanded : undefined}
              aria-selected={!isDirectory && selectedPath === relativePath}
              data-d={Math.min(depth, 5)}
              onClick={() => handleAllFilesClick(entry)}
              title={entry.path}
            >
              <span
                className={['chev', !isDirectory && 'empty']
                  .filter(Boolean)
                  .join(' ')}
              >
                {isDirectory ? (expanded ? '▾' : '▸') : ''}
              </span>
              <span className="icon" aria-hidden="true">
                {isDirectory ? 'd' : '-'}
              </span>
              <span className="git" aria-hidden="true" />
              <span className="fb-node__name">{entry.name}</span>
              {isDirectory && entry.hasChildren ? (
                <span className="fb-node__count">•</span>
              ) : null}
            </button>
            {isDirectory && expanded && allFilesChildren.has(entry.path)
              ? renderAllFilesNode(
                  allFilesChildren.get(entry.path) ?? [],
                  depth + 1
                )
              : null}
          </React.Fragment>
        );
      });
    }

    return (
      <div className="fb">
        <div className="fb__hd">
          <span className="title">explorer</span>
          <span className="meta">
            {aggregate.fileCount} files
            {aggregate.additions > 0 ? ` · +${aggregate.additions}` : ''}
            {aggregate.deletions > 0 ? ` · −${aggregate.deletions}` : ''}
          </span>
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

        <div
          className="fb__tabs"
          role="tablist"
          aria-label="file explorer views"
        >
          {FILE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`fb__tab${rightSidebarTab === tab.id ? ' active' : ''}`}
              role="tab"
              aria-selected={rightSidebarTab === tab.id}
              onClick={() => setRightSidebarTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'changes' && aggregate.fileCount > 0 ? (
                <span className="ct">{aggregate.fileCount}</span>
              ) : null}
            </button>
          ))}
        </div>

        {rightSidebarTab === 'changes' ? (
          <>
            <div className="fb__search">
              <span className="gt" aria-hidden="true">
                &gt;
              </span>
              <input
                type="text"
                placeholder="filter files…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                aria-label="filter files"
              />
            </div>

            <div className="fb__chips">
              {CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className={`chip${activeChip === chip.id ? ' active' : ''}`}
                  onClick={() => setActiveChip(chip.id)}
                >
                  {chip.label} <span className="ct">{chipCounts[chip.id]}</span>
                </button>
              ))}
            </div>

            <div
              className="fb__list"
              ref={scrollerRef}
              role="tree"
              tabIndex={0}
              onKeyDown={handleKeyDown}
            >
              {isLoading ? (
                <div className="fb__loading">loading changes…</div>
              ) : errorMsg ? (
                <div className="fb__error">
                  {errorMsg}
                  <button type="button" className="retry" onClick={refresh}>
                    retry
                  </button>
                </div>
              ) : visibleNodes.length === 0 ? (
                <div className="fb__empty">no changes</div>
              ) : (
                <div
                  className="fb__virt"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  {virtualizer.getVirtualItems().map((vi) => {
                    const flat = visibleNodes[vi.index];
                    if (!flat) return null;
                    const { node, depth } = flat;
                    const isFocused = focusedIndex === vi.index;
                    const isSelected =
                      !node.isDirectory && selectedPath === node.path;
                    return (
                      <FileTreeRow
                        key={node.path}
                        node={node}
                        depth={depth}
                        selected={isSelected}
                        focused={isFocused}
                        onClick={handleNodeClick}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${vi.start}px)`,
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}

        {rightSidebarTab === 'all-files' ? (
          <div className="fb__list" role="tree">
            {allFilesLoading && allFilesTree.length === 0 ? (
              <div className="fb__loading">loading files…</div>
            ) : allFilesError ? (
              <div className="fb__error">
                {allFilesError}
                <button
                  type="button"
                  className="retry"
                  onClick={() => void loadAllFiles()}
                >
                  retry
                </button>
              </div>
            ) : allFilesTree.length === 0 ? (
              <div className="fb__empty">empty repository</div>
            ) : (
              renderAllFilesNode(allFilesTree, 0)
            )}
          </div>
        ) : null}

        {rightSidebarTab === 'checks' ? (
          <div className="fb__empty">checks — coming soon</div>
        ) : null}
      </div>
    );
  }
);

export default FileTree;
