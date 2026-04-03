import { useCallback, useEffect, useState } from 'react';
import { CipherText } from './CipherText.js';
import { TuiProgress } from './TuiProgress.js';
import { useBootStateStore } from '../lib/stores/boot-state.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import type { BootLine } from '../lib/stores/boot-state.js';
import './BootScreen.css';

function badgeText(line: BootLine): string {
  switch (line.status) {
    case 'ok':
      return '[ok]';
    case 'fail':
      return '[fail]';
    default:
      return '';
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  return `${ms}ms`;
}

export function BootScreen() {
  const phase = useBootStateStore((s) => s.phase);
  const greeting = useBootStateStore((s) => s.greeting);
  const lines = useBootStateStore((s) => s.lines);
  const bootComplete = useBootStateStore((s) => s.bootComplete);
  const resetBoot = useBootStateStore((s) => s.resetBoot);
  const reportFetch = useBootStateStore((s) => s.reportFetch);
  const finishBoot = useBootStateStore((s) => s.finishBoot);
  const refreshAll = useSessionsStore((s) => s.refreshAll);

  const [fadingOut, setFadingOut] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const allFailed =
    (phase === 'booting' || phase === 'degraded') &&
    lines.filter((l) => l.service !== 'auth').every((l) => l.status === 'fail');

  useEffect(() => {
    if (bootComplete && !fadingOut && !allFailed) {
      setFadingOut(true);
    }
  }, [bootComplete, fadingOut, allFailed]);

  const handleRetry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    resetBoot();
    await refreshAll(reportFetch);
    finishBoot();
    setRetrying(false);
  }, [retrying, resetBoot, refreshAll, reportFetch, finishBoot]);

  return (
    <div
      className={`boot-screen${fadingOut ? ' fading-out' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="boot-content">
        <div className="greeting" aria-label={greeting}>
          <CipherText text={greeting} loading={phase === 'idle'} />
        </div>

        <div className="status-lines">
          {lines.map((line) => (
            <div
              key={line.service}
              className={`status-line${line.status === 'pending' ? ' pending' : ''}`}
              aria-label={
                line.status === 'ok'
                  ? `${line.service}: ok${line.summary ? `, ${line.summary}` : ''}${line.durationMs ? `, ${line.durationMs} milliseconds` : ''}`
                  : line.status === 'fail'
                    ? `${line.service}: failed${line.error ? `, ${line.error}` : ''}`
                    : `${line.service}: ${line.status}`
              }
            >
              <span className="service-name">{line.service}</span>
              <span
                className={`badge${line.status === 'ok' ? ' badge-ok' : ''}${line.status === 'fail' ? ' badge-fail' : ''}`}
              >
                {line.status === 'loading' ? (
                  <TuiProgress variant="braille" />
                ) : line.status === 'pending' ? (
                  <span className="dot">&middot;</span>
                ) : (
                  badgeText(line)
                )}
              </span>
              <span className="summary">
                {line.status === 'loading'
                  ? 'loading...'
                  : line.status === 'ok' && line.summary
                    ? line.summary
                    : line.status === 'fail' && line.error
                      ? line.error
                      : null}
              </span>
              <span className="duration">
                {formatDuration(line.durationMs)}
              </span>
            </div>
          ))}
        </div>

        {phase === 'ready' ? (
          <div className="ready-line">ready.</div>
        ) : phase === 'degraded' && !allFailed ? (
          <div className="ready-line degraded">ready (degraded).</div>
        ) : allFailed ? (
          <div className="retry-line">
            connection failed.
            <button
              className="retry-btn"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? '[retrying...]' : '[retry]'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default BootScreen;
