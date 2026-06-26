import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceSurface } from '../../../shared/workspace-surfaces.js';
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import { fetchWorkspaceSurfaces, fetchWorkspaceTopics } from '../lib/api.js';
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

function StatusGlyph({ tone }: { tone: TopicNavItem['tone'] }) {
  return <span className={`topic-status topic-status--${tone}`} aria-hidden />;
}

function TopicBadge({ item }: { item: TopicNavItem }) {
  return (
    <span
      className="topic-row__badge"
      style={{ background: deriveColor(item.badgeSeed) }}
      title={`workspace ${item.badgeText}`}
    >
      {item.badgeText}
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
        onClick={() => onSelectSession?.(session.selectKey)}
      >
        <StatusGlyph tone={session.tone} />
        <span className="topic-child-row__label">
          <MarqueeText>{session.label}</MarqueeText>
        </span>
        {session.branch ? (
          <span className="topic-child-row__meta">{session.branch}</span>
        ) : null}
        {session.nodeId ? (
          <span className="topic-child-row__meta">{session.nodeId}</span>
        ) : null}
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

  return (
    <li className="topic-node">
      <button
        type="button"
        className={[
          'topic-row',
          `topic-row--${item.tone}`,
          selected && 'selected',
          item.muted && 'muted',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: `${8 + depth * 18}px` }}
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
        <span
          className={['topic-row__chevron', !expanded && 'collapsed']
            .filter(Boolean)
            .join(' ')}
        >
          {hasNested ? '⌄' : '·'}
        </span>
        <TopicBadge item={item} />
        <span className="topic-row__title">
          <MarqueeText>{item.title}</MarqueeText>
        </span>
        <span
          className="topic-row__trail"
          aria-label={`${item.statusLabel}, ${affordanceCount} linked items`}
        >
          <StatusGlyph tone={item.tone} />
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
      </button>
      {selected ? <TopicDetail item={item} /> : null}
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

export function TopicSidebarView({
  topics,
  sessions,
  surfaces,
  loading = false,
  error = false,
  derived = false,
  onSelectSession,
}: {
  topics: WorkspaceTopic[];
  sessions: SessionSummary[];
  surfaces: WorkspaceSurface[];
  loading?: boolean;
  error?: boolean;
  derived?: boolean;
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

  if (loading) {
    return <div className="topic-shell-state">loading topic shell…</div>;
  }
  if (error) {
    return (
      <div className="topic-shell-state error">topic shell unavailable</div>
    );
  }
  if (model.items.length === 0) {
    return <div className="topic-shell-state">no workspace topics yet</div>;
  }

  return (
    <div className="topic-shell" data-track="topic-shell">
      <div className="topic-shell__header">
        <span>topics</span>
        {model.derived ? (
          <span className="topic-shell__derived">derived</span>
        ) : null}
      </div>
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
    </div>
  );
}

export function TopicSidebarShell({
  onSelectSession,
}: {
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const sessions = useSessionsStore((s) => s.sessions);
  const topicsQuery = useQuery({
    queryKey: ['workspace-topics'],
    queryFn: () => fetchWorkspaceTopics(),
    staleTime: 30_000,
  });
  const surfacesQuery = useQuery<WorkspaceSurface[]>({
    queryKey: ['workspace-surfaces', 'topic-shell'],
    queryFn: () => fetchWorkspaceSurfaces(),
    staleTime: 30_000,
  });

  return (
    <TopicSidebarView
      topics={topicsQuery.data?.topics ?? []}
      sessions={sessions}
      surfaces={surfacesQuery.data ?? []}
      loading={topicsQuery.isLoading && !topicsQuery.data}
      error={topicsQuery.isError}
      derived={topicsQuery.data?.derived ?? false}
      onSelectSession={onSelectSession}
    />
  );
}

export default TopicSidebarShell;
