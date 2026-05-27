/**
 * FileBlock — Workbench slice 2 of epic #616.
 *
 * Renders file contents fetched via the file RPC surface using a
 * `FileResourceRef`. Falls back gracefully for legacy `FileRef` descriptors
 * (renders the original placeholder copy with no fetch attempted).
 *
 * Capability gating: BlockHost enforces 'rpc:fs:read' via
 * descriptor.capabilityRequirements before this component mounts.
 */

import React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { createPatch } from 'diff';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import { isFileResourceRef } from '../../../../shared/workbench-block-types.js';
import {
  FILE_RPC_DEFAULT_LIST_ENTRIES,
  FILE_RPC_MAX_READ_BYTES,
  FILE_RPC_MAX_TAIL_BYTES,
  FILE_RPC_MAX_TAIL_LINES,
} from '../../../../shared/file-rpc.js';
import { grantedBits } from '../../../../shared/workbench-capability-utils.js';
import {
  fetchNodeFsList,
  fetchNodeFsRead,
  fetchNodeFsStat,
  fetchNodeFsTail,
  fetchNodeFsWrite,
  type NodeFsReadArgs,
  type NodeFsStatArgs,
  HttpError,
} from '../../lib/api.js';
import { DiffViewer } from '../../components/DiffViewer.js';

import './file.css';

/** Extensions considered binary for preview purposes. */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'pdf',
  'zip',
  'gz',
  'tar',
  'exe',
  'so',
  'dylib',
  'dll',
  'wasm',
  'woff',
  'woff2',
  'mp3',
  'mp4',
  'mov',
]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

type FileBlockMode = 'read' | 'edit' | 'diff';

const FILE_RPC_WRITE_HASH_MISMATCH_CODE = 'FILE_RPC_WRITE_HASH_MISMATCH';
const FILE_RPC_INVALID_REQUEST_CODE = 'INVALID_REQUEST';
const FILE_RPC_EXPECTED_HASH_MISMATCH_REASON_CODE =
  'FILE_RPC_EXPECTED_HASH_MISMATCH';

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

function isImagePath(path: string): boolean {
  return extension(path) in IMAGE_MIME_BY_EXTENSION;
}

function imageMimeForPath(path: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION[extension(path)];
}

function isPdfPath(path: string): boolean {
  return extension(path) === 'pdf';
}

function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extension(path));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kb`;
  return `${(n / (1024 * 1024)).toFixed(1)} mb`;
}

function formatFreshness(mtimeMs?: number, capturedAt?: string): string {
  if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) {
    const date = new Date(mtimeMs);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return capturedAt ?? 'unknown';
}

function isWriteHashMismatchError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  const reasonCode = err.details?.reasonCode;
  return (
    err.code === FILE_RPC_WRITE_HASH_MISMATCH_CODE ||
    (err.code === FILE_RPC_INVALID_REQUEST_CODE &&
      reasonCode === FILE_RPC_EXPECTED_HASH_MISMATCH_REASON_CODE)
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const code = err.code ?? String(err.status ?? '');
    const msg = err.message ?? '';
    if (code === 'NODE_OFFLINE') return 'node offline';
    if (err.status === 403 || code === 'FORBIDDEN' || code === 'UNAUTHORIZED')
      return 'not authorized';
    if (
      err.status === 404 ||
      code === 'NOT_FOUND' ||
      code === 'FILE_RPC_NOT_FOUND'
    )
      return 'file not found';
    if (code === 'FILE_RPC_SESSION_REQUIRED') return 'session required';
    if (isWriteHashMismatchError(err))
      return 'file changed since last read — reload before saving';
    if (code === 'FILE_RPC_WRITE_PERMISSION_DENIED')
      return 'write permission denied on node';
    if (code === 'FILE_RPC_WRITE_SIZE_EXCEEDED')
      return 'write exceeds size cap';
    if (code === 'FILE_RPC_WRITE_NO_SPACE') return 'no space left on node';
    return msg.toLowerCase() || `error ${String(err.status ?? '')}`;
  }
  if (err instanceof Error) return err.message.toLowerCase();
  return 'unknown error';
}

export const FileBlock: WorkbenchBlockRenderer<'file'> = ({
  descriptor,
  context,
}) => {
  const { fileRef, mode = 'read' } = descriptor.meta;

  // ---------------------------------------------------------------------------
  // Legacy FileRef passthrough — no fetch attempted
  // ---------------------------------------------------------------------------
  if (!isFileResourceRef(fileRef)) {
    const displayName = fileRef.displayName ?? fileRef.id;
    return (
      <div className="block-file" aria-label={`file: ${descriptor.title}`}>
        <div className="block-file__header">
          <div className="block-file__kind">file · {mode}</div>
          <div className="block-file__name">{displayName}</div>
          <div className="block-file__ref">{fileRef.id}</div>
        </div>
        <div className="block-file__body">
          <div className="block-file__placeholder">
            <div className="block-file__placeholder-label">
              {mode === 'diff' ? 'diff view' : 'file view'}
            </div>
            <div className="block-file__placeholder-detail">
              file content loading not yet wired (pending slice-3 rpc:fs
              integration)
            </div>
            <div className="block-file__placeholder-ref">{fileRef.id}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <FileBlockContent
      descriptor={descriptor}
      fileRef={fileRef}
      mode={mode}
      context={context}
    />
  );
};

/** Inner component — always receives a FileResourceRef, safe to call hooks. */
function FileBlockContent({
  descriptor,
  fileRef,
  mode,
  context,
}: {
  descriptor: Parameters<WorkbenchBlockRenderer<'file'>>[0]['descriptor'];
  fileRef: import('../../../../shared/file-resource-ref.js').FileResourceRef;
  mode: FileBlockMode;
  context: Parameters<WorkbenchBlockRenderer<'file'>>[0]['context'];
}) {
  const { nodeId, path } = fileRef;
  const sessionId = context.session?.sessionId;
  const readGranted = grantedBits(context).has('rpc:fs:read');

  const headerNode = (
    <div className="block-file__header">
      <div className="block-file__kind">file · {mode}</div>
      <div className="block-file__name">{path.split('/').pop() ?? path}</div>
      <div className="block-file__ref">{path}</div>
    </div>
  );
  const advisoryMetadataNode = (
    <FileBlockMetadata
      fileRef={fileRef}
      nodeId={nodeId}
      sizeBytes={fileRef.size}
      freshness={formatFreshness(fileRef.mtimeMs, fileRef.capturedAt)}
      readGranted={readGranted}
    />
  );

  // No session → short-circuit
  if (!sessionId) {
    return (
      <div className="block-file" aria-label={`file: ${descriptor.title}`}>
        {headerNode}
        <div className="block-file__body">
          {advisoryMetadataNode}
          <div className="block-file__error block-file__error--session">
            session required to fetch file
          </div>
        </div>
      </div>
    );
  }

  return (
    <FileBlockFetcher
      descriptor={descriptor}
      fileRef={fileRef}
      nodeId={nodeId}
      sessionId={sessionId}
      path={path}
      mode={mode}
      headerNode={headerNode}
      context={context}
    />
  );
}

function FileBlockMetadata({
  fileRef,
  nodeId,
  sizeBytes,
  freshness,
  readGranted,
}: {
  fileRef: import('../../../../shared/file-resource-ref.js').FileResourceRef;
  nodeId: string;
  sizeBytes?: number | undefined;
  freshness: string;
  readGranted: boolean;
}) {
  const binding = fileRef.repoBinding;
  return (
    <div className="block-file__metadata" aria-label="file metadata">
      <span>node: {nodeId}</span>
      <span>path: {fileRef.path}</span>
      <span>size: {sizeBytes !== undefined ? formatBytes(sizeBytes) : 'unknown'}</span>
      <span>fresh: {freshness}</span>
      <span>intent: {fileRef.intent}</span>
      <span>grant: {readGranted ? 'read granted' : 'read denied'}</span>
      <span>repo: {binding?.repoPath ?? 'non-git cwd'}</span>
      <span>worktree: {binding?.worktreePath ?? 'none'}</span>
    </div>
  );
}

function FileBlockPlaceholder({ label }: { label: string }) {
  return (
    <div className="block-file__placeholder">
      <div className="block-file__placeholder-detail">{label}</div>
    </div>
  );
}

/** Innermost component — calls hooks unconditionally. */
function FileBlockFetcher({
  descriptor,
  fileRef,
  nodeId,
  sessionId,
  path,
  mode,
  headerNode,
  context,
}: {
  descriptor: import('../../../../shared/workbench-block-types.js').FileBlockDescriptor;
  fileRef: import('../../../../shared/file-resource-ref.js').FileResourceRef;
  nodeId: string;
  sessionId: string;
  path: string;
  mode: FileBlockMode;
  headerNode: React.ReactNode;
  context: Parameters<WorkbenchBlockRenderer<'file'>>[0]['context'];
}) {
  const statArgs: NodeFsStatArgs = { nodeId, sessionId, path };
  const statQuery = useQuery({
    queryKey: ['fs.stat', nodeId, sessionId, path],
    queryFn: () => fetchNodeFsStat(statArgs),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const stat = statQuery.data?.stat;
  const sizeBytes = stat?.size ?? fileRef.size;
  const statFreshness = formatFreshness(stat?.mtimeMs, fileRef.capturedAt);
  const directory = stat?.type === 'directory';
  const imageMime = imageMimeForPath(path);
  const image = isImagePath(path);
  const pdf = isPdfPath(path);
  const binary = isBinaryPath(path);
  const tooLarge =
    !directory && !binary && sizeBytes !== undefined && sizeBytes > FILE_RPC_MAX_READ_BYTES;
  const imageTooLarge =
    image && sizeBytes !== undefined && sizeBytes > FILE_RPC_MAX_READ_BYTES;
  const tailMode = fileRef.intent === 'tail';
  const enableRead =
    statQuery.isSuccess &&
    !directory &&
    !tailMode &&
    !image &&
    !pdf &&
    !binary &&
    !tooLarge;

  const listQuery = useQuery({
    queryKey: ['fs.list', nodeId, sessionId, path],
    queryFn: () =>
      fetchNodeFsList({
        nodeId,
        sessionId,
        cwd: statQuery.data?.cwd ?? path,
        path,
        maxEntries: FILE_RPC_DEFAULT_LIST_ENTRIES,
      }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: statQuery.isSuccess && stat !== undefined && stat.type === 'directory',
  });

  const tailQuery = useQuery({
    queryKey: ['fs.tail', nodeId, sessionId, path],
    queryFn: () =>
      fetchNodeFsTail({
        nodeId,
        sessionId,
        path,
        maxBytes: FILE_RPC_MAX_TAIL_BYTES,
        maxLines: FILE_RPC_MAX_TAIL_LINES,
        follow: false,
      }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: statQuery.isSuccess && !directory && tailMode,
  });

  const imageQuery = useQuery({
    queryKey: ['fs.read', nodeId, sessionId, path, 'base64'],
    queryFn: () =>
      fetchNodeFsRead({
        nodeId,
        sessionId,
        path,
        maxBytes: FILE_RPC_MAX_READ_BYTES,
        encoding: 'base64',
      }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: statQuery.isSuccess && image && !imageTooLarge && !directory,
  });

  const readArgs: NodeFsReadArgs = {
    nodeId,
    sessionId,
    path,
    maxBytes: FILE_RPC_MAX_READ_BYTES,
  };
  const readQuery = useQuery({
    queryKey: ['fs.read', nodeId, sessionId, path],
    queryFn: () => fetchNodeFsRead(readArgs),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: enableRead,
  });

  const metadataNode = (
    <FileBlockMetadata
      fileRef={fileRef}
      nodeId={nodeId}
      sizeBytes={sizeBytes}
      freshness={statFreshness}
      readGranted={grantedBits(context).has('rpc:fs:read')}
    />
  );

  function renderDirectoryPreview() {
    if (listQuery.isLoading) {
      return <FileBlockPlaceholder label="loading directory…" />;
    }
    if (listQuery.isError) {
      return <div className="block-file__error">{errorMessage(listQuery.error)}</div>;
    }
    const entries = listQuery.data?.entries ?? [];
    if (entries.length === 0) {
      return (
        <div className="block-file__directory block-file__directory--empty">
          empty directory · cap {FILE_RPC_DEFAULT_LIST_ENTRIES} entries
        </div>
      );
    }
    return (
      <div className="block-file__directory">
        <div className="block-file__directory-meta">
          {entries.length} entries
          {listQuery.data?.truncated ? ` · truncated at ${listQuery.data.maxEntries}` : ''}
        </div>
        <div className="block-file__directory-list" role="list">
          {entries.map((entry) => (
            <div className="block-file__directory-entry" role="listitem" key={entry.path}>
              <span className="block-file__directory-entry-name">{entry.name}</span>
              <span>{entry.type}</span>
              <span>{formatBytes(entry.size)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderTailPreview() {
    if (tailQuery.isLoading) return <FileBlockPlaceholder label="loading tail…" />;
    if (tailQuery.isError) {
      return <div className="block-file__error">{errorMessage(tailQuery.error)}</div>;
    }
    if (!tailQuery.data) return <FileBlockPlaceholder label="tail preview" />;
    return (
      <div className="block-file__tail">
        <div className="block-file__tail-meta">
          latest {formatBytes(tailQuery.data.bytesRead)} · cap{' '}
          {formatBytes(tailQuery.data.maxBytes)} · offset {tailQuery.data.startOffset}-
          {tailQuery.data.endOffset}
          {tailQuery.data.truncatedBytes || tailQuery.data.truncatedLines
            ? ' · truncated'
            : ''}
        </div>
        <pre className="block-file__content">{tailQuery.data.content}</pre>
      </div>
    );
  }

  function renderImagePreview() {
    if (imageTooLarge && sizeBytes !== undefined) {
      return (
        <div className="block-file__too-large">
          {`image too large to preview · ${formatBytes(sizeBytes)} · cap ${formatBytes(FILE_RPC_MAX_READ_BYTES)}`}
        </div>
      );
    }
    if (imageQuery.isLoading) return <FileBlockPlaceholder label="loading image…" />;
    if (imageQuery.isError) {
      return <div className="block-file__error">{errorMessage(imageQuery.error)}</div>;
    }
    if (!imageQuery.data || !imageMime) return <FileBlockPlaceholder label="image preview" />;
    const src = `data:${imageMime};base64,${imageQuery.data.content}`;
    return (
      <div className="block-file__image">
        <img className="block-file__image-img" src={src} alt={path} />
        <div className="block-file__image-meta">
          {imageMime} · {formatBytes(imageQuery.data.bytesRead)}
          {imageQuery.data.truncatedBytes ? ' · truncated' : ''}
        </div>
      </div>
    );
  }

  function renderReadPreview() {
    if (tooLarge && sizeBytes !== undefined) {
      return (
        <div className="block-file__too-large">
          {`file too large to preview · ${formatBytes(sizeBytes)} · cap ${formatBytes(FILE_RPC_MAX_READ_BYTES)}`}
        </div>
      );
    }
    if (readQuery.isLoading) return <FileBlockPlaceholder label="loading…" />;
    if (readQuery.isError) {
      return <div className="block-file__error">{errorMessage(readQuery.error)}</div>;
    }
    if (!readQuery.data) {
      return <FileBlockPlaceholder label={mode === 'diff' ? 'diff view' : 'file view'} />;
    }
    const text = readQuery.data.content;
    if (mode === 'edit') {
      return (
        <FileBlockEditor
          nodeId={nodeId}
          sessionId={sessionId}
          path={path}
          initialContent={text}
          context={context}
          onSaved={() => {
            void readQuery.refetch();
            void statQuery.refetch();
          }}
        />
      );
    }
    return <pre className="block-file__content">{text}</pre>;
  }

  function body() {
    if (statQuery.isError) {
      return <div className="block-file__error">{errorMessage(statQuery.error)}</div>;
    }
    if (statQuery.isLoading) return <FileBlockPlaceholder label="loading…" />;
    if (directory) return renderDirectoryPreview();
    if (tailMode) return renderTailPreview();
    if (image) return renderImagePreview();
    if (pdf) {
      return (
        <div className="block-file__unsupported block-file__unsupported--pdf">
          pdf preview unavailable · metadata only · open/download from file browser
        </div>
      );
    }
    if (binary) {
      return (
        <div className="block-file__binary block-file__unsupported">
          unsupported preview · binary content · open/download from file browser · {path}
          {sizeBytes !== undefined ? ` · ${formatBytes(sizeBytes)}` : ''}
        </div>
      );
    }
    return renderReadPreview();
  }

  return (
    <div className="block-file" aria-label={`file: ${descriptor.title}`}>
      {headerNode}
      <div className="block-file__body">
        {metadataNode}
        {body()}
      </div>
    </div>
  );
}

/**
 * Edit-mode subcomponent. Renders an editable textarea seeded with the
 * file's current content. Hides the save affordance when `rpc:fs:write`
 * is not granted in the context.
 *
 * Save flow:
 *   1. User edits → "preview diff" toggles a unified-diff view via DiffViewer.
 *   2. "confirm write" → POST fs.write with `mode: 'overwrite'` and an
 *      `expectedHash` derived from the initial content (sha256 of the read
 *      response). Server enforces optimistic concurrency: a mismatch surfaces
 *      as `FILE_RPC_WRITE_HASH_MISMATCH` or the server's real
 *      `INVALID_REQUEST` + `details.reasonCode =
 *      FILE_RPC_EXPECTED_HASH_MISMATCH` shape → inline error copy prompts a
 *      reload.
 *   3. On success, parent refetches stat+read so the editor re-seeds.
 *
 * No raw-bytes display, no preview escapes — write content stays in the
 * textarea state and is base64-encoded by `fetchNodeFsWrite` for transport.
 */
function FileBlockEditor({
  nodeId,
  sessionId,
  path,
  initialContent,
  context,
  onSaved,
}: {
  nodeId: string;
  sessionId: string;
  path: string;
  initialContent: string;
  context: Parameters<WorkbenchBlockRenderer<'file'>>[0]['context'];
  onSaved: () => void;
}) {
  const [draft, setDraft] = React.useState(initialContent);
  const [showingDiff, setShowingDiff] = React.useState(false);
  const [expectedHash, setExpectedHash] = React.useState<string | null>(null);

  // Hash the current baseline so the server can detect concurrent edits.
  React.useEffect(() => {
    let cancelled = false;
    setExpectedHash(null);
    void sha256Hex(initialContent).then((hash) => {
      if (!cancelled) setExpectedHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [initialContent]);

  const writable = grantedBits(context).has('rpc:fs:write');

  const mutation = useMutation({
    mutationFn: () =>
      fetchNodeFsWrite({
        nodeId,
        sessionId,
        path,
        mode: 'overwrite',
        content: draft,
        ...(expectedHash ? { expectedHash } : {}),
      }),
    onSuccess: () => {
      setShowingDiff(false);
      onSaved();
    },
  });

  const resetMutation = mutation.reset;

  // Refetch/reload can replace the parent read result without remounting this
  // editor. Treat a changed initialContent as a new server baseline: discard the
  // stale draft/diff/error from the old baseline, but leave normal typing alone
  // while initialContent is unchanged.
  React.useEffect(() => {
    setDraft(initialContent);
    setShowingDiff(false);
    resetMutation();
  }, [initialContent, resetMutation]);

  const unchanged = draft === initialContent;
  const diff = React.useMemo(() => {
    if (!showingDiff) return '';
    return createPatch(path, initialContent, draft, '', '');
  }, [showingDiff, path, initialContent, draft]);

  if (!writable) {
    return (
      <div className="block-file__edit">
        <textarea
          className="block-file__edit-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly
          aria-label={`file editor (read-only) ${path}`}
        />
        <div className="block-file__edit-gate">
          rpc:fs:write not granted — cannot save
        </div>
      </div>
    );
  }

  return (
    <div className="block-file__edit">
      {!showingDiff && (
        <textarea
          className="block-file__edit-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`file editor ${path}`}
        />
      )}
      {showingDiff && (
        <div className="block-file__edit-diff">
          <DiffViewer diff={diff} filePath={path} mode="unified" />
        </div>
      )}
      <div className="block-file__edit-actions">
        {!showingDiff && (
          <button
            type="button"
            className="block-file__edit-button"
            disabled={unchanged}
            onClick={() => setShowingDiff(true)}
          >
            preview diff
          </button>
        )}
        {showingDiff && (
          <>
            <button
              type="button"
              className="block-file__edit-button"
              onClick={() => setShowingDiff(false)}
              disabled={mutation.isPending}
            >
              back to edit
            </button>
            <button
              type="button"
              className="block-file__edit-button block-file__edit-button--primary"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || unchanged || !expectedHash}
            >
              {mutation.isPending ? 'saving…' : 'confirm write'}
            </button>
          </>
        )}
      </div>
      {mutation.isError && (
        <div className="block-file__error">
          {errorMessage(mutation.error)}
          {isWriteHashMismatchError(mutation.error) && (
            <button
              type="button"
              className="block-file__edit-button block-file__edit-reload"
              onClick={onSaved}
            >
              reload
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** sha256 hex of a UTF-8 string via Web Crypto. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default FileBlock;
