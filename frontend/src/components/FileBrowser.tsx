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
import { browseFsDirectory, type BrowseEntry } from '../lib/api.js';
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
}

function TreeRow({
  node,
  focused,
  onToggleExpand,
  onToggleSelect,
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
        if (target.closest('.expand-btn') || target.closest('.tui-checkbox'))
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
    </div>
  );
}

interface TreeViewProps {
  visibleNodes: BrowseNode[];
  focusIndex: number;
  rootTruncated: { shown: number; total: number } | null;
  onToggleExpand: (node: BrowseNode) => void;
  onToggleSelect: (node: BrowseNode) => void;
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
  onKeyDown,
  filterText,
  initialLoading,
}: TreeViewProps) {
  /**
   * Prevent browser auto-scroll-on-focus from scrolling ancestor containers.
   * When a focusable element (checkbox input) inside the tree receives focus,
   * the browser walks up ALL scrollable ancestors and scrolls each one to
   * reveal the focused element. The tree-container handles its own scrolling,
   * but the dialog body (an ancestor with overflow-y: auto) also gets scrolled,
   * pushing the entire file browser out of view.
   *
   * Fix: capture the dialog body's scroll position before focus, then restore
   * it on the next frame — but ONLY when the focused element is already within
   * the visible viewport of the dialog body. When the element is out of view,
   * we allow the browser's normal scroll-into-view behavior so the user can
   * reach offscreen content via keyboard navigation.
   *
   * Testing note: asserting that scrollTop stays stable when focusing a
   * checkbox inside the file tree requires a real browser DOM (the behavior
   * depends on native scroll-into-view and requestAnimationFrame timing).
   * The project's component tests are logic-only (no jsdom/RTL). Playwright
   * e2e tests exist under test/e2e/ but do not cover this interaction.
   * A dedicated e2e spec for this behaviour is a known gap; tracked in the
   * bug analysis at docs/bug-analyses/2026-04-03-add-repo-modal-focus-shift-bug-analysis.md.
   */
  const handleFocusIn = useCallback((e: React.FocusEvent) => {
    const treeContainer = e.currentTarget as HTMLElement;
    const dialogBody = treeContainer.closest('.dialog-shell__body');
    if (!dialogBody) return;

    // Only guard the scroll when the focused element is already visible inside
    // the dialog body's viewport. If it's offscreen, let the browser scroll it
    // into view normally so keyboard users can reach out-of-view items.
    const focusedEl = e.target as HTMLElement;
    const bodyRect = dialogBody.getBoundingClientRect();
    const elRect = focusedEl.getBoundingClientRect();
    const isInView =
      elRect.top >= bodyRect.top && elRect.bottom <= bodyRect.bottom;

    if (!isInView) return;

    const savedScrollTop = dialogBody.scrollTop;
    requestAnimationFrame(() => {
      if (dialogBody.scrollTop !== savedScrollTop) {
        dialogBody.scrollTop = savedScrollTop;
      }
    });
  }, []);

  return (
    <div
      className="tree-container"
      role="tree"
      aria-label="File browser"
      onKeyDown={onKeyDown}
      onFocus={handleFocusIn}
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
  const treeRef = useRef<BrowseNode[]>([]);

  function syncTree(newTree: BrowseNode[]) {
    treeRef.current = newTree;
    setTree([...newTree]);
    onSelectedPathsChange(collectSelected(newTree));
  }

  const loadRoot = useCallback(async () => {
    setInitialLoading(true);
    setRootTruncated(null);
    try {
      const data = await browseFsDirectory();
      const newTree = data.entries.map((e) => entryToNode(e, 0));
      treeRef.current = newTree;
      setTree(newTree);
      if (data.truncated)
        setRootTruncated({ shown: data.entries.length, total: data.total });
    } catch {
      treeRef.current = [];
      setTree([]);
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  useImperativeHandle(ref, () => ({
    reset() {
      setFilterText('');
      setFocusIndex(-1);
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
      </div>
      <TreeView
        visibleNodes={visibleNodes}
        focusIndex={focusIndex}
        rootTruncated={rootTruncated}
        onToggleExpand={(n) => void toggleExpand(n)}
        onToggleSelect={toggleSelect}
        onKeyDown={handleTreeKeydown}
        filterText={filterText}
        initialLoading={initialLoading}
      />
    </div>
  );
});

export default FileBrowser;
