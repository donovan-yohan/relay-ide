// #730 (Epic #444 view-spine): Bench-creation flow on an Instance row. A Bench
// is a cwd + env layered on an Instance; for a repo-instance the cwd defaults to
// a worktree path under the repo, for a node-instance it is an arbitrary
// absolute cwd. Flag-gated by its only mount point (`ViewSpineTree`, which is
// only rendered when `viewSpineEnabled`).
//
// Wired to the #735 `/hub/ia/benches` CRUD API via `useIaBenchMutations`. This
// component owns the CREATE form + the "+ bench" affordance ONLY. The PERSISTED
// overlay rows are rendered by `InstanceRow` (`ViewSpineTree`) as part of the
// #773 derived-vs-overlay dedup (one row per cwd), so this component no longer
// renders a separate overlay list. Scope: CREATE + minimal DELETE (delete is
// invoked from the merged row); env-override INHERITANCE into tabs is out of
// scope (#740).
//
// C1 (from #735 review): a bench `cwd` is sent and displayed VERBATIM — never
// `decodeURIComponent`-ed. The raw absolute path the user enters is the path the
// hub mints the BenchId from.
//
// States: error (non-destructive inline message + refetch), in-flight (form
// disabled while a create/delete is pending), validation (cwd rejected
// client-side mirroring the server). Touch targets ≥44px; full keyboard support
// (Enter submits, Escape cancels).
import { useMemo, useState } from 'react';

import { useIaBenchMutations } from '../lib/hooks/use-ia-benches.js';
import {
  benchCwdErrorMessage,
  buildBenchPayload,
  validateBenchCwd,
  type EnvOverrideEntry,
} from '../lib/state/bench-create.js';
import type { ViewTreeProject } from '../lib/state/view-tree.js';
import { createLogger } from '../lib/logger.js';
import './BenchCreate.css';

const logger = createLogger('bench-create');

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

interface BenchCreateFormProps {
  projectKind: ViewTreeProject['kind'];
  defaultCwd: string;
  busy: boolean;
  onSubmit: (input: {
    cwd: string;
    label: string;
    envEntries: EnvOverrideEntry[];
  }) => void;
  onCancel: () => void;
}

function BenchCreateForm({
  projectKind,
  defaultCwd,
  busy,
  onSubmit,
  onCancel,
}: BenchCreateFormProps) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [label, setLabel] = useState('');
  const [envEntries, setEnvEntries] = useState<EnvOverrideEntry[]>([]);
  // Validate only AFTER a submit attempt, so the field isn't red on first open.
  const [touched, setTouched] = useState(false);

  const cwdError = useMemo(() => validateBenchCwd(cwd), [cwd]);
  const showCwdError = touched && cwdError !== null;

  function updateEnv(index: number, patch: Partial<EnvOverrideEntry>) {
    setEnvEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, ...patch } : e))
    );
  }

  function submit() {
    setTouched(true);
    if (busy) return;
    if (validateBenchCwd(cwd) !== null) return;
    onSubmit({ cwd, label, envEntries });
  }

  const cwdPlaceholder =
    projectKind === 'repo'
      ? '/abs/path/to/worktree'
      : '/home/you/project or /tmp/scratch';

  return (
    <div className="bench-create-form">
      <label className="bench-create-field">
        <span className="bench-create-label">cwd</span>
        <input
          type="text"
          className="bench-create-input"
          value={cwd}
          placeholder={cwdPlaceholder}
          disabled={busy}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-invalid={showCwdError}
          aria-label="bench cwd (absolute path)"
          onChange={(e) => setCwd(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
      </label>
      {showCwdError && cwdError ? (
        <div className="bench-create-validation" role="alert">
          {benchCwdErrorMessage(cwdError)}
        </div>
      ) : null}

      <label className="bench-create-field">
        <span className="bench-create-label">label</span>
        <input
          type="text"
          className="bench-create-input"
          value={label}
          placeholder="optional"
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label="bench label (optional)"
          onChange={(e) => setLabel(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
      </label>

      <div className="bench-create-env">
        <span className="bench-create-label">env overrides (optional)</span>
        {envEntries.map((entry, index) => (
          <div className="bench-create-env-row" key={index}>
            <input
              type="text"
              className="bench-create-input bench-create-env-key"
              value={entry.key}
              placeholder="KEY"
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              aria-label={`env override key ${index + 1}`}
              onChange={(e) => updateEnv(index, { key: e.currentTarget.value })}
            />
            <span className="bench-create-env-eq">=</span>
            <input
              type="text"
              className="bench-create-input bench-create-env-value"
              value={entry.value}
              placeholder="value"
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              aria-label={`env override value ${index + 1}`}
              onChange={(e) =>
                updateEnv(index, { value: e.currentTarget.value })
              }
            />
            <button
              type="button"
              className="bench-create-env-remove"
              disabled={busy}
              aria-label={`remove env override ${index + 1}`}
              title="remove"
              onClick={() =>
                setEnvEntries((prev) => prev.filter((_, i) => i !== index))
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="bench-create-env-add"
          disabled={busy}
          onClick={() =>
            setEnvEntries((prev) => [...prev, { key: '', value: '' }])
          }
        >
          + env var
        </button>
      </div>

      <div className="bench-create-actions">
        <button
          type="button"
          className="bench-create-submit"
          disabled={busy}
          onClick={submit}
        >
          {busy ? 'creating…' : 'create bench'}
        </button>
        <button
          type="button"
          className="bench-create-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

export function BenchCreate({
  instanceId,
  projectKind,
  defaultCwd,
  onRefetch,
}: {
  instanceId: string;
  projectKind: ViewTreeProject['kind'];
  /** Pre-filled cwd for a repo-instance (the parent repo path); empty for a
   *  node-instance (arbitrary absolute cwd). */
  defaultCwd: string;
  /** Refetch the (tree-level) bench cache — used to reconcile after a failed
   *  create. The list itself is owned by `InstanceRow` (#773 single query). */
  onRefetch: () => void;
}) {
  const { createMutation } = useIaBenchMutations(instanceId);
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const busy = createMutation.isPending;

  function clearError() {
    setActionError(null);
  }

  function handleCreate(input: {
    cwd: string;
    label: string;
    envEntries: EnvOverrideEntry[];
  }) {
    clearError();
    const payload = buildBenchPayload({
      instanceId,
      cwd: input.cwd,
      label: input.label,
      envEntries: input.envEntries,
    });
    createMutation.mutate(payload, {
      onSuccess: () => {
        setOpen(false);
      },
      onError: (err) => {
        logger.warn('create bench failed', err);
        setActionError(errorMessage(err, 'could not create bench'));
      },
    });
  }

  return (
    <div className="bench-create">
      {open ? (
        <BenchCreateForm
          projectKind={projectKind}
          defaultCwd={defaultCwd}
          busy={busy}
          onSubmit={handleCreate}
          onCancel={() => {
            clearError();
            setOpen(false);
          }}
        />
      ) : (
        // Reuses the ViewSpine-scoped `.add-worktree-row`/`.add-worktree-btn`
        // affordance token (same primitive as the "+ tab" row), distinct copy
        // `+ bench`.
        <div
          className="add-worktree-row"
          data-track="view-spine.new-bench"
          onClick={() => {
            clearError();
            setOpen(true);
          }}
        >
          <button className="add-worktree-btn" type="button" tabIndex={0}>
            + bench
          </button>
        </div>
      )}

      {actionError ? (
        <div className="bench-create-error" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            className="bench-create-retry"
            onClick={() => {
              clearError();
              onRefetch();
            }}
          >
            retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default BenchCreate;
