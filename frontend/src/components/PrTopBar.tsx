import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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
import type { PrInfo, CiStatus } from '../lib/types.js';
import CipherText from './CipherText.js';
import TuiButton from './TuiButton.js';
import BranchSwitcher from './BranchSwitcher.js';
import TargetBranchSwitcher from './TargetBranchSwitcher.js';
import { useUiStore } from '../lib/stores/ui.js';
import RenameWarningModal from './dialogs/RenameWarningModal.js';
import './PrTopBar.css';

export interface PrTopBarProps {
  workspacePath: string;
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
  refresh: () => void;
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
    refresh: () => {
      void fetchPrAndCi();
    },
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
            <button
              className="hover-icon"
              onClick={onCopy}
              title={copyFeedback ? 'Copied!' : 'Copy branch name'}
              aria-label="Copy branch name"
              type="button"
            >
              {copyFeedback ? COPY_SVG_CHECK : COPY_SVG_DEFAULT}
            </button>
            <button
              className="hover-icon"
              onClick={rename.startRename}
              disabled={agentRunning}
              title={
                agentRunning
                  ? 'Unavailable while agent is running'
                  : 'Rename branch'
              }
              aria-label="Rename branch"
              type="button"
            >
              {RENAME_SVG}
            </button>
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

interface PrActionsProps {
  isRefreshing: boolean;
  prLoading: boolean;
  prAction: PrAction;
  secondaryAction: PrAction | null;
  onRefresh: () => void;
  onAction: (action?: PrAction) => void;
}

function PrActions({
  isRefreshing,
  prLoading,
  prAction,
  secondaryAction,
  onRefresh,
  onAction,
}: PrActionsProps) {
  const rightSidebarCollapsed = useUiStore((s) => s.rightSidebarCollapsed);
  const toggleRightSidebarCollapsed = useUiStore(
    (s) => s.toggleRightSidebarCollapsed
  );

  return (
    <div className="bar-right">
      <button
        className={['refresh-btn', isRefreshing && 'refreshing']
          .filter(Boolean)
          .join(' ')}
        onClick={onRefresh}
        disabled={isRefreshing}
        aria-label="Refresh PR data"
        title="Refresh PR data"
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
      <button
        className="sidebar-toggle-btn"
        onClick={toggleRightSidebarCollapsed}
        aria-label={
          rightSidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'
        }
        title={
          rightSidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'
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
    const ctx = {
      branchName: currentBranch,
      baseBranch: pr?.baseRefName ?? '',
      prNumber: pr?.number ?? 0,
      unresolvedCommentCount: pr?.unresolvedCommentCount ?? 0,
    };
    const prompt = getActionPrompt(action, ctx);
    if (prompt === null) {
      onArchive?.();
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
        isRefreshing={isRefreshing}
        prLoading={prLoading}
        prAction={prAction}
        secondaryAction={secondaryAction}
        onRefresh={refresh}
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
