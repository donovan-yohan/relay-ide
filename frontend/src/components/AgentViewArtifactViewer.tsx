import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  assembleInlinedHtml,
  type AgentViewSource,
  type ViewArtifactPackage,
} from '../../../shared/agent-view-artifact.js';
import { fetchAgentViewArtifactPackage } from '../lib/api.js';
import './AgentViewArtifactViewer.css';

export interface AgentViewArtifactViewerProps {
  artifactId: string | null;
  onClose: () => void;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; pkg: ViewArtifactPackage }
  | { kind: 'error'; message: string };

function sourceHref(source: AgentViewSource): string | null {
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function authorLabel(pkg: ViewArtifactPackage): string {
  const { authoring } = pkg.manifest;
  return authoring.harness
    ? `${authoring.actorId} · ${authoring.harness}`
    : authoring.actorId;
}

export function AgentViewArtifactViewer({
  artifactId,
  onClose,
}: AgentViewArtifactViewerProps) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });

  useEffect(() => {
    if (!artifactId) {
      setState({ kind: 'idle' });
      return;
    }

    let cancelled = false;
    setState({ kind: 'loading' });
    fetchAgentViewArtifactPackage(artifactId)
      .then((pkg) => {
        if (!cancelled) setState({ kind: 'ready', pkg });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'failed to load view',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  const inlinedHtml = useMemo(
    () => (state.kind === 'ready' ? assembleInlinedHtml(state.pkg) : ''),
    [state]
  );

  if (!artifactId) return null;

  const title =
    state.kind === 'ready'
      ? state.pkg.manifest.title
      : state.kind === 'loading'
        ? 'loading view artifact'
        : 'view artifact';

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div
      className="agent-view-artifact-viewer"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
      data-track="agent-view-artifact.viewer"
    >
      <section
        className="agent-view-artifact-viewer__modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-view-artifact-viewer-title"
      >
        <header className="agent-view-artifact-viewer__chrome">
          <div>
            <div className="agent-view-artifact-viewer__eyebrow">
              agent-authored static html
            </div>
            <h2
              className="agent-view-artifact-viewer__title"
              id="agent-view-artifact-viewer-title"
            >
              {title}
            </h2>
          </div>
          <button
            className="agent-view-artifact-viewer__close"
            onClick={onClose}
            type="button"
            aria-label="close view artifact"
          >
            close
          </button>
        </header>

        {state.kind === 'loading' && (
          <div className="agent-view-artifact-viewer__message">loading…</div>
        )}

        {state.kind === 'error' && (
          <div className="agent-view-artifact-viewer__message agent-view-artifact-viewer__message--error">
            {state.message}
          </div>
        )}

        {state.kind === 'ready' && (
          <div className="agent-view-artifact-viewer__content">
            <section
              className="agent-view-artifact-viewer__provenance"
              aria-label="view artifact provenance"
            >
              <div className="agent-view-artifact-viewer__provenance-head">
                <span className="agent-view-artifact-viewer__provenance-title">
                  {state.pkg.manifest.title}
                </span>
                <span className="agent-view-artifact-viewer__provenance-pill">
                  rev {state.pkg.manifest.revision.id}
                </span>
              </div>
              {state.pkg.manifest.description && (
                <p className="agent-view-artifact-viewer__description">
                  {state.pkg.manifest.description}
                </p>
              )}
              <dl className="agent-view-artifact-viewer__meta">
                <div>
                  <dt>agent</dt>
                  <dd>{authorLabel(state.pkg)}</dd>
                </div>
                <div>
                  <dt>created</dt>
                  <dd>{state.pkg.manifest.createdAt}</dd>
                </div>
                <div>
                  <dt>updated</dt>
                  <dd>{state.pkg.manifest.updatedAt}</dd>
                </div>
              </dl>
              <div className="agent-view-artifact-viewer__sources">
                <span className="agent-view-artifact-viewer__sources-label">
                  sources
                </span>
                {state.pkg.manifest.sources.length > 0 ? (
                  <ul className="agent-view-artifact-viewer__source-list">
                    {state.pkg.manifest.sources.map((source, index) => {
                      const href = sourceHref(source);
                      return (
                        <li key={`${source.label}-${index}`}>
                          {href ? (
                            <a
                              className="agent-view-artifact-viewer__source-link"
                              href={href}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {source.label}
                            </a>
                          ) : (
                            <span>{source.label}</span>
                          )}
                          {source.kind && (
                            <span className="agent-view-artifact-viewer__source-kind">
                              {source.kind}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <span className="agent-view-artifact-viewer__empty">
                    none declared
                  </span>
                )}
              </div>
            </section>

            {/* SECURITY (#830): this is the ONLY HTML render point for agent view
                artifacts. Keep sandbox as the hard-coded empty string. Never add
                allow-scripts, allow-same-origin, a fetchable src, or any sandbox
                escape hatch here. */}
            <iframe
              className="agent-view-artifact-viewer__frame"
              title={`view artifact preview: ${state.pkg.manifest.title}`}
              sandbox=""
              srcDoc={inlinedHtml}
            />
          </div>
        )}
      </section>
    </div>
  );
}

export default AgentViewArtifactViewer;
