/**
 * WorkbenchBlockCreateDialog (#631) — block-create entry point that wires the
 * EnvironmentPicker (#627) and safe-default selection (#628) into Workbench
 * block creation.
 *
 * Scope:
 *   - Renders the existing `EnvironmentPicker` against the supplied candidate
 *     option list. Defaults via `pickDefaultEnvironment`; if the default fails
 *     ("no fresh candidate", "active tab is degraded/missing"), the dialog
 *     surfaces the typed reason and blocks `create` instead of silently
 *     substituting a different node. This preserves the #615 acceptance
 *     criterion that launches never silently jump machines.
 *   - On confirm, calls `onCreate({ descriptor, environment, picker })` with a
 *     typed `WorkbenchBlockEnvironmentRef` built from the chosen option. The
 *     caller (WorkbenchCanvas / hub) owns the actual block-add side effect.
 *   - Pure presentational + small local state. No API calls, no router hooks,
 *     no Zustand store subscriptions. Mirrors the existing TUI aesthetic from
 *     `DESIGN.md` (lowercase, monospace, no emoji, outline-only chrome).
 *
 * What this component does NOT do:
 *   - Persist the block to the layout — that lives in the canvas layer.
 *   - Create a session — slice 5 / #629's launch hook does that. The dialog
 *     only chooses the env and emits the typed descriptor.
 *   - Validate the kind picker against capability-bit requirements at the
 *     dialog layer; the renderer + BlockHost already gate on capabilities at
 *     mount time.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EnvironmentPicker } from '../components/EnvironmentPicker.js';
import type { EnvironmentOption } from '../../../shared/environment-option.js';
import {
  pickDefaultEnvironment,
  type ActiveTabContext,
  type EnvironmentHistoryEntry,
  type PickDefaultEnvironmentErrorReason,
} from '../../../shared/safe-defaults.js';
import type { RelayCapabilityBit } from '../../../shared/security-policy.js';
import type { WorkbenchBlockDescriptor } from '../../../shared/workbench-block-types.js';
import {
  buildBlockEnvironmentRef,
  type WorkbenchBlockEnvironmentRef,
} from '../../../shared/workbench-block-environment.js';
import './workbench-block-create-dialog.css';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * Args fired by the dialog on confirm. Carries the typed env metadata so the
 * caller can attach it to a fresh descriptor (or hand it to #629's launch
 * hook) without ever re-deriving env IDs from prose strings.
 */
export interface WorkbenchBlockCreateRequest {
  /** Title the user entered (lowercase per DESIGN.md). */
  title: string;
  /** Block kind chosen in the dialog. */
  kind: WorkbenchBlockDescriptor['kind'];
  /** Typed env metadata destined for `descriptor.environment`. */
  environment: WorkbenchBlockEnvironmentRef;
  /** Original picker option, retained for adapters that want capability bits etc. */
  option: EnvironmentOption;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkbenchBlockCreateDialogProps {
  /** Picker candidate list, supplied by the caller from the env store. */
  candidates: readonly EnvironmentOption[];
  /** Active tab context for safe-default selection. */
  activeTab?: ActiveTabContext | null;
  /** Last-used env history, newest-first by caller convention. */
  history?: readonly EnvironmentHistoryEntry[];
  /** Capability bits the block kind requires; forwarded to the picker filter. */
  requiredCapabilities?: readonly RelayCapabilityBit[];
  /**
   * Whether File RPC is available on the selected node. When explicitly `false`,
   * file and artifact kinds are hidden from the kind picker so users don't
   * select a block that will immediately render a degraded card (#654).
   * `undefined` means unknown — all kinds are shown (optimistic default).
   */
  nodeFileRpcAvailable?: boolean;
  /** Fired on confirm. */
  onCreate: (req: WorkbenchBlockCreateRequest) => void;
  /** Fired on cancel / escape. */
  onCancel: () => void;
  /**
   * Wall-clock ISO timestamp. Injected so tests can pin createdAt. Defaults
   * to `new Date().toISOString()` at the call site of buildBlockEnvironmentRef.
   */
  nowIso?: () => string;
  /**
   * Default block kind to preselect. The dialog leaves the user free to
   * change it before confirming.
   */
  defaultKind?: WorkbenchBlockDescriptor['kind'];
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const ALL_SUPPORTED_KINDS: WorkbenchBlockDescriptor['kind'][] = [
  'terminal',
  'file',
  'markdown',
  'work-context',
  'artifact',
  'custom',
];

/**
 * Kinds that require File RPC. Hidden from the picker when the active node
 * explicitly reports file RPC as unavailable so users never pick a kind that
 * will immediately render a degraded card (#654 terminal-only fallback).
 */
const FILE_RPC_REQUIRED_KINDS: ReadonlySet<WorkbenchBlockDescriptor['kind']> =
  new Set(['file', 'artifact']);

function describeDefaultError(
  reason: PickDefaultEnvironmentErrorReason
): string {
  switch (reason) {
    case 'no-candidates':
      return 'no environments available — pair a node first';
    case 'active-tab-missing':
      return "the active tab's environment is no longer paired — pick a different one";
    case 'active-tab-degraded':
      return "the active tab's environment is stale or offline — pick a different one";
    case 'all-degraded':
      return 'no fresh environments available — try again once a node comes online';
    default: {
      const _exhaustive: never = reason;
      return String(_exhaustive);
    }
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function WorkbenchBlockCreateDialog({
  candidates,
  activeTab = null,
  history = [],
  requiredCapabilities,
  nodeFileRpcAvailable,
  onCreate,
  onCancel,
  nowIso,
  defaultKind = 'terminal',
}: WorkbenchBlockCreateDialogProps): React.ReactElement {
  // Derive which block kinds to offer. When the node explicitly lacks file RPC,
  // hide file-rpc-requiring kinds so users can't select them — they'd immediately
  // hit a NodeDegradedCard. Terminal, markdown, and other safe kinds remain.
  const supportedKinds = useMemo(
    () =>
      nodeFileRpcAvailable === false
        ? ALL_SUPPORTED_KINDS.filter((k) => !FILE_RPC_REQUIRED_KINDS.has(k))
        : ALL_SUPPORTED_KINDS,
    [nodeFileRpcAvailable]
  );

  // Default-selection result. Recomputed when inputs change so the typed
  // error message stays accurate as candidates load / nodes come online.
  const defaultResult = useMemo(
    () =>
      pickDefaultEnvironment({
        activeTab,
        history,
        candidates,
      }),
    [activeTab, history, candidates]
  );

  const [selectedId, setSelectedId] = useState<string | undefined>(
    defaultResult.kind === 'ok' ? defaultResult.option.id : undefined
  );
  const [kind, setKind] =
    useState<WorkbenchBlockDescriptor['kind']>(defaultKind);
  const [title, setTitle] = useState('');

  // If we didn't have a selection yet (candidates loaded after mount, or the
  // active tab's node just turned fresh), apply the first valid default that
  // becomes available. Explicit user navigation always wins because we only
  // fire while `selectedId === undefined`.
  useEffect(() => {
    if (selectedId === undefined && defaultResult.kind === 'ok') {
      setSelectedId(defaultResult.option.id);
    }
  }, [defaultResult, selectedId]);

  const defaultErrorMessage =
    defaultResult.kind === 'error'
      ? describeDefaultError(defaultResult.reason)
      : null;

  // Filter candidates by required capabilities at the picker layer. Resolves
  // up-front so the picker never offers an option that fails the block's
  // capability requirements (which would just hit a DeniedCard later).
  const filteredCandidates = useMemo(() => {
    if (!requiredCapabilities || requiredCapabilities.length === 0) {
      return candidates;
    }
    const required = new Set(requiredCapabilities);
    return candidates.filter((c) => {
      const advertised = new Set(c.capabilities);
      for (const bit of required) {
        if (!advertised.has(bit)) return false;
      }
      return true;
    });
  }, [candidates, requiredCapabilities]);

  const selectedOption = useMemo(
    () => filteredCandidates.find((c) => c.id === selectedId),
    [filteredCandidates, selectedId]
  );

  const handleSelect = useCallback((opt: EnvironmentOption) => {
    setSelectedId(opt.id);
  }, []);

  const canCreate =
    selectedOption !== undefined &&
    selectedOption.freshness === 'fresh' &&
    title.trim().length > 0;

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedOption || !canCreate) return;
      const createdAt = nowIso ? nowIso() : new Date().toISOString();
      const env = buildBlockEnvironmentRef({
        option: selectedOption,
        createdAt,
      });
      onCreate({
        title: title.trim(),
        kind,
        environment: env,
        option: selectedOption,
      });
    },
    [canCreate, kind, nowIso, onCreate, selectedOption, title]
  );

  return (
    <form
      className="workbench-block-create-dialog"
      data-testid="workbench-block-create-dialog"
      onSubmit={handleSubmit}
      aria-label="create workbench block"
    >
      <div className="workbench-block-create-dialog__header">
        <span className="workbench-block-create-dialog__title">
          create block
        </span>
        <button
          type="button"
          className="workbench-block-create-dialog__cancel"
          onClick={onCancel}
          aria-label="cancel"
        >
          esc
        </button>
      </div>

      <label className="workbench-block-create-dialog__field">
        <span className="workbench-block-create-dialog__label">title</span>
        <input
          type="text"
          className="workbench-block-create-dialog__input"
          data-testid="workbench-block-create-title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          placeholder="lowercase title"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="workbench-block-create-dialog__field">
        <span className="workbench-block-create-dialog__label">kind</span>
        <select
          className="workbench-block-create-dialog__select"
          data-testid="workbench-block-create-kind"
          value={kind}
          onChange={(e) =>
            setKind(e.currentTarget.value as WorkbenchBlockDescriptor['kind'])
          }
        >
          {supportedKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {nodeFileRpcAvailable === false && (
          <div
            className="workbench-block-create-dialog__file-rpc-note"
            role="note"
            data-testid="workbench-block-create-file-rpc-note"
          >
            file and artifact blocks hidden — file rpc unavailable on this node
          </div>
        )}
      </label>

      <div className="workbench-block-create-dialog__picker-section">
        <div className="workbench-block-create-dialog__label">environment</div>
        {defaultErrorMessage !== null ? (
          <div
            className="workbench-block-create-dialog__default-error"
            role="alert"
            data-testid="workbench-block-create-default-error"
          >
            {defaultErrorMessage}
          </div>
        ) : null}
        <EnvironmentPicker
          // `filteredCandidates` is already a fresh array from useMemo above
          // (or the unmodified `candidates` passthrough); no spread needed.
          // EnvironmentPicker accepts a mutable `EnvironmentOption[]`, so
          // we narrow the readonly prop with a cast rather than copying.
          options={filteredCandidates as EnvironmentOption[]}
          {...(selectedId !== undefined
            ? { selectedOptionId: selectedId }
            : {})}
          onSelect={handleSelect}
          onCancel={onCancel}
          autoFocusSearch={false}
        />
      </div>

      <div className="workbench-block-create-dialog__actions">
        <button
          type="submit"
          className="workbench-block-create-dialog__confirm"
          data-testid="workbench-block-create-confirm"
          disabled={!canCreate}
          aria-disabled={!canCreate}
        >
          create
        </button>
        <button
          type="button"
          className="workbench-block-create-dialog__cancel-btn"
          onClick={onCancel}
        >
          cancel
        </button>
      </div>
    </form>
  );
}

export default WorkbenchBlockCreateDialog;
