import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubIssue, JiraIssue, AnyIssue, Repo } from '../lib/types.js';
import { ConflictError, fetchWorkspaces } from '../lib/api.js';
import { createAgentSession } from '../lib/session-utils.js';
import { TuiButton } from './TuiButton.js';
import './StartWorkModal.css';

export interface StartWorkModalProps {
  issue: AnyIssue;
  open: boolean;
  onClose: () => void;
  onSessionCreated: (sessionId: string) => void;
}

function detectSource(i: AnyIssue): 'github' | 'jira' {
  if ('number' in i && 'labels' in i) return 'github';
  return 'jira';
}

function buildDefaultBranch(
  issue: AnyIssue,
  source: 'github' | 'jira'
): string {
  if (source === 'github') return `gh-${(issue as GitHubIssue).number}`;
  return (issue as JiraIssue).key.toLowerCase();
}

function buildTicketDisplay(
  issue: AnyIssue,
  source: 'github' | 'jira'
): string {
  if (source === 'github')
    return `#${(issue as GitHubIssue).number} — ${issue.title}`;
  return `${(issue as JiraIssue).key} — ${issue.title}`;
}

type TicketContext = {
  ticketId: string;
  title: string;
  url: string;
  repoPath: string;
  repoName: string;
  source: 'github' | 'jira';
};

function useWorkspaceLoader(source: 'github' | 'jira', open: boolean) {
  const [workspaces, setWorkspaces] = useState<Repo[]>([]);
  const [selectedPath, setSelectedPath] = useState('');

  useEffect(() => {
    if (source !== 'jira' || !open) return;
    fetchWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        setSelectedPath((prev) =>
          !prev && ws.length > 0 ? ws[0]!.path : prev
        );
      })
      .catch(() => {});
  }, [source, open]);

  return { workspaces, selectedPath, setSelectedPath };
}

function useStartWork(
  repoPath: string,
  branchName: string,
  buildCtx: () => TicketContext,
  onSessionCreated: (id: string) => void,
  onClose: () => void
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = useCallback(async () => {
    if (loading || !repoPath) {
      if (!repoPath)
        setError(
          'No workspace selected. Jira tickets require a workspace context.'
        );
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { session, error } = await createAgentSession({
        repoPath,
        worktreePath: null,
        type: 'agent',
        branchName,
        ticketContext: buildCtx(),
      });
      if (error instanceof ConflictError) {
        if (session?.id) onSessionCreated(session.id);
        onClose();
        return;
      }
      if (!session?.id) throw error;
      onSessionCreated(session.id);
      onClose();
    } catch (err) {
      if (err instanceof ConflictError) {
        onSessionCreated(err.sessionId);
        onClose();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to start work');
    } finally {
      setLoading(false);
    }
  }, [loading, repoPath, branchName, buildCtx, onSessionCreated, onClose]);

  return { loading, error, handleStart };
}

export function StartWorkModal({
  issue,
  open,
  onClose,
  onSessionCreated,
}: StartWorkModalProps) {
  const source = detectSource(issue);
  const defaultBranch = buildDefaultBranch(issue, source);
  const ticketDisplay = buildTicketDisplay(issue, source);
  const [branchName, setBranchName] = useState('');
  const [branchInitialized, setBranchInitialized] = useState(false);
  const { workspaces, selectedPath, setSelectedPath } = useWorkspaceLoader(
    source,
    open
  );
  const backdropRef = useRef<HTMLDivElement>(null);

  const repoPath =
    source === 'github' ? (issue as GitHubIssue).repoPath : selectedPath;
  const repoName =
    source === 'github'
      ? (issue as GitHubIssue).repoName
      : (workspaces.find((w) => w.path === selectedPath)?.name ?? '');

  const buildCtx = useCallback((): TicketContext => {
    if (source === 'github') {
      const gh = issue as GitHubIssue;
      return {
        ticketId: `GH-${gh.number}`,
        title: gh.title,
        url: gh.url,
        source: 'github',
        repoPath: gh.repoPath,
        repoName: gh.repoName,
      };
    }
    const jira = issue as JiraIssue;
    return {
      ticketId: jira.key,
      title: jira.title,
      url: jira.url,
      source: 'jira',
      repoPath,
      repoName,
    };
  }, [source, issue, repoPath, repoName]);

  const { loading, error, handleStart } = useStartWork(
    repoPath,
    branchName,
    buildCtx,
    onSessionCreated,
    onClose
  );

  useEffect(() => {
    if (open && !branchInitialized) {
      setBranchName(defaultBranch);
      setBranchInitialized(true);
    }
    if (!open) setBranchInitialized(false);
  }, [open, branchInitialized, defaultBranch]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && !loading) void handleStart();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, onClose, handleStart]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose]
  );

  if (!open) return null;
  return (
    <div
      className="start-work-modal-backdrop"
      ref={backdropRef}
      onClick={handleBackdropClick}
    >
      <div className="start-work-modal">
        <div className="modal-header">
          <span className="modal-title">Start Work</span>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="ticket-info">
            <span className="ticket-info-label">Ticket</span>
            <span className="ticket-info-value">{ticketDisplay}</span>
          </div>
          {source === 'github' ? (
            <div className="ticket-info">
              <span className="ticket-info-label">Repo</span>
              <span className="ticket-info-value">{repoName}</span>
            </div>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="workspace-select">
                Workspace
              </label>
              {workspaces.length > 0 ? (
                <select
                  id="workspace-select"
                  className="field-input"
                  value={selectedPath}
                  onChange={(e) => setSelectedPath(e.target.value)}
                >
                  {workspaces.map((ws) => (
                    <option key={ws.path} value={ws.path}>
                      {ws.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="ticket-info-value" style={{ opacity: 0.5 }}>
                  Loading workspaces...
                </span>
              )}
            </div>
          )}
          <div className="field">
            <label className="field-label" htmlFor="branch-name">
              Branch Name
            </label>
            <input
              id="branch-name"
              className="field-input"
              type="text"
              value={branchName}
              placeholder={defaultBranch}
              onChange={(e) => setBranchName(e.target.value)}
            />
          </div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <TuiButton variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </TuiButton>
          <TuiButton
            variant="primary"
            onClick={() => void handleStart()}
            disabled={loading}
          >
            {loading ? 'Starting...' : 'Start Work'}
          </TuiButton>
        </div>
      </div>
    </div>
  );
}

export default StartWorkModal;
