// EnvironmentPicker (#627) — pure presentational picker for an
// EnvironmentOption list. Renders options grouped by RepoIdentity, with
// freshness + capability badges, search filter, and keyboard navigation.
//
// Scope per #627:
//   - Pure presentational. No API calls, no store subscriptions, no router
//     hooks. Props in, callbacks out. Downstream issues wire this into
//     surfaces (session creation, command palette, Workbench block create).
//   - Mirrors visual language from `DESIGN.md` (TUI aesthetic: lowercase,
//     monospace, zero border-radius, outline-only chrome, no emoji).
//   - Pattern matches existing TerminalNodePicker portal-listbox structure
//     (id-based aria-activedescendant focus, role="combobox"/"listbox").

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  EnvironmentDegradedReason,
  EnvironmentOption,
} from '../../../shared/environment-option.js';
import './EnvironmentPicker.css';

export interface EnvironmentPickerGroup {
  /** RepoIdentity string (e.g. `github.com/owner/repo`) or `null` for free / non-git cwd options. */
  repoIdentity: string | null;
  /** Display label for the group header. */
  label: string;
  options: EnvironmentOption[];
}

export interface EnvironmentPickerProps {
  options: EnvironmentOption[];
  /**
   * Optional id of the currently-selected option. Used to render a persistent
   * "selected" mark; the keyboard active descendant tracks focus separately so
   * users can navigate without losing the prior selection until they confirm.
   */
  selectedOptionId?: string;
  /** Fired when the user activates an option (click or Enter). */
  onSelect: (option: EnvironmentOption) => void;
  /** Fired on Escape. Optional — the picker is presentational. */
  onCancel?: () => void;
  /** Placeholder for the search/filter input. Defaults to a lowercase TUI prompt. */
  searchPlaceholder?: string;
  /**
   * When true (default) the picker autofocuses the search input on mount so
   * keyboard users can start typing immediately. Set false when embedded
   * inside a surface that owns focus.
   */
  autoFocusSearch?: boolean;
}

const FREE_GROUP_LABEL = 'non-git cwd';

/**
 * Group options by their repo identity. Options with no `repoInstance` (free
 * / non-git cwd launches) collapse into a single trailing group whose
 * `repoIdentity` is `null`.
 *
 * Group order preserves the order of first appearance in `options`, then
 * appends the free group last. This is presentational order only — callers
 * can pre-sort if they want a different policy.
 */
export function groupOptionsByRepoIdentity(
  options: EnvironmentOption[]
): EnvironmentPickerGroup[] {
  const repoGroups = new Map<string, EnvironmentPickerGroup>();
  const freeGroup: EnvironmentPickerGroup = {
    repoIdentity: null,
    label: FREE_GROUP_LABEL,
    options: [],
  };
  for (const opt of options) {
    const identity = opt.repoInstance?.repoIdentity ?? null;
    if (identity === null) {
      freeGroup.options.push(opt);
      continue;
    }
    const existing = repoGroups.get(identity);
    if (existing) {
      existing.options.push(opt);
      continue;
    }
    repoGroups.set(identity, {
      repoIdentity: identity,
      label: opt.repoInstance?.name ?? identity,
      options: [opt],
    });
  }
  const result = Array.from(repoGroups.values());
  if (freeGroup.options.length > 0) result.push(freeGroup);
  return result;
}

/**
 * Filter options by a case-insensitive substring match against the most useful
 * label fields. Empty / whitespace-only queries return all options unchanged.
 */
export function filterOptions(
  options: EnvironmentOption[],
  query: string
): EnvironmentOption[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return options;
  return options.filter((opt) => {
    const haystack = [
      opt.node.displayName ?? '',
      opt.node.nodeId,
      opt.cwd,
      opt.repoInstance?.repoIdentity ?? '',
      opt.repoInstance?.name ?? '',
      opt.repoInstance?.currentBranch ?? '',
      opt.bench?.branchName ?? '',
      opt.bench?.displayName ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(trimmed);
  });
}

function describeDegradedReason(reason: EnvironmentDegradedReason): string {
  switch (reason.kind) {
    case 'node-offline':
      return reason.message ?? 'node offline';
    case 'node-stale':
      return reason.message ?? `node stale since ${reason.lastSeenAt}`;
    case 'capability-missing':
      return reason.message ?? `missing capability ${reason.capability}`;
    case 'repo-missing':
      return (
        reason.message ??
        `repo missing${reason.localPath ? ` at ${reason.localPath}` : ''}`
      );
    case 'worktree-missing':
      return reason.message ?? `worktree missing at ${reason.localPath}`;
    case 'auth-failed':
      return reason.message;
    case 'version-skew':
      // #861(C): render message + optional remediationHint, matching the
      // node-dashboard disabledReason copy convention.
      return reason.remediationHint
        ? `${reason.message} — ${reason.remediationHint}`
        : reason.message;
    case 'cwd-invalid':
      // #861(D): live population deferred to the launcher slices; this arm
      // keeps the exhaustive guard green for the new shared union member.
      return reason.message ?? `cwd unavailable at ${reason.cwd}`;
    case 'other':
      return reason.message;
    default: {
      // Exhaustive guard: any new EnvironmentDegradedReason kind added to the
      // shared union will fail to compile here until handled above.
      const _exhaustive: never = reason;
      return String(_exhaustive);
    }
  }
}

export function EnvironmentPicker({
  options,
  selectedOptionId,
  onSelect,
  onCancel,
  searchPlaceholder = 'filter environments…',
  autoFocusSearch = true,
}: EnvironmentPickerProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const idPrefix = useId();
  const listboxId = `${idPrefix}-listbox`;
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Filter, then group, then derive the flat list FROM the grouped order. This
  // ensures keyboard navigation order matches the visual order — Arrow Down
  // moves to the next visually-adjacent row, even across the free / non-git
  // group that grouping appends to the end.
  const groups = useMemo(
    () => groupOptionsByRepoIdentity(filterOptions(options, query)),
    [options, query]
  );
  const visibleOptions = useMemo(
    () => groups.flatMap((group) => group.options),
    [groups]
  );
  // Map from option id → flat index so per-row render is O(1) instead of an
  // O(N) `indexOf` per row (avoids O(N²) total when the picker grows).
  const flatIndexById = useMemo(() => {
    const map = new Map<string, number>();
    visibleOptions.forEach((opt, i) => map.set(opt.id, i));
    return map;
  }, [visibleOptions]);

  // The keyboard active descendant tracks a flat index into `visibleOptions`,
  // independent of the persistent `selectedOptionId` so navigation never
  // mutates selection until the user confirms.
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    // Reset to the top of the visible list whenever the filtered set changes
    // (e.g. user typed a query). Highlighting the first match is the standard
    // command-palette behavior; clamping mid-list would otherwise leave a
    // confusing arbitrary row highlighted as the user types.
    setActiveIndex(0);
  }, [visibleOptions]);

  useEffect(() => {
    if (autoFocusSearch) inputRef.current?.focus();
  }, [autoFocusSearch]);

  const optionDomId = useCallback(
    (id: string) => `${idPrefix}-opt-${id}`,
    [idPrefix]
  );

  const activeOption = visibleOptions[activeIndex];
  const activeDescendantId = activeOption ? optionDomId(activeOption.id) : '';

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => {
          if (visibleOptions.length === 0) return 0;
          return (prev + 1) % visibleOptions.length;
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) => {
          if (visibleOptions.length === 0) return 0;
          return (prev - 1 + visibleOptions.length) % visibleOptions.length;
        });
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(Math.max(0, visibleOptions.length - 1));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (activeOption) onSelect(activeOption);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel?.();
      }
    },
    [activeOption, onCancel, onSelect, visibleOptions.length]
  );

  return (
    // Wrapper is purely presentational. ARIA APG combobox/listbox pattern
    // places role="combobox" + aria-* on the input (the element that actually
    // receives focus). Matches existing CommandPalette / FilePicker pattern.
    <div className="env-picker">
      <div className="env-picker__search" role="presentation">
        <span className="env-picker__search-prompt" aria-hidden="true">
          &gt;
        </span>
        <input
          ref={inputRef}
          type="text"
          className="env-picker__search-input"
          data-testid="env-picker-search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={visibleOptions.length > 0}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          {...(activeDescendantId
            ? { 'aria-activedescendant': activeDescendantId }
            : {})}
        />
      </div>
      <div
        id={listboxId}
        role="listbox"
        tabIndex={-1}
        className="env-picker__listbox"
        onKeyDown={handleKeyDown}
      >
        {groups.length === 0 ? (
          <div className="env-picker__empty" data-testid="env-picker-empty">
            no matching environments
          </div>
        ) : (
          groups.map((group) => (
            <div
              key={group.repoIdentity ?? '__free__'}
              className="env-picker__group"
              data-testid="env-picker-group"
            >
              <div
                className="env-picker__group-label"
                data-testid="env-picker-group-label"
              >
                {group.label}
              </div>
              {group.options.map((opt) => {
                const flatIndex = flatIndexById.get(opt.id) ?? -1;
                const isActive = flatIndex === activeIndex;
                const isSelected = selectedOptionId === opt.id;
                return (
                  <div
                    key={opt.id}
                    id={optionDomId(opt.id)}
                    role="option"
                    // ARIA APG combobox/listbox pattern: aria-selected reflects
                    // the *persistent* selection only. The focused/active row
                    // is communicated via aria-activedescendant on the
                    // container; doubling it up on aria-selected confuses
                    // screen readers in a single-select listbox.
                    aria-selected={isSelected}
                    data-option-id={opt.id}
                    data-freshness={opt.freshness}
                    data-active={isActive ? 'true' : 'false'}
                    className={[
                      'env-picker__option',
                      isActive ? 'env-picker__option--active' : '',
                      isSelected ? 'env-picker__option--selected' : '',
                      `env-picker__option--${opt.freshness}`,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onSelect(opt)}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                  >
                    <div className="env-picker__option-header">
                      <span
                        className={`env-picker__dot env-picker__dot--${opt.freshness}`}
                        aria-hidden="true"
                      />
                      <span className="env-picker__node">
                        {opt.node.displayName ?? opt.node.nodeId}
                      </span>
                      <span className="env-picker__cwd" title={opt.cwd}>
                        {opt.cwd}
                      </span>
                      {opt.bench?.branchName ? (
                        <span className="env-picker__branch">
                          {opt.bench.branchName}
                        </span>
                      ) : opt.repoInstance?.currentBranch ? (
                        <span className="env-picker__branch">
                          {opt.repoInstance.currentBranch}
                        </span>
                      ) : null}
                    </div>
                    {opt.capabilities.length > 0 ? (
                      <div className="env-picker__capabilities">
                        {opt.capabilities.map((cap) => (
                          <span
                            key={cap}
                            className="env-picker__capability"
                            data-testid="env-picker-capability"
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {opt.degradedReasons && opt.degradedReasons.length > 0 ? (
                      <ul className="env-picker__degraded-list">
                        {opt.degradedReasons.map((reason, i) => (
                          <li
                            key={`${reason.kind}-${i}`}
                            className="env-picker__degraded"
                            data-testid="env-picker-degraded"
                          >
                            {describeDegradedReason(reason)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default EnvironmentPicker;
