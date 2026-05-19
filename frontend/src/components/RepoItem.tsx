import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  Repo,
  RepoWebhookStatus,
  SessionSummary,
  WorktreeInfo,
  PullRequest,
  SidebarItem,
} from '../lib/types.js';
import {
  isAttentionState,
  type DisplayState,
} from '../lib/state/display-state.js';
import { deriveColor } from '../lib/colors.js';
import { derivePrDotStatus } from '../lib/pr-status.js';
import { formatRelativeTimeCompact, isMobileDevice } from '../lib/utils.js';
import StatusDot from './StatusDot.js';
import { SessionIndicator } from './SessionIndicator.js';
import RepoSourceDot from './RepoSourceDot.js';
import { MarqueeText } from './MarqueeText.js';
import ContextMenu from './ContextMenu.js';
import { useRepoAggregation } from '../hooks/useRepoAggregation.js';
import { createRepoWebhook } from '../lib/api.js';
import { deriveRepoWebhookStatus } from '../lib/repo-source.js';
import { showToast } from '../lib/stores/toasts.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { scopedSessionKey, sessionKeyMatches } from '../lib/session-keys.js';
import { useUiStore } from '../lib/stores/ui.js';
import './RepoItem.css';

const DOUBLE_CLICK_DELAY_MS = 200;
const EMPTY_SET = new Set<string>();
const EMPTY_ARRAY: never[] = [];

export interface RepoItemProps {
  repo: Repo;
  sessionGroups: Map<string, SessionSummary[]>;
  inactiveWorktrees?: WorktreeInfo[];
  isActive: boolean;
  activeSessionId?: string | null;
  onSelectWorkspace: (path: string) => void;
  onSelectSession: (id: string) => void;
  onNewWorktree: (repo: Repo) => void;
  onOpenSettings: (repo?: Repo) => void;
  onDeleteSession?: ((id: string) => void) | undefined;
  onDeleteWorktree?: ((wt: WorktreeInfo) => void) | undefined;
  onResumeWorktree?: ((wt: WorktreeInfo) => void) | undefined;
  onLaunchRepoSession?: ((repoPath: string) => void) | undefined;
  onViewHistory?: ((repoPath: string) => void) | undefined;
  orgPrs?: PullRequest[];
  sidebarItems?: SidebarItem[];
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  loadingItems?: Set<string> | undefined;
}

const settingsSvg = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="square"
    width="14"
    height="14"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51V15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const historySvg = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="square"
    width="14"
    height="14"
  >
    <polyline points="12 8 12 12 16 14" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);

export function groupDisplayName(
  groupPath: string,
  repoPath: string,
  sessions: SessionSummary[]
): string {
  const isRepoRoot = groupPath === repoPath;
  if (isRepoRoot) {
    const repoSession = sessions.find((s) => s.worktreePath === null);
    if (repoSession) {
      const wasRenamed =
        repoSession.displayName &&
        repoSession.displayName !== repoSession.repoName;
      return wasRenamed ? repoSession.displayName : 'default';
    }
    return 'default';
  }
  const renamedSession = sessions.find(
    (s) => s.displayName && s.displayName !== s.repoName
  );
  if (renamedSession) return renamedSession.displayName;
  const branch = sessions.find((s) => s.branchName)?.branchName;
  const cwdName = sessions[0]?.cwd.split('/').pop();
  return branch || cwdName || sessions[0]?.repoName || 'unknown';
}

type FleetStatusTone = 'active' | 'attention' | 'idle' | 'inactive' | 'error';

export interface SidebarFleetStatus {
  label: string;
  tone: FleetStatusTone;
  title: string;
}

const STATUS_LABELS: Record<DisplayState, Omit<SidebarFleetStatus, 'title'>> = {
  initializing: { label: 'starting', tone: 'active' },
  running: { label: 'running', tone: 'active' },
  'unseen-idle': { label: 'done unread', tone: 'attention' },
  'seen-idle': { label: 'idle', tone: 'idle' },
  permission: { label: 'approval needed', tone: 'attention' },
  'needs-answer': { label: 'answer needed', tone: 'attention' },
  error: { label: 'error', tone: 'error' },
  inactive: { label: 'inactive', tone: 'inactive' },
};

function compactStatusText(
  value: string,
  maxLength = 42,
  preserveCase = false
): string {
  const normalizedValue = value.replace(/\s+/g, ' ').trim();
  const normalized = preserveCase
    ? normalizedValue
    : normalizedValue.toLowerCase();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatCurrentActivity(session: SessionSummary): string | null {
  const activity = session.currentActivity;
  if (!activity?.tool) return null;

  const tool = compactStatusText(activity.tool, 18, true);
  const detail = activity.detail
    ? compactStatusText(activity.detail, 32, true)
    : '';
  return detail ? `${tool}: ${detail}` : tool;
}

function findStatusActivity(sessions: SessionSummary[]): string | null {
  const sessionWithActivity = sessions.find(
    (session) => session.currentActivity
  );
  return sessionWithActivity
    ? formatCurrentActivity(sessionWithActivity)
    : null;
}

export function deriveSessionFleetStatus(
  displayState: DisplayState,
  sessions: SessionSummary[]
): SidebarFleetStatus {
  const base = STATUS_LABELS[displayState];
  const activity = findStatusActivity(sessions);
  const shouldShowActivity =
    activity &&
    (displayState === 'running' ||
      displayState === 'initializing' ||
      displayState === 'seen-idle' ||
      displayState === 'unseen-idle');
  const label = shouldShowActivity ? `${base.label} · ${activity}` : base.label;
  return {
    ...base,
    label,
    title: `fleet status: ${label}`,
  };
}

interface PrStatusBadgeProps {
  pr: PullRequest;
}
function PrStatusBadge({ pr }: PrStatusBadgeProps) {
  return (
    <span className="sidebar-pr-status">
      <StatusDot
        status={
          derivePrDotStatus(pr) as
            | 'running'
            | 'idle'
            | 'attention'
            | 'disconnected'
        }
        size={5}
      />
      {pr.ciStatus === 'SUCCESS' ? (
        <span className="ci-pass">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
            width="9"
            height="9"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      ) : pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR' ? (
        <span className="ci-fail">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
            width="9"
            height="9"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      ) : pr.ciStatus === 'PENDING' ? (
        <span className="ci-pending" style={{ fontSize: '9px' }}>
          ●
        </span>
      ) : null}
    </span>
  );
}

interface SessionGroupRowProps {
  groupPath: string;
  groupSessions: SessionSummary[];
  rep: SessionSummary;
  isSelected: boolean;
  attention: boolean;
  dotState: DisplayState;
  matchedPr: PullRequest | undefined;
  cancelLongPress: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession?: ((id: string) => void) | undefined;
  onDeleteWorktree?: ((wt: WorktreeInfo) => void) | undefined;
  onViewHistory?: ((repoPath: string) => void) | undefined;
  repoPath: string;
}

function SessionGroupRow({
  groupPath,
  groupSessions,
  rep,
  isSelected,
  attention,
  dotState,
  matchedPr,
  cancelLongPress,
  onSelectSession,
  onDeleteSession,
  onDeleteWorktree,
  onViewHistory,
  repoPath,
}: SessionGroupRowProps) {
  const fleetStatus = deriveSessionFleetStatus(dotState, groupSessions);

  return (
    <li
      className={[
        'session-row',
        `state-${dotState}`,
        isSelected && 'selected',
        attention && 'attention',
      ]
        .filter(Boolean)
        .join(' ')}
      data-track="sidebar.session.click"
      onClick={() => onSelectSession(scopedSessionKey(rep))}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
    >
      <div className="session-row-primary">
        <SessionIndicator state={dotState} />
        <span
          className={['session-name', attention && 'bold']
            .filter(Boolean)
            .join(' ')}
        >
          <MarqueeText>
            {groupDisplayName(groupPath, repoPath, groupSessions)}
          </MarqueeText>
        </span>
        {groupSessions.length > 1 ? (
          <span className="session-count-badge">{groupSessions.length}</span>
        ) : null}
        {matchedPr ? <PrStatusBadge pr={matchedPr} /> : null}
      </div>
      <div className="session-row-secondary">
        {dotState !== 'running' && dotState !== 'initializing' ? (
          <span
            className={`fleet-status tone-${fleetStatus.tone}`}
            title={fleetStatus.title}
          >
            {fleetStatus.label}
          </span>
        ) : null}
        <span className="secondary-time">
          {formatRelativeTimeCompact(rep.lastActivity)}
        </span>
        {rep.branchName ? (
          <span className="secondary-branch">
            <MarqueeText>{rep.branchName}</MarqueeText>
          </span>
        ) : null}
      </div>
      {onDeleteSession || (onDeleteWorktree && groupPath !== repoPath) ? (
        <div className="row-menu-overlay">
          <ContextMenu
            items={[
              ...(onDeleteSession
                ? [
                    {
                      label: 'close session',
                      action: () => onDeleteSession(rep.id),
                      danger: true,
                    },
                  ]
                : []),
              ...(onDeleteWorktree && groupPath !== repoPath
                ? [
                    {
                      label: 'delete worktree',
                      action: () =>
                        onDeleteWorktree({
                          name: groupPath.split('/').pop() || '',
                          path: groupPath,
                          repoName:
                            rep.repoName ?? repoPath.split('/').pop() ?? repoPath,
                          repoPath,
                          displayName: groupDisplayName(
                            groupPath,
                            repoPath,
                            groupSessions
                          ),
                          lastActivity: rep.lastActivity,
                          branchName: rep.branchName || '',
                        }),
                      danger: true,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      ) : null}
      {onViewHistory ? (
        <button
          className="session-history-btn"
          title="View session history"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewHistory(repoPath);
          }}
        >
          {historySvg}
        </button>
      ) : null}
    </li>
  );
}

interface InactiveRepoRowProps {
  groupPath: string;
  repoPath: string;
  repoCurrentBranch: string | null;
  repoDefaultBranch: string | null;
  webhookStatus: RepoWebhookStatus;
  webhookError?: string | undefined;
  sidebarItemById: Map<string, SidebarItem>;
  loadingItems: Set<string>;
  onWebhookSetup: () => void;
  onWebhookRetry: () => void;
  onLaunchRepoSession?: ((repoPath: string) => void) | undefined;
  onViewHistory?: ((repoPath: string) => void) | undefined;
}

function InactiveRepoRow({
  groupPath,
  repoPath,
  repoCurrentBranch,
  repoDefaultBranch,
  webhookStatus,
  webhookError,
  sidebarItemById,
  loadingItems,
  onWebhookSetup,
  onWebhookRetry,
  onLaunchRepoSession,
  onViewHistory,
}: InactiveRepoRowProps) {
  const repoLoadingKey = `repo-session:${repoPath}`;
  const isLoading = loadingItems.has(repoLoadingKey);
  const rootItem = sidebarItemById.get(groupPath);
  const branchName =
    repoCurrentBranch || rootItem?.branchName || repoDefaultBranch;
  const lastActivity = rootItem?.lastActivity;
  const displayLabel = repoCurrentBranch || 'default';
  return (
    <li
      className={[
        'session-row',
        'inactive',
        isLoading ? 'state-initializing' : 'state-inactive',
        isLoading && 'loading',
      ]
        .filter(Boolean)
        .join(' ')}
      data-track="sidebar.repo.click"
      onClick={() => {
        if (!isLoading) onLaunchRepoSession?.(repoPath);
      }}
    >
      <div className="session-row-primary">
        <span className="repo-source-stack">
          <SessionIndicator state={isLoading ? 'initializing' : 'inactive'} />
          <RepoSourceDot
            status={webhookStatus}
            error={webhookError}
            onManualSetup={onWebhookSetup}
            onRetry={onWebhookRetry}
          />
        </span>
        <span className="session-name">
          <MarqueeText>{isLoading ? 'starting...' : displayLabel}</MarqueeText>
        </span>
      </div>
      <div className="session-row-secondary">
        {!isLoading ? (
          <span
            className="fleet-status tone-inactive"
            title="fleet status: inactive"
          >
            inactive
          </span>
        ) : null}
        {lastActivity ? (
          <span className="secondary-time">
            {formatRelativeTimeCompact(lastActivity)}
          </span>
        ) : (
          <span className="secondary-placeholder" />
        )}
        {branchName ? (
          <span className="secondary-branch">
            <MarqueeText>{branchName}</MarqueeText>
          </span>
        ) : (
          <span className="secondary-placeholder" />
        )}
      </div>
      {onViewHistory ? (
        <button
          className="session-history-btn"
          title="View session history"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewHistory(repoPath);
          }}
        >
          {historySvg}
        </button>
      ) : null}
    </li>
  );
}

export function RepoItem({
  repo,
  sessionGroups,
  inactiveWorktrees = EMPTY_ARRAY,
  isActive,
  activeSessionId = null,
  onSelectWorkspace,
  onSelectSession,
  onNewWorktree,
  onOpenSettings,
  onDeleteSession,
  onDeleteWorktree,
  onResumeWorktree,
  onLaunchRepoSession,
  onViewHistory,
  orgPrs = EMPTY_ARRAY,
  sidebarItems = EMPTY_ARRAY,
  collapsed = false,
  onToggleCollapse,
  loadingItems = EMPTY_SET,
}: RepoItemProps) {
  const initialColor = useMemo(() => deriveColor(repo.name), [repo.name]);
  const initial = repo.name.charAt(0).toUpperCase();
  const allSessions = useMemo(
    () => [...sessionGroups.values()].flat(),
    [sessionGroups]
  );
  const totalItems = allSessions.length + inactiveWorktrees.length;
  const sidebarItemById = useMemo(
    () => new Map(sidebarItems.map((i) => [i.id, i])),
    [sidebarItems]
  );
  const hasAttention = useMemo(
    () =>
      sidebarItems.some(
        (i) => i.repoPath === repo.path && isAttentionState(i.displayState)
      ),
    [sidebarItems, repo.path]
  );
  const creatingWorktree = loadingItems.has(`new-worktree:${repo.path}`);
  const repoMeta = useSessionsStore((s) => s.repoEnrichmentMeta[repo.path]);
  const webhookStatus = deriveRepoWebhookStatus(repo, repoMeta);
  const openWebhookSetup = useCallback(() => {
    useUiStore
      .getState()
      .setActiveModal({ modal: 'settings', scrollToId: 'integration-webhooks' });
  }, []);
  const retryWebhookSetup = useCallback(async () => {
    try {
      await createRepoWebhook(repo.path);
      await useSessionsStore.getState().refreshAll();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'failed to retry webhook setup'
      );
    }
  }, [repo.path]);
  const { highestState, attentionCount } = useRepoAggregation(
    repo.path,
    sidebarItems,
    loadingItems
  );
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    };
  }, []);

  const handleHeaderClick = useCallback(() => {
    if (isMobileDevice) {
      onSelectWorkspace(repo.path);
      return;
    }
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      onToggleCollapse?.();
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        onSelectWorkspace(repo.path);
      }, DOUBLE_CLICK_DELAY_MS);
    }
  }, [onSelectWorkspace, repo.path, onToggleCollapse]);

  function cancelLongPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function findPr(branchName: string) {
    return orgPrs?.find(
      (pr) =>
        pr.headRefName === branchName &&
        pr.state === 'OPEN' &&
        pr.repoPath === repo.path
    );
  }

  return (
    <div
      className={['repo-item', isActive && 'active'].filter(Boolean).join(' ')}
    >
      <div
        className={['repo-header', hasAttention && 'attention']
          .filter(Boolean)
          .join(' ')}
        data-track="sidebar.repo.click"
        onClick={handleHeaderClick}
      >
        <div className="repo-left">
          <span
            className={['collapse-chevron', collapsed && 'collapsed']
              .filter(Boolean)
              .join(' ')}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse?.();
            }}
          >
            {collapsed ? '›' : '⌄'}
          </span>
          <span className="initial-block" style={{ background: initialColor }}>
            {initial}
          </span>
          <span className="repo-name">
            <MarqueeText>{repo.name}</MarqueeText>
          </span>
          {repo.kind === 'directory' || (!repo.isGitRepo && repo.kind == null) ? (
            <span className="repo-kind-chip">dir</span>
          ) : null}
          {highestState && attentionCount > 0 ? (
            <span className="repo-attention-badge">
              <SessionIndicator state={highestState} />
              {attentionCount}
            </span>
          ) : null}
          {collapsed && totalItems > 0 ? (
            <span className="collapse-count">{totalItems}</span>
          ) : null}
        </div>
        <div className="repo-actions">
          <button
            className="action-btn"
            title="Settings"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSettings(repo);
            }}
          >
            {settingsSvg}
          </button>
        </div>
      </div>
      {!collapsed ? (
        <ul className="session-list">
          {[...sessionGroups.entries()].map(([groupPath, groupSessions]) => {
            const sorted = [...groupSessions].sort((a, b) =>
              b.lastActivity.localeCompare(a.lastActivity)
            );
            const rep = sorted[0];
            const isRepoRoot = groupPath === repo.path;
            if (rep) {
              const isDirectory = repo.kind === 'directory' || repo.isGitRepo === false;
              const matchedPr = isDirectory
                ? undefined
                : findPr(groupSessions[0]?.branchName ?? '');
              const isSelected =
                activeSessionId !== null &&
                groupSessions.some((s) => sessionKeyMatches(s, activeSessionId));
              const sidebarItem = sidebarItemById.get(groupPath);
              const attention =
                sidebarItem !== undefined &&
                isAttentionState(sidebarItem.displayState);
              const dotState = sidebarItem?.displayState ?? 'inactive';
              return (
                <SessionGroupRow
                  key={groupPath}
                  groupPath={groupPath}
                  groupSessions={groupSessions}
                  rep={rep}
                  isSelected={isSelected}
                  attention={attention}
                  dotState={dotState}
                  matchedPr={matchedPr}
                  cancelLongPress={cancelLongPress}
                  onSelectSession={onSelectSession}
                  onDeleteSession={onDeleteSession}
                  onDeleteWorktree={onDeleteWorktree}
                  onViewHistory={onViewHistory}
                  repoPath={repo.path}
                />
              );
            } else if (isRepoRoot) {
              return (
                <InactiveRepoRow
                  key={groupPath}
                  groupPath={groupPath}
                  repoPath={repo.path}
                  repoCurrentBranch={repo.currentBranch}
                  repoDefaultBranch={repo.defaultBranch}
                  webhookStatus={webhookStatus}
                  webhookError={repo.webhookError}
                  sidebarItemById={sidebarItemById}
                  loadingItems={loadingItems}
                  onWebhookSetup={openWebhookSetup}
                  onWebhookRetry={retryWebhookSetup}
                  onLaunchRepoSession={onLaunchRepoSession}
                  onViewHistory={onViewHistory}
                />
              );
            }
            return null;
          })}
          {inactiveWorktrees.map((wt) => {
            const isLoading = loadingItems.has(wt.path);
            return (
              <li
                key={wt.path}
                className={[
                  'session-row',
                  'inactive',
                  isLoading ? 'state-initializing' : 'state-inactive',
                  isLoading && 'loading',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-track="sidebar.worktree.click"
                onClick={() => {
                  if (!isLoading) onResumeWorktree?.(wt);
                }}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
              >
                <div className="session-row-primary">
                  <span className="repo-source-stack">
                    <SessionIndicator state={isLoading ? 'initializing' : 'inactive'} />
                    <RepoSourceDot
                      status={webhookStatus}
                      error={repo.webhookError}
                      onManualSetup={openWebhookSetup}
                      onRetry={retryWebhookSetup}
                    />
                  </span>
                  <span className="session-name">
                    <MarqueeText>
                      {isLoading
                        ? 'resuming...'
                        : wt.branchName || wt.displayName || wt.name}
                    </MarqueeText>
                  </span>
                </div>
                <div className="session-row-secondary">
                  {!isLoading ? (
                    <span
                      className="fleet-status tone-inactive"
                      title="fleet status: inactive"
                    >
                      inactive
                    </span>
                  ) : null}
                  {wt.lastActivity ? (
                    <span className="secondary-time">
                      {formatRelativeTimeCompact(wt.lastActivity)}
                    </span>
                  ) : (
                    <span className="secondary-placeholder" />
                  )}
                  {wt.branchName ? (
                    <span className="secondary-branch">
                      <MarqueeText>{wt.branchName}</MarqueeText>
                    </span>
                  ) : (
                    <span className="secondary-placeholder" />
                  )}
                </div>
                {onDeleteWorktree ? (
                  <div className="row-menu-overlay">
                    <ContextMenu
                      items={[
                        {
                          label: 'delete worktree',
                          action: () => onDeleteWorktree(wt),
                          danger: true,
                        },
                      ]}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!collapsed && repo.isGitRepo !== false ? (
        <div
          className={['add-worktree-row', creatingWorktree && 'disabled']
            .filter(Boolean)
            .join(' ')}
          data-track="sidebar.new-worktree"
          onClick={() => {
            if (!creatingWorktree) onNewWorktree(repo);
          }}
        >
          <button className="add-worktree-btn" type="button" tabIndex={-1}>
            {creatingWorktree ? 'creating...' : '+ new worktree'}
          </button>
        </div>
      ) : null}
      <div className="repo-divider" />
    </div>
  );
}

export default RepoItem;
