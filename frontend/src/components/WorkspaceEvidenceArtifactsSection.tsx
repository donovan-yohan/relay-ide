import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  copyPipelineHandoffArtifact,
  fetchActiveWork,
  fetchPipelineHandoffArtifacts,
} from '../lib/api.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { resolveWorkContextIdsForRepo } from '../lib/workspace-evidence-view.js';
import { shortSha } from '../lib/pipeline-handoff-timeline.js';
import type {
  PipelineHandoffArtifactEnvelope,
  PublicPipelineHandoffArtifactSummary,
} from '../lib/pipeline-handoff-timeline.js';
import type { WorkContextActiveGroup } from '../lib/types.js';
import ArtifactFeedbackPanel from './ArtifactFeedbackPanel.js';
import './WorkspaceEvidenceArtifactsSection.css';

// SECURITY (#898): artifacts carry agent-authored content. This section renders
// METADATA + the bounded public `summary` text ONLY — never artifact-derived
// HTML, never an iframe, never raw payload bytes. Copy/export goes through
// `copyPipelineHandoffArtifact`, which returns the sanitized public-summary
// form (rawPayloadAvailable: false). Do not add dangerouslySetInnerHTML here.

export interface WorkspaceEvidenceArtifactsSectionProps {
  repoPath: string;
}

// Cap matched contexts so a busy workspace does not fan out unbounded queries.
const MAX_CONTEXTS = 5;

const ACTIVE_WORK_QUERY_KEY = ['active-work'] as const;

function shortHash(value: string | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}

function ArtifactCard({
  envelope,
  workContextId,
}: {
  envelope: PipelineHandoffArtifactEnvelope;
  workContextId: string;
}) {
  const meta: PublicPipelineHandoffArtifactSummary = envelope.metadata;
  const sessions = useSessionsStore((s) => s.sessions);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [copyState, setCopyState] = useState<
    | { kind: 'idle' }
    | { kind: 'copying' }
    | { kind: 'copied'; bytes: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const headShaShort = shortSha(meta.headSha);
  const payloadShaShort = shortHash(meta.payloadSha256);
  const taskSource = meta.taskRef
    ? `${meta.taskRef.kind}:${meta.taskRef.id}`
    : null;

  async function handleCopy() {
    setCopyState({ kind: 'copying' });
    try {
      // Public-summary export only — sanitized metadata + summary text, never
      // raw payload. We surface byte size for operator awareness, no preview.
      const result = await copyPipelineHandoffArtifact(meta.id);
      const text = JSON.stringify(result.artifact.metadata, null, 2);
      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
      }
      setCopyState({ kind: 'copied', bytes: result.copy.exportBytes });
    } catch (err) {
      setCopyState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'copy failed',
      });
    }
  }

  return (
    <div className="evidence-artifact" data-track="evidence.artifact-card">
      <div className="evidence-artifact__head">
        <span className="evidence-artifact__title">{meta.title}</span>
        <span
          className={`evidence-artifact__visibility evidence-artifact__visibility--${meta.visibility}`}
        >
          {meta.visibility}
        </span>
      </div>
      <div className="evidence-artifact__summary">{meta.summary}</div>
      <div className="evidence-artifact__meta">
        <span className="evidence-artifact__kind">{meta.kind}</span>
        {meta.stage && (
          <span className="evidence-artifact__stage">{meta.stage}</span>
        )}
        <span
          className="evidence-artifact__provenance"
          title={`work context ${workContextId}`}
        >
          wc {shortHash(workContextId)}
        </span>
        {taskSource && (
          <span className="evidence-artifact__task" title={meta.taskRef?.url}>
            {taskSource}
          </span>
        )}
      </div>
      <div className="evidence-artifact__meta evidence-artifact__meta--hashes">
        <span title={meta.capturedAt}>captured {meta.capturedAt}</span>
        {headShaShort && <span title={meta.headSha}>head {headShaShort}</span>}
        {payloadShaShort && (
          <span title={meta.payloadSha256}>sha {payloadShaShort}</span>
        )}
      </div>
      <div className="evidence-artifact__actions">
        {/* #890 contract: copy/export are public-only; CLI 403s identically — UI
            must match instead of erroring. Private artifacts disable the button. */}
        <button
          className="evidence-artifact__action"
          onClick={meta.visibility === 'public' ? handleCopy : undefined}
          disabled={
            meta.visibility !== 'public' || copyState.kind === 'copying'
          }
          title={
            meta.visibility !== 'public'
              ? 'private artifact — copy/export requires public visibility'
              : undefined
          }
        >
          {copyState.kind === 'copying' ? 'copying' : 'copy summary'}
        </button>
        <button
          className="evidence-artifact__action"
          onClick={() => setFeedbackOpen((open) => !open)}
        >
          {feedbackOpen ? 'hide feedback' : 'feedback'}
        </button>
        {copyState.kind === 'copied' && (
          <span className="evidence-artifact__copy-state">
            copied · {copyState.bytes}b
          </span>
        )}
        {copyState.kind === 'error' && (
          <span className="evidence-artifact__copy-error">
            {copyState.message}
          </span>
        )}
      </div>
      {feedbackOpen && (
        <ArtifactFeedbackPanel
          artifactRef={{
            artifactId: meta.id,
            workContextId: meta.workContextId,
            ...(meta.payloadSha256
              ? { payloadSha256: meta.payloadSha256 }
              : {}),
            kind: meta.kind,
            title: meta.title,
          }}
          artifactLabel={`${meta.kind} · ${meta.title}`}
          sessions={sessions}
          preferredTargetSessionId={null}
        />
      )}
    </div>
  );
}

export function WorkspaceEvidenceArtifactsSection({
  repoPath,
}: WorkspaceEvidenceArtifactsSectionProps) {
  // Reuse the SAME ['active-work'] query the sessions section uses so TanStack
  // dedups them into one fetch.
  const activeWork = useQuery<WorkContextActiveGroup[]>({
    queryKey: ACTIVE_WORK_QUERY_KEY,
    queryFn: fetchActiveWork,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  });

  const workContextIds = useMemo(
    () => resolveWorkContextIdsForRepo(activeWork.data ?? [], repoPath),
    [activeWork.data, repoPath]
  );

  const visibleIds = workContextIds.slice(0, MAX_CONTEXTS);
  const overflow = workContextIds.length - visibleIds.length;

  // One artifact query per matched context (capped). Keyed identically to any
  // other ['work-context-artifacts', wcId] consumer so they dedup.
  const artifactQueries = useQueries({
    queries: visibleIds.map((id) => ({
      queryKey: ['work-context-artifacts', id],
      queryFn: () => fetchPipelineHandoffArtifacts({ workContextId: id }),
      staleTime: 60_000,
      refetchOnWindowFocus: true,
    })),
  });

  const anyLoading = artifactQueries.some((q) => q.isLoading);
  const anyArtifacts = artifactQueries.some(
    (q) => (q.data?.length ?? 0) > 0
  );

  function renderBody() {
    if (activeWork.isLoading) {
      return <div className="section-message">loading…</div>;
    }
    if (activeWork.isError) {
      return (
        <div className="section-message section-message--error">
          failed to load work contexts
        </div>
      );
    }
    if (workContextIds.length === 0) {
      return (
        <div className="section-message">
          no work context bound to this workspace
        </div>
      );
    }
    return (
      <div className="evidence-artifacts">
        {visibleIds.map((id, index) => {
          const query = artifactQueries[index];
          if (query?.isLoading) {
            return (
              <div key={id} className="section-message">
                loading…
              </div>
            );
          }
          if (query?.isError) {
            // Inline error — never crash; other contexts still render.
            return (
              <div
                key={id}
                className="section-message section-message--error"
              >
                failed to load artifacts for this context
              </div>
            );
          }
          const artifacts = query?.data ?? [];
          if (artifacts.length === 0) return null;
          return (
            <div key={id} className="evidence-artifacts__group">
              {artifacts.map((envelope) => (
                <ArtifactCard
                  key={envelope.metadata.id}
                  envelope={envelope}
                  workContextId={id}
                />
              ))}
            </div>
          );
        })}
        {!anyLoading && !anyArtifacts && (
          <div className="section-message">no typed evidence refs yet</div>
        )}
        {overflow > 0 && (
          <div className="section-message">+{overflow} more contexts</div>
        )}
      </div>
    );
  }

  return (
    <section className="dashboard-section" data-track="evidence.artifacts">
      <div className="section-heading">artifacts</div>
      {renderBody()}
    </section>
  );
}

export default WorkspaceEvidenceArtifactsSection;
