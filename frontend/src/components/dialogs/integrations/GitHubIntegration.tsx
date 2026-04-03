import React, { useEffect, useRef, useState } from 'react';
import CipherText from '../../CipherText.js';
import TuiButton from '../../TuiButton.js';
import IntegrationRow from './IntegrationRow.js';
import { fetchGitHubStatus, initiateGitHubDevice, disconnectGitHub } from '../../../lib/api.js';
import './GitHubIntegration.css';

interface Props {
  onConnected?: () => void;
  onDisconnect?: () => void;
  needsReauth?: boolean;
  webhookCount?: number;
}

interface GitHubStatus { connected: boolean; username?: string; deviceFlowStatus?: string }
interface DeviceCode { userCode: string; verificationUri: string; expiresIn: number }

interface ConnectedBodyProps {
  username: string | undefined; webhookCount: number; disconnecting: boolean;
  showConfirm: boolean; onConfirm: () => void; onCancel: () => void; onDisconnect: () => void;
}

function ConnectedBody({ username, webhookCount, disconnecting, showConfirm, onConfirm, onCancel, onDisconnect }: ConnectedBodyProps) {
  return (
    <>
      <p className="github-integration-body-text">Connected as <strong>@{username ?? 'GitHub'}</strong></p>
      {showConfirm ? (
        <>
          <p className="github-integration-body-text github-integration-body-text--warning">
            {webhookCount > 0 ? `This will delete ${webhookCount} webhook${webhookCount === 1 ? '' : 's'} on GitHub. Continue?` : 'Disconnect your GitHub account. Continue?'}
          </p>
          <div className="github-integration-action-row">
            <TuiButton variant="ghost" size="sm" onClick={onCancel}>Cancel</TuiButton>
            <TuiButton variant="danger" size="sm" onClick={onDisconnect} disabled={disconnecting}>{disconnecting ? 'Disconnecting...' : 'Disconnect'}</TuiButton>
          </div>
        </>
      ) : (
        <TuiButton variant="danger" size="sm" onClick={onConfirm}>Disconnect</TuiButton>
      )}
    </>
  );
}

function DeviceFlowBody({ deviceCode, onCopy }: { deviceCode: DeviceCode; onCopy: () => void }) {
  return (
    <div className="github-integration-device-flow">
      <div className="github-integration-code-row">
        <span className="github-integration-body-text">Enter code:{' '}<strong className="github-integration-user-code">{deviceCode.userCode}</strong></span>
        <TuiButton variant="ghost" size="sm" onClick={onCopy}>Copy</TuiButton>
      </div>
      <p className="github-integration-body-text">at{' '}<a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">{deviceCode.verificationUri}</a></p>
      <p className="github-integration-body-text github-integration-body-text--muted">Waiting for authorization...</p>
    </div>
  );
}

function useGitHubFlow(setGithubStatus: (s: GitHubStatus) => void, setLoading: (v: boolean) => void, onConnected?: () => void) {
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const [deviceFlowError, setDeviceFlowError] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimers() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (expiryRef.current) { clearTimeout(expiryRef.current); expiryRef.current = null; }
  }

  useEffect(() => {
    async function load() {
      try {
        const s = await fetchGitHubStatus();
        setGithubStatus({ connected: s.connected, ...(s.username ? { username: s.username } : {}), ...(s.deviceFlowStatus ? { deviceFlowStatus: s.deviceFlowStatus } : {}) });
      } catch { setGithubStatus({ connected: false }); }
      finally { setLoading(false); }
    }
    void load();
    return clearTimers;
  }, []);

  async function connect() {
    setDeviceFlowError('');
    try {
      const code = await initiateGitHubDevice(); setDeviceCode(code); clearTimers();
      pollRef.current = setInterval(async () => {
        try {
          const s = await fetchGitHubStatus();
          if (s.connected) { setGithubStatus({ connected: true, ...(s.username ? { username: s.username } : {}) }); setDeviceCode(null); clearTimers(); onConnected?.(); }
          else if (s.deviceFlowStatus === 'denied' || s.deviceFlowStatus === 'expired') { setDeviceCode(null); setDeviceFlowError(s.deviceFlowStatus === 'denied' ? 'Authorization denied. Please try again.' : 'Code expired. Please try again.'); clearTimers(); }
        } catch { /* keep polling */ }
      }, 2000);
      expiryRef.current = setTimeout(() => { clearTimers(); setDeviceCode(null); setDeviceFlowError('Code expired. Please try again.'); }, code.expiresIn * 1000);
    } catch { setDeviceFlowError('Failed to initiate GitHub authorization. Please try again.'); }
  }

  async function disconnect(onDone: () => void) {
    setDisconnecting(true);
    try { await disconnectGitHub(); setGithubStatus({ connected: false }); setDeviceCode(null); setDeviceFlowError(''); onDone(); }
    catch { /* stay in confirm state */ }
    finally { setDisconnecting(false); }
  }

  return { deviceCode, deviceFlowError, disconnecting, connect, disconnect };
}

export default function GitHubIntegration({ onConnected, onDisconnect, needsReauth = false, webhookCount = 0 }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const { deviceCode, deviceFlowError, disconnecting, connect, disconnect } = useGitHubFlow(setGithubStatus, setLoading, onConnected);

  let statusText: string;
  if (loading) statusText = 'Checking connection...';
  else if (githubStatus?.connected) statusText = `Connected as @${githubStatus.username ?? 'GitHub'}`;
  else statusText = 'Not connected';

  function renderBody() {
    if (loading) return <CipherText loading={true} text="Checking connection..." />;
    if (needsReauth) return (<><p className="github-integration-reauth-warning">Re-connect to enable webhook management</p><TuiButton variant="primary" size="sm" onClick={() => void connect()}>Re-connect GitHub</TuiButton></>);
    if (githubStatus?.connected) return (
      <ConnectedBody username={githubStatus.username} webhookCount={webhookCount} disconnecting={disconnecting}
        showConfirm={showDisconnectConfirm} onConfirm={() => setShowDisconnectConfirm(true)}
        onCancel={() => setShowDisconnectConfirm(false)} onDisconnect={() => void disconnect(() => { setShowDisconnectConfirm(false); onDisconnect?.(); })} />
    );
    if (deviceCode) return <DeviceFlowBody deviceCode={deviceCode} onCopy={() => void navigator.clipboard.writeText(deviceCode.userCode)} />;
    if (deviceFlowError) return (<><p className="github-integration-error-text">{deviceFlowError}</p><TuiButton variant="primary" size="sm" onClick={() => void connect()}>Try Again</TuiButton></>);
    return (<><p className="github-integration-body-text github-integration-body-text--muted">Connect your GitHub account to enable PRs, CI status, and webhook management.</p><TuiButton variant="primary" size="sm" onClick={() => void connect()}>Connect GitHub</TuiButton></>);
  }

  const headerActions = (
    <>
      {githubStatus?.connected ? (
        <TuiButton variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>Manage {expanded ? '▴' : '▾'}</TuiButton>
      ) : !loading ? (
        <TuiButton variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); setExpanded(true); void connect(); }}>Connect</TuiButton>
      ) : null}
    </>
  );

  return (
    <div className="github-integration">
      <IntegrationRow name="GitHub" statusText={statusText} connected={githubStatus?.connected ?? false}
        loading={loading} expanded={expanded} onExpandedChange={setExpanded} headerActions={headerActions}>
        {renderBody()}
      </IntegrationRow>
    </div>
  );
}
