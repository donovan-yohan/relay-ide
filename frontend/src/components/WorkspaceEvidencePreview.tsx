import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchWorkspaceEvidencePreview,
  type WorkspaceEvidenceApiError,
} from '../lib/api.js';
import type { WorkspaceEvidenceRoot } from '../../../shared/workspace-evidence.js';
import { mapPreviewToRenderKind } from '../lib/workspace-evidence-view.js';
import CodeBlock from './CodeBlock.js';
import DiffViewer from './DiffViewer.js';
import './WorkspaceEvidencePreview.css';

export interface WorkspaceEvidencePreviewProps {
  root: WorkspaceEvidenceRoot;
  selectedPath: string | null;
}

function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

// The evidence preview type has no mimeType field, so derive a best-effort
// image MIME from the file extension. Browsers will not render an <img> whose
// src uses application/octet-stream; default to image/* for unknown extensions.
function imageMimeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[ext] ?? 'image/*';
}

export function WorkspaceEvidencePreview({
  root,
  selectedPath,
}: WorkspaceEvidencePreviewProps) {
  const rootId = root.ref.id;
  const query = useQuery({
    queryKey: ['workspace-evidence-preview', rootId, selectedPath],
    queryFn: () =>
      fetchWorkspaceEvidencePreview({
        rootRef: root.ref,
        path: selectedPath as string,
      }),
    enabled: Boolean(selectedPath),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  if (!selectedPath) {
    return (
      <div className="evidence-preview" data-track="evidence.preview">
        <div className="evidence-preview__notice">select a file to preview</div>
      </div>
    );
  }

  let body: ReactNode;
  if (query.isError) {
    const err = query.error as WorkspaceEvidenceApiError | Error;
    const reason =
      'error' in err && err.error ? err.error.reason : undefined;
    if (reason === 'WORKSPACE_EVIDENCE_NOT_FOUND') {
      body = <div className="evidence-preview__notice">file not found</div>;
    } else if (reason === 'WORKSPACE_EVIDENCE_PERMISSION_DENIED') {
      body = (
        <div className="evidence-preview__notice">
          permission denied reading this file
        </div>
      );
    } else {
      body = <div className="evidence-preview__notice">failed to load preview</div>;
    }
  } else if (query.isPending || !query.data) {
    body = <div className="evidence-preview__notice">loading…</div>;
  } else {
    const preview = query.data.preview;
    const { mode, language } = mapPreviewToRenderKind(preview);
    const content = preview.content ?? '';
    switch (mode) {
      case 'oversized':
        body = (
          <div className="evidence-preview__notice">
            file too large to preview · cap 64kb
          </div>
        );
        break;
      case 'binary':
        body = (
          <div className="evidence-preview__notice">
            binary file — cannot preview
          </div>
        );
        break;
      case 'unsupported':
        body = (
          <div className="evidence-preview__notice">
            preview unsupported for this file type
          </div>
        );
        break;
      case 'error':
        body = <div className="evidence-preview__notice">file not found</div>;
        break;
      case 'image':
        body = (
          <div className="evidence-preview__image">
            <img
              src={`data:${imageMimeForPath(selectedPath)};base64,${content}`}
              alt={fileName(selectedPath)}
            />
          </div>
        );
        break;
      case 'diff':
        body = <DiffViewer diff={content} filePath={selectedPath} />;
        break;
      default:
        body = (
          <CodeBlock
            code={content}
            language={language ?? 'text'}
            showLineNumbers={false}
            cacheKey={`evidence:${rootId}:${selectedPath}`}
          />
        );
    }
  }

  return (
    <div className="evidence-preview" data-track="evidence.preview">
      <div className="evidence-preview__header">
        <span className="evidence-preview__name">{fileName(selectedPath)}</span>
        {query.data?.preview.kind && (
          <span className="evidence-preview__kind">
            {query.data.preview.kind}
          </span>
        )}
      </div>
      <div className="evidence-preview__body">{body}</div>
    </div>
  );
}

export default WorkspaceEvidencePreview;
