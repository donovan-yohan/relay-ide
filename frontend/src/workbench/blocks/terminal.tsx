/**
 * TerminalBlock — Workbench slice 2 of epic #612.
 *
 * Attaches to a node-owned PTY/session via the existing Terminal component.
 * The terminal is mounted using sessionId and sessionKey derived from the
 * descriptor's sessionRef (scoped ref, never a raw filesystem path).
 *
 * In this slice the Terminal is rendered in a read-only / attach context.
 * The caller (WorkspaceContentLayer pattern) owns the PTY connection lifecycle;
 * this renderer simply surfaces it inside the block host.
 */

import React from 'react';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import { createGlobalSessionId } from '../../../../shared/identity.js';
import Terminal from '../../components/Terminal.js';

import './terminal.css';

/**
 * Derive a stable sessionKey from the SessionRef for PTY routing.
 * Prefers the pre-computed globalSessionId when present (already URI-encoded),
 * otherwise constructs it via createGlobalSessionId (URI-encodes nodeId and
 * sessionId so reserved characters are safe for parseGlobalSessionId).
 */
function deriveSessionKey(
  nodeId: string,
  sessionId: string,
  globalSessionId?: string
): string {
  if (globalSessionId) return globalSessionId;
  return createGlobalSessionId(nodeId, sessionId);
}

export const TerminalBlock: WorkbenchBlockRenderer<'terminal'> = ({
  descriptor,
  context: _context,
}) => {
  const { sessionRef } = descriptor.meta;
  const sessionKey = deriveSessionKey(
    sessionRef.nodeId,
    sessionRef.sessionId,
    sessionRef.globalSessionId
  );

  return (
    <div
      className="block-terminal"
      aria-label={`terminal: ${descriptor.title}`}
    >
      <Terminal
        sessionId={sessionRef.sessionId}
        sessionKey={sessionKey}
        isActive={true}
      />
    </div>
  );
};

export default TerminalBlock;
