import React, { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  fetchSecurityAuditEntries,
  fetchSecurityAuditVerify,
  HttpError,
  type SecurityAuditEntryRow,
} from '../lib/api.js';
import './SecurityAuditPanel.css';

const MAX_DISPLAYED_ROWS = 500;

function first8(hash: string | null | undefined): string {
  if (!hash) return 'none';
  return hash.slice(0, 8);
}

function first12(hash: string | null | undefined): string {
  if (!hash) return 'none';
  return hash.slice(0, 12);
}

function shortIso(ts: string): string {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'z';
  } catch {
    return ts;
  }
}

function decisionClass(decision: string): string {
  if (decision === 'allow' || decision === 'approved' || decision === 'recorded') {
    return 'audit-decision-allow';
  }
  if (decision === 'requires_confirmation') {
    return 'audit-decision-requires-confirmation';
  }
  return 'audit-decision-deny';
}

interface AuditRowProps {
  row: SecurityAuditEntryRow;
}

function AuditTableRow({ row }: AuditRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="audit-row"
        onClick={() => setExpanded((v) => !v)}
        title="click to expand"
      >
        <td className="audit-cell audit-cell-seq">{row.sequence}</td>
        <td className="audit-cell audit-cell-time">{shortIso(row.timestamp)}</td>
        <td className="audit-cell audit-cell-event">{row.eventType}</td>
        <td className={`audit-cell audit-cell-decision ${decisionClass(row.decision)}`}>
          {row.decision}
        </td>
        <td className="audit-cell audit-cell-node">{row.node.nodeId?.slice(0, 12) ?? '—'}</td>
        <td className="audit-cell audit-cell-intent">{row.intent.action}</td>
        <td className="audit-cell audit-cell-bits">
          <span className="audit-bits-granted">{row.grantedBits.join(' ')}</span>
          {row.deniedBits.length > 0 && (
            <span className="audit-bits-denied"> /{row.deniedBits.join(' ')}</span>
          )}
        </td>
        <td className="audit-cell audit-cell-corr" title={row.correlationId}>
          {first8(row.correlationId)}
        </td>
      </tr>
      {expanded && (
        <tr className="audit-row-expanded">
          <td colSpan={8}>
            <div className="audit-expand-grid">
              <span className="audit-expand-label">scope</span>
              <code className="audit-hash-box" title={row.scopeHash}>
                {first12(row.scopeHash)}
              </code>
              <span className="audit-expand-label">params</span>
              <code className="audit-hash-box" title={row.paramsHash}>
                {first12(row.paramsHash)}
              </code>
              <span className="audit-expand-label">prev</span>
              <code className="audit-hash-box" title={row.prevHash ?? ''}>
                {first12(row.prevHash)}
              </code>
              <span className="audit-expand-label">entry</span>
              <code className="audit-hash-box" title={row.entryHash}>
                {first12(row.entryHash)}
              </code>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function auditEntriesErrorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 503) return 'audit sink not available on this hub';
    if (error.status === 401) return 'authentication expired · refresh and re-enter pin';
    if (error.status === 403) return 'not authorized to view audit log';
    return `could not load audit log (http ${error.status})`;
  }
  return 'could not load audit log (network error)';
}

export function SecurityAuditPanel() {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useInfiniteQuery({
    queryKey: ['security-audit'],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      fetchSecurityAuditEntries({ beforeSequence: pageParam as number | null, limit: 50 }),
    getNextPageParam: (last) => last.nextBeforeSequence ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
    maxPages: 10,
  });

  const head = data?.pages[0]?.head;

  const {
    data: verifyData,
    isLoading: verifyLoading,
    isError: verifyError,
  } = useQuery({
    queryKey: ['security-audit-verify', head?.latestSequence ?? 0],
    queryFn: fetchSecurityAuditVerify,
    enabled: head !== undefined,
    staleTime: Infinity,
  });

  const allRows = data?.pages.flatMap((p) => p.entries) ?? [];
  const displayedRows = allRows.slice(0, MAX_DISPLAYED_ROWS);
  const totalEntries = allRows.length;

  let chainStatusNode: React.ReactNode = null;
  if (verifyLoading) {
    chainStatusNode = (
      <span className="audit-chain-status audit-chain-pending">[pending]</span>
    );
  } else if (verifyError) {
    chainStatusNode = (
      <span className="audit-chain-status audit-chain-break">[verify failed]</span>
    );
  } else if (verifyData !== undefined) {
    const chainOk = verifyData.ok;
    chainStatusNode = (
      <span
        className={`audit-chain-status ${chainOk ? 'audit-chain-ok' : 'audit-chain-break'}`}
      >
        [{chainOk ? 'ok' : 'break'}]
      </span>
    );
  }

  return (
    <div className="security-audit-panel">
      <header className="audit-header">
        <span className="audit-header-title">audit log</span>
        <span className="audit-header-meta">
          {totalEntries} {totalEntries === 1 ? 'entry' : 'entries'}
        </span>
        {head && (
          <span className="audit-header-meta">
            chain head {first8(head.latestHash)}…
          </span>
        )}
        {chainStatusNode}
      </header>

      {isLoading && <p className="audit-state-msg">loading…</p>}
      {isError && (
        <p className="audit-state-msg audit-state-msg--error">
          {auditEntriesErrorMessage(error)}
        </p>
      )}
      {!isLoading && !isError && allRows.length === 0 && (
        <p className="audit-state-msg">no audit entries yet</p>
      )}

      {displayedRows.length > 0 && (
        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th className="audit-th">seq</th>
                <th className="audit-th">time</th>
                <th className="audit-th">event</th>
                <th className="audit-th">decision</th>
                <th className="audit-th">node</th>
                <th className="audit-th">intent</th>
                <th className="audit-th">granted/denied bits</th>
                <th className="audit-th">correlation</th>
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row) => (
                <AuditTableRow key={row.eventId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="audit-footer">
        <button
          className="audit-load-older"
          onClick={() => void fetchNextPage()}
          disabled={!hasNextPage || isFetchingNextPage}
        >
          {isFetchingNextPage ? 'loading…' : 'load older entries'}
        </button>
      </div>
    </div>
  );
}

export default SecurityAuditPanel;
