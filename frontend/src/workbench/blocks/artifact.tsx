/**
 * ArtifactBlock — Workbench slice 2 of epic #612.
 *
 * PR/check/log/screenshot/diag bundle preview.
 * Branches on artifactRef.kind for kind-specific formatting. Falls back to
 * a generic preview card for unknown artifact kinds.
 *
 * ArtifactRef shapes come from shared/work-context.ts. The ref carries
 * id, kind, title, uri, mediaType, summary — no raw payload data.
 * Raw content is never stored inline; the ref points to a hub-managed store.
 *
 * TODO(slice-3+): Add actual content fetching via the artifact URI when the
 * hub artifact store API is defined.
 */

import React from 'react';

import type {
  WorkbenchBlockRenderer,
  ArtifactRef,
} from '../../../../shared/workbench-block-types.js';

import './artifact.css';

const _fmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

function formatTimestamp(iso: string): string {
  try {
    return _fmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Human-readable label for each artifact kind. */
function artifactKindLabel(kind: ArtifactRef['kind']): string {
  switch (kind) {
    case 'file':
      return 'file';
    case 'diff':
      return 'diff';
    case 'log-ref':
      return 'log';
    case 'transcript-ref':
      return 'transcript';
    case 'screenshot':
      return 'screenshot';
    case 'report':
      return 'report';
    case 'command-output-ref':
      return 'command output';
    case 'external':
      return 'external';
    default: {
      // Exhaustiveness guard — if ArtifactRef['kind'] gains a new literal,
      // TypeScript will flag this `kind satisfies never` line at compile time.
      const _exhaustive: never = kind;
      return String(_exhaustive);
    }
  }
}

/** Render kind-specific content hint. */
function ArtifactKindDetail({ artifactRef }: { artifactRef: ArtifactRef }) {
  switch (artifactRef.kind) {
    case 'screenshot':
      return (
        <div className="block-artifact__detail">
          screenshot — preview not yet wired (slice 3)
        </div>
      );
    case 'diff':
      return (
        <div className="block-artifact__detail">
          diff artifact — viewer not yet wired (slice 3)
        </div>
      );
    case 'log-ref':
    case 'command-output-ref':
    case 'transcript-ref':
      return (
        <div className="block-artifact__detail">
          log stream — viewer not yet wired (slice 3)
        </div>
      );
    default:
      return artifactRef.summary ? (
        <div className="block-artifact__summary">{artifactRef.summary}</div>
      ) : null;
  }
}

export const ArtifactBlock: WorkbenchBlockRenderer<'artifact'> = ({
  descriptor,
  context: _context,
}) => {
  const { artifactRef } = descriptor.meta;
  const kindLabel = artifactKindLabel(artifactRef.kind);

  return (
    <div
      className="block-artifact"
      aria-label={`artifact: ${descriptor.title}`}
    >
      <div className="block-artifact__header">
        <div className="block-artifact__kind">{kindLabel}</div>
        <div className="block-artifact__title">
          {artifactRef.title ?? descriptor.title}
        </div>
        {artifactRef.mediaType && (
          <div className="block-artifact__media-type">
            {artifactRef.mediaType}
          </div>
        )}
      </div>

      <div className="block-artifact__body">
        <ArtifactKindDetail artifactRef={artifactRef} />

        {artifactRef.uri && (
          <div className="block-artifact__ref">
            <span className="block-artifact__ref-label">uri</span>
            <span className="block-artifact__ref-value">{artifactRef.uri}</span>
          </div>
        )}

        <div className="block-artifact__meta">
          <div className="block-artifact__meta-row">
            <span className="block-artifact__meta-key">id</span>
            <span className="block-artifact__meta-value">{artifactRef.id}</span>
          </div>
          {artifactRef.producedAt && (
            <div className="block-artifact__meta-row">
              <span className="block-artifact__meta-key">produced</span>
              <span className="block-artifact__meta-value">
                {formatTimestamp(artifactRef.producedAt)}
              </span>
            </div>
          )}
          {artifactRef.producedByActorId && (
            <div className="block-artifact__meta-row">
              <span className="block-artifact__meta-key">by</span>
              <span className="block-artifact__meta-value">
                {artifactRef.producedByActorId}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ArtifactBlock;
