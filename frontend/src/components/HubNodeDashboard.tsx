import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HubNodeSummary } from '../../../shared/relay-node-protocol.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../../../shared/relay-node-protocol.js';
import { fetchHubNodes } from '../lib/api.js';
import {
  deriveHubNodeDashboardRows,
  hubNodeDashboardSummary,
} from '../lib/state/node-dashboard.js';
import './HubNodeDashboard.css';

export interface HubNodeDashboardProps {
  nodes: HubNodeSummary[];
  now?: Date;
  expectedProtocolVersion?: string;
}

export function HubNodeDashboard({
  nodes,
  now,
  expectedProtocolVersion = RELAY_NODE_LINK_PROTOCOL_VERSION,
}: HubNodeDashboardProps) {
  const deriveOptions = useMemo(
    () => ({ ...(now ? { now } : {}), expectedProtocolVersion }),
    [now, expectedProtocolVersion]
  );
  const rows = useMemo(
    () => deriveHubNodeDashboardRows(nodes, deriveOptions),
    [nodes, deriveOptions]
  );
  const summary = useMemo(
    () => hubNodeDashboardSummary(nodes, deriveOptions),
    [nodes, deriveOptions]
  );

  if (rows.length === 0) return null;

  return (
    <section className="hub-node-dashboard" aria-label="hub nodes">
      <div className="hub-node-dashboard-header">
        <div>
          <div className="hub-node-dashboard-title">nodes</div>
          <div className="hub-node-dashboard-summary">{summary}</div>
        </div>
      </div>
      <div className="hub-node-dashboard-list">
        {rows.map((row) => (
          <article
            key={row.nodeId}
            className={[
              'hub-node-card',
              `status-${row.statusTone}`,
              row.attachable ? 'attachable' : 'blocked',
              `security-${row.security.tone}`,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="hub-node-card-main">
              <span
                className={`hub-node-status-dot status-${row.statusTone}`}
                aria-hidden="true"
              />
              <div className="hub-node-card-text">
                <div className="hub-node-card-title-row">
                  <span className="hub-node-card-title">{row.displayName}</span>
                  <span className={`hub-node-trust-tier trust-${row.security.trustTier}`}>
                    {row.security.trustTier}
                  </span>
                  <span className="hub-node-status-label">{row.status}</span>
                </div>
                <div className="hub-node-card-meta">{row.hostLabel}</div>
                <div className="hub-node-card-meta">
                  last seen {row.lastSeenLabel} · {row.routeLabel}
                </div>
              </div>
            </div>

            <div className="hub-node-readiness">
              {row.disabledReason ?? row.workReadiness}
            </div>
            {row.versionWarning && (
              <div className="hub-node-warning">{row.versionWarning}</div>
            )}

            <div className="hub-node-security" aria-label={`${row.displayName} security posture`}>
              <div className="hub-node-security-row">
                <span className={`hub-node-policy-posture posture-${row.security.tone}`}>
                  {row.security.postureLabel}
                </span>
                <span>{row.security.scopeLabel}</span>
              </div>
              <div className="hub-node-security-row">
                <span className={`hub-node-high-risk posture-${row.security.tone}`}>
                  {row.security.highRiskLabel}
                </span>
                <span>{row.security.auditLabel}</span>
              </div>
              {row.security.policyRef && (
                <div className="hub-node-security-ref" title={row.security.policyRef}>
                  policy {row.security.policyRef}
                </div>
              )}
            </div>

            <div className="hub-node-capabilities" aria-label={`${row.displayName} capabilities`}>
              {row.capabilityHints.map((hint) => (
                <span
                  key={hint.key}
                  className={`hub-node-capability status-${hint.status}`}
                  title={`${hint.label}: ${hint.status}`}
                >
                  {hint.label}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function HubNodeDashboardPanel() {
  const { data: nodes } = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: false,
  });

  if (!nodes || nodes.length === 0) return null;
  return <HubNodeDashboard nodes={nodes} />;
}

export default HubNodeDashboard;
