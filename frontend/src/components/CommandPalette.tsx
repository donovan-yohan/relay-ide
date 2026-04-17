import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  Repo,
  SessionSummary,
  PullRequest,
  OrgPrsResponse,
  GitHubIssue,
  GitHubIssuesResponse,
  JiraIssue,
  JiraIssuesResponse,
} from '../lib/types.js';
import { derivePrDotStatus } from '../lib/pr-status.js';
import StatusDot from './StatusDot.js';
import { getAllActions } from '../lib/actions/registry.js';
import { formatShortcut } from '../lib/actions/shortcuts.js';
import type { ActionContext, Action } from '../lib/actions/types.js';
import { isMobileDevice, isMac } from '../lib/utils.js';
import './CommandPalette.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = ['all', 'sessions', 'workspaces', 'prs', 'settings'] as const;
type Tab = (typeof TABS)[number];

const SEC_GENERAL = 'section-general';
const SEC_INTEGRATIONS = 'section-integrations';
const SEC_ADVANCED = 'section-advanced';
const SEC_ABOUT = 'section-about';

const SETTINGS_ENTRIES = [
  {
    id: 'setting-agent',
    label: 'Default Coding Agent',
    description: 'Which AI agent to use',
    section: SEC_GENERAL,
  },
  {
    id: 'setting-continue',
    label: 'Continue Session',
    description: 'Resume last session when opening a repo',
    section: SEC_GENERAL,
  },
  {
    id: 'setting-yolo',
    label: 'YOLO Mode',
    description: 'Skip permission checks',
    section: SEC_GENERAL,
  },
  {
    id: 'setting-tmux',
    label: 'Launch in tmux',
    description: 'Wrap sessions in tmux',
    section: SEC_GENERAL,
  },
  {
    id: 'setting-notifications',
    label: 'Notifications',
    description: 'Push notifications for sessions',
    section: SEC_GENERAL,
  },
  {
    id: 'setting-github',
    label: 'GitHub Connection',
    description: 'Connect GitHub account for PRs and CI',
    section: SEC_INTEGRATIONS,
  },
  {
    id: 'setting-webhooks',
    label: 'Webhooks',
    description: 'Real-time CI and PR updates',
    section: SEC_INTEGRATIONS,
  },
  {
    id: 'setting-jira',
    label: 'Jira',
    description: 'See Jira tickets in the sidebar',
    section: SEC_INTEGRATIONS,
  },
  {
    id: 'setting-devtools',
    label: 'Developer Tools',
    description: 'Mobile debug panel',
    section: SEC_ADVANCED,
  },
  {
    id: 'setting-analytics',
    label: 'Analytics',
    description: 'Local usage data',
    section: SEC_ADVANCED,
  },
  {
    id: 'setting-version',
    label: 'Version',
    description: 'Check for updates',
    section: SEC_ABOUT,
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type SettingEntry = (typeof SETTINGS_ENTRIES)[number];

type PaletteResult =
  | {
      type: 'workspace';
      id: string;
      label: string;
      sublabel?: string;
      data: Repo;
    }
  | {
      type: 'session';
      id: string;
      label: string;
      sublabel?: string;
      data: SessionSummary;
    }
  | {
      type: 'pr' | 'attention';
      id: string;
      label: string;
      sublabel?: string;
      data: PullRequest;
    }
  | {
      type: 'ticket';
      id: string;
      label: string;
      sublabel?: string;
      data: GitHubIssue | JiraIssue;
    }
  | {
      type: 'command';
      id: string;
      label: string;
      sublabel?: string;
      data: Action;
    }
  | {
      type: 'setting';
      id: string;
      label: string;
      sublabel?: string;
      data: SettingEntry;
    };

interface ResultGroup {
  label: string;
  items: PaletteResult[];
}

export interface CommandPaletteProps {
  open: boolean;
  workspaces: Repo[];
  sessions: SessionSummary[];
  actionContext: ActionContext;
  onClose: () => void;
  onSelectWorkspace: (path: string) => void;
  onSelectSession: (id: string) => void;
  onSelectPr: (pr: PullRequest) => void;
  onOpenSettings?: (sectionId: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function categoryIcon(type: PaletteResult['type']): string {
  switch (type) {
    case 'workspace':
      return '■';
    case 'session':
      return '▸';
    case 'pr':
    case 'attention':
      return '●';
    case 'ticket':
      return '#';
    case 'command':
      return '>';
    case 'setting':
      return '*';
    default:
      return '';
  }
}

function matchesTab(type: PaletteResult['type'], activeTab: Tab): boolean {
  if (activeTab === 'all') return true;
  if (activeTab === 'sessions') return type === 'session' || type === 'command';
  if (activeTab === 'workspaces') return type === 'workspace';
  if (activeTab === 'prs') return type === 'pr' || type === 'attention';
  if (activeTab === 'settings') return type === 'setting' || type === 'command';
  return true;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useCachedData(open: boolean) {
  const queryClient = useQueryClient();
  // Snapshot cache on each render (deps include `open` to re-read when palette opens)
  const cachedPrs = useMemo<PullRequest[]>(
    () => queryClient.getQueryData<OrgPrsResponse>(['org-prs'])?.prs ?? [],
    [queryClient, open]
  );
  const cachedGithubIssues = useMemo<GitHubIssue[]>(
    () =>
      queryClient.getQueryData<GitHubIssuesResponse>(['github-issues'])
        ?.issues ?? [],
    [queryClient, open]
  );
  const cachedJiraIssues = useMemo<JiraIssue[]>(
    () =>
      queryClient.getQueryData<JiraIssuesResponse>(['jira-issues'])?.issues ??
      [],
    [queryClient, open]
  );
  return { cachedPrs, cachedGithubIssues, cachedJiraIssues };
}

function buildResults(
  q: string,
  workspaces: Repo[],
  sessions: SessionSummary[],
  cachedPrs: PullRequest[],
  cachedGithubIssues: GitHubIssue[],
  cachedJiraIssues: JiraIssue[],
  registryCommands: Action[],
  needsAttention: PullRequest[],
  activeTab: Tab
): PaletteResult[] {
  const items: PaletteResult[] = [];
  if (!q) {
    for (const pr of needsAttention)
      items.push({
        type: 'attention',
        id: `attn-${pr.number}`,
        label: `#${pr.number} ${pr.title}`,
        sublabel: pr.repoName ?? '',
        data: pr,
      });
    for (const ws of workspaces.slice(0, 5))
      items.push({
        type: 'workspace',
        id: `ws-${ws.path}`,
        label: ws.name,
        sublabel: ws.path,
        data: ws,
      });
    for (const a of registryCommands)
      items.push({
        type: 'command',
        id: `cmd-${a.id}`,
        label: a.label,
        sublabel: a.description ?? '',
        data: a,
      });
    return items.filter((r) => matchesTab(r.type, activeTab));
  }
  for (const ws of workspaces
    .filter((w) => w.name.toLowerCase().includes(q))
    .slice(0, 5))
    items.push({
      type: 'workspace',
      id: `ws-${ws.path}`,
      label: ws.name,
      sublabel: ws.path,
      data: ws,
    });
  for (const s of sessions
    .filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.branchName.toLowerCase().includes(q) ||
        s.repoName.toLowerCase().includes(q)
    )
    .slice(0, 5)) {
    items.push({
      type: 'session',
      id: `sess-${s.id}`,
      label: s.displayName || s.branchName || s.repoName,
      sublabel: s.repoName,
      data: s,
    });
  }
  for (const pr of cachedPrs
    .filter(
      (pr) =>
        pr.title.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        pr.headRefName.toLowerCase().includes(q)
    )
    .slice(0, 5)) {
    items.push({
      type: 'pr',
      id: `pr-${pr.number}`,
      label: `#${pr.number} ${pr.title}`,
      sublabel: pr.repoName ?? pr.headRefName,
      data: pr,
    });
  }
  for (const issue of cachedGithubIssues
    .filter(
      (i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q)
    )
    .slice(0, 3)) {
    items.push({
      type: 'ticket',
      id: `gh-${issue.number}`,
      label: `#${issue.number} ${issue.title}`,
      sublabel: issue.repoName,
      data: issue,
    });
  }
  for (const issue of cachedJiraIssues
    .filter(
      (i) =>
        i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q)
    )
    .slice(0, 3)) {
    items.push({
      type: 'ticket',
      id: `jira-${issue.key}`,
      label: `${issue.key} ${issue.title}`,
      sublabel: issue.status,
      data: issue,
    });
  }
  for (const a of registryCommands.filter(
    (a) =>
      a.label.toLowerCase().includes(q) ||
      a.description?.toLowerCase().includes(q) ||
      a.aliases?.some((alias) => alias.toLowerCase().includes(q))
  )) {
    items.push({
      type: 'command',
      id: `cmd-${a.id}`,
      label: a.label,
      sublabel: a.description ?? '',
      data: a,
    });
  }
  for (const s of SETTINGS_ENTRIES.filter(
    (s) =>
      s.label.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
  ))
    items.push({
      type: 'setting',
      id: s.id,
      label: s.label,
      sublabel: s.description,
      data: s,
    });
  return items.filter((r) => matchesTab(r.type, activeTab));
}

function useGroupedResults(
  results: PaletteResult[],
  query: string
): ResultGroup[] {
  return useMemo(() => {
    const q = query.toLowerCase().trim();
    const typeOrder: Array<{ type: PaletteResult['type']; label: string }> = q
      ? [
          { type: 'workspace', label: 'workspaces' },
          { type: 'session', label: 'sessions' },
          { type: 'pr', label: 'pull requests' },
          { type: 'ticket', label: 'tickets' },
          { type: 'command', label: 'commands' },
          { type: 'setting', label: 'settings' },
        ]
      : [
          { type: 'attention', label: 'needs attention' },
          { type: 'workspace', label: 'workspaces' },
          { type: 'command', label: 'commands' },
        ];
    return typeOrder.flatMap(({ type, label }) => {
      const items = results.filter((r) => r.type === type);
      return items.length > 0 ? [{ label, items }] : [];
    });
  }, [results, query]);
}

// ── usePaletteState hook ───────────────────────────────────────────────────────

function usePaletteState(
  open: boolean,
  inputRef: React.RefObject<HTMLInputElement | null>
) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartYRef = useRef(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebouncedQuery('');
      setFocusedIndex(0);
      setActiveTab('all');
      setDragOffset(0);
      setDragging(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, inputRef]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  return {
    query,
    setQuery,
    debouncedQuery,
    focusedIndex,
    setFocusedIndex,
    activeTab,
    setActiveTab,
    dragOffset,
    setDragOffset,
    dragging,
    setDragging,
    dragStartYRef,
  };
}

// ── usePaletteHandlers hook ────────────────────────────────────────────────────

function usePaletteHandlers(
  flatItems: PaletteResult[],
  focusedIndex: number,
  activeTab: Tab,
  setFocusedIndex: (v: number | ((p: number) => number)) => void,
  setActiveTab: (t: Tab) => void,
  dragging: boolean,
  dragOffset: number,
  setDragging: (v: boolean) => void,
  setDragOffset: (v: number) => void,
  dragStartYRef: React.RefObject<number>,
  resultsRef: React.RefObject<HTMLDivElement | null>,
  actionContext: ActionContext,
  onClose: () => void,
  onSelectWorkspace: (path: string) => void,
  onSelectSession: (id: string) => void,
  onSelectPr: (pr: PullRequest) => void,
  onOpenSettings?: (sectionId: string) => void
) {
  const scrollFocusedIntoView = useCallback(() => {
    requestAnimationFrame(() => {
      document
        .querySelector('.palette-item.focused')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  const selectItem = useCallback(
    async (item: PaletteResult) => {
      if (item.type === 'command') {
        try {
          await (item.data as Action).handler(actionContext);
        } finally {
          onClose();
        }
        return;
      }
      onClose();
      if (item.type === 'workspace')
        onSelectWorkspace((item.data as Repo).path);
      else if (item.type === 'session')
        onSelectSession((item.data as SessionSummary).id);
      else if (item.type === 'attention' || item.type === 'pr')
        onSelectPr(item.data as PullRequest);
      else if (item.type === 'setting')
        onOpenSettings?.((item.data as SettingEntry).section);
    },
    [
      actionContext,
      onClose,
      onSelectWorkspace,
      onSelectSession,
      onSelectPr,
      onOpenSettings,
    ]
  );

  const handleKeydown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((p) => Math.min(p + 1, flatItems.length - 1));
        scrollFocusedIntoView();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((p) => Math.max(p - 1, 0));
        scrollFocusedIntoView();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = flatItems[focusedIndex];
        if (item) void selectItem(item);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const idx = TABS.indexOf(activeTab);
        setActiveTab(
          e.shiftKey
            ? TABS[(idx - 1 + TABS.length) % TABS.length]!
            : TABS[(idx + 1) % TABS.length]!
        );
        setFocusedIndex(0);
      }
    },
    [
      onClose,
      flatItems,
      focusedIndex,
      scrollFocusedIntoView,
      selectItem,
      activeTab,
      setActiveTab,
      setFocusedIndex,
    ]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('palette-overlay'))
        onClose();
    },
    [onClose]
  );

  const handleDragStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobileDevice) return;
      const target = e.target as HTMLElement;
      const isHandle =
        target.classList.contains('drag-handle') ||
        target.classList.contains('drag-bar');
      if (!isHandle && resultsRef.current && resultsRef.current.scrollTop > 0)
        return;
      dragStartYRef.current = e.touches[0]!.clientY;
      setDragging(true);
    },
    [dragStartYRef, resultsRef, setDragging]
  );

  const handleDragMove = useCallback(
    (e: React.TouchEvent) => {
      if (!dragging) return;
      const delta = e.touches[0]!.clientY - dragStartYRef.current;
      if (delta > 0) setDragOffset(delta);
    },
    [dragging, dragStartYRef, setDragOffset]
  );

  const handleDragEnd = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    if (dragOffset > 100) onClose();
    setDragOffset(0);
  }, [dragging, dragOffset, onClose, setDragging, setDragOffset]);

  return {
    handleKeydown,
    handleBackdropClick,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    selectItem,
  };
}

// ── Main Component ────────────────────────────────────────────────────────────

export function CommandPalette({
  open,
  workspaces,
  sessions,
  actionContext,
  onClose,
  onSelectWorkspace,
  onSelectSession,
  onSelectPr,
  onOpenSettings,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const {
    query,
    setQuery,
    debouncedQuery,
    focusedIndex,
    setFocusedIndex,
    activeTab,
    setActiveTab,
    dragOffset,
    setDragOffset,
    dragging,
    setDragging,
    dragStartYRef,
  } = usePaletteState(open, inputRef);
  const { cachedPrs, cachedGithubIssues, cachedJiraIssues } =
    useCachedData(open);
  const registryCommands = useMemo(
    () => getAllActions().filter((a) => !a.when || a.when(actionContext)),
    [actionContext]
  );
  const needsAttention = useMemo(
    () =>
      cachedPrs
        .filter(
          (pr) =>
            pr.state === 'OPEN' &&
            (pr.reviewDecision === 'CHANGES_REQUESTED' ||
              pr.role === 'reviewer')
        )
        .slice(0, 5),
    [cachedPrs]
  );

  const results = useMemo(
    () =>
      buildResults(
        debouncedQuery.toLowerCase().trim(),
        workspaces,
        sessions,
        cachedPrs,
        cachedGithubIssues,
        cachedJiraIssues,
        registryCommands,
        needsAttention,
        activeTab
      ),
    [
      debouncedQuery,
      workspaces,
      sessions,
      cachedPrs,
      cachedGithubIssues,
      cachedJiraIssues,
      registryCommands,
      needsAttention,
      activeTab,
    ]
  );
  const groupedResults = useGroupedResults(results, debouncedQuery);
  const flatItems = useMemo(
    () => groupedResults.flatMap((g) => g.items),
    [groupedResults]
  );

  useEffect(() => {
    if (focusedIndex >= flatItems.length)
      setFocusedIndex(Math.max(0, flatItems.length - 1));
  }, [flatItems.length, focusedIndex, setFocusedIndex]);

  const {
    handleKeydown,
    handleBackdropClick,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    selectItem,
  } = usePaletteHandlers(
    flatItems,
    focusedIndex,
    activeTab,
    setFocusedIndex,
    setActiveTab,
    dragging,
    dragOffset,
    setDragging,
    setDragOffset,
    dragStartYRef,
    resultsRef,
    actionContext,
    onClose,
    onSelectWorkspace,
    onSelectSession,
    onSelectPr,
    onOpenSettings
  );

  if (!open) return null;
  const paletteStyle =
    isMobileDevice && dragOffset > 0
      ? { transform: `translateY(${dragOffset}px)` }
      : undefined;

  return (
    <div
      className={['palette-overlay', isMobileDevice ? 'mobile' : '']
        .filter(Boolean)
        .join(' ')}
      onClick={handleBackdropClick}
    >
      <div
        className={['palette', isMobileDevice ? 'mobile' : '']
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label="Command palette"
        style={paletteStyle}
        onTouchStart={isMobileDevice ? handleDragStart : undefined}
        onTouchMove={isMobileDevice ? handleDragMove : undefined}
        onTouchEnd={isMobileDevice ? handleDragEnd : undefined}
        onTouchCancel={isMobileDevice ? handleDragEnd : undefined}
      >
        {isMobileDevice && (
          <div className="drag-handle">
            <span className="drag-bar" />
          </div>
        )}
        <div className="palette-input-row">
          <span className="palette-prompt">&gt;</span>
          <input
            ref={inputRef}
            className="palette-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeydown}
            placeholder="search commands, workspaces, sessions..."
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={flatItems.length > 0}
            aria-controls="palette-results"
            aria-activedescendant={
              flatItems[focusedIndex]
                ? `palette-item-${flatItems[focusedIndex]!.id}`
                : undefined
            }
          />
        </div>
        <div className="palette-tabs" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={['palette-tab', activeTab === tab ? 'active' : '']
                .filter(Boolean)
                .join(' ')}
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => {
                setActiveTab(tab);
                setFocusedIndex(0);
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        {(() => {
          const flatIndexMap = new Map(
            flatItems.map((item, i) => [item.id, i])
          );
          if (flatItems.length === 0 && debouncedQuery.trim()) {
            return (
              <div className="palette-results" ref={resultsRef} role="listbox">
                <div className="palette-empty">
                  no results for &quot;{debouncedQuery}&quot;
                </div>
              </div>
            );
          }
          return (
            <div
              className="palette-results"
              id="palette-results"
              role="listbox"
              ref={resultsRef}
            >
              {groupedResults.map((group) => (
                <div key={group.label} role="presentation">
                  <div className="palette-category" role="presentation">
                    {group.label}
                    {group.label === 'needs attention' && (
                      <span className="category-count">
                        ({group.items.length})
                      </span>
                    )}
                  </div>
                  {group.items.map((item) => {
                    const globalIndex = flatIndexMap.get(item.id) ?? -1;
                    const isFocused = globalIndex === focusedIndex;
                    return (
                      <div
                        key={item.id}
                        id={`palette-item-${item.id}`}
                        className={['palette-item', isFocused ? 'focused' : '']
                          .filter(Boolean)
                          .join(' ')}
                        role="option"
                        tabIndex={-1}
                        aria-selected={isFocused}
                        onClick={() => void selectItem(item)}
                        onMouseEnter={() => setFocusedIndex(globalIndex)}
                      >
                        <span
                          className={['item-cursor', isFocused ? 'visible' : '']
                            .filter(Boolean)
                            .join(' ')}
                        >
                          &gt;
                        </span>
                        {item.type === 'attention' || item.type === 'pr' ? (
                          <StatusDot
                            status={derivePrDotStatus(item.data as PullRequest)}
                            size={7}
                          />
                        ) : item.type === 'command' &&
                          (item.data as Action).icon ? (
                          <span className="item-icon">
                            {(item.data as Action).icon}
                          </span>
                        ) : (
                          <span className="item-icon">
                            {categoryIcon(item.type)}
                          </span>
                        )}
                        <span className="item-label">{item.label}</span>
                        {item.sublabel && (
                          <span className="item-sublabel">{item.sublabel}</span>
                        )}
                        {!isMobileDevice &&
                          item.type === 'command' &&
                          (item.data as Action).shortcut && (
                            <kbd className="item-shortcut">
                              {formatShortcut(
                                (item.data as Action).shortcut!.key,
                                isMac
                              )}
                            </kbd>
                          )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })()}
        {!isMobileDevice && (
          <div className="palette-footer">
            <span className="hint">↑↓ navigate</span>
            <span className="hint">tab category</span>
            <span className="hint">↵ select</span>
            <span className="hint">esc close</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default CommandPalette;
