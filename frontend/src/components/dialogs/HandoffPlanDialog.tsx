import { useMemo, useState } from 'react';
import {
  DEFAULT_HANDOFF_FIXTURE_KEY,
  HANDOFF_CANONICAL_COPY,
  HANDOFF_FIXTURE_ORDER,
  getHandoffPlanFixture,
  fixtureTransferModeLabel,
  type HandoffFixtureKey,
  type HandoffPlanFixture,
} from '../../lib/handoff-fixtures.js';
import { TuiButton } from '../TuiButton.js';
import './HandoffPlanDialog.css';

export interface HandoffPlanDialogProps {
  open: boolean;
  onClose: () => void;
  initialFixture?: HandoffFixtureKey;
}

function fileSizeLabel(bytes: number): string {
  if (bytes <= 0) return '0 b';
  if (bytes < 1024) return `${bytes} b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} mb`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="handoff-plan-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
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

function FileGroups({ fixture }: { fixture: HandoffPlanFixture }) {
  const { plan } = fixture;
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

export function HandoffPlanDialog({
  open,
  onClose,
  initialFixture = DEFAULT_HANDOFF_FIXTURE_KEY,
}: HandoffPlanDialogProps) {
  const [fixtureKey, setFixtureKey] = useState<HandoffFixtureKey>(initialFixture);
  const fixture = getHandoffPlanFixture(fixtureKey);
  const plan = fixture.plan;
  const routeLabel = `${plan.route.sourceNodeId} -> ${plan.route.destinationNodeId}`;
  const transferSummary = useMemo(
    () => `${plan.fileCount} files · ${fileSizeLabel(plan.byteCount)} · ${fixtureTransferModeLabel(plan.transferMode)}`,
    [plan.byteCount, plan.fileCount, plan.transferMode]
  );

  if (!open) return null;

  return (
    <div className="handoff-plan-backdrop" role="presentation">
      <section
        className="handoff-plan-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-plan-title"
      >
        <header className="handoff-plan-header">
          <div>
            <p className="handoff-plan-eyebrow">fixture dry run</p>
            <h2 id="handoff-plan-title">handoff plan</h2>
          </div>
          <TuiButton size="sm" variant="ghost" onClick={onClose}>
            close
          </TuiButton>
        </header>

        <p className="handoff-plan-copy">{HANDOFF_CANONICAL_COPY}</p>

        <div className="handoff-plan-fixtures" aria-label="fixture states">
          {HANDOFF_FIXTURE_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className="handoff-plan-fixture"
              data-active={key === fixtureKey}
              onClick={() => setFixtureKey(key)}
            >
              {key.replaceAll('-', ' ')}
            </button>
          ))}
        </div>

        <div className="handoff-plan-body">
          <div className="handoff-plan-status" data-status={fixture.status}>
            <span>{fixture.status}</span>
            <strong>{fixture.statusCopy}</strong>
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
            <FileGroups fixture={fixture} />
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
              <EmptyLine text="no conflicts in this fixture" />
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
            <p className="handoff-plan-copy">{fixture.sourceSessionOutcome}</p>
          </Section>

          <Section title="launch summary">
            <p className="handoff-plan-copy">{plan.launchPreview.summary}</p>
          </Section>

          <Section title="agent continuation">
            <div className="handoff-plan-grid">
              <KeyValue label="mode" value={fixture.agentContinuation.mode.replaceAll('-', ' ')} />
              <KeyValue label="confidence" value={fixture.agentContinuation.confidence} />
            </div>
            <p className="handoff-plan-copy">{fixture.agentContinuation.summary}</p>
          </Section>
        </div>

        <footer className="handoff-plan-footer">
          <div>
            <span>{transferSummary}</span>
            <strong>{fixture.confirmDisabledReason}</strong>
          </div>
          <TuiButton size="sm" variant="primary" disabled title={fixture.confirmDisabledReason}>
            {fixture.confirmLabel}
          </TuiButton>
        </footer>
      </section>
    </div>
  );
}

export default HandoffPlanDialog;
