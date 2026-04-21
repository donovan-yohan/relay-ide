import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import type { FileTreeNode } from '../lib/file-tree-utils.js';
import { buildChangedFilesTree, flattenVisibleNodes, statusToBadge, statusToBadgeColor } from '../lib/file-tree-utils.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import { fetchChangedFiles, fetchDefaultBranch, browseFsDirectory, type BrowseEntry } from '../lib/api.js';
import { useUiStore, type RightSidebarTab } from '../lib/stores/ui.js';
import type { ChangedFile } from '../lib/types.js';
import DiffSourceToggle from './DiffSourceToggle.js';
import './FileTreeSidebar.css';

export type { ChangedFile } from '../lib/types.js';

export interface FileTreeSidebarHandle {
  refresh: () => Promise<void>;
}

export interface FileTreeSidebarProps {
  workspacePath: string;
  changedFilesData?: string[];
  onFileSelect?: (filePath: string, isChanged: boolean) => void;
}

export const FileTreeSidebar = forwardRef<FileTreeSidebarHandle, FileTreeSidebarProps>(
  function FileTreeSidebar({ workspacePath, changedFilesData = [], onFileSelect }, ref) {
    const rightSidebarTab = useUiStore((s) => s.rightSidebarTab);
    const setRightSidebarTab = useUiStore((s) => s.setRightSidebarTab);
    const fileDiffSource = useUiStore((s) => s.fileDiffSource);
    const fileDiffDefaultBranch = useUiStore((s) => s.fileDiffDefaultBranch);
    const openFileTab = useUiStore((s) => s.openFileTab);
    // ── Changes tab state ──
    const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
    const [aggregate, setAggregate] = useState({ additions: 0, deletions: 0, fileCount: 0 });
    const [changesLoading, setChangesLoading] = useState(false);
    const [changesError, setChangesError] = useState<string | null>(null);
    const [treeNodes, setTreeNodes] = useState<FileTreeNode[]>([]);

    // ── All files tab state ──
    const [allFilesTree, setAllFilesTree] = useState<BrowseEntry[]>([]);
    const [allFilesExpanded, setAllFilesExpanded] = useState<Set<string>>(new Set());
    const [allFilesChildren, setAllFilesChildren] = useState<Map<string, BrowseEntry[]>>(new Map());
    const [allFilesLoading, setAllFilesLoading] = useState(false);
    const [allFilesError, setAllFilesError] = useState<string | null>(null);

    // ── Cipher-decode animation state ──
    const [animatingPaths, setAnimatingPaths] = useState<Set<string>>(new Set());

    // ── Keyboard nav ──
    const [focusedIndex, setFocusedIndex] = useState(-1);

    const base = useMemo(() => diffSourceToBase(fileDiffSource, fileDiffDefaultBranch), [fileDiffSource, fileDiffDefaultBranch]);
    const visibleNodes = useMemo(() => flattenVisibleNodes(treeNodes), [treeNodes]);

    const changedFilesRef = useRef(changedFiles);
    changedFilesRef.current = changedFiles;

    // ── Fetch changed files ──
    const refresh = useCallback(async () => {
      if (!workspacePath) return;
      setChangesLoading(true);
      setChangesError(null);
      try {
        const data = await fetchChangedFiles(workspacePath, base);
        if (data.error) {
          setChangesError(data.error);
        } else {
          setChangedFiles(data.files);
          setAggregate(data.aggregate);
          setTreeNodes(buildChangedFilesTree(data.files));
        }
      } catch (err) {
        setChangesError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setChangesLoading(false);
      }
    }, [workspacePath, base]);

    useImperativeHandle(ref, () => ({ refresh }), [refresh]);

    // Fetch default branch then refresh
    const lastWorkspacePathRef = useRef('');
    useEffect(() => {
      if (!workspacePath) return;
      const needsBranchFetch = workspacePath !== lastWorkspacePathRef.current;
      lastWorkspacePathRef.current = workspacePath;

      if (needsBranchFetch) {
        fetchDefaultBranch(workspacePath).then((b) => {
          useUiStore.getState().setFileDiffDefaultBranch(b);
          refresh();
        });
      } else {
        refresh();
      }
    }, [workspacePath, base, refresh]);

    // Handle real-time file change events — mark new files for animation
    useEffect(() => {
      if (changedFilesData.length > 0) {
        const prevSet = new Set(useUiStore.getState().lastChangedFiles);
        const justChanged = changedFilesData.filter((f) => !prevSet.has(f));
        if (justChanged.length > 0) {
          setAnimatingPaths((prev) => new Set([...prev, ...justChanged]));
          setTimeout(() => {
            setAnimatingPaths((prev) => new Set([...prev].filter((p) => !justChanged.includes(p))));
          }, 500);
        }
        useUiStore.getState().setLastChangedFiles([...changedFilesData]);
      }
    }, [changedFilesData]);

    // ── All files tab ──
    const loadAllFiles = useCallback(async () => {
      if (!workspacePath) return;
      setAllFilesLoading(true);
      setAllFilesError(null);
      try {
        const data = await browseFsDirectory(workspacePath, { includeFiles: true, showHidden: false });
        setAllFilesTree(data.entries);
      } catch (err) {
        setAllFilesError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setAllFilesLoading(false);
      }
    }, [workspacePath]);

    const toggleAllFilesDir = useCallback(async (entryPath: string) => {
      if (allFilesExpanded.has(entryPath)) {
        setAllFilesExpanded((prev) => {
          const next = new Set(prev);
          next.delete(entryPath);
          return next;
        });
      } else {
        setAllFilesExpanded((prev) => new Set([...prev, entryPath]));
        if (!allFilesChildren.has(entryPath)) {
          try {
            const data = await browseFsDirectory(entryPath, { includeFiles: true, showHidden: false });
            setAllFilesChildren((prev) => new Map([...prev, [entryPath, data.entries]]));
          } catch {
            // best effort
          }
        }
      }
    }, [allFilesExpanded, allFilesChildren]);

    // Load all files on tab switch
    useEffect(() => {
      if (rightSidebarTab === 'all-files' && allFilesTree.length === 0 && !allFilesLoading) {
        loadAllFiles();
      }
    }, [rightSidebarTab, allFilesTree.length, allFilesLoading, loadAllFiles]);

    // ── Tree interactions ──
    const handleFileClick = useCallback((node: FileTreeNode) => {
      if (node.isDirectory) {
        setTreeNodes((prev) => {
          function toggleExpanded(nodes: FileTreeNode[]): FileTreeNode[] {
            return nodes.map((n) => {
              if (n.path === node.path) return { ...n, expanded: !n.expanded, children: toggleExpanded(n.children) };
              return { ...n, children: toggleExpanded(n.children) };
            });
          }
          return toggleExpanded(prev);
        });
      } else {
        const isChanged = changedFilesRef.current.some((f) => f.path === node.path);
        openFileTab(node.path, isChanged);
        onFileSelect?.(node.path, isChanged);
      }
    }, [openFileTab, onFileSelect]);

    const handleAllFilesClick = useCallback((entry: BrowseEntry) => {
      if (entry.isDirectory !== false) {
        toggleAllFilesDir(entry.path);
      } else {
        const prefix = workspacePath + '/';
        const relativePath = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
        const isChanged = changedFilesRef.current.some((f) => f.path === relativePath);
        openFileTab(relativePath, isChanged);
        onFileSelect?.(relativePath, isChanged);
      }
    }, [workspacePath, toggleAllFilesDir, openFileTab, onFileSelect]);

    const handleKeydown = useCallback((e: React.KeyboardEvent) => {
      const nodes = visibleNodes;
      if (nodes.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, nodes.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < nodes.length) {
        e.preventDefault();
        handleFileClick(nodes[focusedIndex]!.node);
      }
    }, [visibleNodes, focusedIndex, handleFileClick]);

    function isRecentlyChanged(filePath: string): boolean {
      return changedFilesData.length > 0 && changedFilesData.includes(filePath);
    }

    // ── All files recursive renderer ──
    function renderAllFilesNode(entries: BrowseEntry[], depth: number): React.ReactNode {
      return entries.map((entry) => (
        <React.Fragment key={entry.path}>
          <button
            className={`tree-item ${entry.isDirectory !== false ? 'directory' : 'file'}`}
            role="treeitem"
            aria-expanded={entry.isDirectory !== false ? allFilesExpanded.has(entry.path) : undefined}
            aria-selected={false}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            onClick={() => handleAllFilesClick(entry)}
          >
            <span className="icon-slot">
              {entry.isDirectory !== false ? (
                <span className="expand-arrow">{allFilesExpanded.has(entry.path) ? 'v' : '>'}</span>
              ) : (
                <span className="file-icon">-</span>
              )}
            </span>
            <span className="node-name">{entry.name}</span>
            {entry.isDirectory !== false && entry.hasChildren && (
              <span className="action-slot">
                <span className="has-children-dot" />
              </span>
            )}
          </button>
          {allFilesExpanded.has(entry.path) && allFilesChildren.has(entry.path) && (
            renderAllFilesNode(allFilesChildren.get(entry.path) ?? [], depth + 1)
          )}
        </React.Fragment>
      ));
    }

    return (
      <div className="fts-sidebar" role="complementary" aria-label="file tree">
        {/* Tab bar */}
        <div className="fts-tab-bar" role="tablist">
          {([
            { id: 'changes' as RightSidebarTab, label: 'changes' },
            { id: 'all-files' as RightSidebarTab, label: 'all files' },
            { id: 'checks' as RightSidebarTab, label: 'checks' },
          ]).map((tab) => (
            <button
              key={tab.id}
              className={`fts-tab${rightSidebarTab === tab.id ? ' active' : ''}`}
              role="tab"
              aria-selected={rightSidebarTab === tab.id}
              onClick={() => setRightSidebarTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'changes' && aggregate.fileCount > 0 && (
                <span className="fts-tab-count">{aggregate.fileCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="fts-tab-content">
          {rightSidebarTab === 'changes' && (
            <>
              <div className="fts-controls-row">
                <DiffSourceToggle
                  value={fileDiffSource}
                  onchange={(s) => useUiStore.getState().setFileDiffSource(s)}
                  defaultBranch={fileDiffDefaultBranch}
                />
              </div>

              {changesLoading && changedFiles.length === 0 ? (
                <div className="fts-loading-state">
                  <span className="fts-spinner">&#x280B;</span> loading changes...
                </div>
              ) : changesError ? (
                <div className="fts-error-state">
                  <span className="fts-error-text">{changesError}</span>
                  <button className="fts-retry-btn" onClick={() => refresh()}>retry</button>
                </div>
              ) : visibleNodes.length === 0 ? (
                <div className="fts-empty-state">
                  no changes yet — when an agent writes code, changed files appear here. click any line to send it as context.
                </div>
              ) : (
                <div className="fts-tree" role="tree" tabIndex={0} onKeyDown={handleKeydown}>
                  {visibleNodes.map(({ node, depth }, i) => (
                    <button
                      key={node.path}
                      className={[
                        'tree-item',
                        focusedIndex === i && 'focused',
                        animatingPaths.has(node.path) && 'animating',
                        node.isDirectory ? 'directory' : 'file',
                      ].filter(Boolean).join(' ')}
                      role="treeitem"
                      aria-selected={focusedIndex === i}
                      aria-expanded={node.isDirectory ? node.expanded : undefined}
                      aria-label={`${node.name}${node.status ? `, ${node.status}` : ''}${node.additions ? `, ${node.additions} additions` : ''}${node.deletions ? `, ${node.deletions} deletions` : ''}${isRecentlyChanged(node.path) ? ', recently changed' : ''}`}
                      style={{ paddingLeft: `${8 + depth * 16}px` }}
                      onClick={() => handleFileClick(node)}
                    >
                      <span className="icon-slot">
                        {isRecentlyChanged(node.path) && !node.isDirectory ? (
                          <span className="blue-dot" aria-label="recently changed" />
                        ) : node.isDirectory ? (
                          <span className="expand-arrow">{node.expanded ? 'v' : '>'}</span>
                        ) : (
                          <span className="file-icon">-</span>
                        )}
                      </span>
                      <span className="node-name">{node.name}</span>
                      <span className="action-slot">
                        {node.isDirectory ? (
                          <span className="file-count">{node.fileCount}</span>
                        ) : node.status ? (
                          <span className="badge" style={{ color: statusToBadgeColor(node.status) }}>{statusToBadge(node.status)}</span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {aggregate.fileCount > 0 && (
                <div className="fts-stats-bar">
                  {aggregate.fileCount} changed{' '}
                  <span className="fts-stat-add">+{aggregate.additions}</span>{' '}
                  <span className="fts-stat-del">-{aggregate.deletions}</span>
                </div>
              )}
            </>
          )}

          {rightSidebarTab === 'all-files' && (
            <>
              {allFilesLoading && allFilesTree.length === 0 ? (
                <div className="fts-loading-state">
                  <span className="fts-spinner">&#x280B;</span> loading files...
                </div>
              ) : allFilesError ? (
                <div className="fts-error-state">
                  <span className="fts-error-text">{allFilesError}</span>
                  <button className="fts-retry-btn" onClick={() => loadAllFiles()}>retry</button>
                </div>
              ) : allFilesTree.length === 0 ? (
                <div className="fts-empty-state">empty repository</div>
              ) : (
                <div className="fts-tree" role="tree">
                  {renderAllFilesNode(allFilesTree, 0)}
                </div>
              )}
            </>
          )}

          {rightSidebarTab === 'checks' && (
            <div className="fts-empty-state">checks — coming soon</div>
          )}
        </div>
      </div>
    );
  }
);

export default FileTreeSidebar;
