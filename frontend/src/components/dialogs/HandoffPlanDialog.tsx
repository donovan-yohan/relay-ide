import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HandoffPlan, HandoffRun } from '../../../../shared/handoff.js';
import {
  DEFAULT_HANDOFF_FIXTURE_KEY,
  HANDOFF_CANONICAL_COPY,
  HANDOFF_FIXTURE_ORDER,
  getHandoffPlanFixture,
  fixtureTransferModeLabel,
  type HandoffFixtureKey,
  type HandoffPlanFixture,
} from '../../lib/handoff-fixtures.js';
import {
  buildHandoffDraft,
  createHandoffFromPlan,
  handoffStatusFromError,
  planHandoff,
  type HandoffApiErrorView,
  type HandoffDraft,
  type HandoffLiveStatus,
} from '../../lib/handoff-live.js';
import type { SessionSummary } from '../../lib/types.js';
import { TuiButton } from '../TuiButton.js';
import './HandoffPlanDialog.css';

export interface HandoffPlanDialogProps {
  open: boolean;
  onClose: () => void;
  initialFixture?: HandoffFixtureKey;
  mode?: 'live' | 'fixture';
  activeSession?: SessionSummary | null;
}

interface PlanView {
  plan: HandoffPlan;
  status: HandoffLiveStatus | HandoffPlanFixture['status'];
  statusCopy: string;
  confirmLabel: string;
  confirmDisabledReason: string | null;
  sourceSessionOutcome: string;
  agentContinuation: { mode: string; confidence: string; summary: string };
  showFixtures: boolean;
}

function fileSizeLabel(bytes: number): string {
  if (bytes <= 0) return '0 b';
  if (bytes < 1024) return `${bytes} b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} mb`;
}

function statusLabel(status: HandoffLiveStatus | HandoffPlanFixture['status']): string {
  return status.replaceAll('-', ' ');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="handoff-plan-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="handoff-plan-kv">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="handoff-plan-empty">{text}</p>;
}

function FileGroups({ plan }: { plan: HandoffPlan }) {
  return (
    <div className="handoff-plan-file-groups">
      <details open={plan.includedGroups.length <= 1}>
        <summary>includes · {plan.includedGroups.length}</summary>
        {plan.includedGroups.length ? (
          <ul>
            {plan.includedGroups.map((group) => (
              <li key={group}>{group.replaceAll('-', ' ')}</li>
            ))}
          </ul>
        ) : (
          <EmptyLine text="nothing selected for transfer" />
        )}
      </details>
      <details open={false}>
        <summary>excludes · {plan.excludedGroups.length}</summary>
        {plan.excludedGroups.length ? (
          <ul>
            {plan.excludedGroups.map((group) => (
              <li key={group}>{group.replaceAll('-', ' ')}</li>
            ))}
          </ul>
        ) : (
          <EmptyLine text="no excluded groups" />
        )}
      </details>
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apiErrorMessage(error: HandoffApiErrorView): string {
  if (error.code === 'CAPABILITY_DENIED') {
    return 'capability denied: handoff grants are not available to this browser session yet';
  }
  if (error.code === 'SOURCE_STALE_OR_OFFLINE') {
    return 'source is stale or offline; refresh the active WorkContext before retrying';
  }
  if (error.code === 'DESTINATION_UNAVAILABLE') {
    return 'hub unavailable; plan cannot start a destination session yet';
  }
  return error.message;
}

function conflictsFromError(error: HandoffApiErrorView) {
  const conflicts = error.details?.conflicts;
  return Array.isArray(conflicts) ? conflicts.filter(isRecord) : [];
}

function runFromError(error: HandoffApiErrorView): HandoffRun | null {
  const run = error.details?.run;
  return isRecord(run) ? (run as unknown as HandoffRun) : null;
}

function fixtureView(fixture: HandoffPlanFixture): PlanView {
  return {
    plan: fixture.plan,
    status: fixture.status,
    statusCopy: fixture.statusCopy,
    confirmLabel: fixture.confirmLabel,
    confirmDisabledReason: fixture.confirmDisabledReason,
    sourceSessionOutcome: fixture.sourceSessionOutcome,
    agentContinuation: fixture.agentContinuation,
    showFixtures: true,
  };
}

function liveView(plan: HandoffPlan, run: HandoffRun | null): PlanView {
  const hasConflicts = plan.conflicts.length > 0;
  const needsGrants = plan.requiredGrants.some((grant) => grant.decision !== 'allow');
  const status: HandoffLiveStatus = run
    ? 'created'
    : hasConflicts
      ? 'blocked'
      : needsGrants
        ? 'needs-grants'
        : 'ready';
  const confirmDisabledReason = hasConflicts
    ? 'blocked: resolve plan conflicts before starting a hub-side session'
    : run
      ? `run ${run.id} is ${run.state}`
      : null;
  return {
    plan,
    status,
    statusCopy: run
      ? `handoff API returned run ${run.id} (${run.state}); raw logs and transcripts are not exposed`
      : hasConflicts
        ? 'live API returned conflicts; cold handoff is review-only until resolved'
        : needsGrants
          ? 'live API returned a valid plan; confirm explicitly allows the listed grants for this cold snapshot'
          : 'live API returned a clean plan; ready to request a hub-side continuation',
    confirmLabel: run ? 'handoff requested' : 'start on hub',
    confirmDisabledReason,
    sourceSessionOutcome: plan.source.disposition.replaceAll('-', ' '),
    agentContinuation: {
      mode: plan.launchPreview.runtime.kind,
      confidence: 'server planned',
      summary: plan.launchPreview.summary,
    },
    showFixtures: false,
  };
}

function PlanDetails({ view }: { view: PlanView }) {
  const plan = view.plan;
  const routeLabel = `${plan.route.sourceNodeId} -> ${plan.route.destinationNodeId}`;
  const transferSummary = `${plan.fileCount} files · ${fileSizeLabel(plan.byteCount)} · ${fixtureTransferModeLabel(plan.transferMode)}`;
  return (
    <>
      <div className="handoff-plan-status" data-status={view.status}>
        <span>{statusLabel(view.status)}</span>
        <strong>{view.statusCopy}</strong>
      </div>

      <Section title="route">
        <div className="handoff-plan-grid">
          <KeyValue label="path" value={routeLabel} />
          <KeyValue label="workcontext" value={plan.route.workContextId} />
          <KeyValue label="source cwd" value={plan.source.cwd} />
          <KeyValue label="destination path" value={plan.destinationProposal.cwd} />
        </div>
      </Section>

      <Section title="transfer mode">
        <div className="handoff-plan-grid">
          <KeyValue label="mode" value={fixtureTransferModeLabel(plan.transferMode)} />
          <KeyValue label="payload" value={transferSummary} />
          <KeyValue label="destination action" value={plan.destinationProposal.action ?? 'use cwd'} />
          <KeyValue label="launch runtime" value={plan.launchPreview.runtime.providerId ?? plan.launchPreview.runtime.kind} />
        </div>
      </Section>

      <Section title="includes and excludes">
        <FileGroups plan={plan} />
        {plan.pathMappings.length ? (
          <ul className="handoff-plan-paths">
            {plan.pathMappings.map((mapping) => (
              <li key={`${mapping.kind}:${mapping.destination.path}`}>
                <span>{mapping.kind}</span>
                <strong>{mapping.summary ?? mapping.destination.path}</strong>
                <em>{mapping.destination.path}</em>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyLine text="no files selected; continuation uses metadata only" />
        )}
      </Section>

      <Section title="conflicts">
        {plan.conflicts.length ? (
          <ul className="handoff-plan-list handoff-plan-list--danger">
            {plan.conflicts.map((item) => (
              <li key={`${item.code}:${item.message}`}>
                <span>{item.code.toLowerCase().replaceAll('_', ' ')}</span>
                <strong>{item.message}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyLine text="no conflicts returned by this plan" />
        )}
      </Section>

      <Section title="grants">
        {plan.requiredGrants.length ? (
          <ul className="handoff-plan-list handoff-plan-list--warning">
            {plan.requiredGrants.map((grant) => (
              <li key={`${grant.leg}:${grant.capability}`}>
                <span>{grant.leg.replaceAll('-', ' ')}</span>
                <strong>{grant.capability}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyLine text="no additional grants requested" />
        )}
      </Section>

      <Section title="source session outcome">
        <p className="handoff-plan-copy">{view.sourceSessionOutcome}</p>
      </Section>

      <Section title="launch summary">
        <p className="handoff-plan-copy">{plan.launchPreview.summary}</p>
      </Section>

      <Section title="agent continuation">
        <div className="handoff-plan-grid">
          <KeyValue label="mode" value={view.agentContinuation.mode.replaceAll('-', ' ')} />
          <KeyValue label="confidence" value={view.agentContinuation.confidence} />
        </div>
        <p className="handoff-plan-copy">{view.agentContinuation.summary}</p>
      </Section>
    </>
  );
}

function useLiveHandoffPlan(open: boolean, enabled: boolean, activeSession: SessionSummary | null) {
  const [draft, setDraft] = useState<HandoffDraft | null>(null);
  const [plan, setPlan] = useState<HandoffPlan | null>(null);
  const [run, setRun] = useState<HandoffRun | null>(null);
  const [status, setStatus] = useState<HandoffLiveStatus>('idle');
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  const [error, setError] = useState<HandoffApiErrorView | null>(null);

  useEffect(() => {
    if (!open || !enabled) return;
    const result = buildHandoffDraft(activeSession);
    setDraft(result.draft);
    setPlan(null);
    setRun(null);
    setError(null);
    setEmptyReason(result.emptyReason ?? null);
    if (!result.draft) {
      setStatus('empty');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    void planHandoff(result.draft)
      .then((response) => {
        if (cancelled) return;
        setPlan(response.plan);
        setStatus(
          response.plan.conflicts.length
            ? 'blocked'
            : response.plan.requiredGrants.length
              ? 'needs-grants'
              : 'ready'
        );
      })
      .catch((caught: HandoffApiErrorView) => {
        if (cancelled) return;
        setError(caught);
        setStatus(handoffStatusFromError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession, enabled, open]);

  const confirm = async () => {
    if (!draft || !plan) return;
    setStatus('creating');
    setError(null);
    try {
      const response = await createHandoffFromPlan(draft, plan);
      setRun(response.run);
      setStatus('created');
    } catch (caught) {
      const apiError = caught as HandoffApiErrorView;
      setError(apiError);
      setRun(runFromError(apiError));
      setStatus(handoffStatusFromError(apiError));
    }
  };

  return { draft, plan, run, status, emptyReason, error, confirm };
}

function LiveFallbackBody({
  status,
  emptyReason,
  error,
}: {
  status: HandoffLiveStatus;
  emptyReason: string | null;
  error: HandoffApiErrorView | null;
}) {
  if (status === 'loading') {
    return (
      <div className="handoff-plan-status" data-status="loading">
        <span>loading</span>
        <strong>requesting live cold handoff dry-run from the server</strong>
      </div>
    );
  }
  if (status === 'empty') {
    return (
      <div className="handoff-plan-status" data-status="empty">
        <span>empty</span>
        <strong>{emptyReason ?? 'no active handoff source'}</strong>
      </div>
    );
  }
  if (!error) return null;
  const conflicts = conflictsFromError(error);
  return (
    <>
      <div className="handoff-plan-status" data-status={status}>
        <span>{statusLabel(status)}</span>
        <strong>{apiErrorMessage(error)}</strong>
      </div>
      <Section title="api response">
        <div className="handoff-plan-grid">
          <KeyValue label="code" value={error.code} />
          <KeyValue label="retryable" value={error.retryable ? 'yes' : 'no'} />
          {error.reasonCode && <KeyValue label="reason" value={error.reasonCode} />}
          {error.status && <KeyValue label="http" value={error.status} />}
        </div>
        {conflicts.length ? (
          <ul className="handoff-plan-list handoff-plan-list--danger">
            {conflicts.map((item, index) => (
              <li key={index}>
                <span>{String(item.code ?? 'conflict').toLowerCase().replaceAll('_', ' ')}</span>
                <strong>{String(item.message ?? 'typed handoff conflict')}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyLine text="no raw logs, transcripts, provider auth, or secrets are exposed" />
        )}
      </Section>
    </>
  );
}

function HandoffFooter({
  status,
  transferSummary,
  confirmDisabledReason,
  canConfirm,
  confirmLabel,
  onConfirm,
}: {
  status: HandoffLiveStatus;
  transferSummary: string;
  confirmDisabledReason: string;
  canConfirm: boolean;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <footer className="handoff-plan-footer">
      <div>
        <span>{status === 'creating' ? 'requesting handoff run' : transferSummary}</span>
        <strong>{canConfirm ? 'ready: explicit grants will be confirmed for this plan only' : confirmDisabledReason}</strong>
      </div>
      <TuiButton
        size="sm"
        variant="primary"
        disabled={!canConfirm}
        title={canConfirm ? 'start hub-side continuation from this cold snapshot' : confirmDisabledReason}
        onClick={onConfirm}
      >
        {status === 'creating' ? 'starting...' : confirmLabel}
      </TuiButton>
    </footer>
  );
}

export function HandoffPlanDialog({
  open,
  onClose,
  initialFixture = DEFAULT_HANDOFF_FIXTURE_KEY,
  mode,
  activeSession = null,
}: HandoffPlanDialogProps) {
  const effectiveMode = mode ?? (activeSession ? 'live' : 'fixture');
  const live = useLiveHandoffPlan(open, effectiveMode === 'live', activeSession);
  const [fixtureKey, setFixtureKey] = useState<HandoffFixtureKey>(initialFixture);
  const fixture = getHandoffPlanFixture(fixtureKey);
  const view = useMemo(() => {
    if (effectiveMode === 'fixture') return fixtureView(fixture);
    return live.plan ? liveView(live.plan, live.run) : null;
  }, [effectiveMode, fixture, live.plan, live.run]);

  const transferSummary = view
    ? `${view.plan.fileCount} files · ${fileSizeLabel(view.plan.byteCount)} · ${fixtureTransferModeLabel(view.plan.transferMode)}`
    : 'no plan loaded';
  const confirmDisabledReason =
    view?.confirmDisabledReason ??
    live.emptyReason ??
    (live.error ? apiErrorMessage(live.error) : 'handoff plan unavailable');
  const canConfirm =
    effectiveMode === 'live' &&
    !!live.draft &&
    !!live.plan &&
    !!view &&
    !view.confirmDisabledReason &&
    live.status !== 'creating';

  if (!open) return null;

  return (
    <div className="handoff-plan-backdrop" role="presentation">
      <section className="handoff-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-plan-title">
        <header className="handoff-plan-header">
          <div>
            <p className="handoff-plan-eyebrow">{effectiveMode === 'live' ? 'live api dry run' : 'fixture dry run'}</p>
            <h2 id="handoff-plan-title">handoff plan</h2>
          </div>
          <TuiButton size="sm" variant="ghost" onClick={onClose}>close</TuiButton>
        </header>

        <p className="handoff-plan-copy">{HANDOFF_CANONICAL_COPY}</p>

        {view?.showFixtures && (
          <div className="handoff-plan-fixtures" aria-label="fixture states">
            {HANDOFF_FIXTURE_ORDER.map((key) => (
              <button key={key} type="button" className="handoff-plan-fixture" data-active={key === fixtureKey} onClick={() => setFixtureKey(key)}>
                {key.replaceAll('-', ' ')}
              </button>
            ))}
          </div>
        )}

        <div className="handoff-plan-body">
          {view ? <PlanDetails view={view} /> : <LiveFallbackBody status={live.status} emptyReason={live.emptyReason} error={live.error} />}
        </div>

        <HandoffFooter
          status={live.status}
          transferSummary={transferSummary}
          confirmDisabledReason={confirmDisabledReason}
          canConfirm={canConfirm}
          confirmLabel={view?.confirmLabel ?? 'start on hub'}
          onConfirm={live.confirm}
        />
      </section>
    </div>
  );
}

export default HandoffPlanDialog;
