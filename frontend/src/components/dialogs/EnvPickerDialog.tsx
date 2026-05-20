// EnvPickerDialog (#630) — wraps `EnvironmentPicker` with safe-default
// preselection and launch-on-confirm, surfaced from the command palette
// action "start work in environment…".
//
// Why a separate dialog (not the picker rendered inline):
//   - The picker (#627) is intentionally pure-presentational: props in,
//     callbacks out, no I/O. This dialog owns the "what happens after the
//     user picks an option" decision tree: compute the safe default via
//     `pickDefaultEnvironment` (#628), block-on-stale with a typed reason
//     (#615 invariant), and route through the shared `launchEnvironment`
//     hook so #629's new-session dialog can reuse it without duplicating
//     launch logic.
//
//   - Rendered as an overlay (not native <dialog>) so it composes with the
//     palette overlay z-stack and is testable under happy-dom, which does
//     not implement HTMLDialogElement.showModal/close.
//
// The "never silently switch nodes" invariant lives here AND in
// `launchEnvironment` (defense-in-depth): the dialog gates the confirm
// button on the selection's freshness so a stale row cannot be activated
// without surfacing the typed degraded reason.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnvironmentOption,
  EnvironmentDegradedReason,
} from '../../../../shared/environment-option.js';
import {
  pickDefaultEnvironment,
  type ActiveTabContext,
  type EnvironmentHistoryEntry,
} from '../../../../shared/safe-defaults.js';
import { EnvironmentPicker } from '../EnvironmentPicker.js';
import {
  canLaunchEnvironment,
  launchEnvironment,
  type LaunchEnvironmentOptions,
  type LaunchEnvironmentResult,
} from '../../lib/launch-environment.js';
import './EnvPickerDialog.css';

export interface EnvPickerDialogProps {
  open: boolean;
  options: readonly EnvironmentOption[];
  /** Last-used environment history, newest-first per `pickDefaultEnvironment`. */
  history?: readonly EnvironmentHistoryEntry[];
  /** Active tab context for the safe-default rule (#628). */
  activeTab?: ActiveTabContext | null;
  /** Launch shape overrides forwarded to `launchEnvironment`. */
  launchOverrides?: LaunchEnvironmentOptions;
  onClose: () => void;
  /**
   * Called after a successful launch. Receives the launch result so callers
   * can navigate to the new session / show a toast etc.
   */
  onLaunched?: (result: LaunchEnvironmentResult) => void;
  /**
   * Injection point for tests. Defaults to the real `launchEnvironment`.
   */
  launch?: typeof launchEnvironment;
}

function describeBlockReason(
  freshness: EnvironmentOption['freshness'],
  reasons: EnvironmentDegradedReason[] | undefined
): string {
  // Use the FIRST typed reason for a concise headline; the picker row itself
  // already lists all reasons inline. Keep wording lowercase per DESIGN.md.
  const head = reasons?.[0];
  if (head) {
    switch (head.kind) {
      case 'node-offline':
        return 'node offline — launch blocked';
      case 'node-stale':
        return 'node stale — launch blocked';
      case 'capability-missing':
        return `missing capability ${head.capability} — launch blocked`;
      case 'repo-missing':
        return 'repo missing on node — launch blocked';
      case 'worktree-missing':
        return 'worktree missing on node — launch blocked';
      case 'auth-failed':
        return 'auth failed — launch blocked';
      case 'other':
        return `${head.message} — launch blocked`;
    }
  }
  return freshness === 'offline'
    ? 'node offline — launch blocked'
    : 'environment stale — launch blocked';
}

/**
 * Pick the initial selection id from `pickDefaultEnvironment`. On `error`
 * (no compatible default), returns `undefined` so the picker shows nothing
 * pre-selected; the user must still pick before launch.
 */
function initialSelectionId(
  options: readonly EnvironmentOption[],
  history: readonly EnvironmentHistoryEntry[],
  activeTab: ActiveTabContext | null
): string | undefined {
  const result = pickDefaultEnvironment({
    activeTab,
    history,
    candidates: options,
  });
  if (result.kind === 'ok') return result.option.id;
  return undefined;
}

export function EnvPickerDialog({
  open,
  options,
  history = [],
  activeTab = null,
  launchOverrides,
  onClose,
  onLaunched,
  launch = launchEnvironment,
}: EnvPickerDialogProps): React.ReactElement | null {
  // Compute the default selection once per open. We DO NOT recompute on every
  // render so the user's keyboard navigation isn't reset by upstream prop
  // jitter.
  const defaultId = useMemo(
    () => (open ? initialSelectionId(options, history, activeTab) : undefined),
    // Recompute only when the dialog opens, not on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open]
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(defaultId);
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  // Re-entry guard. We use a ref (not the `launching` state) because state
  // updates batch and a fast double-click would race past the `launching`
  // check before React schedules the re-render. The ref reflects the in-flight
  // launch synchronously. Per CodeRabbit feedback on PR #646.
  const launchInFlightRef = useRef(false);

  useEffect(() => {
    if (open) {
      setSelectedId(defaultId);
      setBlockReason(null);
      setLaunching(false);
      launchInFlightRef.current = false;
    }
  }, [open, defaultId]);

  const handleSelect = useCallback(
    async (option: EnvironmentOption) => {
      // Re-entry guard: ignore additional selects while a launch is pending.
      // Double-clicking a fresh option or hammering Enter would otherwise fire
      // duplicate create-session POSTs (CodeRabbit PR #646 feedback).
      if (launchInFlightRef.current) return;
      setSelectedId(option.id);
      // Always re-check freshness at launch time (defense-in-depth against the
      // picker surfacing a stale row).
      if (!canLaunchEnvironment(option)) {
        setBlockReason(
          describeBlockReason(option.freshness, option.degradedReasons)
        );
        return;
      }
      setBlockReason(null);
      setLaunching(true);
      launchInFlightRef.current = true;
      try {
        const result = await launch(option, launchOverrides);
        if (result.kind === 'blocked') {
          // Should not happen given the canLaunch gate above, but if the
          // launch hook ever rejects, surface the typed reason instead of
          // silently closing.
          setBlockReason(
            describeBlockReason(option.freshness, option.degradedReasons)
          );
          return;
        }
        onLaunched?.(result);
        onClose();
      } catch (error) {
        // Reject-path safety: if the launch hook throws (network blip,
        // capability check raised mid-flight, etc.) we MUST surface a typed
        // user-visible failure instead of silently swallowing the error and
        // leaving the dialog open with no feedback. Defense-in-depth against
        // the "never silently switch nodes" invariant — a thrown launch is
        // morally equivalent to a stale environment from the user's POV.
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown');
        setBlockReason(`launch failed: ${message.toLowerCase()}`);
      } finally {
        setLaunching(false);
        launchInFlightRef.current = false;
      }
    },
    [launch, launchOverrides, onClose, onLaunched]
  );

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!open) return null;

  const handleBackdropClick = (event: React.MouseEvent) => {
    if (
      (event.target as HTMLElement).classList.contains('env-picker-dialog__overlay')
    ) {
      onClose();
    }
  };

  return (
    <div
      className="env-picker-dialog__overlay"
      role="presentation"
      onClick={handleBackdropClick}
      data-testid="env-picker-dialog"
    >
      <div
        className="env-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="start work in environment"
      >
        <header className="env-picker-dialog__header">
          <h2 className="env-picker-dialog__title">start work in environment</h2>
          <button
            type="button"
            className="env-picker-dialog__close"
            onClick={handleCancel}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="env-picker-dialog__body">
          <EnvironmentPicker
            options={options as EnvironmentOption[]}
            onSelect={handleSelect}
            onCancel={handleCancel}
            {...(selectedId !== undefined ? { selectedOptionId: selectedId } : {})}
          />
          {blockReason ? (
            <div
              className="env-picker-dialog__block-reason"
              role="alert"
              data-testid="env-picker-dialog-block-reason"
            >
              {blockReason}
            </div>
          ) : null}
          {launching ? (
            <div
              className="env-picker-dialog__launching"
              data-testid="env-picker-dialog-launching"
            >
              launching…
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default EnvPickerDialog;
