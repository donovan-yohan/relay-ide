import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRepoWebhook,
  fetchPrForBranchOrNull,
  fetchCiStatusOrNull,
  fetchCurrentBranch,
  renameBranch,
} from '../lib/api.js';
import { sendPtyData } from '../lib/ws.js';
import {
  derivePrAction,
  deriveSecondaryAction,
  getActionPrompt,
  colorToVariant,
} from '../lib/pr-state.js';
import type { PrAction } from '../lib/pr-state.js';
import type { PrInfo, CiStatus, RepoWebhookStatus } from '../lib/types.js';
import CipherText from './CipherText.js';
import RepoSourceDot from './RepoSourceDot.js';
import TuiButton from './TuiButton.js';
import BranchSwitcher from './BranchSwitcher.js';
import TargetBranchSwitcher from './TargetBranchSwitcher.js';
import { DEFAULT_UTILITY_RAIL_STATE, useUiStore } from '../lib/stores/ui.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { formatRelativeTime } from '../lib/utils.js';
import RenameWarningModal from './dialogs/RenameWarningModal.js';
import Tooltip from './Tooltip.js';
import './PrTopBar.css';

export interface PrTopBarProps {
  workspacePath: string;
  utilityRailWorkspacePath?: string;
  branchName: string;
  sessionId: string | null;
  agentRunning?: boolean;
  onArchive?: () => void;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

interface PrDataState {
  pr: PrInfo | null;
  ci: CiStatus | null;
  isRefreshing: boolean;
  prLoading: boolean;
  refresh: () => Promise<void>;
}

function usePrData(
  workspacePath: string,
  currentBranch: string,
  sessionId: string | null
): PrDataState {
  const [pr, setPr] = useState<PrInfo | null>(null);
  const [ci, setCi] = useState<CiStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [prLoading, setPrLoading] = useState(false);

  const fetchPrAndCi = useCallback(async () => {
    if (!currentBranch) return;
    setIsRefreshing(true);
    setPrLoading(true);
    try {
      const prData = await fetchPrForBranchOrNull(workspacePath, currentBranch);
      setPr(prData);
      if (prData?.state === 'OPEN') {
        const ciData = await fetchCiStatusOrNull(workspacePath, currentBranch);
        setCi(ciData);
      } else {
        setCi(null);
      }
    } finally {
      setIsRefreshing(false);
      setPrLoading(false);
    }
  }, [workspacePath, currentBranch]);

  useEffect(() => {
    void fetchPrAndCi();
  }, [fetchPrAndCi, sessionId]);
  return {
    pr,
    ci,
    isRefreshing,
    prLoading,
    refresh: fetchPrAndCi,
  };
}

interface RenameState {
  renaming: boolean;
  renameValue: string;
  renameSubmitting: boolean;
  renameWarning: { oldName: string; newName: string } | null;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  startRename: () => void;
  cancelRename: () => void;
  confirmRename: () => Promise<void>;
  handleRenameKeydown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  setRenameValue: (v: string) => void;
  clearWarning: () => void;
}

function useRename(
  workspacePath: string,
  currentBranch: string,
  agentRunning: boolean,
  hasPr: boolean,
  onBranchRenamed: (name: string) => void
): RenameState {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [renameWarning, setRenameWarning] = useState<{
    oldName: string;
    newName: string;
  } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  function startRename() {
    if (agentRunning) return;
    setRenaming(true);
    setRenameValue(currentBranch);
    requestAnimationFrame(() => renameInputRef.current?.focus());
  }

  function cancelRename() {
    if (renameSubmitting) return;
    setRenaming(false);
    setRenameValue('');
  }

  async function confirmRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === currentBranch) {
      cancelRename();
      return;
    }
    setRenameSubmitting(true);
    try {
      const data = await renameBranch(workspacePath, trimmed);
      setRenaming(false);
      setRenameValue('');
      if (data.success && data.oldName && data.newName) {
        onBranchRenamed(data.newName);
        if (hasPr)
          setRenameWarning({ oldName: data.oldName, newName: data.newName });
      }
    } catch {
      setRenaming(false);
      setRenameValue('');
    } finally {
      setRenameSubmitting(false);
    }
  }

  function handleRenameKeydown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void confirmRename();
    } else if (e.key === 'Escape') cancelRename();
  }

  return {
    renaming,
    renameValue,
    renameSubmitting,
    renameWarning,
    renameInputRef,
    startRename,
    cancelRename,
    confirmRename,
    handleRenameKeydown,
    setRenameValue,
    clearWarning: () => setRenameWarning(null),
  };
}

// ── Sub-components ───────────────────────────────────────────────────────────

const COPY_SVG_CHECK = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3 8l3 3 7-7"
      stroke="currentColor"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const COPY_SVG_DEFAULT = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <rect
      x="5"
      y="5"
      width="9"
      height="9"
      rx="1.5"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
    />
    <path
      d="M3 11V3a1.5 1.5 0 011.5-1.5H11"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);
const RENAME_SVG = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

interface BranchSectionProps {
  workspacePath: string;
  currentBranch: string;
  agentRunning: boolean;
  pr: PrInfo | null;
  rename: RenameState;
  copyFeedback: boolean;
  onBranchSwitch: (branch: string) => void;
  onCopy: () => void;
  onBaseChanged: () => void;
}

function BranchSection({
  workspacePath,
  currentBranch,
  agentRunning,
  pr,
  rename,
  copyFeedback,
  onBranchSwitch,
  onCopy,
  onBaseChanged,
}: BranchSectionProps) {
  return (
    <div className="bar-left">
      {rename.renaming ? (
        <div className="rename-input-wrap">
          <span className="branch-icon">⑂</span>
          <input
            ref={rename.renameInputRef}
            type="text"
            className="rename-input"
            value={rename.renameValue}
            onChange={(e) => rename.setRenameValue(e.currentTarget.value)}
            onKeyDown={rename.handleRenameKeydown}
            onBlur={rename.cancelRename}
          />
        </div>
      ) : (
        <div className="branch-with-actions">
          <BranchSwitcher
            repoPath={workspacePath}
            currentWorktreePath={workspacePath}
            currentBranch={currentBranch}
            disabled={agentRunning}
            onSwitch={onBranchSwitch}
          />
          <div className="hover-icons">
            <Tooltip
              label={copyFeedback ? 'copied' : 'copy branch name'}
              actionId="pr.copy-branch-name"
            >
              <button
                className="hover-icon"
                onClick={onCopy}
                aria-label="Copy branch name"
                type="button"
              >
                {copyFeedback ? COPY_SVG_CHECK : COPY_SVG_DEFAULT}
              </button>
            </Tooltip>
            <Tooltip
              label={
                agentRunning
                  ? 'unavailable while agent is running'
                  : 'rename branch'
              }
              actionId="pr.rename-branch"
            >
              <button
                className="hover-icon"
                onClick={rename.startRename}
                disabled={agentRunning}
                aria-label="Rename branch"
                type="button"
              >
                {RENAME_SVG}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {pr?.baseRefName ? (
        <span className="target-section">
          <span className="target-arrow" aria-hidden="true">
            <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
              <path
                d="M1 5h10M8 2l3 3-3 3"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <TargetBranchSwitcher
            workspacePath={workspacePath}
            currentBase={pr.baseRefName}
            prNumber={pr.number}
            disabled={agentRunning}
            onBaseChanged={onBaseChanged}
          />
        </span>
      ) : null}
    </div>
  );
}

interface SourceIndicatorProps {
  status: RepoWebhookStatus;
  error?: string | undefined;
  lastEnrichedAt?: number | undefined;
  onManualSetup: () => void;
  onRetry: () => void;
}

function sourceLabel(status: RepoWebhookStatus): string {
  if (status === 'live') return 'live';
  if (status === 'manual') return 'manual';
  if (status === 'limited') return 'limited';
  return 'webhook broken';
}

function SourceIndicator({
  status,
  error,
  lastEnrichedAt,
  onManualSetup,
  onRetry,
}: SourceIndicatorProps) {
  const updatedText = lastEnrichedAt
    ? `updated ${formatRelativeTime(new Date(lastEnrichedAt).toISOString())}`
    : 'updated never';

  return (
    <span className="source-indicator" data-testid="pr-source-indicator">
      <RepoSourceDot
        status={status}
        error={error}
        onManualSetup={onManualSetup}
        onRetry={onRetry}
      />
      <span className="source-label">{sourceLabel(status)}</span>
      <span className="source-updated">· {updatedText}</span>
    </span>
  );
}

interface PrActionsProps {
  utilityRailWorkspacePath: string;
  sourceStatus: RepoWebhookStatus;
  sourceError?: string | undefined;
  sourceLastEnrichedAt?: number | undefined;
  sourceRefreshing: boolean;
  isRefreshing: boolean;
  prLoading: boolean;
  prAction: PrAction;
  secondaryAction: PrAction | null;
  onSourceRefresh: () => void;
  onManualSetup: () => void;
  onWebhookRetry: () => void;
  onAction: (action?: PrAction) => void;
}

function PrActions({
  utilityRailWorkspacePath,
  sourceStatus,
  sourceError,
  sourceLastEnrichedAt,
  sourceRefreshing,
  isRefreshing,
  prLoading,
  prAction,
  secondaryAction,
  onSourceRefresh,
  onManualSetup,
  onWebhookRetry,
  onAction,
}: PrActionsProps) {
  const workspaceUtilityRailState = useUiStore((s) =>
    utilityRailWorkspacePath
      ? s.utilityRailByWorkspace[utilityRailWorkspacePath]
      : undefined
  );
  const hydrateUtilityRailState = useUiStore((s) => s.hydrateUtilityRailState);
  const toggleUtilityRailVisible = useUiStore(
    (s) => s.toggleUtilityRailVisible
  );
  useEffect(() => {
    if (utilityRailWorkspacePath)
      hydrateUtilityRailState(utilityRailWorkspacePath);
  }, [hydrateUtilityRailState, utilityRailWorkspacePath]);
  const utilityRailState = utilityRailWorkspacePath
    ? (workspaceUtilityRailState ?? DEFAULT_UTILITY_RAIL_STATE)
    : null;
  const utilityRailVisible = utilityRailState?.visible ?? true;

  return (
    <div className="bar-right">
      <SourceIndicator
        status={sourceStatus}
        error={sourceError}
        lastEnrichedAt={sourceLastEnrichedAt}
        onManualSetup={onManualSetup}
        onRetry={onWebhookRetry}
      />
      <Tooltip
        label={
          sourceStatus === 'error'
            ? 'retry webhook provisioning'
            : 'refresh repo data'
        }
        actionId="pr.refresh"
      >
        <button
          className={[
            'refresh-btn',
            (isRefreshing || sourceRefreshing) && 'refreshing',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={onSourceRefresh}
          disabled={isRefreshing || sourceRefreshing}
          aria-label={
            sourceStatus === 'error'
              ? 'Retry webhook provisioning'
              : 'Refresh repo data'
          }
          type="button"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M14 8A6 6 0 1 1 8 2"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M8 0L14 2L12 4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </button>
      </Tooltip>
      {prLoading ? (
        <CipherText text="loading" loading={true} />
      ) : (
        <>
          {secondaryAction ? (
            <TuiButton
              variant="ghost"
              size="sm"
              data-track="pr-top-bar.secondary-action"
              onClick={() => onAction(secondaryAction)}
              aria-label={secondaryAction.label}
            >
              {secondaryAction.label}
            </TuiButton>
          ) : null}
          {prAction.type !== 'none' ? (
            <TuiButton
              variant={colorToVariant(prAction.color)}
              size="sm"
              data-track="pr-top-bar.primary-action"
              onClick={() => onAction()}
              disabled={prAction.type === 'checks-running'}
              aria-label={prAction.label}
            >
              {prAction.label}
            </TuiButton>
          ) : null}
        </>
      )}
      <Tooltip
        label={utilityRailVisible ? 'hide utility rail' : 'show utility rail'}
      >
        <button
          className="sidebar-toggle-btn"
          onClick={() => {
            if (utilityRailWorkspacePath)
              toggleUtilityRailVisible(utilityRailWorkspacePath);
          }}
          aria-label={
            utilityRailVisible ? 'Hide utility rail' : 'Show utility rail'
          }
          type="button"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1"
              y="2"
              width="14"
              height="12"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="square"
            />
            <line
              x1="10"
              y1="2"
              x2="10"
              y2="14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="square"
            />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type PrStateType = 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT' | null;

function buildPrStateInput(pr: PrInfo | null, ci: CiStatus | null) {
  const prState: PrStateType = pr ? (pr.isDraft ? 'DRAFT' : pr.state) : null;
  return {
    commitsAhead: pr ? 1 : 0,
    prState,
    ciPassing: ci?.passing ?? 0,
    ciFailing: ci?.failing ?? 0,
    ciPending: ci?.pending ?? 0,
    ciTotal: ci?.total ?? 0,
    mergeable: pr?.mergeable ?? null,
    unresolvedCommentCount: pr?.unresolvedCommentCount ?? 0,
  };
}

function deriveBarClass(pr: PrInfo | null): string {
  return [
    'pr-top-bar',
    pr?.state === 'MERGED' && 'bar-merged',
    pr?.mergeable === 'CONFLICTING' && 'bar-conflicts',
  ]
    .filter(Boolean)
    .join(' ');
}

// ── Main component ───────────────────────────────────────────────────────────

export function PrTopBar({
  workspacePath,
  utilityRailWorkspacePath = workspacePath,
  branchName,
  sessionId,
  agentRunning = false,
  onArchive,
}: PrTopBarProps) {
  const [currentBranch, setCurrentBranch] = useState(branchName);
  const [copyFeedback, setCopyFeedback] = useState(false);
  useEffect(() => {
    setCurrentBranch(branchName);
  }, [branchName]);
  useEffect(() => {
    if (!branchName && workspacePath) {
      void fetchCurrentBranch(workspacePath).then((b) => {
        if (b) setCurrentBranch(b);
      });
    }
  }, [branchName, workspacePath]);

  const { pr, ci, isRefreshing, prLoading, refresh } = usePrData(
    workspacePath,
    currentBranch,
    sessionId
  );
  const [sourceRefreshing, setSourceRefreshing] = useState(false);
  const repo = useSessionsStore((s) =>
    s.repos.find((candidate) => candidate.path === workspacePath)
  );
  const repoMeta = useSessionsStore((s) => s.repoEnrichmentMeta[workspacePath]);
  const forceRefresh = useSessionsStore((s) => s.forceRefresh);
  const sourceStatus: RepoWebhookStatus =
    repo?.webhookStatus ?? (repoMeta?.source === 'webhook' ? 'live' : 'manual');
  const rename = useRename(
    workspacePath,
    currentBranch,
    agentRunning,
    pr !== null,
    setCurrentBranch
  );

  const prStateInput = buildPrStateInput(pr, ci);
  const prAction = derivePrAction(prStateInput);
  const secondaryAction = deriveSecondaryAction(prAction, prStateInput);

  function handleActionClick(action: PrAction = prAction) {
    if (action.type === 'merge-pr' && pr?.url) {
      window.open(pr.url, '_blank', 'noopener,noreferrer');
      return;
    }
    const ctx = {
      branchName: currentBranch,
      baseBranch: pr?.baseRefName ?? '',
      prNumber: pr?.number ?? 0,
      unresolvedCommentCount: pr?.unresolvedCommentCount ?? 0,
    };
    const prompt = getActionPrompt(action, ctx);
    if (prompt === null) {
      if (
        action.type === 'archive-merged' ||
        action.type === 'archive-closed'
      ) {
        onArchive?.();
      }
      return;
    }
    if (sessionId) sendPtyData(prompt + '\r');
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(currentBranch);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      /* clipboard may not be available */
    }
  }

  function handleManualSetup() {
    useUiStore
      .getState()
      .setActiveModal({ modal: 'settings', scrollToId: 'integration-webhooks' });
  }

  async function retryWebhookSetup() {
    if (!workspacePath) return;
    await createRepoWebhook(workspacePath);
    await useSessionsStore.getState().refreshAll();
  }

  async function handleSourceRefresh() {
    if (!workspacePath) return;
    setSourceRefreshing(true);
    try {
      if (sourceStatus === 'error') await retryWebhookSetup();
      await forceRefresh(workspacePath, 'manual');
      await refresh();
    } finally {
      setSourceRefreshing(false);
    }
  }

  const barClass = deriveBarClass(pr);

  return (
    <div className={barClass}>
      <BranchSection
        workspacePath={workspacePath}
        currentBranch={currentBranch}
        agentRunning={agentRunning}
        pr={pr}
        rename={rename}
        copyFeedback={copyFeedback}
        onBranchSwitch={setCurrentBranch}
        onCopy={() => void handleCopy()}
        onBaseChanged={refresh}
      />
      {pr ? (
        <>
          <div className="bar-middle" aria-label="pull request">
            <a
              className="pr-link"
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              data-track="pr-top-bar.open-pr"
              aria-label={`PR #${pr.number}: ${pr.title}`}
            >
              PR #{pr.number}
              <svg
                className="pr-ext-icon"
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
              >
                <path
                  d="M1 9L9 1M9 1H4M9 1V6"
                  stroke="currentColor"
                  fill="none"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </a>
          </div>
          <span className="diff-stats">
            <span className="diff-add">+{pr.additions}</span>
            <span className="diff-del">-{pr.deletions}</span>
          </span>
        </>
      ) : null}
      <PrActions
        utilityRailWorkspacePath={utilityRailWorkspacePath}
        sourceStatus={sourceStatus}
        sourceError={repo?.webhookError}
        sourceLastEnrichedAt={repoMeta?.lastEnrichedAt}
        sourceRefreshing={sourceRefreshing}
        isRefreshing={isRefreshing}
        prLoading={prLoading}
        prAction={prAction}
        secondaryAction={secondaryAction}
        onSourceRefresh={() => void handleSourceRefresh()}
        onManualSetup={handleManualSetup}
        onWebhookRetry={() => void retryWebhookSetup()}
        onAction={handleActionClick}
      />
      {rename.renameWarning ? (
        <RenameWarningModal
          oldName={rename.renameWarning.oldName}
          newName={rename.renameWarning.newName}
          workspacePath={workspacePath}
          onClose={() => {
            rename.clearWarning();
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

export default PrTopBar;
