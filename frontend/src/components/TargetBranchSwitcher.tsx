import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { BranchInfo } from '../lib/types.js';
import { fetchWorkspaceBranches, setPrBase } from '../lib/api.js';
import useClickOutside from '../hooks/useClickOutside.js';
import TuiMenuItem from './TuiMenuItem.js';
import TuiMenuPanel from './TuiMenuPanel.js';
import './TargetBranchSwitcher.css';

export interface TargetBranchSwitcherProps {
  workspacePath: string;
  currentBase: string;
  prNumber: number;
  disabled?: boolean;
  onBaseChanged?: (newBase: string) => void;
}

function filterRemoteBranches(
  branches: BranchInfo[],
  filterText: string
): BranchInfo[] {
  const remote = branches
    .filter((b) => b.isRemote)
    .map((b) => ({ ...b, name: b.name.replace(/^origin\//, '') }));
  const seen = new Set<string>();
  const deduped = remote.filter((b) => {
    if (seen.has(b.name)) return false;
    seen.add(b.name);
    return true;
  });
  if (!filterText.trim()) return deduped;
  const lower = filterText.toLowerCase();
  return deduped.filter((b) => b.name.toLowerCase().includes(lower));
}

interface DropdownProps {
  filteredBranches: BranchInfo[];
  currentBase: string;
  switching: string | null;
  isLoading: boolean;
  switchError: string | null;
  filterText: string;
  filterInputRef: React.RefObject<HTMLInputElement | null>;
  onFilterChange: (text: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (name: string) => void;
}

function TargetDropdown({
  filteredBranches,
  currentBase,
  switching,
  isLoading,
  switchError,
  filterText,
  filterInputRef,
  onFilterChange,
  onKeyDown,
  onSelect,
}: DropdownProps) {
  return (
    <div
      className="target-dropdown"
      role="listbox"
      tabIndex={-1}
      aria-label="Target branches"
      onKeyDown={onKeyDown}
    >
      <TuiMenuPanel>
        <div className="target-filter-wrap">
          <input
            ref={filterInputRef}
            type="text"
            className="target-filter"
            placeholder="Filter branches..."
            value={filterText}
            onChange={(e) => onFilterChange(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            aria-label="Filter target branches"
          />
        </div>
        {switchError ? <div className="target-error">{switchError}</div> : null}
        {isLoading ? (
          <div className="target-loading">Loading...</div>
        ) : filteredBranches.length === 0 ? (
          <div className="target-empty">No branches match</div>
        ) : (
          <div className="target-list">
            {filteredBranches.map((branch) => (
              <TuiMenuItem
                key={branch.name}
                role="option"
                ariaSelected={branch.name === currentBase}
                disabled={switching === branch.name}
                icon={
                  branch.name === currentBase ? (
                    <span className="target-check">&#10003;</span>
                  ) : (
                    <span className="target-check target-check--empty" />
                  )
                }
                onMouseDown={() => onSelect(branch.name)}
              >
                <span
                  className={[
                    'target-option-name',
                    branch.name === currentBase && 'target-current',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {branch.name}
                </span>
                {switching === branch.name ? (
                  <span className="target-spinner">&hellip;</span>
                ) : null}
              </TuiMenuItem>
            ))}
          </div>
        )}
      </TuiMenuPanel>
    </div>
  );
}

export function TargetBranchSwitcher({
  workspacePath,
  currentBase,
  prNumber,
  disabled = false,
  onBaseChanged,
}: TargetBranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoading(true);
    fetchWorkspaceBranches(workspacePath)
      .then((data) => {
        if (!cancelled) setBranches(data);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspacePath]);

  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() =>
      filterInputRef.current?.focus()
    );
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  const handleClickOutside = useCallback(() => {
    closeDropdown();
  }, []);
  useClickOutside(wrapperRef, handleClickOutside, open);

  const filteredBranches = useMemo(
    () => filterRemoteBranches(branches, filterText),
    [branches, filterText]
  );

  function closeDropdown() {
    setOpen(false);
    setFilterText('');
  }

  async function handleSelect(branchName: string) {
    if (branchName === currentBase) {
      closeDropdown();
      return;
    }
    setSwitching(branchName);
    setSwitchError(null);
    try {
      const data = await setPrBase(workspacePath, prNumber, branchName);
      if (data.success) {
        closeDropdown();
        onBaseChanged?.(branchName);
      } else setSwitchError(data.error ?? 'Failed to change base branch');
    } catch {
      setSwitchError('Failed to change base branch');
    } finally {
      setSwitching(null);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      closeDropdown();
      e.stopPropagation();
    }
  };

  return (
    <div className="target-switcher" ref={wrapperRef}>
      <button
        className={['target-trigger', disabled && 'target-disabled']
          .filter(Boolean)
          .join(' ')}
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            setFilterText('');
            setSwitchError(null);
          }
        }}
        aria-label="Change target branch"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={
          disabled
            ? 'Unavailable while agent is running'
            : 'Change target branch'
        }
        type="button"
      >
        <span className="target-name">{currentBase}</span>
        <svg
          className="target-caret"
          width="8"
          height="5"
          viewBox="0 0 8 5"
          aria-hidden="true"
        >
          <path
            d="M1 1l3 3 3-3"
            stroke="currentColor"
            fill="none"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open ? (
        <TargetDropdown
          filteredBranches={filteredBranches}
          currentBase={currentBase}
          switching={switching}
          isLoading={isLoading}
          switchError={switchError}
          filterText={filterText}
          filterInputRef={filterInputRef}
          onFilterChange={setFilterText}
          onKeyDown={onKeyDown}
          onSelect={(name) => void handleSelect(name)}
        />
      ) : null}
    </div>
  );
}

export default TargetBranchSwitcher;
