import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchBranches, switchBranch } from '../lib/api.js';
import type { BranchInfo } from '../lib/types.js';
import CipherText from './CipherText';
import TuiMenuItem from './TuiMenuItem';
import TuiMenuPanel from './TuiMenuPanel';
import './BranchSwitcher.css';

export interface BranchSwitcherProps {
  repoPath: string;
  currentBranch: string;
  onSwitch: (branch: string) => void;
  disabled?: boolean;
  currentWorktreePath?: string;
  onJumpToSession?: (sessionId: string) => void;
  onStartSession?: (worktreePath: string) => void;
  onCreateBranch?: (branchName: string) => void;
}

export function BranchSwitcher({
  repoPath,
  currentBranch,
  onSwitch,
  disabled = false,
  currentWorktreePath,
  onJumpToSession,
  onStartSession,
  onCreateBranch,
}: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);

    void fetchBranches(repoPath)
      .then((nextBranches) => {
        if (!cancelled) setBranches(nextBranches);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, repoPath]);

  useEffect(() => {
    if (!open) return;

    const raf = window.requestAnimationFrame(() => {
      filterInputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleWindowClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && wrapperRef.current && !wrapperRef.current.contains(target)) {
        setOpen(false);
        setFilterText('');
      }
    };

    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, [open]);

  const filteredBranches = useMemo(() => {
    if (!filterText.trim()) return branches;
    const lower = filterText.toLowerCase();
    return branches.filter((branch) => branch.name.toLowerCase().includes(lower));
  }, [branches, filterText]);

  const showCreateOption = useMemo(() => {
    const trimmed = filterText.trim();
    if (!trimmed) return false;
    return !branches.some((branch) => branch.name === trimmed);
  }, [branches, filterText]);

  const closeDropdown = () => {
    setOpen(false);
    setFilterText('');
  };

  const openDropdown = () => {
    if (disabled) return;
    setOpen(true);
    setFilterText('');
    setSwitchError(null);
  };

  const handleSelect = async (branchName: string) => {
    if (branchName === currentBranch) {
      closeDropdown();
      return;
    }

    setSwitching(branchName);
    setSwitchError(null);

    try {
      const result = await switchBranch(repoPath, branchName);
      if (result.success) {
        closeDropdown();
        onSwitch(branchName);
      } else {
        setSwitchError(result.error ?? 'Failed to switch branch');
      }
    } catch {
      setSwitchError('Failed to switch branch');
    } finally {
      setSwitching(null);
    }
  };

  const isCheckedOutElsewhere = (branch: BranchInfo) => {
    if (!currentWorktreePath || !branch.checkedOutIn) return false;
    return branch.checkedOutIn.worktreePath !== currentWorktreePath;
  };

  const handleJump = (branch: BranchInfo, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    if (!branch.checkedOutIn) return;

    if (branch.checkedOutIn.sessionId && onJumpToSession) {
      onJumpToSession(branch.checkedOutIn.sessionId);
    } else if (onStartSession) {
      onStartSession(branch.checkedOutIn.worktreePath);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement | HTMLInputElement>) => {
    if (event.key === 'Escape' && open) {
      closeDropdown();
      event.stopPropagation();
    }
  };

  return (
    <div className="branch-switcher" ref={wrapperRef}>
      <button
        className={`branch-trigger${disabled ? ' branch-disabled' : ''}`}
        onClick={openDropdown}
        title={disabled ? 'Unavailable while agent is running' : undefined}
        aria-label="Switch branch"
        aria-expanded={open}
        aria-haspopup="listbox"
        type="button"
      >
        <span className="branch-icon">⑂</span>
        <span className="branch-name">{currentBranch}</span>
        <svg className="branch-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open ? (
        <div className="branch-dropdown" role="listbox" tabIndex={-1} aria-label="Branches" onKeyDown={onKeyDown}>
          <TuiMenuPanel>
            <div className="branch-filter-wrap">
              <input
                ref={filterInputRef}
                type="text"
                className="branch-filter"
                placeholder="Filter branches..."
                value={filterText}
                onChange={(event) => setFilterText(event.currentTarget.value)}
                onKeyDown={onKeyDown}
                aria-label="Filter branches"
              />
            </div>

            {switchError ? <div className="branch-error">{switchError}</div> : null}

            {showCreateOption && onCreateBranch ? (
              <div
                className="branch-create"
                role="option"
                aria-selected={false}
                tabIndex={-1}
                onMouseDown={() => onCreateBranch?.(filterText.trim())}
              >
                <span className="branch-create-icon">+</span>
                <span>
                  Create "<strong>{filterText.trim()}</strong>"
                </span>
              </div>
            ) : null}

            {loading ? (
              <div className="branch-loading">
                <CipherText loading text="Fetching branches..." />
              </div>
            ) : filteredBranches.length === 0 && !showCreateOption ? (
              <div className="branch-empty">No branches match</div>
            ) : (
              <div className="branch-list">
                {filteredBranches.map((branch) => {
                  const checkedOutElsewhere = isCheckedOutElsewhere(branch);

                  return (
                    <TuiMenuItem
                      key={branch.name}
                      role="option"
                      ariaSelected={branch.name === currentBranch}
                      disabled={checkedOutElsewhere || switching === branch.name}
                      onMouseDown={() => void handleSelect(branch.name)}
                    >
                      <>
                        <span className="branch-check">
                          {branch.name === currentBranch ? '✓' : <span className="branch-check--empty" />}
                        </span>
                        <span
                          className={`branch-option-name${branch.name === currentBranch ? ' branch-current' : ''}${checkedOutElsewhere ? ' branch-checked-out' : ''}`}
                        >
                          {branch.name}
                        </span>

                        {checkedOutElsewhere && branch.checkedOutIn && (onJumpToSession || onStartSession) ? (
                          <>
                            <span className="branch-worktree-name">({branch.checkedOutIn.worktreeName})</span>
                            <button
                              className="branch-jump-btn"
                              title="Jump to worktree"
                              type="button"
                              onMouseDown={(event) => handleJump(branch, event)}
                            >
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                                <path d="M4.5 2H2.5C2.22 2 2 2.22 2 2.5V9.5C2 9.78 2.22 10 2.5 10H9.5C9.78 10 10 9.78 10 9.5V7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                <path d="M7 2H10V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M10 2L5.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                              </svg>
                            </button>
                          </>
                        ) : null}

                        {switching === branch.name ? <span className="branch-spinner">&hellip;</span> : null}
                      </>
                    </TuiMenuItem>
                  );
                })}
              </div>
            )}
          </TuiMenuPanel>
        </div>
      ) : null}
    </div>
  );
}

export default BranchSwitcher;
