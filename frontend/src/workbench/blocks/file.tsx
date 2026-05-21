/**
 * FileBlock — Workbench slice 2 of epic #616.
 *
 * Renders file contents fetched via the file RPC surface using a
 * `FileResourceRef`. Falls back gracefully for legacy `FileRef` descriptors
 * (renders the original placeholder copy with no fetch attempted).
 *
 * Capability gating: BlockHost enforces 'rpc:fs:read' via
 * descriptor.capabilityRequirements before this component mounts.
 *
 * State branches:
 *   - legacy FileRef → placeholder (no fetch)
 *   - missing sessionId → "session required" empty state
 *   - stat loading → loading copy
 *   - stat error → inline error copy
 *   - binary extension → "binary content" fallback with size + path
 *   - size > FILE_RPC_MAX_READ_BYTES → "too large" fallback with size + cap
 *   - read loading → loading copy
 *   - read error → inline error copy
 *   - success → decoded text in monospace <pre>
 *
 * Deferred: markdown, PDF, image, diff rendering.
 */

import React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { createPatch } from 'diff';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import { isFileResourceRef } from '../../../../shared/workbench-block-types.js';
import { FILE_RPC_MAX_READ_BYTES } from '../../../../shared/file-rpc.js';
import { grantedBits } from '../../../../shared/workbench-capability-utils.js';
import {
  fetchNodeFsStat,
  fetchNodeFsRead,
  fetchNodeFsWrite,
  type NodeFsStatArgs,
  type NodeFsReadArgs,
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

type FileBlockMode = 'read' | 'edit' | 'diff';

const FILE_RPC_WRITE_HASH_MISMATCH_CODE = 'FILE_RPC_WRITE_HASH_MISMATCH';
const FILE_RPC_INVALID_REQUEST_CODE = 'INVALID_REQUEST';
const FILE_RPC_EXPECTED_HASH_MISMATCH_REASON_CODE =
  'FILE_RPC_EXPECTED_HASH_MISMATCH';

function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kb`;
  return `${(n / (1024 * 1024)).toFixed(1)} mb`;
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

  // ---------------------------------------------------------------------------
  // FileResourceRef path — delegate to the inner component that can use hooks
  // ---------------------------------------------------------------------------
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

  const headerNode = (
    <div className="block-file__header">
      <div className="block-file__kind">file · {mode}</div>
      <div className="block-file__name">{path.split('/').pop() ?? path}</div>
      <div className="block-file__ref">{path}</div>
    </div>
  );

  // No session → short-circuit
  if (!sessionId) {
    return (
      <div className="block-file" aria-label={`file: ${descriptor.title}`}>
        {headerNode}
        <div className="block-file__body">
          <div className="block-file__error">
            session required to fetch file
          </div>
        </div>
      </div>
    );
  }

  return (
    <FileBlockFetcher
      descriptor={descriptor}
      nodeId={nodeId}
      sessionId={sessionId}
      path={path}
      mode={mode}
      headerNode={headerNode}
      context={context}
    />
  );
}

/** Innermost component — calls hooks unconditionally. */
function FileBlockFetcher({
  descriptor,
  nodeId,
  sessionId,
  path,
  mode,
  headerNode,
  context,
}: {
  descriptor: import('../../../../shared/workbench-block-types.js').FileBlockDescriptor;
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

  const sizeBytes = statQuery.data?.stat.size;
  const binary = isBinaryPath(path);
  const tooLarge =
    !binary && sizeBytes !== undefined && sizeBytes > FILE_RPC_MAX_READ_BYTES;
  // Only fetch content when stat succeeded, file is not binary, and within cap
  const enableRead = statQuery.isSuccess && !binary && !tooLarge;

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

  function body() {
    // stat error
    if (statQuery.isError) {
      return (
        <div className="block-file__error">{errorMessage(statQuery.error)}</div>
      );
    }

    // binary
    if (binary) {
      return (
        <div className="block-file__binary">
          binary content · {path}
          {sizeBytes !== undefined ? ` · ${formatBytes(sizeBytes)}` : ''}
        </div>
      );
    }

    // too large
    if (tooLarge && sizeBytes !== undefined) {
      return (
        <div className="block-file__too-large">
          {`file too large to preview · ${formatBytes(sizeBytes)} · cap ${formatBytes(FILE_RPC_MAX_READ_BYTES)}`}
        </div>
      );
    }

    // read loading / error
    if (statQuery.isLoading || (!statQuery.isError && readQuery.isLoading)) {
      return (
        <div className="block-file__placeholder">
          <div className="block-file__placeholder-detail">loading…</div>
        </div>
      );
    }

    if (readQuery.isError) {
      return (
        <div className="block-file__error">{errorMessage(readQuery.error)}</div>
      );
    }

    // success
    if (readQuery.data) {
      // FileRpcReadResponse.content is a UTF-8 string (encoding: 'utf8').
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

    // initial / idle
    return (
      <div className="block-file__placeholder">
        <div className="block-file__placeholder-detail">
          {mode === 'diff' ? 'diff view' : 'file view'}
        </div>
      </div>
    );
  }

  return (
    <div className="block-file" aria-label={`file: ${descriptor.title}`}>
      {headerNode}
      <div className="block-file__body">{body()}</div>
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
