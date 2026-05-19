/**
 * FileBlock — Workbench slice 2 of epic #612.
 *
 * Placeholder for a future browse/read/diff file panel.
 * Displays the node-scoped FileRef metadata and a placeholder body.
 * Raw filesystem paths are never used — the hub resolves the ref.
 *
 * Capability gating: BlockHost enforces 'rpc:fs:read' via
 * descriptor.capabilityRequirements before this component mounts.
 *
 * TODO(slice-3+): Wire actual RPC content fetch via file-rpc.ts once the
 * FS-RPC surface formalises the ref shape. FileTabContent and DiffViewer
 * (the established file-viewing components) should be integrated at that point.
 */

import React from 'react';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';

import './file.css';

export const FileBlock: WorkbenchBlockRenderer<'file'> = ({
  descriptor,
  context: _context,
}) => {
  const { fileRef, mode = 'read' } = descriptor.meta;
  // BlockHost already gates on capabilityRequirements (which must include
  // 'rpc:fs:read') before mounting this component. No redundant check here.
  const displayName = fileRef.displayName ?? fileRef.id;

  return (
    <div className="block-file" aria-label={`file: ${descriptor.title}`}>
      <div className="block-file__header">
        <div className="block-file__kind">file · {mode}</div>
        <div className="block-file__name">{displayName}</div>
        <div className="block-file__ref">{fileRef.id}</div>
      </div>

      <div className="block-file__body">
        {/*
         * TODO(slice-3+): Replace this placeholder with a real RPC fetch
         * once file-rpc.ts formalises the FileRef → content resolution path.
         * The FileTabContent + DiffViewer components (already used in the
         * workspace) should be wired here once the content is available.
         */}
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
};

export default FileBlock;
