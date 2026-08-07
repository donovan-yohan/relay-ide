import type { SessionSummary } from '../lib/types.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailLogsPanelProps {
  activeSession?: SessionSummary | undefined;
}

export function UtilityRailLogsPanel({
  activeSession,
}: UtilityRailLogsPanelProps) {
  const activity = activeSession?.currentActivity;
  return (
    <div className="utility-simple-panel">
      <div className="utility-kv-row">
        <span>session</span>
        <span>{activeSession?.displayName ?? activeSession?.id ?? 'none'}</span>
      </div>
      <div className="utility-kv-row">
        <span>branch</span>
        <span>{activeSession?.branchName ?? '-'}</span>
      </div>
      <div className="utility-kv-row">
        <span>state</span>
        <span>{activeSession?.activityState ?? 'idle'}</span>
      </div>
      <div className="utility-log-box">
        {activity ? (
          <>
            <div>{activity.tool}</div>
            {activity.detail ? (
              <div className="utility-muted">{activity.detail}</div>
            ) : null}
          </>
        ) : (
          <div className="utility-muted">no current output event</div>
        )}
      </div>
    </div>
  );
}

export default UtilityRailLogsPanel;
