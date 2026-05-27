/**
 * PromptFanoutBlock — issue #705 mock comparison workbench shell.
 *
 * Renders Relay-owned PromptFanoutRun fixtures/schema data only. The dry-run
 * action emits an audit event for previewability and intentionally never writes
 * to a terminal, tmux pane, provider process, or rmux runtime.
 */

import React, { useMemo, useState } from 'react';

import type {
  PromptFanoutRun,
  PromptFanoutTarget,
  PromptFanoutTargetResult,
} from '../../../../shared/prompt-fanout-run.js';
import {
  promptFanoutHasPartialFailure,
  promptFanoutStatusCounts,
  selectedPromptFanoutTargets,
  unselectedPromptFanoutTargets,
} from '../../../../shared/prompt-fanout-run.js';
import { getPromptFanoutRunFixture } from '../../../../shared/prompt-fanout-fixtures.js';
import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';

import './prompt-fanout.css';

type ResultByTarget = Map<string, PromptFanoutTargetResult>;

const STATUS_LABELS: Record<PromptFanoutTargetResult['status'], string> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'success',
  failed: 'failed',
  denied: 'denied',
  timeout: 'timeout',
  skipped: 'skipped',
};

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return 'pending';
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 100) / 10}s`;
}

function targetRuntime(target: PromptFanoutTarget): string {
  return target.actorRef?.runtime ?? target.actorRef?.providerId ?? 'unknown';
}

function TargetRow({
  target,
  result,
  muted = false,
}: {
  target: PromptFanoutTarget;
  result?: PromptFanoutTargetResult | undefined;
  muted?: boolean;
}) {
  const status = result?.status ?? (target.eligible ? 'queued' : 'skipped');
  const detail =
    result?.response?.summary ?? result?.error?.message ?? target.deniedReason;

  return (
    <div
      className={[
        'block-prompt-fanout__target',
        `block-prompt-fanout__target--${status}`,
        muted ? 'block-prompt-fanout__target--muted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="block-prompt-fanout__target-main">
        <span className="block-prompt-fanout__status">
          {STATUS_LABELS[status]}
        </span>
        <span className="block-prompt-fanout__target-label">
          {target.label}
        </span>
        <span className="block-prompt-fanout__target-runtime">
          {targetRuntime(target)}
        </span>
      </div>
      <div className="block-prompt-fanout__target-meta">
        <span>{target.nodeLabel ?? target.sessionRef?.nodeId ?? 'node unknown'}</span>
        <span>{formatDuration(result?.durationMs)}</span>
      </div>
      {detail && <div className="block-prompt-fanout__target-detail">{detail}</div>}
    </div>
  );
}

function EmptyState({ run }: { run?: PromptFanoutRun }) {
  return (
    <div
      className="block-prompt-fanout block-prompt-fanout--empty"
      aria-label="prompt fanout empty state"
    >
      <div className="block-prompt-fanout__heading">no eligible targets</div>
      <div className="block-prompt-fanout__detail">
        no selected agent sessions are eligible for this dry-run fixture. relay
        will not broadcast to every session by default.
      </div>
      {run && (
        <div className="block-prompt-fanout__detail">run: {run.id}</div>
      )}
    </div>
  );
}

export const PromptFanoutBlock: WorkbenchBlockRenderer<'prompt-fanout'> = ({
  descriptor,
  context,
}) => {
  const [dryRunNotice, setDryRunNotice] = useState<string | null>(null);
  const meta = descriptor.meta;
  const run = meta.run ?? getPromptFanoutRunFixture(meta.fixture ?? 'all-success');

  const selectedTargets = useMemo(
    () => selectedPromptFanoutTargets(run),
    [run]
  );
  const unselectedTargets = useMemo(
    () => unselectedPromptFanoutTargets(run),
    [run]
  );
  const resultByTarget: ResultByTarget = useMemo(
    () => new Map(run.results.map((result) => [result.targetId, result])),
    [run.results]
  );
  const counts = useMemo(() => promptFanoutStatusCounts(run), [run]);
  const partialFailure = promptFanoutHasPartialFailure(run);
  const loading = meta.loading === true || run.state === 'loading';

  const dryRunDisabled = selectedTargets.length === 0 || loading;

  function handleDryRun() {
    const selectedTargetIds = selectedTargets.map((target) => target.id);
    context.emitAuditEvent({
      type: 'prompt-fanout.dry-run',
      payload: {
        runId: run.id,
        workContextId: run.workContextId,
        selectedTargetIds,
        sendsTerminalInput: false,
      },
    });
    setDryRunNotice(
      `dry-run queued for ${selectedTargetIds.length} selected target${
        selectedTargetIds.length === 1 ? '' : 's'
      }; terminal input not sent`
    );
  }

  if (loading) {
    return (
      <div
        className="block-prompt-fanout block-prompt-fanout--loading"
        aria-label="prompt fanout loading state"
      >
        <span className="block-prompt-fanout__spinner">&#x280B;</span>
        <span className="block-prompt-fanout__detail">
          loading selected target comparison…
        </span>
      </div>
    );
  }

  if (selectedTargets.length === 0 || run.allTargets.length === 0) {
    return <EmptyState run={run} />;
  }

  return (
    <div
      className={[
        'block-prompt-fanout',
        partialFailure ? 'block-prompt-fanout--partial-failure' : '',
        run.state === 'denied' ? 'block-prompt-fanout--denied' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`prompt fanout run: ${descriptor.title}`}
    >
      <div className="block-prompt-fanout__header">
        <div>
          <div className="block-prompt-fanout__kind">prompt fanout</div>
          <div className="block-prompt-fanout__title">{descriptor.title}</div>
        </div>
        <div className="block-prompt-fanout__run-state">{run.state}</div>
      </div>

      <div className="block-prompt-fanout__section">
        <div className="block-prompt-fanout__label">prompt</div>
        <div className="block-prompt-fanout__prompt-title">
          {run.prompt.title}
        </div>
        <div className="block-prompt-fanout__prompt-preview">
          {run.prompt.bodyPreview}
        </div>
        <div className="block-prompt-fanout__meta-line">
          <span>work context: {run.workContextId}</span>
          <span>tokens: {run.prompt.tokenEstimate ?? 'n/a'}</span>
          <span>{run.prompt.dryRun ? 'dry-run only' : 'live disabled'}</span>
        </div>
      </div>

      <div className="block-prompt-fanout__section block-prompt-fanout__section--actions">
        <button
          type="button"
          className="block-prompt-fanout__dry-run"
          onClick={handleDryRun}
          disabled={dryRunDisabled}
        >
          dry-run selected targets
        </button>
        <span className="block-prompt-fanout__detail">
          no broadcast-to-all default; {selectedTargets.length} of{' '}
          {run.allTargets.length} sessions selected
        </span>
        {dryRunNotice && (
          <span className="block-prompt-fanout__notice">{dryRunNotice}</span>
        )}
      </div>

      <div className="block-prompt-fanout__section">
        <div className="block-prompt-fanout__label">selected targets</div>
        <div className="block-prompt-fanout__targets">
          {selectedTargets.map((target) => (
            <TargetRow
              key={target.id}
              target={target}
              result={resultByTarget.get(target.id)}
            />
          ))}
        </div>
      </div>

      {unselectedTargets.length > 0 && (
        <div className="block-prompt-fanout__section">
          <div className="block-prompt-fanout__label">all sessions not selected</div>
          <div className="block-prompt-fanout__targets">
            {unselectedTargets.map((target) => (
              <TargetRow
                key={target.id}
                target={target}
                result={resultByTarget.get(target.id)}
                muted
              />
            ))}
          </div>
        </div>
      )}

      {(partialFailure || run.errors.length > 0) && (
        <div className="block-prompt-fanout__section block-prompt-fanout__section--errors">
          <div className="block-prompt-fanout__label">errors</div>
          {run.errors.map((error) => (
            <div key={`${error.code}:${error.message}`} className="block-prompt-fanout__error">
              <span>{error.code}</span>
              <span>{error.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="block-prompt-fanout__footer">
        <span>run: {run.id}</span>
        <span>success: {counts.succeeded}</span>
        <span>failed: {counts.failed + counts.denied + counts.timeout}</span>
      </div>
    </div>
  );
};

export default PromptFanoutBlock;
