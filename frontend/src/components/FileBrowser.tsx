import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import TuiCheckbox from './TuiCheckbox.js';
import TuiButton from './TuiButton.js';
import {
  browseFsDirectory,
  createWorkspaceFolder,
  type BrowseEntry,
} from '../lib/api.js';
import './FileBrowser.css';

export interface FileBrowserHandle {
  reset(): void;
}

interface BrowseNode {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasChildren: boolean;
  children: BrowseNode[] | null;
  expanded: boolean;
  selected: boolean;
  loading: boolean;
  depth: number;
  truncatedInfo: { shown: number; total: number } | null;
}

interface Props {
  selectedPaths: string[];
  onSelectedPathsChange: (paths: string[]) => void;
}

function entryToNode(entry: BrowseEntry, depth: number): BrowseNode {
  return {
    name: entry.name,
    path: entry.path,
    isGitRepo: entry.isGitRepo,
    hasChildren: entry.hasChildren,
    children: null,
    expanded: false,
    selected: false,
    loading: false,
    depth,
    truncatedInfo: null,
  };
}

function collectSelected(nodes: BrowseNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.selected) result.push(node.path);
    if (node.children) result.push(...collectSelected(node.children));
  }
  return result;
}

function findNode(nodes: BrowseNode[], targetPath: string): BrowseNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children) {
      const found = findNode(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function mergeCreatedEntry(
  entries: BrowseEntry[],
  createdEntry?: BrowseEntry
): BrowseEntry[] {
  if (!createdEntry || entries.some((entry) => entry.path === createdEntry.path)) {
    return entries;
  }
  return [...entries, createdEntry].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}

function mergeBrowseNodes(
  entries: BrowseEntry[],
  previousNodes: BrowseNode[],
  depth: number,
  selectedPath?: string
): BrowseNode[] {
  const previousByPath = new Map(
    previousNodes.map((node) => [node.path, node])
  );
  return entries.map((entry) => {
    const existing = previousByPath.get(entry.path);
    if (existing) {
      existing.name = entry.name;
      existing.isGitRepo = entry.isGitRepo;
      existing.hasChildren =
        entry.hasChildren || Boolean(existing.children?.length);
      existing.depth = depth;
      if (entry.path === selectedPath) existing.selected = true;
      return existing;
    }
    const node = entryToNode(entry, depth);
    node.selected = entry.path === selectedPath;
    return node;
  });
}

function flattenVisible(nodes: BrowseNode[], filter: string): BrowseNode[] {
  const result: BrowseNode[] = [];
  for (const node of nodes) {
    if (
      filter &&
      !node.expanded &&
      !node.name.toLowerCase().includes(filter.toLowerCase())
    )
      continue;
    result.push(node);
    if (node.expanded && node.children)
      result.push(...flattenVisible(node.children, filter));
  }
  return result;
}

interface TreeRowProps {
  node: BrowseNode;
  focused: boolean;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
  onCreateFolder: () => void;
}

function TreeRow({
  node,
  focused,
  onToggleExpand,
  onToggleSelect,
  onCreateFolder,
}: TreeRowProps) {
  const cls = [
    'tree-row',
    focused ? 'focused' : '',
    node.selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      style={{ paddingLeft: `${12 + node.depth * 20}px` }}
      role="treeitem"
      aria-expanded={node.hasChildren ? node.expanded : undefined}
      aria-selected={node.selected}
      aria-level={node.depth + 1}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest('.expand-btn') ||
          target.closest('.tui-checkbox') ||
          target.closest('.new-folder-btn')
        )
          return;
        if (node.hasChildren && !node.expanded) onToggleExpand();
        else onToggleSelect();
      }}
    >
      {node.hasChildren ? (
        <button
          className="expand-btn"
          data-track="file-browser.expand"
          aria-label={node.expanded ? 'Collapse' : 'Expand'}
          onClick={onToggleExpand}
        >
          {node.loading ? (
            <span className="spinner">...</span>
          ) : (
            <span
              className={['arrow', node.expanded ? 'expanded' : '']
                .filter(Boolean)
                .join(' ')}
            >
              &#9654;
            </span>
          )}
        </button>
      ) : (
        <span className="expand-spacer" />
      )}
      <TuiCheckbox checked={node.selected} onChange={onToggleSelect} />
      <span className="node-name">{node.name}</span>
      {node.isGitRepo && (
        <span className="git-badge" aria-label="Git repository">
          git
        </span>
      )}
      <TuiButton
        variant="ghost"
        size="sm"
        className="new-folder-btn"
        aria-label={`new folder in ${node.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onCreateFolder();
        }}
      >
        new folder
      </TuiButton>
    </div>
  );
}

interface TreeViewProps {
  visibleNodes: BrowseNode[];
  focusIndex: number;
  rootTruncated: { shown: number; total: number } | null;
  onToggleExpand: (node: BrowseNode) => void;
  onToggleSelect: (node: BrowseNode) => void;
  onCreateFolder: (node: BrowseNode) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  filterText: string;
  initialLoading: boolean;
}

function TreeView({
  visibleNodes,
  focusIndex,
  rootTruncated,
  onToggleExpand,
  onToggleSelect,
  onCreateFolder,
  onKeyDown,
  filterText,
  initialLoading,
}: TreeViewProps) {
  return (
    <div
      className="tree-container"
      role="tree"
      aria-label="File browser"
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      {initialLoading ? (
        <div className="loading-placeholder">Loading...</div>
      ) : visibleNodes.length === 0 ? (
        <div className="empty-placeholder">
          {filterText
            ? `No matches for "${filterText}"`
            : 'No directories found'}
        </div>
      ) : (
        <>
          {visibleNodes.map((node, i) => (
            <TreeRow
              key={node.path}
              node={node}
              focused={i === focusIndex}
              onToggleExpand={() => onToggleExpand(node)}
              onToggleSelect={() => onToggleSelect(node)}
              onCreateFolder={() => onCreateFolder(node)}
            />
          ))}
          {rootTruncated && (
            <div className="truncated-notice">
              Showing {rootTruncated.shown} of {rootTruncated.total}{' '}
              directories. Use the filter to narrow results.
            </div>
          )}
        </>
      )}
    </div>
  );
}

const FileBrowser = forwardRef<FileBrowserHandle, Props>(function FileBrowser(
  { onSelectedPathsChange },
  ref
) {
  const [tree, setTree] = useState<BrowseNode[]>([]);
  const [filterText, setFilterText] = useState('');
  const [focusIndex, setFocusIndex] = useState(-1);
  const [initialLoading, setInitialLoading] = useState(true);
  const [rootTruncated, setRootTruncated] = useState<{
    shown: number;
    total: number;
  } | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [folderParentPath, setFolderParentPath] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const treeRef = useRef<BrowseNode[]>([]);
  const folderNameInputRef = useRef<HTMLInputElement>(null);

  function syncTree(newTree: BrowseNode[]) {
    treeRef.current = newTree;
    setTree([...newTree]);
    onSelectedPathsChange(collectSelected(newTree));
  }

  const loadRoot = useCallback(async (createdEntry?: BrowseEntry) => {
    setInitialLoading(true);
    setRootTruncated(null);
    try {
      const data = await browseFsDirectory();
      const entries = mergeCreatedEntry(data.entries, createdEntry);
      const newTree = mergeBrowseNodes(
        entries,
        treeRef.current,
        0,
        createdEntry?.path
      );
      setRootPath(data.resolved);
      const total = Math.max(data.total, entries.length);
      if (total > entries.length)
        setRootTruncated({ shown: entries.length, total });
      syncTree(newTree);
    } catch {
      treeRef.current = [];
      setTree([]);
      setRootPath('');
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  useEffect(() => {
    if (folderParentPath) folderNameInputRef.current?.focus();
  }, [folderParentPath]);

  useImperativeHandle(ref, () => ({
    reset() {
      setFilterText('');
      setFocusIndex(-1);
      setFolderParentPath(null);
      setFolderName('');
      setFolderError('');
      function deselectAll(nodes: BrowseNode[]) {
        for (const n of nodes) {
          n.selected = false;
          n.expanded = false;
          if (n.children) deselectAll(n.children);
        }
      }
      deselectAll(treeRef.current);
      setTree([...treeRef.current]);
      onSelectedPathsChange([]);
    },
  }));

  async function toggleExpand(node: BrowseNode) {
    if (node.expanded) {
      node.expanded = false;
      setTree([...treeRef.current]);
      return;
    }
    if (node.children === null) {
      node.loading = true;
      setTree([...treeRef.current]);
      try {
        const data = await browseFsDirectory(node.path);
        node.children = data.entries.map((e) => entryToNode(e, node.depth + 1));
        node.truncatedInfo = data.truncated
          ? { shown: data.entries.length, total: data.total }
          : null;
      } catch {
        node.children = [];
      } finally {
        node.loading = false;
      }
    }
    node.expanded = true;
    setTree([...treeRef.current]);
  }

  async function refreshNodeChildren(
    node: BrowseNode,
    createdEntry?: BrowseEntry
  ) {
    const data = await browseFsDirectory(node.path);
    const entries = mergeCreatedEntry(data.entries, createdEntry);
    node.children = mergeBrowseNodes(
      entries,
      node.children ?? [],
      node.depth + 1,
      createdEntry?.path
    );
    node.hasChildren = node.children.length > 0;
    const total = Math.max(data.total, entries.length);
    node.truncatedInfo = total > entries.length
      ? { shown: entries.length, total }
      : null;
    node.expanded = true;
    syncTree(treeRef.current);
  }

  function beginFolderCreate(parentPath: string) {
    setFolderParentPath(parentPath);
    setFolderName('');
    setFolderError('');
  }

  function cancelFolderCreate() {
    if (creatingFolder) return;
    setFolderParentPath(null);
    setFolderName('');
    setFolderError('');
  }

  async function createFolder() {
    if (!folderParentPath || creatingFolder) return;
    setCreatingFolder(true);
    setFolderError('');
    try {
      const entry = await createWorkspaceFolder(folderParentPath, folderName);
      if (folderParentPath === rootPath) {
        await loadRoot(entry);
      } else {
        const parent = findNode(treeRef.current, folderParentPath);
        if (!parent) throw new Error('parent folder is no longer visible');
        await refreshNodeChildren(parent, entry);
      }
      setFolderParentPath(null);
      setFolderName('');
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingFolder(false);
    }
  }

  function toggleSelect(node: BrowseNode) {
    node.selected = !node.selected;
    syncTree(treeRef.current);
  }

  const visibleNodes = useMemo(
    () => flattenVisible(tree, filterText),
    [tree, filterText]
  );

  function handleTreeKeydown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => Math.min(i + 1, visibleNodes.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => Math.max(i - 1, 0));
      return;
    }
    const focused = focusIndex >= 0 ? visibleNodes[focusIndex] : undefined;
    if (!focused) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (focused.hasChildren && !focused.expanded) void toggleExpand(focused);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (focused.expanded) {
        focused.expanded = false;
        setTree([...treeRef.current]);
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      toggleSelect(focused);
    }
  }

  return (
    <div className="file-browser">
      <div className="filter-row">
        <input
          type="text"
          className="filter-input"
          placeholder="Filter..."
          value={filterText}
          onChange={(e) => setFilterText(e.currentTarget.value)}
          aria-label="Filter directories"
          autoComplete="off"
          spellCheck={false}
        />
        <TuiButton
          variant="ghost"
          size="sm"
          className="new-root-folder-btn"
          disabled={!rootPath || initialLoading}
          onClick={() => beginFolderCreate(rootPath)}
        >
          new folder
        </TuiButton>
      </div>
      {folderParentPath && (
        <div className="folder-create-editor">
          <label htmlFor="new-folder-name" className="folder-create-label">
            new folder in {folderParentPath}
          </label>
          <div className="folder-create-controls">
            <input
              ref={folderNameInputRef}
              id="new-folder-name"
              className="folder-create-input"
              aria-label={`new folder name in ${folderParentPath}`}
              value={folderName}
              onChange={(e) => setFolderName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void createFolder();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelFolderCreate();
                }
              }}
              placeholder="folder name"
              autoComplete="off"
              spellCheck={false}
              disabled={creatingFolder}
            />
            <TuiButton
              variant="primary"
              size="sm"
              disabled={creatingFolder || !folderName.trim()}
              onClick={() => void createFolder()}
            >
              {creatingFolder ? 'creating...' : 'create'}
            </TuiButton>
            <TuiButton
              variant="ghost"
              size="sm"
              disabled={creatingFolder}
              onClick={cancelFolderCreate}
            >
              cancel
            </TuiButton>
          </div>
          {folderError && <p className="folder-create-error">{folderError}</p>}
        </div>
      )}
      <TreeView
        visibleNodes={visibleNodes}
        focusIndex={focusIndex}
        rootTruncated={rootTruncated}
        onToggleExpand={(n) => void toggleExpand(n)}
        onToggleSelect={toggleSelect}
        onCreateFolder={(n) => beginFolderCreate(n.path)}
        onKeyDown={handleTreeKeydown}
        filterText={filterText}
        initialLoading={initialLoading}
      />
    </div>
  );
});

export default FileBrowser;
