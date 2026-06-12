import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HubNodeSummary } from '../../../shared/relay-node-protocol.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../../../shared/relay-node-protocol.js';
import type { NodeManifestDegradedReason } from '../../../shared/node-manifest.js';
import { fetchHubNodes, fetchRepoInventory, HttpError } from '../lib/api.js';
import {
  deriveHubNodeDashboardRows,
  deriveNodeRepoLocality,
  hubNodeDashboardSummary,
  repoLocalitySummary,
  type HubNodeDashboardRow,
  type NodeRepoLocality,
} from '../lib/state/node-dashboard.js';
import './HubNodeDashboard.css';

// ---------------------------------------------------------------------------
// DegradedReasonsExpander — collapsible "why degraded?" section
// ---------------------------------------------------------------------------

function severityClass(
  severity: NodeManifestDegradedReason['severity']
): string {
  if (severity === 'error') return 'degraded-reason--error';
  if (severity === 'warn') return 'degraded-reason--warn';
  return 'degraded-reason--info';
}

interface DegradedReasonsExpanderProps {
  nodeId: string;
  reasons: NodeManifestDegradedReason[];
}

function DegradedReasonsExpander({
  nodeId,
  reasons,
}: DegradedReasonsExpanderProps) {
  const [open, setOpen] = useState(false);

  if (reasons.length === 0) return null;

  return (
    <div
      className="hub-node-degraded-reasons"
      aria-label={`${nodeId} degraded reasons`}
    >
      <button
        type="button"
        className="hub-node-degraded-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? '▾' : '▸'} why degraded? ({reasons.length})
      </button>
      {open && (
        <ul className="hub-node-degraded-list" role="list">
          {reasons.map((reason) => {
            const fullReason = `${reason.code}: ${reason.description} (${reason.severity})`;
            return (
              <li
                key={reason.code}
                className={[
                  'hub-node-degraded-reason',
                  severityClass(reason.severity),
                ].join(' ')}
                title={fullReason}
              >
                <span className="hub-node-degraded-code">{reason.code}</span>
                <span className="hub-node-degraded-desc">
                  {reason.description}
                </span>
                <span className="hub-node-degraded-severity">
                  {reason.severity}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NodeHelperMeta — helper version + file-rpc status line
// ---------------------------------------------------------------------------

const MAX_LOCALITY_REPOS = 3;
const MAX_LOCALITY_WORKTREES_PER_REPO = 3;

interface NodeLocalityProps {
  locality: NodeRepoLocality | undefined;
}

function NodeLocality({ locality }: NodeLocalityProps) {
  if (!locality || locality.repoCount === 0) {
    return (
      <div className="hub-node-locality hub-node-locality--empty">
        no repo locality reported yet
      </div>
    );
  }

  return (
    <div className="hub-node-locality" aria-label="repo locality">
      <div className="hub-node-locality-summary">
        repo locality: {repoLocalitySummary(locality)}
      </div>
      <ul className="hub-node-locality-list" role="list">
        {locality.repos.slice(0, MAX_LOCALITY_REPOS).map((repo) => {
          const branch =
            repo.currentBranch ?? repo.defaultBranch ?? 'unknown branch';
          const visibleWorktrees = repo.worktrees.slice(
            0,
            MAX_LOCALITY_WORKTREES_PER_REPO
          );
          const hiddenWorktreeCount =
            repo.worktrees.length - visibleWorktrees.length;
          return (
            <li key={repo.repoInstanceId} className="hub-node-locality-repo">
              <span className="hub-node-locality-name">{repo.name}</span>
              <span className="hub-node-locality-branch">{branch}</span>
              <span className="hub-node-locality-path" title={repo.localPath}>
                {repo.localPath}
              </span>
              {visibleWorktrees.length > 0 && (
                <div
                  className="hub-node-locality-worktrees"
                  aria-label={`${repo.name} worktrees`}
                >
                  <div className="hub-node-locality-worktrees-label">
                    worktrees
                  </div>
                  <ul className="hub-node-locality-worktree-list" role="list">
                    {visibleWorktrees.map((worktree) => {
                      const worktreeBranch =
                        worktree.branchName ?? 'unknown branch';
                      return (
                        <li
                          key={worktree.worktreeInstanceId}
                          className="hub-node-locality-worktree"
                        >
                          <span className="hub-node-locality-worktree-name">
                            {worktree.displayName}
                          </span>
                          <span
                            className="hub-node-locality-worktree-branch"
                            title={worktreeBranch}
                          >
                            {worktreeBranch}
                          </span>
                          <span
                            className="hub-node-locality-worktree-path"
                            title={worktree.localPath}
                          >
                            {worktree.localPath}
                          </span>
                        </li>
                      );
                    })}
                    {hiddenWorktreeCount > 0 && (
                      <li className="hub-node-locality-worktree-more">
                        +{hiddenWorktreeCount} more{' '}
                        {hiddenWorktreeCount === 1 ? 'worktree' : 'worktrees'}
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
        {locality.repoCount > MAX_LOCALITY_REPOS && (
          <li className="hub-node-locality-more">
            +{locality.repoCount - MAX_LOCALITY_REPOS} more repos on this node
          </li>
        )}
      </ul>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 401) {
    return error.message || 'authorization required';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'request failed';
}

function nodesErrorMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 401) {
    return error.message || 'authorization required';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'could not load hub nodes';
}

interface NodeHelperMetaProps {
  row: HubNodeDashboardRow;
}

function NodeHelperMeta({ row }: NodeHelperMetaProps) {
  const parts: string[] = [];
  if (row.helperVersion) {
    parts.push(`helper v${row.helperVersion}`);
  }
  if (row.fileRpcAvailable === false) {
    parts.push('file rpc unavailable');
  } else if (row.fileRpcAvailable === true) {
    parts.push('file rpc available');
  }
  if (parts.length === 0) return null;
  return (
    <div
      className={[
        'hub-node-card-meta',
        row.fileRpcAvailable === false ? 'hub-node-meta--warn' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {parts.join(' · ')}
    </div>
  );
}

export interface HubNodeDashboardProps {
  nodes: HubNodeSummary[];
  now?: Date;
  expectedProtocolVersion?: string;
  localityByNode?: Map<string, NodeRepoLocality>;
  inventoryError?: string;
}

export function HubNodeDashboard({
  nodes,
  now,
  expectedProtocolVersion = RELAY_NODE_LINK_PROTOCOL_VERSION,
  localityByNode,
  inventoryError,
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
      {inventoryError && (
        <div className="hub-node-locality-banner">
          repo locality unavailable: {inventoryError}
        </div>
      )}
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
                  <span
                    className={`hub-node-trust-tier trust-${row.security.trustTier}`}
                  >
                    {row.security.trustTier}
                  </span>
                  <span className="hub-node-status-label">{row.status}</span>
                </div>
                <div className="hub-node-card-meta">{row.hostLabel}</div>
                <div className="hub-node-card-meta">
                  last seen {row.lastSeenLabel} · {row.routeLabel}
                </div>
                <NodeHelperMeta row={row} />
              </div>
            </div>

            <div className="hub-node-readiness">
              {row.disabledReason ?? row.workReadiness}
            </div>
            <NodeLocality locality={localityByNode?.get(row.nodeId)} />
            {row.versionWarning && (
              <div className="hub-node-warning">{row.versionWarning}</div>
            )}
            <DegradedReasonsExpander
              nodeId={row.nodeId}
              reasons={row.degradedReasons}
            />

            <div
              className="hub-node-security"
              aria-label={`${row.displayName} security posture`}
            >
              <div className="hub-node-security-row">
                <span
                  className={`hub-node-policy-posture posture-${row.security.tone}`}
                >
                  {row.security.postureLabel}
                </span>
                <span>{row.security.scopeLabel}</span>
              </div>
              <div className="hub-node-security-row">
                <span
                  className={`hub-node-high-risk posture-${row.security.tone}`}
                >
                  {row.security.highRiskLabel}
                </span>
                <span>{row.security.auditLabel}</span>
              </div>
              {row.security.policyRef && (
                <div
                  className="hub-node-security-ref"
                  title={row.security.policyRef}
                >
                  policy {row.security.policyRef}
                </div>
              )}
            </div>

            <div
              className="hub-node-capabilities"
              aria-label={`${row.displayName} capabilities`}
            >
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
  const {
    data: nodes,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const inventoryQuery = useQuery({
    queryKey: ['repo-inventory'],
    queryFn: fetchRepoInventory,
    staleTime: 60_000,
    retry: false,
    enabled: Boolean(nodes?.length) && !isError,
  });

  const localityByNode = useMemo(
    () => deriveNodeRepoLocality(inventoryQuery.data),
    [inventoryQuery.data]
  );

  if (isLoading) {
    return <div className="hub-node-panel-state">loading nodes...</div>;
  }
  if (isError) {
    return (
      <div className="hub-node-panel-state hub-node-panel-state--error">
        nodes unavailable: {nodesErrorMessage(error)}
        <button type="button" onClick={() => void refetch()}>
          retry
        </button>
      </div>
    );
  }
  if (!nodes || nodes.length === 0) {
    return <div className="hub-node-panel-state">no paired nodes yet</div>;
  }

  return (
    <HubNodeDashboard
      nodes={nodes}
      localityByNode={localityByNode}
      {...(inventoryQuery.isError
        ? { inventoryError: errorMessage(inventoryQuery.error) }
        : {})}
    />
  );
}

export default HubNodeDashboard;
