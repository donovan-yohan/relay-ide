import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  Folder,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  TriangleAlert,
} from 'lucide-react';
import type { WorkspaceSurface } from '../../../shared/workspace-surfaces.js';
import type {
  WorkspaceTopic,
  WorkspaceTopicSearchResult,
} from '../../../shared/workspace-topics.js';
import {
  fetchWorkspaceSurfaces,
  fetchWorkspaceTopics,
  searchWorkspaceTopics,
} from '../lib/api.js';
import { deriveColor } from '../lib/colors.js';
import type { SessionSummary } from '../lib/types.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import {
  buildTopicNavModel,
  type TopicNavItem,
  type TopicNavModel,
  type TopicNavSessionRef,
  type TopicNavSurfaceRef,
} from '../lib/state/topic-nav.js';
import { MarqueeText } from './MarqueeText.js';
import './TopicSidebarShell.css';

function WorkspaceKindIcon({ kind }: { kind: TopicNavItem['kind'] }) {
  const props = { 'aria-hidden': true, size: 16, strokeWidth: 1.8 } as const;
  if (kind === 'repo') return <GitBranch {...props} />;
  if (kind === 'folder') return <Folder {...props} />;
  return <MessageSquare {...props} />;
}

function AttentionIcon({ tone }: { tone: TopicNavItem['tone'] }) {
  if (tone === 'active') {
    return (
      <LoaderCircle className="topic-status__spinner" aria-hidden size={13} />
    );
  }
  if (tone === 'attention') return <CircleAlert aria-hidden size={13} />;
  if (tone === 'error') return <TriangleAlert aria-hidden size={13} />;
  return null;
}

function StatusGlyph({ tone }: { tone: TopicNavItem['tone'] }) {
  const attention = AttentionIcon({ tone });
  return (
    <span className={`topic-status topic-status--${tone}`} aria-hidden>
      {attention}
    </span>
  );
}

function TopicBadge({ item }: { item: TopicNavItem }) {
  return (
    <span
      className="topic-row__badge"
      style={{ background: deriveColor(item.badgeSeed) }}
      title={`${item.kindLabel} workspace`}
    >
      <WorkspaceKindIcon kind={item.kind} />
    </span>
  );
}

function SurfaceButton({ surface }: { surface: TopicNavSurfaceRef }) {
  const canOpen =
    surface.openMode === 'direct' && surface.target?.startsWith('http');
  const label = `${surface.kind}: ${surface.label}`;
  if (canOpen) {
    return (
      <a
        className={`topic-action topic-action--${surface.health}`}
        href={surface.target ?? undefined}
        rel="noreferrer"
        target="_blank"
        title={`${label} · ${surface.health}`}
      >
        {surface.kind}
      </a>
    );
  }
  return (
    <button
      className={`topic-action topic-action--${surface.health}`}
      type="button"
      disabled={!surface.target}
      title={`${label} · ${surface.openMode}`}
      onClick={() => {
        if (surface.target) void navigator.clipboard?.writeText(surface.target);
      }}
    >
      {surface.kind}
    </button>
  );
}

function SessionChildRow({
  session,
  onSelectSession,
}: {
  session: TopicNavSessionRef;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  return (
    <li className={`topic-child-row topic-child-row--${session.tone}`}>
      <button
        type="button"
        className="topic-child-row__button"
        {...(onSelectSession
          ? { onClick: () => onSelectSession(session.selectKey) }
          : {})}
      >
        <span className="topic-child-row__label">
          <MarqueeText>{session.label}</MarqueeText>
        </span>
        {session.branch ? (
          <span className="topic-child-row__meta">{session.branch}</span>
        ) : null}
        {session.nodeId ? (
          <span className="topic-child-row__meta">{session.nodeId}</span>
        ) : null}
        <StatusGlyph tone={session.tone} />
      </button>
    </li>
  );
}

function TopicDetail({ item }: { item: TopicNavItem }) {
  return (
    <section className="topic-detail" aria-label={`${item.title} details`}>
      <div className="topic-detail__title">{item.title}</div>
      {item.description ? (
        <p className="topic-detail__description">{item.description}</p>
      ) : (
        <p className="topic-detail__description muted">no topic brief yet</p>
      )}
      <div className="topic-detail__meta">
        <span>{item.statusLabel}</span>
        {item.routingLabel ? <span>{item.routingLabel}</span> : null}
        {item.taskRefs.length > 0 ? (
          <span>{item.taskRefs.length} task refs</span>
        ) : null}
        {item.surfaces.length > 0 ? (
          <span>{item.surfaces.length} surfaces</span>
        ) : null}
      </div>
      {item.surfaces.length > 0 ? (
        <div className="topic-detail__surfaces" aria-label="topic surfaces">
          {item.surfaces.slice(0, 6).map((surface) => (
            <SurfaceButton key={surface.id} surface={surface} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TopicRow({
  item,
  depth,
  model,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
  onSelectSession,
}: {
  item: TopicNavItem;
  depth: number;
  model: TopicNavModel;
  expandedIds: Set<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const hasNested = item.childIds.length > 0 || item.sessions.length > 0;
  const expanded = expandedIds.has(item.id);
  const selected = selectedId === item.id;
  const affordanceCount =
    item.sessions.length + item.surfaces.length + item.taskRefs.length;

  const activate = () => {
    onSelect(item.id);
    if (hasNested) onToggle(item.id);
  };

  const rowStyle = { '--topic-depth': depth } as CSSProperties;
  const rowClassName = [
    'topic-row',
    `topic-row--${item.tone}`,
    selected && 'selected',
    item.muted && 'muted',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={['topic-node', expanded && hasNested && 'expanded']
        .filter(Boolean)
        .join(' ')}
      style={rowStyle}
    >
      <div className={rowClassName}>
        <button
          type="button"
          className="topic-row__main"
          aria-expanded={hasNested ? expanded : undefined}
          aria-current={selected ? 'page' : undefined}
          onClick={activate}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' && hasNested && !expanded) {
              event.preventDefault();
              onToggle(item.id);
            } else if (event.key === 'ArrowLeft' && hasNested && expanded) {
              event.preventDefault();
              onToggle(item.id);
            }
          }}
        >
          <TopicBadge item={item} />
          <span className="topic-row__title">
            <MarqueeText>{item.title}</MarqueeText>
          </span>
        </button>
        <span
          className="topic-row__trail"
          aria-label={`${item.statusLabel}, ${affordanceCount} linked items`}
        >
          <span className="topic-row__hover-actions" aria-hidden="true">
            {item.sessions.length > 0 ? (
              <span className="topic-chip">s{item.sessions.length}</span>
            ) : null}
            {item.surfaces.slice(0, 2).map((surface) => (
              <SurfaceButton key={surface.id} surface={surface} />
            ))}
            {item.taskRefs.length > 0 ? (
              <span className="topic-chip">t{item.taskRefs.length}</span>
            ) : null}
          </span>
          <StatusGlyph tone={item.tone} />
        </span>
      </div>
      {expanded ? (
        <>
          {item.sessions.length > 0 ? (
            <ul className="topic-child-list">
              {item.sessions.map((session) => (
                <SessionChildRow
                  key={session.id}
                  session={session}
                  onSelectSession={onSelectSession}
                />
              ))}
            </ul>
          ) : null}
          {item.childIds.length > 0 ? (
            <ul className="topic-child-list topic-child-list--topics">
              {item.childIds.map((childId) => {
                const child = model.byId.get(childId);
                return child ? (
                  <TopicRow
                    key={child.id}
                    item={child}
                    depth={depth + 1}
                    model={model}
                    expandedIds={expandedIds}
                    selectedId={selectedId}
                    onToggle={onToggle}
                    onSelect={onSelect}
                    onSelectSession={onSelectSession}
                  />
                ) : null;
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function searchMatchSummary(result: WorkspaceTopicSearchResult): string {
  const primary = result.matches[0];
  if (!primary) return 'matched topic metadata';
  return `${primary.label}: ${primary.value}`;
}

function TopicSearchResults({
  results,
  truncated,
  onSelectSession,
}: {
  results: WorkspaceTopicSearchResult[];
  truncated: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  if (results.length === 0 && !truncated) return null;
  return (
    <div
      className="topic-search-results"
      aria-label="topic search result details"
    >
      {results.map((result) => {
        const disabledReason = result.action.disabledReason;
        const primarySessionId = result.action.primarySessionId;
        const actionDisabled = Boolean(disabledReason) || !primarySessionId;
        const actionTitle =
          disabledReason ??
          (primarySessionId
            ? `open session ${primarySessionId}`
            : 'no linked session');
        return (
          <div
            key={result.topic.id}
            className={`topic-search-result topic-search-result--${result.freshness}`}
          >
            <div className="topic-search-result__main">
              <span className="topic-search-result__title">
                {result.topic.display.title}
              </span>
              <span className="topic-search-result__meta">
                {searchMatchSummary(result)}
              </span>
            </div>
            <span className="topic-search-result__freshness">
              {result.freshness}
            </span>
            <button
              type="button"
              className="topic-action topic-search-result__action"
              disabled={actionDisabled}
              title={actionTitle}
              onClick={() => {
                if (primarySessionId && !actionDisabled) {
                  onSelectSession?.(primarySessionId);
                }
              }}
            >
              open
            </button>
            {disabledReason ? (
              <span className="topic-search-result__disabled">
                {disabledReason}
              </span>
            ) : null}
          </div>
        );
      })}
      {truncated ? (
        <div className="topic-search-result__truncated">
          results truncated; refine search
        </div>
      ) : null}
    </div>
  );
}

function topicEmptyStateText(input: {
  searchActive: boolean;
  searchUnavailableReason?: string | undefined;
  searchQuery: string;
}): string {
  if (!input.searchActive) return 'no workspace topics yet';
  if (input.searchUnavailableReason === 'empty_query') {
    return 'type to search bounded topic history';
  }
  return `no topic matches for “${input.searchQuery.trim()}”`;
}

export function TopicSidebarView({
  topics,
  sessions,
  surfaces,
  loading = false,
  error = false,
  derived = false,
  searchQuery = '',
  searchLoading = false,
  searchError = false,
  searchResults = [],
  searchTruncated = false,
  searchUnavailableReason,
  onSearchQueryChange,
  onSearchRetry,
  onSearchClear,
  onSelectSession,
}: {
  topics: WorkspaceTopic[];
  sessions: SessionSummary[];
  surfaces: WorkspaceSurface[];
  loading?: boolean;
  error?: boolean;
  derived?: boolean;
  searchQuery?: string;
  searchLoading?: boolean;
  searchError?: boolean;
  searchResults?: WorkspaceTopicSearchResult[];
  searchTruncated?: boolean;
  searchUnavailableReason?: string | undefined;
  onSearchQueryChange?: ((query: string) => void) | undefined;
  onSearchRetry?: (() => void) | undefined;
  onSearchClear?: (() => void) | undefined;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const model = useMemo(
    () => buildTopicNavModel({ topics, sessions, surfaces, derived }),
    [topics, sessions, surfaces, derived]
  );
  const firstId = model.rootIds[0] ?? model.items[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(firstId);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(model.rootIds)
  );

  useEffect(() => {
    setSelectedId((current) =>
      current && model.byId.has(current) ? current : firstId
    );
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const id of model.rootIds) next.add(id);
      return next;
    });
  }, [firstId, model.byId, model.rootIds]);

  const toggle = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const select = useCallback((id: string) => setSelectedId(id), []);
  const selectedItem = selectedId ? model.byId.get(selectedId) : undefined;
  const searchActive = searchQuery.trim().length > 0;
  const activeSearchLoading = Boolean(searchQuery.trim() && searchLoading);

  if (loading && !activeSearchLoading) {
    return <div className="topic-shell-state">loading topic shell…</div>;
  }
  if (error) {
    return (
      <div className="topic-shell-state error">topic shell unavailable</div>
    );
  }

  return (
    <div className="topic-shell" data-track="topic-shell">
      <div className="topic-shell__header">
        <span>topics</span>
        {searchQuery.trim() ? (
          <span className="topic-shell__derived">search</span>
        ) : model.derived ? (
          <span className="topic-shell__derived">derived</span>
        ) : null}
      </div>
      <label className="topic-search" aria-label="search topic history">
        <span className="topic-search__prompt">/</span>
        <input
          className="topic-search__input"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange?.(event.target.value)}
          placeholder="search topics, tasks, artifacts..."
          spellCheck={false}
        />
        {searchLoading ? <span className="topic-search__state">…</span> : null}
      </label>
      {searchError ? (
        <div className="topic-shell-state topic-search-state error">
          <span>topic search unavailable</span>
          <span className="topic-search-state__actions">
            {onSearchRetry ? (
              <button type="button" onClick={onSearchRetry}>
                retry
              </button>
            ) : null}
            {onSearchClear ? (
              <button type="button" onClick={onSearchClear}>
                clear
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      {searchLoading && model.items.length === 0 ? (
        <div className="topic-shell-state topic-search-state">
          searching topic history…
        </div>
      ) : null}
      {model.items.length === 0 && !searchLoading && !searchError ? (
        <div className="topic-shell-state">
          {topicEmptyStateText({
            searchActive,
            searchUnavailableReason,
            searchQuery,
          })}
        </div>
      ) : null}
      {searchActive ? (
        <TopicSearchResults
          results={searchResults}
          truncated={searchTruncated}
          onSelectSession={onSelectSession}
        />
      ) : null}
      <ul className="topic-tree" aria-label="workspace topics">
        {model.rootIds.map((id) => {
          const item = model.byId.get(id);
          return item ? (
            <TopicRow
              key={item.id}
              item={item}
              depth={0}
              model={model}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onToggle={toggle}
              onSelect={select}
              onSelectSession={onSelectSession}
            />
          ) : null;
        })}
      </ul>
      {selectedItem ? <TopicDetail item={selectedItem} /> : null}
    </div>
  );
}

export function TopicSidebarShell({
  onSelectSession,
}: {
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const sessions = useSessionsStore((s) => s.sessions);
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedSearchQuery = searchQuery.trim();
  const topicsQuery = useQuery({
    queryKey: ['workspace-topics'],
    queryFn: () => fetchWorkspaceTopics(),
    staleTime: 30_000,
  });
  const topicSearchQuery = useQuery({
    queryKey: ['workspace-topics', 'search', normalizedSearchQuery],
    queryFn: () =>
      searchWorkspaceTopics({ q: normalizedSearchQuery, limit: 20 }),
    enabled: normalizedSearchQuery.length > 0,
    staleTime: 10_000,
  });
  const surfacesQuery = useQuery<WorkspaceSurface[]>({
    queryKey: ['workspace-surfaces', 'topic-shell'],
    queryFn: () => fetchWorkspaceSurfaces(),
    staleTime: 30_000,
  });
  const searchActive = normalizedSearchQuery.length > 0;
  const searchData = topicSearchQuery.data;
  const searchResults = searchData?.results ?? [];

  return (
    <TopicSidebarView
      topics={
        searchActive
          ? searchResults.map((result) => result.topic)
          : (topicsQuery.data?.topics ?? [])
      }
      sessions={sessions}
      surfaces={surfacesQuery.data ?? []}
      loading={
        !searchActive &&
        ((topicsQuery.isLoading && !topicsQuery.data) ||
          (surfacesQuery.isLoading && !surfacesQuery.data))
      }
      error={
        (topicsQuery.isError && !topicsQuery.data && !searchActive) ||
        (surfacesQuery.isError && !surfacesQuery.data)
      }
      derived={
        searchActive
          ? (searchData?.derived ?? false)
          : (topicsQuery.data?.derived ?? false)
      }
      searchQuery={searchQuery}
      searchLoading={topicSearchQuery.isFetching && searchActive}
      searchError={topicSearchQuery.isError && searchActive}
      searchResults={searchResults}
      searchTruncated={searchData?.truncated ?? false}
      searchUnavailableReason={searchData?.unavailableReason}
      onSearchQueryChange={setSearchQuery}
      onSearchRetry={() => void topicSearchQuery.refetch()}
      onSearchClear={() => setSearchQuery('')}
      onSelectSession={onSelectSession}
    />
  );
}

export default TopicSidebarShell;
