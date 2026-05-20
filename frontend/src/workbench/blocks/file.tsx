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
import { useQuery } from '@tanstack/react-query';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import { isFileResourceRef } from '../../../../shared/workbench-block-types.js';
import { FILE_RPC_MAX_READ_BYTES } from '../../../../shared/file-rpc.js';
import {
  fetchNodeFsStat,
  fetchNodeFsRead,
  type NodeFsStatArgs,
  type NodeFsReadArgs,
  HttpError,
} from '../../lib/api.js';

import './file.css';

/** Extensions considered binary for preview purposes. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'pdf', 'zip', 'gz', 'tar',
  'exe', 'so', 'dylib', 'dll', 'wasm',
  'woff', 'woff2', 'mp3', 'mp4', 'mov',
]);

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

function errorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const code = err.code ?? String(err.status ?? '');
    const msg = err.message ?? '';
    if (code === 'NODE_OFFLINE') return 'node offline';
    if (err.status === 403 || code === 'FORBIDDEN') return 'not authorized';
    if (err.status === 404 || code === 'NOT_FOUND' || code === 'FILE_RPC_NOT_FOUND') return 'file not found';
    if (code === 'FILE_RPC_SESSION_REQUIRED') return 'session required';
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
  mode: 'read' | 'diff';
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
          <div className="block-file__error">session required to fetch file</div>
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
}: {
  descriptor: import('../../../../shared/workbench-block-types.js').FileBlockDescriptor;
  nodeId: string;
  sessionId: string;
  path: string;
  mode: 'read' | 'diff';
  headerNode: React.ReactNode;
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
    !binary &&
    sizeBytes !== undefined &&
    sizeBytes > FILE_RPC_MAX_READ_BYTES;
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
        <div className="block-file__error">
          {errorMessage(statQuery.error)}
        </div>
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
        <div className="block-file__error">
          {errorMessage(readQuery.error)}
        </div>
      );
    }

    // success
    if (readQuery.data) {
      // FileRpcReadResponse.content is a UTF-8 string (encoding: 'utf8').
      const text = readQuery.data.content;
      return (
        <pre className="block-file__content">
          {text}
        </pre>
      );
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

export default FileBlock;
