/**
 * CustomBlock — Workbench slice 2 of epic #612.
 *
 * SCAFFOLD ONLY — agent-authored payload execution is NOT implemented here.
 *
 * This renderer is a placeholder for the extensibility escape-hatch defined in
 * CustomBlockDescriptor. The `rendererId` and `props` fields are displayed for
 * diagnostic purposes only.
 *
 * Slice 4 will implement:
 *   - A sandboxed execution environment for agent-authored renderers.
 *   - Registry lookup by `rendererId` for externally registered custom renderers.
 *   - Safe execution of `props` / `dataRefs` resolution from the hub.
 *
 * DO NOT execute `descriptor.meta.props` or `descriptor.meta.dataRefs` as code.
 * They are opaque JSON values forwarded from agent-authored payloads and must
 * not be treated as trusted input until slice 4 implements the sandbox.
 */

import React from 'react';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';

import './custom.css';

export const CustomBlock: WorkbenchBlockRenderer<'custom'> = ({
  descriptor,
  context: _context,
}) => {
  const { rendererId, dataRefs, props } = descriptor.meta;

  return (
    <div
      className="block-custom"
      aria-label={`custom block: ${descriptor.title}`}
    >
      <div className="block-custom__header">
        <div className="block-custom__kind">custom block</div>
        <div className="block-custom__title">{descriptor.title}</div>
      </div>

      <div className="block-custom__body">
        <div className="block-custom__notice">
          custom block (sandbox not yet implemented — slice 4)
        </div>

        <div className="block-custom__info">
          <div className="block-custom__row">
            <span className="block-custom__key">renderer</span>
            <span className="block-custom__value">{rendererId}</span>
          </div>

          {dataRefs && dataRefs.length > 0 && (
            <div className="block-custom__row">
              <span className="block-custom__key">data refs</span>
              <span className="block-custom__value">
                {dataRefs.length} ref(s)
              </span>
            </div>
          )}

          {props && Object.keys(props).length > 0 && (
            <div className="block-custom__row">
              <span className="block-custom__key">props</span>
              <span className="block-custom__value">
                {Object.keys(props).length} key(s)
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CustomBlock;
