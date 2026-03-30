import type { SessionSummary, WorktreeInfo, Repo, SidebarItem } from '../types.js';
import type { BackendDisplayState, DisplayState } from './display-state.js';
import { transitionDisplayState } from './display-state.js';
import { sortByAttention } from './attention.js';

/**
 * Derive a BackendDisplayState from a session's agentState and idle flag.
 * Priority order (highest first): permission > error > running > initializing > idle
 *
 * Mirrors server/sessions.ts computeBackendState — keep in sync.
 * The idle flag is a fallback for sessions without a defined agentState.
 */
function sessionToBackendState(session: SessionSummary): BackendDisplayState {
  const { agentState, idle } = session;
  if (agentState === 'permission-prompt') return 'permission';
  if (agentState === 'error') return 'error';
  if (agentState === 'processing') return 'running';
  if (agentState === 'initializing') return 'initializing';
  // For sessions without agentState (e.g. terminal sessions), fall back to the idle timer flag
  if (!agentState && !idle) return 'running';
  return 'idle';
}

/**
 * Given an array of sessions that belong to the same sidebar item, derive the
 * aggregate BackendDisplayState (highest-priority state wins).
 *
 * Priority order (highest first): permission > error > running > initializing > idle
 */
function deriveBackendState(sessions: SessionSummary[]): BackendDisplayState {
  const priority: Record<BackendDisplayState, number> = {
    permission: 4,
    error: 3,
    running: 2,
    initializing: 1,
    idle: 0,
  };

  let best: BackendDisplayState = 'idle';
  for (const session of sessions) {
    const state = sessionToBackendState(session);
    if (priority[state] > priority[best]) {
      best = state;
    }
  }
  return best;
}

/**
 * Derive the initial DisplayState for a brand-new item (no existing item to
 * reconcile against).
 */
function initialDisplayState(sessions: SessionSummary[]): DisplayState {
  if (sessions.length === 0) return 'inactive';
  switch (deriveBackendState(sessions)) {
    case 'permission':   return 'permission';
    case 'error':        return 'error';
    case 'running':      return 'running';
    case 'initializing': return 'initializing';
    case 'idle':
    default:
      // Safe default on initial load — don't spam notifications for already-idle sessions
      return 'seen-idle';
  }
}

/**
 * Find the most recent lastActivity timestamp across an array of sessions.
 */
function mostRecentActivity(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return '';
  return sessions.reduce((best, s) => (s.lastActivity > best ? s.lastActivity : best), sessions[0]!.lastActivity);
}

/**
 * Build the full list of SidebarItems from current server data, reconciling
 * displayState against the existing items map to preserve user-facing state.
 */
export function buildSidebarItems(
  sessions: SessionSummary[],
  worktrees: WorktreeInfo[],
  workspaces: Repo[],
  existingItems: SidebarItem[],
  checkUnread?: (id: string) => boolean,
): SidebarItem[] {
  // Build lookup from id → existing item for O(1) reconciliation
  const existingById = new Map<string, SidebarItem>();
  for (const item of existingItems) {
    existingById.set(item.id, item);
  }

  // Group sessions by their "group path" (worktreePath ?? repoPath)
  const sessionsByGroup = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const groupPath = session.worktreePath ?? session.repoPath;
    const existing = sessionsByGroup.get(groupPath);
    if (existing) {
      existing.push(session);
    } else {
      sessionsByGroup.set(groupPath, [session]);
    }
  }

  // Track which group paths have been handled so we can detect orphan groups
  const handledGroupPaths = new Set<string>();

  const result: SidebarItem[] = [];

  // --- Process each workspace ---
  for (const workspace of workspaces) {
    // Collect group paths that belong to this workspace
    const workspaceGroupPaths: string[] = [];
    for (const [groupPath] of sessionsByGroup) {
      if (groupPath === workspace.path || groupPath.startsWith(workspace.path + '/')) {
        workspaceGroupPaths.push(groupPath);
        handledGroupPaths.add(groupPath);
      }
    }

    // For each group path with sessions, build a SidebarItem
    const coveredPaths = new Set<string>();
    for (const groupPath of workspaceGroupPaths) {
      const groupSessions = sessionsByGroup.get(groupPath) ?? [];
      const firstSession = groupSessions[0];
      if (!firstSession) continue;
      const kind: 'repo' | 'worktree' = groupPath === workspace.path ? 'repo' : 'worktree';

      const newBackendState = deriveBackendState(groupSessions);
      const displayState = reconcileDisplayState(existingById.get(groupPath), newBackendState, groupSessions);

      result.push({
        id: groupPath,
        kind,
        path: groupPath,
        repoPath: workspace.path,
        displayName: firstSession.displayName,
        branchName: firstSession.branchName,
        lastActivity: mostRecentActivity(groupSessions),
        displayState,
        lastKnownBackendState: newBackendState,
        sessions: groupSessions,
        isUnread: existingById.get(groupPath)?.isUnread ?? checkUnread?.(groupPath) ?? false,
      });
      coveredPaths.add(groupPath);
    }

    // Add inactive worktrees (those whose path has no active sessions)
    for (const worktree of worktrees) {
      if (worktree.repoPath !== workspace.path) continue;
      if (coveredPaths.has(worktree.path)) continue;

      result.push({
        id: worktree.path,
        kind: 'worktree',
        path: worktree.path,
        repoPath: worktree.repoPath,
        displayName: worktree.displayName,
        branchName: worktree.branchName,
        lastActivity: worktree.lastActivity,
        displayState: reconcileDisplayState(existingById.get(worktree.path), null, []),
        lastKnownBackendState: null,
        sessions: [],
        isUnread: existingById.get(worktree.path)?.isUnread ?? checkUnread?.(worktree.path) ?? false,
      });
      coveredPaths.add(worktree.path);
    }

    // If no sessions at workspace root and the workspace root was not covered by
    // any group path, add the repo root as inactive
    if (!coveredPaths.has(workspace.path)) {
      result.push({
        id: workspace.path,
        kind: 'repo',
        path: workspace.path,
        repoPath: workspace.path,
        displayName: workspace.name,
        branchName: workspace.defaultBranch ?? '',
        lastActivity: '',
        displayState: reconcileDisplayState(existingById.get(workspace.path), null, []),
        lastKnownBackendState: null,
        sessions: [],
        isUnread: existingById.get(workspace.path)?.isUnread ?? checkUnread?.(workspace.path) ?? false,
      });
    }
  }

  // --- Handle any session groups not belonging to any known workspace ---
  // (edge case: sessions for paths outside configured workspaces)
  for (const [groupPath, groupSessions] of sessionsByGroup) {
    if (handledGroupPaths.has(groupPath)) continue;
    const firstSession = groupSessions[0];
    if (!firstSession) continue;
    const newBackendState = deriveBackendState(groupSessions);

    result.push({
      id: groupPath,
      kind: 'worktree',
      path: groupPath,
      repoPath: firstSession.repoPath,
      displayName: firstSession.displayName,
      branchName: firstSession.branchName,
      lastActivity: mostRecentActivity(groupSessions),
      displayState: reconcileDisplayState(existingById.get(groupPath), newBackendState, groupSessions),
      lastKnownBackendState: newBackendState,
      sessions: groupSessions,
      isUnread: existingById.get(groupPath)?.isUnread ?? checkUnread?.(groupPath) ?? false,
    });
  }

  return sortByAttention(result);
}

/**
 * Reconcile displayState from an existing item and a newly computed backend state.
 *
 * - No sessions (inactive): always 'inactive'
 * - No existing item: derive initial state
 * - Existing item, same backend state: preserve existing displayState
 * - Existing item, different backend state: apply transition
 */
function reconcileDisplayState(
  existing: SidebarItem | undefined,
  newBackendState: BackendDisplayState | null,
  sessions: SessionSummary[],
): DisplayState {
  // No sessions → always inactive regardless of history
  if (sessions.length === 0) return 'inactive';

  if (!existing || existing.displayState === 'inactive') return initialDisplayState(sessions);

  // Backend state unchanged — preserve the existing display state
  if (existing.lastKnownBackendState === newBackendState) return existing.displayState;

  // Backend state changed — apply transition
  if (newBackendState) {
    // Preserve needs-answer: reconciliation doesn't have permissionType, so
    // transitionDisplayState would downgrade needs-answer → permission.
    if (newBackendState === 'permission' && existing.displayState === 'needs-answer') {
      return 'needs-answer';
    }
    return transitionDisplayState(existing.displayState, { type: 'backend-state-changed', state: newBackendState });
  }
  return existing.displayState;
}
