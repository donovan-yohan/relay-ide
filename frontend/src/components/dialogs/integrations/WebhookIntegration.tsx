import React, { useEffect, useRef, useState } from 'react';
import CipherText from '../../CipherText.js';
import StatusDot from '../../StatusDot.js';
import TuiButton from '../../TuiButton.js';
import TuiCheckbox from '../../TuiCheckbox.js';
import IntegrationRow from './IntegrationRow.js';
import {
  fetchWebhookStatus, setupWebhooks, removeWebhookSetup, pingWebhook,
  backfillWebhooks, updateConfigAutoProvision, type WebhookStatus, type BackfillResult,
} from '../../../lib/api.js';
import './WebhookIntegration.css';

interface Props { githubConnected: boolean }

function relativeTime(isoString: string | null): string {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

function BackfillBanner({ backfilling, onBackfill, onSkip }: { backfilling: boolean; onBackfill: () => void; onSkip: () => void }) {
  return (
    <div className="webhook-integration-backfill-banner">
      <p className="webhook-integration-body-text">Create webhooks for all your existing repos?</p>
      <div className="webhook-integration-action-row">
        <TuiButton variant="primary" size="sm" onClick={onBackfill} disabled={backfilling}>{backfilling ? 'Setting up repos...' : 'Setup All Repos'}</TuiButton>
        <TuiButton variant="ghost" size="sm" onClick={onSkip}>Skip</TuiButton>
      </div>
    </div>
  );
}

function BackfillResults({ results }: { results: BackfillResult }) {
  return (
    <div className="webhook-integration-backfill-results">
      <p className="webhook-integration-body-text">Created webhooks for {results.success}/{results.total} repos.{results.failed > 0 && ` ${results.failed} failed:`}</p>
      {results.failed > 0 && (
        <ul className="webhook-integration-results-list">
          {results.results.filter((r) => !r.ok).map((repo) => (
            <li key={repo.path} className="webhook-integration-result-item webhook-integration-result-item--fail">
              <span className="webhook-integration-result-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></span>
              <span className="webhook-integration-result-label">{repo.ownerRepo}</span>
              {repo.error && <span className="webhook-integration-result-error">({repo.error})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TestResultBadge({ testResult }: { testResult: 'success' | 'error' | 'no_webhook' }) {
  const cls = ['webhook-integration-test-result', testResult === 'success' ? 'webhook-integration-test-result--success' : 'webhook-integration-test-result--error'].join(' ');
  return (
    <p className={cls}>{testResult === 'success' ? (<><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" width="12" height="12"><polyline points="20 6 9 17 4 12" /></svg>{' '}Event received</>) : testResult === 'no_webhook' ? 'No webhook to ping' : 'Timed out'}</p>
  );
}

interface WebhookActions {
  status: WebhookStatus | null; loading: boolean; settingUp: boolean; removing: boolean;
  testing: boolean; backfilling: boolean; backfillResults: BackfillResult | null;
  showBackfillBanner: boolean; showRemoveConfirm: boolean; testResult: 'success' | 'error' | 'no_webhook' | null;
  error: string; setup: () => void; remove: () => void; test: () => void;
  backfill: () => void; toggleAutoProvision: () => void;
  setShowBackfillBanner: (v: boolean) => void; setShowRemoveConfirm: (v: boolean) => void;
}

function useWebhookActions(): WebhookActions {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingUp, setSettingUp] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResults, setBackfillResults] = useState<BackfillResult | null>(null);
  const [showBackfillBanner, setShowBackfillBanner] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | 'no_webhook' | null>(null);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    setLoading(true); setError('');
    try { setStatus(await fetchWebhookStatus()); } catch { setError('Failed to load webhook status.'); } finally { setLoading(false); }
  }

  useEffect(() => { void load(); return () => { if (timerRef.current) clearTimeout(timerRef.current); }; }, []);

  function setup() { void (async () => { setSettingUp(true); setError(''); try { const r = await setupWebhooks(); if (r.ok) { await load(); setShowBackfillBanner(true); } else setError(r.error ?? 'Setup failed.'); } catch { setError('Setup failed. Could not reach smee.io.'); } finally { setSettingUp(false); } })(); }
  function remove() { void (async () => { setRemoving(true); setError(''); try { await removeWebhookSetup(); setStatus(null); setShowRemoveConfirm(false); setShowBackfillBanner(false); setBackfillResults(null); } catch { setError('Removal failed.'); } finally { setRemoving(false); } })(); }
  function test() { void (async () => { setTesting(true); setTestResult(null); if (timerRef.current) clearTimeout(timerRef.current); try { const r = await pingWebhook(); setTestResult(r.ok ? 'success' : r.error === 'no_webhook' ? 'no_webhook' : 'error'); } catch { setTestResult('error'); } finally { setTesting(false); timerRef.current = setTimeout(() => setTestResult(null), 5000); } })(); }
  function backfill() { void (async () => { setBackfilling(true); setError(''); try { setBackfillResults(await backfillWebhooks()); setShowBackfillBanner(false); } catch { setError('Backfill failed.'); } finally { setBackfilling(false); } })(); }
  function toggleAutoProvision() { if (!status) return; const next = !status.autoProvision; setStatus({ ...status, autoProvision: next }); void updateConfigAutoProvision(next).catch(() => { setStatus({ ...status, autoProvision: !next }); setError('Failed to update auto-provision setting.'); }); }

  return { status, loading, settingUp, removing, testing, backfilling, backfillResults, showBackfillBanner, showRemoveConfirm, testResult, error, setup, remove, test, backfill, toggleAutoProvision, setShowBackfillBanner, setShowRemoveConfirm };
}

export default function WebhookIntegration({ githubConnected }: Props) {
  const [expanded, setExpanded] = useState(false);
  const a = useWebhookActions();

  let headerStatus: string;
  if (a.loading) headerStatus = 'Loading...';
  else if (a.status?.configured) headerStatus = a.status.smeeConnected ? 'Connected via smee.io' : 'Reconnecting...';
  else headerStatus = 'Not configured';

  const webhookConnected = a.status?.configured ? a.status.smeeConnected : false;

  const headerActions = (
    <>
      {!githubConnected ? <span className="webhook-integration-status-hint">Connect GitHub first</span>
        : !a.loading && a.status?.configured ? <TuiButton variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>Manage {expanded ? '▴' : '▾'}</TuiButton>
        : !a.loading ? <TuiButton variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); setExpanded(true); }} disabled={a.settingUp}>Setup</TuiButton>
        : null}
    </>
  );

  function renderBody() {
    if (!githubConnected) return <p className="webhook-integration-body-text webhook-integration-body-text--muted">Connect your GitHub account above to enable webhook setup.</p>;
    if (a.loading) return <CipherText loading={true} text="Loading..." />;
    if (!a.status?.configured) return (<><p className="webhook-integration-body-text webhook-integration-body-text--muted">Get real-time CI and PR updates instead of polling every 30s.</p>{a.error && <p className="webhook-integration-error-text">{a.error}</p>}<TuiButton variant="primary" size="sm" onClick={a.setup} disabled={a.settingUp}>{a.settingUp ? 'Setting up...' : 'Setup Webhooks'}</TuiButton></>);
    const dotStatus: 'connected' | 'warning' = a.status.smeeConnected ? 'connected' : 'warning';
    return (
      <>
        <div className="webhook-integration-health-row"><StatusDot status={dotStatus} size={8} /><span className="webhook-integration-body-text">{a.status.smeeConnected ? 'Connected via smee.io' : 'Reconnecting... (using polling fallback)'}</span></div>
        <p className="webhook-integration-body-text webhook-integration-body-text--muted">Last event: {relativeTime(a.status.lastEventAt)}</p>
        <TuiCheckbox checked={a.status.autoProvision} onChange={a.toggleAutoProvision}>Auto-add webhooks for new repos</TuiCheckbox>
        {a.error && <p className="webhook-integration-error-text">{a.error}</p>}
        {a.showBackfillBanner && !a.backfillResults && <BackfillBanner backfilling={a.backfilling} onBackfill={a.backfill} onSkip={() => a.setShowBackfillBanner(false)} />}
        {a.backfillResults && <BackfillResults results={a.backfillResults} />}
        <div className="webhook-integration-action-row">{a.showRemoveConfirm && <p className="webhook-integration-body-text webhook-integration-body-text--warning">This will delete webhooks from GitHub repos and disable real-time updates.</p>}</div>
        <div className="webhook-integration-action-row">
          {a.showRemoveConfirm ? (<><TuiButton variant="ghost" size="sm" onClick={() => a.setShowRemoveConfirm(false)}>Cancel</TuiButton><TuiButton variant="danger" size="sm" onClick={a.remove} disabled={a.removing}>{a.removing ? 'Removing...' : 'Remove'}</TuiButton></>) : (<><TuiButton variant="ghost" size="sm" onClick={a.test} disabled={a.testing}>{a.testing ? 'Testing...' : 'Test Connection'}</TuiButton><TuiButton variant="danger" size="sm" onClick={() => a.setShowRemoveConfirm(true)}>Remove Setup</TuiButton></>)}
        </div>
        {a.testResult && <TestResultBadge testResult={a.testResult} />}
      </>
    );
  }

  return (
    <IntegrationRow name="Webhooks" statusText={headerStatus} connected={webhookConnected} loading={a.loading} expanded={expanded} onExpandedChange={setExpanded} headerActions={headerActions}>
      {renderBody()}
    </IntegrationRow>
  );
}
