// Flag-gated six-layer navigation surface over projects, instances, benches,
// and tabs. It combines derived repo/session state with persisted Workspace and
// Bench overlays while keeping git-specific actions anchored to their existing
// repo/worktree contracts.
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { fetchHubNodes } from '../lib/api.js';
import { deriveColor } from '../lib/colors.js';
import { MarqueeText } from './MarqueeText.js';
import { CipherText } from './CipherText.js';
import { SessionIndicator } from './SessionIndicator.js';
import {
  applyLens,
  applyPins,
  applyPinsToGrouped,
  benchCreatePayload,
  buildViewTree,
  groupBenchOverlaysByInstance,
  groupProjectsByWorkspace,
  mergeInstanceBenches,
  type BenchCreatePayload,
  type BenchOverlayInput,
  type InstanceHostStatus,
  type MergedBench,
  type SavedView,
  type ViewLens,
  type ViewTreeAttention,
  type ViewTreeFreeEntry,
  type ViewTreeInstance,
  type ViewTreeProject,
  type ViewTreeNodeStatus,
  type ViewTreeTabLeaf,
} from '../lib/state/view-tree.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useIaWorkspaces } from '../lib/hooks/use-ia-workspaces.js';
import {
  useIaBenchesAll,
  useIaBenchMutations,
} from '../lib/hooks/use-ia-benches.js';
import { WorkspaceBar } from './WorkspaceBar.js';
import { BenchCreate } from './BenchCreate.js';
import { createLogger } from '../lib/logger.js';
import './ViewSpineTree.css';

const logger = createLogger('view-spine-tree');

function benchErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Create a Tab anchored to a Bench's (nodeId, cwd). Wired to App's node-aware
 *  session-create entrypoint; separate from git worktree creation. */
export type ViewSpineCreateTab = (payload: BenchCreatePayload) => void;

/** Focus/select an individual Tab using the scoped session key that App already
 *  routes through its active-session action. */
export type ViewSpineSelectTab = (selectKey: string) => void;

/** Persisted pin state + toggle handed to a row. */
export interface PinControls {
  isPinned: (id: string) => boolean;
  toggle: (id: string) => void;
}

// View lens order is also the visual + arrow-key order.
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

// Pin/favorite toggle. A tiny icon button (★ pinned / ☆ unpinned) reusing
// the muted-icon affordance language already used by the bench delete/chevron —
// no new color tokens. Pinned items float to the top of their parent via the
// pure `applyPins` re-order. Keyboard-accessible (real button) + ≥44px touch via
// `.view-spine-pin-btn` CSS. Stops propagation so it never triggers a row action.
function PinButton({
  pinned,
  label,
  onToggle,
}: {
  pinned: boolean;
  /** Human label for the accessible name (e.g. the project/bench/workspace name). */
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={['view-spine-pin-btn', pinned && 'pinned']
        .filter(Boolean)
        .join(' ')}
      aria-pressed={pinned}
      aria-label={pinned ? `unpin ${label}` : `pin ${label}`}
      title={pinned ? 'unpin' : 'pin to top'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {pinned ? '★' : '☆'}
    </button>
  );
}

// Bubbled attention badge. Rendered on a Bench/Instance/Project when any
// descendant Tab needs attention; null when none, so quiet nodes stay quiet.
function AttentionBadge({ attention }: { attention: ViewTreeAttention }) {
  if (!attention.state || attention.count <= 0) return null;
  return (
    <span
      className="repo-attention-badge"
      title={`${attention.count} tab(s) need attention`}
    >
      <SessionIndicator state={attention.state} />
      {attention.count}
    </span>
  );
}

// Individual Tab (session) leaf. Click/keyboard activation focuses that Tab via
// App's active-session action. Indented one level below its Bench.
function TabLeafRow({
  leaf,
  onSelectTab,
}: {
  leaf: ViewTreeTabLeaf;
  onSelectTab?: ViewSpineSelectTab | undefined;
}) {
  const selectable = !!onSelectTab;
  const activate = () => {
    if (onSelectTab) onSelectTab(leaf.selectKey);
  };
  return (
    <li
      className={[
        'session-row view-spine-tab-leaf',
        `state-${leaf.state}`,
        leaf.attention && 'attention',
        selectable && 'selectable',
      ]
        .filter(Boolean)
        .join(' ')}
      data-track="view-spine.tab.click"
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-label={selectable ? `focus tab ${leaf.label}` : undefined}
      onClick={selectable ? activate : undefined}
      onKeyDown={
        selectable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }
          : undefined
      }
    >
      <div className="session-row-primary">
        <SessionIndicator state={leaf.state} />
        <span
          className={['session-name', leaf.attention && 'bold']
            .filter(Boolean)
            .join(' ')}
        >
          <MarqueeText>{leaf.label}</MarqueeText>
        </span>
      </div>
      {leaf.branch ? (
        <div className="session-row-secondary">
          <span className="secondary-branch">
            <MarqueeText>{leaf.branch}</MarqueeText>
          </span>
        </div>
      ) : null}
    </li>
  );
}

// #773: one row per cwd, fusing a derived worktree bench with a persisted
// overlay sharing that cwd. Renders the union: branch + tab count + "+ tab"
// (when a derived worktree backs it), env badge + delete (when an overlay backs
// it), and the verbatim cwd secondary line for overlay-backed rows.
// #739: a Bench with tabs is now expand/collapsible, listing its individual Tabs
// as selectable leaves; per-tab attention bubbles up via `AttentionBadge`.
function BenchRow({
  instance,
  merged,
  busy,
  onCreateTab,
  onSelectTab,
  onDeleteOverlay,
  pins,
}: {
  instance: ViewTreeInstance;
  merged: MergedBench;
  /** Overlay delete in flight (disables this row's delete affordance). */
  busy: boolean;
  onCreateTab?: ViewSpineCreateTab | undefined;
  /** #739: focus/select an individual Tab leaf. */
  onSelectTab?: ViewSpineSelectTab | undefined;
  /** Delete the persisted overlay backing this row. Only invoked when
   *  `merged.overlayId` is set. */
  onDeleteOverlay: (overlayId: string) => void;
  /** #738: pin state + toggle for the BenchId backing this row. */
  pins: PinControls;
}) {
  const { bench } = merged;
  // #739: the individual Tab leaves under this bench (empty for an overlay-only
  // row with no derived worktree → no sessions). Default expanded so attention
  // tabs are visible without an extra click; collapsible to reduce noise.
  const leaves = bench?.tab.leaves ?? [];
  const hasLeaves = leaves.length > 0;
  const [expanded, setExpanded] = useState(true);
  // Per-bench in-flight guard so the affordance disables itself (and other
  // benches stay clickable) while a create is pending. Errors surface through
  // the existing create path's toast — no bespoke error UI here.
  const [creating, setCreating] = useState(false);
  // Resolve the create payload up front. `null` for a non-git/directory bench
  // OR an overlay-only row (no derived worktree → no config.repos anchor), which
  // withholds the "+ tab" affordance entirely. Memoized so the render decision
  // and the click handler agree.
  const createPayload = useMemo(
    () => (bench ? benchCreatePayload(instance, bench) : null),
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

  const envCount = Object.keys(merged.envOverrides).length;
  const isOverlay = merged.overlayId !== null;
  const showBranch = bench?.isGit && bench.branch;
  // The verbatim cwd line is shown for overlay-backed rows (so the user sees the
  // raw absolute path they entered, C1). A derived-only git row shows its branch
  // instead (no cwd leak beyond the existing #731 behaviour).
  const showCwd = isOverlay;

  return (
    <li
      className={[
        'session-row inactive state-inactive view-spine-bench',
        isOverlay && 'bench-overlay-row',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="session-row-primary">
        {/* #739: collapse/expand toggle — only when this bench has Tab leaves.
            Keyboard-accessible (real button), stops propagation so it never
            triggers a row-level action. */}
        {hasLeaves ? (
          <button
            type="button"
            className={['collapse-chevron', !expanded && 'collapsed']
              .filter(Boolean)
              .join(' ')}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `collapse tabs for ${merged.label}`
                : `expand tabs for ${merged.label}`
            }
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? '⌄' : '›'}
          </button>
        ) : null}
        <span className="session-name">
          <MarqueeText>{merged.label}</MarqueeText>
        </span>
        {bench ? <CountBadge count={bench.tab.count} /> : null}
        {/* #739: attention bubbles up from the bench's tabs (shown when collapsed
            OR expanded — the badge is the at-a-glance summary). */}
        {bench ? <AttentionBadge attention={bench.attention} /> : null}
        {/* #738: pin/favorite this Bench (only derived benches carry a stable
            BenchId; overlay-only rows have no pinnable id). */}
        {bench ? (
          <PinButton
            pinned={pins.isPinned(bench.id)}
            label={merged.label}
            onToggle={() => pins.toggle(bench.id)}
          />
        ) : null}
        {envCount > 0 ? (
          <span
            className="bench-overlay-env-badge"
            title={`${envCount} env override(s)`}
          >
            env {envCount}
          </span>
        ) : null}
        {isOverlay ? (
          <button
            type="button"
            className="bench-overlay-delete"
            disabled={busy}
            onClick={() =>
              merged.overlayId && onDeleteOverlay(merged.overlayId)
            }
            aria-label={`delete bench ${merged.label}`}
            title="delete bench"
          >
            ×
          </button>
        ) : null}
      </div>
      {/* `.secondary-branch` is rendered ONLY for git benches. Directory
          benches omit the element entirely (no branch leakage). */}
      {showBranch ? (
        <div className="session-row-secondary">
          <span className="secondary-branch">
            <MarqueeText>{bench!.branch}</MarqueeText>
          </span>
        </div>
      ) : null}
      {/* cwd shown verbatim for overlay-backed rows — the raw absolute path,
          never decoded (C1). */}
      {showCwd ? (
        <div className="session-row-secondary">
          <span className="bench-overlay-cwd">
            <MarqueeText>{merged.cwd}</MarqueeText>
          </span>
        </div>
      ) : null}
      {/* #739: individual Tab leaves, indented one level below the bench. Each
          is a selectable row that focuses the session via the existing
          active-session action. Hidden when collapsed. */}
      {hasLeaves && expanded ? (
        <ul className="session-list view-spine-tab-leaf-list">
          {leaves.map((leaf) => (
            <TabLeafRow
              key={leaf.selectKey}
              leaf={leaf}
              onSelectTab={onSelectTab}
            />
          ))}
        </ul>
      ) : null}
      {/* #731 "+ tab" anchored to THIS bench's (nodeId, repoPath, worktree).
          Reuses the `.add-worktree-row`/`.add-worktree-btn` styling ONLY — it
          wires to session/tab CREATION, NOT worktree creation (distinct copy
          `+ tab`). Withheld for non-git/overlay-only benches (no agent-capable
          repo anchor). */}
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

/** Default cwd a "+ bench" form pre-fills for this instance:
 *  - repo-instance: the first git bench's configured parent repo path (a
 *    worktree path under the repo is the canonical bench cwd), so the user only
 *    edits the suffix.
 *  - node-instance: empty (arbitrary absolute cwd — `$HOME`, `/tmp/…`). */
function defaultBenchCwd(
  instance: ViewTreeInstance,
  projectKind: ViewTreeProject['kind']
): string {
  if (projectKind !== 'repo') return '';
  const gitBench = instance.benches.find((b) => b.repoPath);
  return gitBench?.repoPath ?? '';
}

function InstanceRow({
  instance,
  projectKind,
  overlays,
  onCreateTab,
  onSelectTab,
  onRefetchBenches,
  pins,
}: {
  instance: ViewTreeInstance;
  projectKind: ViewTreeProject['kind'];
  /** Persisted bench overlays for THIS instance, pre-grouped from the single
   *  tree-level `GET /hub/ia/benches` (#773 — no per-instance fan-out). */
  overlays: BenchOverlayInput[];
  onCreateTab?: ViewSpineCreateTab | undefined;
  /** #739: focus/select an individual Tab leaf. */
  onSelectTab?: ViewSpineSelectTab | undefined;
  /** Refetch the tree-level bench cache (reconcile after a failed mutation). */
  onRefetchBenches: () => void;
  /** #738: pin state + toggle, threaded down to each bench row. */
  pins: PinControls;
}) {
  // #773: delete lives here (next to the merged row's delete affordance). The
  // create flow stays in `BenchCreate`. Both invalidate the shared bench cache.
  const { deleteMutation } = useIaBenchMutations(instance.id);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // #773: fuse derived worktree benches with persisted overlays by cwd → one row
  // per cwd (overlay preferred, derived branch/tab/anchor inherited).
  const merged = useMemo(
    () => mergeInstanceBenches(instance.benches, overlays),
    [instance.benches, overlays]
  );

  const handleDeleteOverlay = useCallback(
    (overlayId: string) => {
      setDeleteError(null);
      deleteMutation.mutate(overlayId, {
        onError: (err) => {
          logger.warn('delete bench failed', err);
          setDeleteError(benchErrorMessage(err, 'could not delete bench'));
        },
      });
    },
    [deleteMutation]
  );

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
        {/* #739: attention bubbled up from all of this instance's tabs. */}
        <AttentionBadge attention={instance.attention} />
      </div>
      {/* #739: root-anchored Tabs (sessions at the repo root, no worktree) listed
          as selectable leaves directly under the instance. */}
      {instance.rootTab.leaves.length > 0 ? (
        <ul className="session-list view-spine-tab-leaf-list">
          {instance.rootTab.leaves.map((leaf) => (
            <TabLeafRow
              key={leaf.selectKey}
              leaf={leaf}
              onSelectTab={onSelectTab}
            />
          ))}
        </ul>
      ) : null}
      {merged.length > 0 ? (
        <ul className="session-list view-spine-bench-list">
          {merged.map((row) => (
            <BenchRow
              key={row.cwd}
              instance={instance}
              merged={row}
              busy={deleteMutation.isPending}
              onCreateTab={onCreateTab}
              onSelectTab={onSelectTab}
              onDeleteOverlay={handleDeleteOverlay}
              pins={pins}
            />
          ))}
        </ul>
      ) : null}
      {deleteError ? (
        <div className="bench-create-error" role="alert">
          <span>{deleteError}</span>
          <button
            type="button"
            className="bench-create-retry"
            onClick={() => {
              setDeleteError(null);
              onRefetchBenches();
            }}
          >
            retry
          </button>
        </div>
      ) : null}
      {/* #730 "+ bench": persisted bench overlays (cwd + env) for this instance
          plus the create flow. Wired to the #735 `/hub/ia/benches` CRUD API. */}
      <BenchCreate
        instanceId={instance.id}
        projectKind={projectKind}
        defaultCwd={defaultBenchCwd(instance, projectKind)}
        onRefetch={onRefetchBenches}
      />
    </li>
  );
}

/** Per-project "move to workspace" control. Lists the persisted workspaces plus
 *  an "ungrouped" option; selecting one PATCHes membership (#733). Withheld when
 *  no `assign` handler is supplied (read-only render). */
export interface ProjectAssignControl {
  /** Persisted workspace options (id + label), in display order. */
  options: ReadonlyArray<{ id: string; name: string }>;
  /** The workspace id currently owning this project, or '' for ungrouped. */
  currentWorkspaceId: string;
  /** Move the project to the given workspace id, or '' to ungroup. */
  onAssign: (workspaceId: string) => void;
  /** Disable while a workspace mutation is in flight. */
  busy: boolean;
}

function ProjectAssignSelect({
  project,
  assign,
}: {
  project: ViewTreeProject;
  assign: ProjectAssignControl;
}) {
  return (
    <select
      className="workspace-bar__assign"
      value={assign.currentWorkspaceId}
      disabled={assign.busy}
      aria-label={`assign ${project.label} to a workspace`}
      title="move to workspace"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        assign.onAssign(e.currentTarget.value);
      }}
    >
      <option value="">ungrouped</option>
      {assign.options.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.name}
        </option>
      ))}
    </select>
  );
}

function ProjectRow({
  project,
  overlaysByInstance,
  onCreateTab,
  onSelectTab,
  onRefetchBenches,
  assign,
  pins,
}: {
  project: ViewTreeProject;
  /** Persisted bench overlays grouped by instanceId (#773 single query). */
  overlaysByInstance: Map<string, BenchOverlayInput[]>;
  onCreateTab?: ViewSpineCreateTab | undefined;
  /** #739: focus/select an individual Tab leaf. */
  onSelectTab?: ViewSpineSelectTab | undefined;
  onRefetchBenches: () => void;
  assign?: ProjectAssignControl | undefined;
  /** #738: pin state + toggle for this Project + its descendant benches. */
  pins: PinControls;
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
          {/* #739: attention bubbled up from every Tab in this project. */}
          <AttentionBadge attention={project.attention} />
          {/* #738: pin/favorite this Project — floats it to the top of its
              parent (workspace group or the ungrouped lane). */}
          <PinButton
            pinned={pins.isPinned(project.id)}
            label={project.label}
            onToggle={() => pins.toggle(project.id)}
          />
        </div>
        {assign ? (
          <ProjectAssignSelect project={project} assign={assign} />
        ) : null}
      </div>
      <ul className="session-list">
        {project.instances.map((instance) => (
          <InstanceRow
            key={instance.id}
            instance={instance}
            projectKind={project.kind}
            overlays={overlaysByInstance.get(instance.id) ?? []}
            onCreateTab={onCreateTab}
            onSelectTab={onSelectTab}
            onRefetchBenches={onRefetchBenches}
            pins={pins}
          />
        ))}
      </ul>
      <div className="repo-divider" />
    </div>
  );
}

// Reduced-anatomy row: structurally omits `.initial-block` AND
// `.secondary-branch` JSX so repo-identity/branch leakage is impossible by
// construction for repoPath-less (free/remote) sessions. #739: its Tab leaves are
// selectable too (branch-less by construction) and attention bubbles up here.
function FreeRow({
  entry,
  onSelectTab,
}: {
  entry: ViewTreeFreeEntry;
  onSelectTab?: ViewSpineSelectTab | undefined;
}) {
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
        <AttentionBadge attention={entry.attention} />
      </div>
      {entry.tab.leaves.length > 0 ? (
        <ul className="session-list view-spine-tab-leaf-list">
          {entry.tab.leaves.map((leaf) => (
            <TabLeafRow
              key={leaf.selectKey}
              leaf={leaf}
              onSelectTab={onSelectTab}
            />
          ))}
        </ul>
      ) : null}
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

// #738: saved/named Views. Lists the user's saved Views as selectable chips
// (apply on click, × to delete) alongside a "+ save view" affordance that names
// the CURRENT lens. Reuses the `.view-lens__tab` chip language + the bench
// delete/create input primitives — no new visual chrome. Empty state: just the
// save affordance (no chips), so a fresh user sees a clean control. The name
// input validates non-empty (trimmed) before save is enabled.
function SavedViewsBar({
  savedViews,
  onApply,
  onDelete,
  onSave,
}: {
  savedViews: readonly SavedView[];
  onApply: (id: string) => void;
  onDelete: (id: string) => void;
  onSave: (name: string) => SavedView | null;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const canSave = trimmed.length > 0;

  const commit = () => {
    if (!canSave) return;
    onSave(trimmed);
    setName('');
    setNaming(false);
  };
  const cancel = () => {
    setName('');
    setNaming(false);
  };

  return (
    <div
      className="view-spine-saved-views"
      role="group"
      aria-label="saved views"
    >
      {savedViews.map((view) => (
        <span key={view.id} className="view-spine-saved-view">
          <button
            type="button"
            className="view-spine-saved-view__apply"
            onClick={() => onApply(view.id)}
            title={`apply view: ${view.name}`}
          >
            {view.name}
          </button>
          <button
            type="button"
            className="view-spine-saved-view__delete"
            onClick={() => onDelete(view.id)}
            aria-label={`delete view ${view.name}`}
            title="delete view"
          >
            ×
          </button>
        </span>
      ))}
      {naming ? (
        <span className="view-spine-saved-view-form">
          <input
            type="text"
            className="view-spine-saved-view-input"
            value={name}
            autoFocus
            placeholder="view name"
            aria-label="new view name"
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
          />
          <button
            type="button"
            className="view-spine-saved-view__save"
            disabled={!canSave}
            onClick={commit}
            aria-label="save view"
          >
            save
          </button>
          <button
            type="button"
            className="view-spine-saved-view__cancel"
            onClick={cancel}
            aria-label="cancel save view"
          >
            ×
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="view-spine-saved-view__new"
          onClick={() => setNaming(true)}
        >
          + save view
        </button>
      )}
    </div>
  );
}

export function ViewSpineTree({
  onCreateTab,
  onSelectTab,
}: {
  /** #731: create a Tab anchored to a Bench's (nodeId, cwd). Read-only when
   *  omitted — the "+ tab" affordance only renders when this is provided. */
  onCreateTab?: ViewSpineCreateTab | undefined;
  /** #739: focus/select an individual Tab leaf. Leaves render as static rows
   *  when omitted (read-only); the click action only fires when provided. */
  onSelectTab?: ViewSpineSelectTab | undefined;
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

  // #738: lens, pins, and saved Views are now PERSISTED (localStorage via the ui
  // store) — restored on mount, instead of the #727 in-memory ephemeral lens.
  const lens = useUiStore((s) => s.viewSpineLens);
  const setLens = useUiStore((s) => s.setViewSpineLens);
  const pinnedIds = useUiStore((s) => s.viewSpinePins);
  const togglePin = useUiStore((s) => s.toggleViewSpinePin);
  const savedViews = useUiStore((s) => s.viewSpineSavedViews);
  const saveView = useUiStore((s) => s.saveViewSpineView);
  const deleteView = useUiStore((s) => s.deleteViewSpineView);
  const applySavedView = useUiStore((s) => s.applyViewSpineSavedView);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);

  const pins: PinControls = useMemo(
    () => ({
      isPinned: (id: string) => pinnedIds.has(id),
      toggle: (id: string) => togglePin(id),
    }),
    [pinnedIds, togglePin]
  );

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

  // Lens first (filter/sort), then pins (pinned items float to top of parent).
  const tree = useMemo(
    () => applyPins(applyLens(derived, lens), pinnedIds),
    [derived, lens, pinnedIds]
  );

  // #773: ONE unfiltered `GET /hub/ia/benches` for the whole tree (no
  // per-instance fan-out), grouped by instanceId client-side and passed down to
  // each `InstanceRow`. Reconcile on a failed bench mutation via `refetch`.
  const { data: allBenches, refetch: refetchBenches } = useIaBenchesAll();
  const overlaysByInstance = useMemo(
    () =>
      groupBenchOverlaysByInstance((allBenches ?? []) as BenchOverlayInput[]),
    [allBenches]
  );
  const onRefetchBenches = useCallback(() => {
    void refetchBenches();
  }, [refetchBenches]);

  // #728: the persisted six-layer Workspace layer (#733 CRUD). The bar manages
  // workspace lifecycle; here we OVERLAY persisted membership on the derived
  // tree. All derived projects (from the legacy workspace groups + the legacy
  // ungrouped lane) are flattened — preserving the lens-applied order — and
  // RE-grouped by persisted `projectIds`. Unassigned projects fall back to
  // ungrouped. NO legacy auto-import: the legacy `workspaceGroups` grouping is
  // collapsed away for render, never migrated into persisted Workspaces.
  const {
    workspaces: persistedWorkspaces,
    updateMutation,
    refetch: refetchWorkspaces,
  } = useIaWorkspaces();
  // #752: a project-assign sequences TWO PATCHes (remove from source, append to
  // target). They're not individually optimistic, so guard the whole sequence
  // with one in-flight flag and reconcile via a single refetch at the end. A
  // separate flag (not `updateMutation.isPending`) keeps the controls disabled
  // across BOTH awaited PATCHes, not just whichever is currently in flight.
  const [assignInFlight, setAssignInFlight] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const assignBusy = updateMutation.isPending || assignInFlight;

  const flatProjects = useMemo(
    () => [
      ...tree.workspaces.flatMap((ws) => ws.projects),
      ...tree.ungroupedProjects,
    ],
    [tree]
  );

  // #738: re-rank pinned Workspaces + Projects AFTER persisted grouping (which
  // sorts by `order`/membership and would otherwise clobber the pinned-first
  // rank). Bench pins already rode in via `applyPins` on the raw tree.
  const grouped = useMemo(
    () =>
      applyPinsToGrouped(
        groupProjectsByWorkspace(flatProjects, persistedWorkspaces),
        pinnedIds
      ),
    [flatProjects, persistedWorkspaces, pinnedIds]
  );

  const visibleGrouped = useMemo(() => {
    if (!activeWorkspaceId) return grouped;
    const match = grouped.workspaces.find((ws) => ws.id === activeWorkspaceId);
    return {
      workspaces: match ? [match] : [],
      ungroupedProjects: [],
    };
  }, [grouped, activeWorkspaceId]);

  // The workspace each project currently belongs to (first claimant by order),
  // so the per-project assign control can show the right selection.
  const workspaceIdByProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of grouped.workspaces) {
      for (const project of ws.projects) {
        if (!map.has(project.id)) map.set(project.id, ws.id);
      }
    }
    return map;
  }, [grouped]);

  const assignOptions = useMemo(
    () =>
      [...persistedWorkspaces]
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((ws) => ({ id: ws.id, name: ws.name })),
    [persistedWorkspaces]
  );

  // #752: Move a project into `targetWorkspaceId` (or '' to ungroup). This is a
  // SEQUENCED two-PATCH op: remove the project from its current owner, then
  // append it to the target. The PATCHes are awaited in order via `mutateAsync`
  // with a SINGLE guarded refetch at the end — never per-mutation invalidation
  // (which could refetch between the two PATCHes and flicker, or drop/duplicate
  // the project mid-sequence). On partial failure we surface a clear error AND
  // refetch to reconcile, so a moved project never silently desyncs.
  const assignProjectTo = useCallback(
    async (projectId: string, targetWorkspaceId: string) => {
      const currentId = workspaceIdByProject.get(projectId) ?? '';
      if (currentId === targetWorkspaceId) return;
      if (assignInFlight) return;
      setAssignError(null);
      setAssignInFlight(true);
      try {
        // Remove from the current owner (if any). The membership list is
        // replaced wholesale per the #733 contract.
        if (currentId) {
          const source = persistedWorkspaces.find((w) => w.id === currentId);
          if (source) {
            await updateMutation.mutateAsync({
              id: source.id,
              patch: {
                projectIds: source.projectIds.filter((id) => id !== projectId),
              },
            });
          }
        }
        // Append to the target (if not ungrouping). Guard against dupes.
        if (targetWorkspaceId) {
          const target = persistedWorkspaces.find(
            (w) => w.id === targetWorkspaceId
          );
          if (target && !target.projectIds.includes(projectId)) {
            await updateMutation.mutateAsync({
              id: target.id,
              patch: { projectIds: [...target.projectIds, projectId] },
            });
          }
        }
      } catch (err) {
        logger.warn('assign project to workspace failed', err);
        setAssignError(
          benchErrorMessage(err, 'could not move project to workspace')
        );
      } finally {
        // One refetch reconciles whatever landed (full success OR partial).
        setAssignInFlight(false);
        void refetchWorkspaces();
      }
    },
    [
      persistedWorkspaces,
      updateMutation,
      workspaceIdByProject,
      assignInFlight,
      refetchWorkspaces,
    ]
  );

  const makeAssign = useCallback(
    (project: ViewTreeProject): ProjectAssignControl => ({
      options: assignOptions,
      currentWorkspaceId: workspaceIdByProject.get(project.id) ?? '',
      onAssign: (workspaceId) => void assignProjectTo(project.id, workspaceId),
      busy: assignBusy,
    }),
    [assignOptions, workspaceIdByProject, assignProjectTo, assignBusy]
  );

  // The Views selector is part of the sidebar header chrome: it renders in EVERY
  // state (loading, empty, content) so switching lenses is always available,
  // even when the active lens yields zero nodes. #738: the built-in lenses are
  // joined by the user's saved Views + a "save current as View" affordance.
  const selector = (
    <div className="view-spine-views">
      <LensSelector value={lens} onChange={setLens} />
      <SavedViewsBar
        savedViews={savedViews}
        onApply={applySavedView}
        onDelete={deleteView}
        onSave={(name) => saveView(name)}
      />
    </div>
  );

  // Loading: the node join is still resolving and there's nothing derived yet.
  if (isLoading && repos.length === 0 && sessions.length === 0) {
    return (
      <div className="view-spine-tree">
        {selector}
        <WorkspaceBar />
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

  const hasGroupedContent =
    visibleGrouped.workspaces.some((ws) => ws.projects.length > 0) ||
    visibleGrouped.ungroupedProjects.length > 0;
  const hasContent =
    hasGroupedContent || (!activeWorkspaceId && tree.freeLane.length > 0);

  if (!hasContent) {
    return (
      <div className="view-spine-tree">
        {selector}
        <WorkspaceBar />
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

  const hasPersistedGroups = visibleGrouped.workspaces.some(
    (ws) => ws.projects.length > 0
  );

  return (
    <div className="view-spine-tree">
      {selector}
      <WorkspaceBar />
      <div className="view-spine-scroll">
        {assignError ? (
          <div className="bench-create-error" role="alert">
            <span>{assignError}</span>
            <button
              type="button"
              className="bench-create-retry"
              onClick={() => {
                setAssignError(null);
                void refetchWorkspaces();
              }}
            >
              retry
            </button>
          </div>
        ) : null}
        {visibleGrouped.workspaces.map((ws) =>
          ws.projects.length > 0 ? (
            <section key={ws.id} className="view-spine-workspace">
              <div className="sidebar-ungrouped-label view-spine-workspace-label">
                <span>{ws.name}</span>
                {/* #738: pin/favorite this Workspace — floats the whole group to
                    the top of the workspace list. */}
                <PinButton
                  pinned={pins.isPinned(ws.id)}
                  label={ws.name}
                  onToggle={() => pins.toggle(ws.id)}
                />
              </div>
              {ws.projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  overlaysByInstance={overlaysByInstance}
                  onCreateTab={onCreateTab}
                  onSelectTab={onSelectTab}
                  onRefetchBenches={onRefetchBenches}
                  assign={makeAssign(project)}
                  pins={pins}
                />
              ))}
            </section>
          ) : null
        )}

        {visibleGrouped.ungroupedProjects.length > 0 ? (
          <section className="view-spine-workspace">
            {hasPersistedGroups ? (
              <div className="sidebar-ungrouped-label">ungrouped</div>
            ) : null}
            {visibleGrouped.ungroupedProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                overlaysByInstance={overlaysByInstance}
                onCreateTab={onCreateTab}
                onSelectTab={onSelectTab}
                onRefetchBenches={onRefetchBenches}
                assign={makeAssign(project)}
                pins={pins}
              />
            ))}
          </section>
        ) : null}

        {!activeWorkspaceId && tree.freeLane.length > 0 ? (
          <section className="view-spine-free-lane">
            <div className="sidebar-ungrouped-label">free / remote</div>
            <ul className="session-list">
              {tree.freeLane.map((entry) => (
                <FreeRow
                  key={entry.key}
                  entry={entry}
                  onSelectTab={onSelectTab}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default ViewSpineTree;
