import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWorkspaceSurfaces } from '../lib/api.js';
import type { WorkspaceEvidenceRoot } from '../../../shared/workspace-evidence.js';
import type { WorkspaceSurface } from '../../../shared/workspace-surfaces.js';

export interface WorkspaceEvidenceSurfacesSectionProps {
  root?: WorkspaceEvidenceRoot;
  repoPath: string;
  workspaceId?: string;
}

function shortNode(nodeId: string): string {
  return nodeId.length > 12 ? `${nodeId.slice(0, 12)}…` : nodeId;
}

function actionTarget(surface: WorkspaceSurface): string | null {
  return surface.url ?? surface.command ?? surface.logRef ?? null;
}

function openModeLabel(surface: WorkspaceSurface): string {
  if (surface.openMode === 'direct') return 'open direct';
  if (surface.openMode === 'node-scoped') return 'copy only · node-local';
  if (surface.openMode === 'copy') return 'copy';
  return 'unavailable';
}

function SurfaceCard({ surface }: { surface: WorkspaceSurface }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const target = actionTarget(surface);
  const canOpen = surface.openMode === 'direct' && Boolean(surface.url);
  const canCopy = Boolean(target);

  async function copyTarget() {
    if (!target) return;
    try {
      const writeText = globalThis.navigator?.clipboard?.writeText;
      if (!writeText) {
        throw new Error('Clipboard API not available');
      }
      await writeText.call(globalThis.navigator.clipboard, target);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return (
    <div className="evidence-surface" data-track="evidence.surface-card">
      <div className="evidence-surface__head">
        <span className="evidence-surface__title">{surface.label}</span>
        <span className={`evidence-surface__kind evidence-surface__kind--${surface.kind}`}>
          {surface.kind}
        </span>
      </div>
      {surface.description && (
        <div className="evidence-surface__description">{surface.description}</div>
      )}
      {target && <div className="evidence-surface__target">{target}</div>}
      <div className="evidence-surface__meta">
        <span>{surface.provenance.source}</span>
        {surface.provenance.detail && <span>{surface.provenance.detail}</span>}
        <span>node {shortNode(surface.nodeId)}</span>
        <span>{surface.health}</span>
        <span>{openModeLabel(surface)}</span>
      </div>
      <div className="evidence-surface__actions">
        {canOpen ? (
          <a
            className="evidence-surface__action"
            href={surface.url}
            rel="noreferrer"
            target="_blank"
          >
            open
          </a>
        ) : (
          <button className="evidence-surface__action" disabled type="button">
            open blocked
          </button>
        )}
        <button
          className="evidence-surface__action"
          disabled={!canCopy}
          onClick={copyTarget}
          type="button"
        >
          copy
        </button>
        {copyState === 'copied' && (
          <span className="evidence-surface__copy-state">copied</span>
        )}
        {copyState === 'error' && (
          <span className="evidence-surface__copy-error">copy failed</span>
        )}
      </div>
    </div>
  );
}

export function WorkspaceEvidenceSurfacesSection({
  root,
  repoPath,
  workspaceId,
}: WorkspaceEvidenceSurfacesSectionProps) {
  const query = useQuery<WorkspaceSurface[]>({
    queryKey: ['workspace-surfaces', root?.ref.id ?? null, workspaceId ?? null, repoPath],
    queryFn: () =>
      fetchWorkspaceSurfaces({
        ...(root?.ref.id ? { rootId: root.ref.id } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(repoPath ? { repoPath } : {}),
      }),
    enabled: Boolean(root?.ref.id || repoPath || workspaceId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  return (
    <section className="dashboard-section" data-track="evidence.surfaces">
      <div className="section-heading">surfaces</div>
      {query.isLoading ? (
        <div className="section-message">loading…</div>
      ) : query.isError ? (
        <div className="section-message section-message--error">
          failed to load workspace surfaces
        </div>
      ) : (query.data?.length ?? 0) === 0 ? (
        <div className="section-message">
          no workspace surfaces published or discovered
        </div>
      ) : (
        <div className="evidence-surfaces">
          {query.data!.map((surface) => (
            <SurfaceCard key={surface.id} surface={surface} />
          ))}
        </div>
      )}
    </section>
  );
}

export default WorkspaceEvidenceSurfacesSection;
