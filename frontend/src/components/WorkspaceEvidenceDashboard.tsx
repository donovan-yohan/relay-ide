import { useQuery } from '@tanstack/react-query';
import { fetchWorkspaceEvidenceRoots } from '../lib/api.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import {
  resolveWorkspaceEvidenceRoot,
  workspaceEvidenceSectionState,
} from '../lib/workspace-evidence-view.js';
import WorkspaceEvidenceArtifactsSection from './WorkspaceEvidenceArtifactsSection.js';
import WorkspaceEvidenceFilesSection from './WorkspaceEvidenceFilesSection.js';
import WorkspaceEvidenceSessionsSection from './WorkspaceEvidenceSessionsSection.js';
import './WorkspaceEvidenceDashboard.css';

export interface WorkspaceEvidenceDashboardProps {
  repoPath: string;
  workspaceId?: string;
}

export function WorkspaceEvidenceDashboard({
  repoPath,
  workspaceId,
}: WorkspaceEvidenceDashboardProps) {
  const backendConnectionStatus = useSessionsStore(
    (s) => s.backendConnectionStatus
  );
  const backendConnected = backendConnectionStatus === 'connected';

  const rootsQuery = useQuery({
    queryKey: ['workspace-evidence-roots'],
    queryFn: fetchWorkspaceEvidenceRoots,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const root = resolveWorkspaceEvidenceRoot(rootsQuery.data ?? [], {
    repoPath,
    workspaceId,
  });
  const sectionState = workspaceEvidenceSectionState(root, {
    hasWorkspaceSelected: Boolean(repoPath),
    backendConnected,
  });

  const repo = root?.repo;
  const worktree = root?.worktree;

  function renderFilesSection() {
    if (rootsQuery.isLoading) {
      return <div className="section-message">loading…</div>;
    }
    if (sectionState === 'offline') {
      return (
        <div className="section-message">
          node offline — file evidence unavailable
        </div>
      );
    }
    if (sectionState === 'no-root') {
      return (
        <div className="section-message">
          no filesystem root for this workspace
        </div>
      );
    }
    if (sectionState === 'missing-root') {
      return <div className="section-message">root path not found</div>;
    }
    if (sectionState === 'unsupported') {
      return (
        <div className="section-message">
          file evidence unsupported for this workspace
        </div>
      );
    }
    if (sectionState === 'permission-denied') {
      return (
        <div className="section-message">
          permission denied reading this directory
        </div>
      );
    }
    if (sectionState === 'ready' && root) {
      return <WorkspaceEvidenceFilesSection root={root} />;
    }
    return null;
  }

  return (
    <div className="evidence-dashboard">
      {repo?.isGitRepo && (
        <div
          className="evidence-decoration"
          data-track="evidence.repo-decoration"
        >
          <span className="evidence-decoration__label">repo</span>
          <span className="evidence-decoration__value">{repo.repoPath}</span>
          {repo.currentBranch && (
            <span className="evidence-decoration__branch">
              branch {repo.currentBranch}
            </span>
          )}
        </div>
      )}
      {worktree && (
        <div
          className="evidence-decoration"
          data-track="evidence.worktree-decoration"
        >
          <span className="evidence-decoration__label">worktree</span>
          <span className="evidence-decoration__value">
            {worktree.worktreePath}
          </span>
        </div>
      )}

      <section className="dashboard-section">
        <div className="section-heading">files</div>
        {renderFilesSection()}
      </section>

      <WorkspaceEvidenceArtifactsSection repoPath={repoPath} />

      <WorkspaceEvidenceSessionsSection repoPath={repoPath} />

      <section className="dashboard-section" data-track="evidence.surfaces">
        <div className="section-heading">surfaces</div>
        <div className="section-message">surfaces — coming soon</div>
      </section>
    </div>
  );
}

export default WorkspaceEvidenceDashboard;
