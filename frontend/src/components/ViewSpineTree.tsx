// #729 (Epic #444 view-spine MVP): flag-gated, READ-ONLY render of the
// client-derived view-tree (`lib/state/view-tree.ts`). Reuses EXISTING sidebar
// primitives only — no new visual chrome, no new animations. Leaves are COUNTS,
// not interactive rows. Default OFF; only mounted when `viewSpineEnabled`.
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { fetchHubNodes } from '../lib/api.js';
import { deriveColor } from '../lib/colors.js';
import { MarqueeText } from './MarqueeText.js';
import { CipherText } from './CipherText.js';
import {
  applyLens,
  benchCreatePayload,
  buildViewTree,
  DEFAULT_VIEW_LENS,
  type BenchCreatePayload,
  type InstanceHostStatus,
  type ViewLens,
  type ViewTreeBench,
  type ViewTreeFreeEntry,
  type ViewTreeInstance,
  type ViewTreeProject,
  type ViewTreeNodeStatus,
} from '../lib/state/view-tree.js';
import './ViewSpineTree.css';

/** Create a Tab anchored to a Bench's (nodeId, cwd). Wired to the EXISTING
 *  node-aware session-create entrypoint by `App` — NOT a new create flow, and
 *  NOT the worktree-creation path (`onNewWorktree`). */
export type ViewSpineCreateTab = (payload: BenchCreatePayload) => void;

// Ad-hoc, ephemeral lenses (#727). Order is the visual + arrow-key order.
const LENSES: ReadonlyArray<{ id: ViewLens; label: string }> = [
  { id: 'recent', label: 'recent' },
  { id: 'all', label: 'all sessions' },
  { id: 'this-host', label: 'this host' },
];

// CSS only defines tones for online/stale/offline/revoked; updating falls back
// to the muted default. Map straight through — class is harmless if unstyled.
function statusDotClass(status: InstanceHostStatus): string {
  if (!status) return '';
  return `hub-node-status-dot status-${status}`;
}

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="session-count-badge">{count}</span>;
}

function BenchRow({
  instance,
  bench,
  onCreateTab,
}: {
  instance: ViewTreeInstance;
  bench: ViewTreeBench;
  onCreateTab?: ViewSpineCreateTab | undefined;
}) {
  // Per-bench in-flight guard so the affordance disables itself (and other
  // benches stay clickable) while a create is pending. Errors surface through
  // the existing create path's toast — no bespoke error UI here.
  const [creating, setCreating] = useState(false);
  // Resolve the create payload up front. `null` for a non-git/directory bench
  // (no config.repos anchor → agent session impossible), which withholds the
  // "+ tab" affordance entirely. Memoized so the render decision and the click
  // handler agree.
  const createPayload = useMemo(
    () => benchCreatePayload(instance, bench),
    [instance, bench]
  );
  const handleCreate = useCallback(async () => {
    if (!onCreateTab || !createPayload || creating) return;
    setCreating(true);
    try {
      // Hand the resolved (nodeId, repoPath, worktreePath, cwd) payload to the
      // existing node-aware create entrypoint. NO env-override inheritance.
      await onCreateTab(createPayload);
    } finally {
      setCreating(false);
    }
  }, [onCreateTab, createPayload, creating]);

  return (
    <li className="session-row inactive state-inactive view-spine-bench">
      <div className="session-row-primary">
        <span className="session-name">
          <MarqueeText>{bench.label}</MarqueeText>
        </span>
        <CountBadge count={bench.tab.count} />
      </div>
      {/* `.secondary-branch` is rendered ONLY for git benches. Directory
          benches omit the element entirely (no branch leakage). */}
      {bench.isGit && bench.branch ? (
        <div className="session-row-secondary">
          <span className="secondary-branch">
            <MarqueeText>{bench.branch}</MarqueeText>
          </span>
        </div>
      ) : null}
      {/* #731 "+ tab" anchored to THIS bench's (nodeId, repoPath, worktree).
          Reuses the `.add-worktree-row`/`.add-worktree-btn` styling ONLY — it
          wires to session/tab CREATION, NOT worktree creation (distinct copy
          `+ tab`). Withheld for non-git benches (no agent-capable repo anchor). */}
      {onCreateTab && createPayload ? (
        <div
          className={['add-worktree-row', creating && 'disabled']
            .filter(Boolean)
            .join(' ')}
          data-track="view-spine.new-tab"
          onClick={() => {
            void handleCreate();
          }}
        >
          <button className="add-worktree-btn" type="button" tabIndex={-1}>
            {creating ? 'creating…' : '+ tab'}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function InstanceRow({
  instance,
  onCreateTab,
}: {
  instance: ViewTreeInstance;
  onCreateTab?: ViewSpineCreateTab | undefined;
}) {
  return (
    <li className="session-row view-spine-instance">
      <div className="session-row-primary">
        {instance.status ? (
          <span
            className={statusDotClass(instance.status)}
            aria-label={`host ${instance.status}`}
          />
        ) : null}
        <span className="session-name">
          <MarqueeText>{instance.hostLabel}</MarqueeText>
        </span>
        <CountBadge count={instance.rootTab.count} />
      </div>
      {instance.benches.length > 0 ? (
        <ul className="session-list view-spine-bench-list">
          {instance.benches.map((bench) => (
            <BenchRow
              key={bench.id}
              instance={instance}
              bench={bench}
              onCreateTab={onCreateTab}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ProjectRow({
  project,
  onCreateTab,
}: {
  project: ViewTreeProject;
  onCreateTab?: ViewSpineCreateTab | undefined;
}) {
  const initialColor = useMemo(
    () => deriveColor(project.colorSeed),
    [project.colorSeed]
  );
  const initial = (project.label.charAt(0) || '?').toUpperCase();
  // Instance-count badge hidden when ≤1 (single materialization is implicit).
  const instanceCount = project.instances.length;
  // A repo/directory project always implies a host; show the rolled-up status
  // of the first instance as the project-level dot. Omit when no instances.
  const projectStatus = project.instances[0]?.status ?? null;
  return (
    <div className="repo-item view-spine-project">
      <div className="repo-header">
        <div className="repo-left">
          {/* `.initial-block` color ONLY for bound git/dir projects. */}
          <span className="initial-block" style={{ background: initialColor }}>
            {initial}
          </span>
          <span className="repo-name">
            <MarqueeText>{project.label}</MarqueeText>
          </span>
          {project.kind === 'directory' ? (
            <span className="repo-kind-chip">dir</span>
          ) : null}
          {projectStatus ? (
            <span
              className={statusDotClass(projectStatus)}
              aria-label={`project host ${projectStatus}`}
            />
          ) : null}
          {instanceCount > 1 ? (
            <span className="session-count-badge">{instanceCount}</span>
          ) : null}
        </div>
      </div>
      <ul className="session-list">
        {project.instances.map((instance) => (
          <InstanceRow
            key={instance.id}
            instance={instance}
            onCreateTab={onCreateTab}
          />
        ))}
      </ul>
      <div className="repo-divider" />
    </div>
  );
}

// Reduced-anatomy row: structurally omits `.initial-block` AND
// `.secondary-branch` JSX so repo-identity/branch leakage is impossible by
// construction for repoPath-less (free/remote) sessions.
function FreeRow({ entry }: { entry: ViewTreeFreeEntry }) {
  return (
    <li className="session-row view-spine-free-row">
      <div className="session-row-primary">
        {entry.status ? (
          <span
            className={statusDotClass(entry.status)}
            aria-label={`host ${entry.status}`}
          />
        ) : null}
        <span className="session-name">
          <MarqueeText>{entry.label}</MarqueeText>
        </span>
        <CountBadge count={entry.tab.count} />
      </div>
    </li>
  );
}

// Segmented control reusing the FileTree `.fb__tab`/`.fb__tabs` primitive,
// scope-renamed to `.view-lens` (rule bodies copied into ViewSpineTree.css with
// a larger touch target). Roving tabindex: only the active tab is focusable;
// Left/Right move + activate, Enter/Space (re)activate the focused tab.
function LensSelector({
  value,
  onChange,
}: {
  value: ViewLens;
  onChange: (lens: ViewLens) => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = LENSES.findIndex((l) => l.id === value);

  function focusTab(index: number) {
    const clamped = (index + LENSES.length) % LENSES.length;
    const lens = LENSES[clamped];
    if (!lens) return;
    onChange(lens.id);
    tabRefs.current[clamped]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusTab(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusTab(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(LENSES.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onChange(LENSES[index]!.id);
        break;
      default:
        break;
    }
  }

  return (
    <div className="view-lens__tabs" role="tablist" aria-label="views">
      {LENSES.map((lens, index) => {
        const selected = lens.id === value;
        return (
          <button
            key={lens.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            className={`view-lens__tab${selected ? ' active' : ''}`}
            role="tab"
            aria-selected={selected}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => onChange(lens.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {lens.label}
          </button>
        );
      })}
    </div>
  );
}

export function ViewSpineTree({
  onCreateTab,
}: {
  /** #731: create a Tab anchored to a Bench's (nodeId, cwd). Read-only when
   *  omitted — the "+ tab" affordance only renders when this is provided. */
  onCreateTab?: ViewSpineCreateTab | undefined;
} = {}) {
  const repos = useSessionsStore((s) => s.repos);
  const worktrees = useSessionsStore((s) => s.worktrees);
  const sessions = useSessionsStore((s) => s.sessions);
  const workspaceGroups = useSessionsStore((s) => s.workspaceGroups);
  // Reuse the existing ['hub-nodes'] query (shared TanStack cache, no new
  // server call) — same key the dashboard/dialogs already populate.
  const {
    data: nodes,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: 60_000,
  });

  const nodeStatuses: ViewTreeNodeStatus[] = useMemo(
    () =>
      (nodes ?? []).map((n) => ({
        nodeId: n.nodeId,
        ...(n.displayName ? { displayName: n.displayName } : {}),
        status: n.status,
        ...(n.lastSeenAt ? { lastSeenAt: n.lastSeenAt } : {}),
      })),
    [nodes]
  );

  // Ephemeral lens state: in-memory only, default `recent`, lost on reload (no
  // persistence by design — #727).
  const [lens, setLens] = useState<ViewLens>(DEFAULT_VIEW_LENS);

  const derived = useMemo(
    () =>
      buildViewTree({
        repos,
        worktrees,
        sessions,
        workspaceGroups,
        nodes: nodeStatuses,
      }),
    [repos, worktrees, sessions, workspaceGroups, nodeStatuses]
  );

  const tree = useMemo(() => applyLens(derived, lens), [derived, lens]);

  // The Views selector is part of the sidebar header chrome: it renders in EVERY
  // state (loading, empty, content) so switching lenses is always available,
  // even when the active lens yields zero nodes.
  const selector = <LensSelector value={lens} onChange={setLens} />;

  // Loading: the node join is still resolving and there's nothing derived yet.
  if (isLoading && repos.length === 0 && sessions.length === 0) {
    return (
      <div className="view-spine-tree">
        {selector}
        <div className="view-spine-scroll">
          <ul className="session-list">
            <li className="session-row loading">
              <div className="session-row-primary">
                <span className="session-name">
                  <CipherText text="deriving view…" loading />
                </span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    );
  }

  const hasContent =
    tree.workspaces.some((ws) => ws.projects.length > 0) ||
    tree.ungroupedProjects.length > 0 ||
    tree.freeLane.length > 0;

  if (!hasContent) {
    return (
      <div className="view-spine-tree">
        {selector}
        <div className="view-spine-scroll">
          <div className="sidebar-empty-state">
            <span>
              {isError ? 'node status unavailable' : 'nothing to show'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view-spine-tree">
      {selector}
      <div className="view-spine-scroll">
        {tree.workspaces.map((ws) =>
          ws.projects.length > 0 ? (
            <section key={ws.id} className="view-spine-workspace">
              <div className="sidebar-ungrouped-label">{ws.name}</div>
              {ws.projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  onCreateTab={onCreateTab}
                />
              ))}
            </section>
          ) : null
        )}

        {tree.ungroupedProjects.length > 0 ? (
          <section className="view-spine-workspace">
            {tree.workspaces.some((ws) => ws.projects.length > 0) ? (
              <div className="sidebar-ungrouped-label">ungrouped</div>
            ) : null}
            {tree.ungroupedProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onCreateTab={onCreateTab}
              />
            ))}
          </section>
        ) : null}

        {tree.freeLane.length > 0 ? (
          <section className="view-spine-free-lane">
            <div className="sidebar-ungrouped-label">free / remote</div>
            <ul className="session-list">
              {tree.freeLane.map((entry) => (
                <FreeRow key={entry.key} entry={entry} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default ViewSpineTree;
