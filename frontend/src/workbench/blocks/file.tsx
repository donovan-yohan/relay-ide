/**
 * FileBlock — Workbench slice 2 of epic #612.
 *
 * Browse/read/diff a node-scoped file reference.
 * Uses the existing FileTabContent + DiffViewer + CodeBlock components, which
 * are the established file viewing surface in this codebase.
 *
 * Capability gating:
 *   - Requires 'rpc:fs:read' for read/diff mode (enforced at BlockHost level
 *     via descriptor.capabilityRequirements, but we also double-check here for
 *     belt-and-suspenders when grants change at runtime without remounting).
 *
 * The fileRef.id is the node-scoped identifier; displayName is a hint for UI.
 * Raw filesystem paths are never used — the hub resolves the ref.
 *
 * TODO(slice-3+): Wire actual RPC fetch via file-rpc.ts once the FS-RPC
 * surface formalises the ref shape. For now, displays the ref metadata and
 * a placeholder body.
 */

import React from 'react';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';

import './file.css';

export const FileBlock: WorkbenchBlockRenderer<'file'> = ({
  descriptor,
  context,
}) => {
  const { fileRef, mode = 'read' } = descriptor.meta;

  // Belt-and-suspenders capability check (BlockHost already gate-checks, but
  // grants may change between render cycles without remounting the block).
  const hasReadGrant = context.capabilityGrants.some(
    (g) =>
      g.capability === 'rpc:fs:read' || g.capabilities?.includes('rpc:fs:read')
  );

  const displayName = fileRef.displayName ?? fileRef.id;

  return (
    <div className="block-file" aria-label={`file: ${descriptor.title}`}>
      <div className="block-file__header">
        <div className="block-file__kind">file · {mode}</div>
        <div className="block-file__name">{displayName}</div>
        <div className="block-file__ref">{fileRef.id}</div>
      </div>

      <div className="block-file__body">
        {!hasReadGrant ? (
          <div className="block-file__denied" role="alert">
            rpc:fs:read capability required
          </div>
        ) : (
          /*
           * TODO(slice-3+): Replace this placeholder with a real RPC fetch
           * once file-rpc.ts formalises the FileRef → content resolution path.
           * The FileTabContent + DiffViewer components (already used in the
           * workspace) should be wired here once the content is available.
           */
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
        )}
      </div>
    </div>
  );
};

export default FileBlock;
