import { useMemo } from 'react';
import type { SessionSummary } from '../lib/types.js';
import type { BackendDisplayState } from '../lib/state/display-state.js';
import { deriveBackendState } from '../lib/state/sidebar-items.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import StatusDot, { type StatusDotStatus } from './StatusDot.js';
import './LiveSessionsPanel.css';

/**
 * The chat-first landing surfaces live PTY terminal sessions. Agent work lives
 * in channels and never appears in the public session registry.
 */
const STATE_META: Record<
  BackendDisplayState,
  { dot: StatusDotStatus; label: string }
> = {
  running: { dot: 'running', label: 'running' },
  idle: { dot: 'idle', label: 'idle' },
  permission: { dot: 'permission-prompt', label: 'needs input' },
  error: { dot: 'warning', label: 'error' },
  initializing: { dot: 'initializing', label: 'starting' },
};

function shortLocation(session: SessionSummary): string {
  if (session.branchName) return session.branchName;
  const path = session.worktreePath || session.repoPath || session.cwd || '';
  const segment = path.split('/').filter(Boolean).pop();
  return segment || path || 'local';
}

export interface LiveSessionsPanelProps {
  sessions: SessionSummary[];
  activeSessionKey?: string | null;
  onSelect: (sessionKey: string) => void;
}

export default function LiveSessionsPanel({
  sessions,
  activeSessionKey,
  onSelect,
}: LiveSessionsPanelProps) {
  const rows = useMemo(
    () =>
      sessions.map((session) => ({
        session,
        key: scopedSessionKey(session),
        meta: STATE_META[deriveBackendState([session])],
      })),
    [sessions]
  );

  if (rows.length === 0) return null;

  return (
    <section className="live-sessions" aria-label="live sessions">
      <div className="live-sessions__header">
        <span className="live-sessions__title">live sessions</span>
        <span className="live-sessions__count">{rows.length}</span>
      </div>
      <ul className="live-sessions__list">
        {rows.map(({ session, key, meta }) => (
          <li key={key} className="live-sessions__row-wrap">
            <button
              type="button"
              className={`live-sessions__row${
                activeSessionKey === key ? ' selected' : ''
              }`}
              onClick={() => onSelect(key)}
              aria-label={`open ${session.displayName} terminal`}
            >
              <span className="live-sessions__dot">
                <StatusDot status={meta.dot} size={8} />
              </span>
              <span className="live-sessions__terminal" aria-hidden="true">
                &gt;_
              </span>
              <span className="live-sessions__body">
                <span className="live-sessions__name">
                  {session.displayName}
                </span>
                <span className="live-sessions__meta">
                  <span className="live-sessions__terminal-name">terminal</span>
                  <span className="live-sessions__sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="live-sessions__loc">
                    {shortLocation(session)}
                  </span>
                </span>
              </span>
              <span className="live-sessions__state">{meta.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
