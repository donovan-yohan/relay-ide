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
  EnvironmentAgentProvider,
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
  type LaunchBlockedReason,
  type LaunchEnvironmentOptions,
  type LaunchEnvironmentResult,
} from '../../lib/launch-environment.js';
import './EnvPickerDialog.css';

export interface EnvPickerDialogProps {
  open: boolean;
  /**
   * Mutable shape (not `readonly`) because the downstream
   * `EnvironmentPicker` (#627) takes `EnvironmentOption[]`. We don't mutate
   * here, but typing the prop as `readonly` would force a cast at the
   * `<EnvironmentPicker>` boundary (Gemini PR #646 feedback). When #627's
   * picker is later updated to take `readonly`, this loosens to readonly.
   */
  options: EnvironmentOption[];
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
 * #863: render a typed {@link LaunchBlockedReason} returned by the launch hook
 * (the defense-in-depth path). The dialog already pre-empts the common cases
 * (freshness gating + the provider gate at {@link handleSelect}), so this only
 * fires when the hook's own guard rejects after the dialog's checks — e.g. a
 * race where the UI's disabled state and the launch hook desync, or an injected
 * hook. We MUST pattern-match `provider-unavailable` here: defaulting to the
 * freshness renderer would surface misleading "stale" copy for a fresh node
 * whose provider is simply unavailable. Falls back to the freshness renderer
 * for the `stale | offline | updating` codes. Lowercase per DESIGN.md.
 */
function describeLaunchBlockedReason(
  option: EnvironmentOption,
  reason: LaunchBlockedReason
): string {
  if (reason.code === 'provider-unavailable') {
    const detail =
      reason.providerReason?.trim() ||
      (reason.availability === 'degraded'
        ? 'degraded'
        : reason.availability === 'unavailable'
          ? 'unavailable'
          : 'status unknown');
    const auth = reason.authStatus?.trim();
    const tail = auth ? `${detail} — ${auth}` : detail;
    return `${reason.agent} unavailable — ${tail}`.toLowerCase();
  }
  return describeBlockReason(option.freshness, option.degradedReasons);
}

/**
 * #863: a launch target the user picks for the selected option. `terminal` is
 * the always-available bare shell; `{ kind: 'agent', agent }` launches the
 * named provider. We model this as a discriminated union (not a bare string)
 * so the launch path maps it onto `launchOverrides` without re-parsing a
 * `'agent:<id>'` sentinel — and so the `terminal` default is unambiguous.
 */
export type LaunchTarget =
  | { kind: 'terminal' }
  | { kind: 'agent'; agent: string };

const TERMINAL_TARGET: LaunchTarget = { kind: 'terminal' };

function isSameTarget(a: LaunchTarget, b: LaunchTarget): boolean {
  if (a.kind === 'terminal') return b.kind === 'terminal';
  return b.kind === 'agent' && a.agent === b.agent;
}

/**
 * #863: an agent provider is selectable only when the node reports it
 * `available`. `degraded | unavailable | unknown` are rendered but disabled so
 * the user can SEE the provider (and why it cannot launch) without it ever
 * blocking the terminal path on the same node.
 */
function isProviderSelectable(provider: EnvironmentAgentProvider): boolean {
  return provider.availability === 'available';
}

/**
 * #863: short, lowercase reason for a non-selectable provider, sourced from the
 * provider's own `reason` (RelayNodeErrorCode-derived, #861) with a typed
 * availability fallback so the row is never silently disabled. Auth status is
 * appended when the node reports one (e.g. `logged out`) so the user knows the
 * remediation without a parallel string table. Lowercase per DESIGN.md.
 */
function describeProviderReason(provider: EnvironmentAgentProvider): string {
  const base =
    provider.reason?.trim() ||
    (provider.availability === 'degraded'
      ? 'degraded'
      : provider.availability === 'unavailable'
        ? 'unavailable'
        : 'status unknown');
  const auth = provider.authStatus?.trim();
  const head = auth ? `${base} — ${auth}` : base;
  return head.toLowerCase();
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
  // #863: the launch target chosen for the selected option. Defaults to
  // `terminal` so the #862 zero-extra-clicks shell launch path is preserved —
  // an agent launch is an explicit opt-in, never the friction default. When the
  // caller threads `launchOverrides={{ type: 'agent', agent }}` we honor it as
  // the initial target so an agent-first entry point opens pre-selected.
  const initialTarget = useMemo<LaunchTarget>(
    () =>
      launchOverrides?.type === 'agent' && launchOverrides.agent
        ? { kind: 'agent', agent: launchOverrides.agent }
        : TERMINAL_TARGET,
    [launchOverrides?.type, launchOverrides?.agent]
  );
  const [launchTarget, setLaunchTarget] = useState<LaunchTarget>(initialTarget);
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
      setLaunchTarget(initialTarget);
      setBlockReason(null);
      setLaunching(false);
      launchInFlightRef.current = false;
    }
  }, [open, defaultId, initialTarget]);

  const handleSelect = useCallback(
    async (option: EnvironmentOption, targetOverride?: LaunchTarget) => {
      // Re-entry guard: ignore additional selects while a launch is pending.
      // Double-clicking a fresh option or hammering Enter would otherwise fire
      // duplicate create-session POSTs (CodeRabbit PR #646 feedback).
      if (launchInFlightRef.current) return;
      setSelectedId(option.id);
      // #863: resolve the effective launch target. An explicit click on a
      // provider button threads `targetOverride`; a row activation uses the
      // currently-chosen target (terminal by default — the #862 zero-extra-
      // clicks path). If the chosen target is an agent it MUST still be
      // available on THIS option's node; the providers belong to a specific
      // node, so a stale agent selection from another row falls back to the
      // always-safe terminal target rather than launching a provider the node
      // can't run.
      const requested = targetOverride ?? launchTarget;
      const providers = option.node.agentProviders ?? [];
      let effectiveTarget: LaunchTarget = requested;
      if (requested.kind === 'agent') {
        const provider = providers.find((p) => p.id === requested.agent);
        if (!provider) {
          effectiveTarget = TERMINAL_TARGET;
        } else if (!isProviderSelectable(provider)) {
          // The user explicitly picked an unavailable provider — surface its
          // typed reason rather than silently downgrading to a terminal (that
          // would be a kind-switch as silent as a node-switch).
          setBlockReason(
            `${provider.id} unavailable — ${describeProviderReason(provider)}`
          );
          return;
        }
      }
      setLaunchTarget(effectiveTarget);
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
      // #862/#863: build the launch overrides from the resolved target. A
      // `terminal` target is the bare shell (unchanged from #862); an `agent`
      // target threads the chosen provider so the launch rides the SAME
      // `executeSessionCreateAction` contract (#849) with `agent` set — no
      // provider-specific UI-only launch path.
      const overrides: LaunchEnvironmentOptions =
        effectiveTarget.kind === 'agent'
          ? { type: 'agent', agent: effectiveTarget.agent }
          : { type: 'terminal' };
      try {
        const result = await launch(option, overrides);
        if (result.kind === 'blocked') {
          // Should not happen given the canLaunch + provider gates above, but
          // if the launch hook's own guard rejects (race where the UI disabled
          // state and the hook desync, or an injected hook), surface the TYPED
          // reason. We must route a `provider-unavailable` code through the
          // provider renderer rather than the freshness fallback — defaulting
          // to freshness copy would mislabel a fresh node as "stale" when the
          // real cause is an unavailable provider.
          setBlockReason(
            describeLaunchBlockedReason(option, result.reason)
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
    [launch, launchTarget, onClose, onLaunched]
  );

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  // #863: launch the currently-selected option with an explicit target chosen
  // from the chooser. Reuses `handleSelect` so freshness gating, the re-entry
  // guard, and the typed block-reason path are shared with row activation.
  const handleLaunchTarget = useCallback(
    (option: EnvironmentOption | undefined, target: LaunchTarget) => {
      if (!option) return;
      void handleSelect(option, target);
    },
    [handleSelect]
  );

  // The option whose providers the launch-target chooser reflects. Providers
  // are per-node, so the chooser tracks the currently-selected row.
  const selectedOption = useMemo(
    () => options.find((opt) => opt.id === selectedId),
    [options, selectedId]
  );
  const providers = selectedOption?.node.agentProviders ?? [];

  // #862/#863: title copy switches on the resolved launch target. A bare
  // terminal reads as a terminal launcher (#862); an agent target names the
  // provider so the modal reads as an agent launcher. Falls back to the
  // generic "start work" framing only when the caller threads neither a
  // terminal override nor an agent selection. Lowercase per DESIGN.md.
  const dialogTitle =
    launchTarget.kind === 'agent'
      ? `start ${launchTarget.agent} in environment`
      : launchOverrides?.type === 'terminal'
        ? 'start terminal in environment'
        : 'start work in environment';

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
        aria-label={dialogTitle}
      >
        <header className="env-picker-dialog__header">
          <h2 className="env-picker-dialog__title">{dialogTitle}</h2>
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
            options={options}
            onSelect={handleSelect}
            onCancel={handleCancel}
            {...(selectedId !== undefined ? { selectedOptionId: selectedId } : {})}
          />
          {/* #863: launch-target chooser for the selected option. `terminal`
              is always present and always enabled for a launchable node (an
              unavailable agent provider never blocks it). Available providers
              are selectable; degraded/unavailable/unknown render disabled with
              their typed reason visible. The chooser only shows once a row is
              selected so it reflects that node's providers (providers are
              per-node). DESIGN.md: outline-only buttons, lowercase, 0 radius;
              disabled = opacity 0.4 + cursor not-allowed. */}
          {selectedOption ? (
            <div
              className="env-picker-dialog__targets"
              role="group"
              aria-label="launch target"
              data-testid="env-picker-dialog-targets"
            >
              <button
                type="button"
                className={[
                  'env-picker-dialog__target',
                  isSameTarget(launchTarget, TERMINAL_TARGET)
                    ? 'env-picker-dialog__target--selected'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-testid="env-picker-dialog-target-terminal"
                data-target="terminal"
                aria-pressed={isSameTarget(launchTarget, TERMINAL_TARGET)}
                disabled={launching}
                onClick={() =>
                  handleLaunchTarget(selectedOption, TERMINAL_TARGET)
                }
              >
                terminal
              </button>
              {providers.map((provider) => {
                const selectable = isProviderSelectable(provider);
                const target: LaunchTarget = {
                  kind: 'agent',
                  agent: provider.id,
                };
                const reason = selectable
                  ? undefined
                  : describeProviderReason(provider);
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className={[
                      'env-picker-dialog__target',
                      isSameTarget(launchTarget, target)
                        ? 'env-picker-dialog__target--selected'
                        : '',
                      selectable ? '' : 'env-picker-dialog__target--disabled',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-testid="env-picker-dialog-target-agent"
                    data-target="agent"
                    data-agent={provider.id}
                    data-availability={provider.availability}
                    aria-pressed={isSameTarget(launchTarget, target)}
                    disabled={!selectable || launching}
                    {...(reason ? { title: reason } : {})}
                    onClick={() => handleLaunchTarget(selectedOption, target)}
                  >
                    <span className="env-picker-dialog__target-label">
                      {provider.id}
                    </span>
                    {reason ? (
                      <span
                        className="env-picker-dialog__target-reason"
                        data-testid="env-picker-dialog-target-reason"
                      >
                        {reason}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
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
