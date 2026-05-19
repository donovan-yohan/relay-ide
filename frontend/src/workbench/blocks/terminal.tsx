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
import Terminal from '../../components/Terminal.js';

import './terminal.css';

/**
 * Derive a stable sessionKey from the SessionRef for PTY routing.
 * For local sessions: sessionId is the key.
 * For remote sessions: nodeId:sessionId.
 */
function deriveSessionKey(nodeId: string, sessionId: string): string {
  if (nodeId === 'local') return sessionId;
  return `${nodeId}:${sessionId}`;
}

export const TerminalBlock: WorkbenchBlockRenderer<'terminal'> = ({
  descriptor,
  context: _context,
}) => {
  const { sessionRef } = descriptor.meta;
  const sessionKey = deriveSessionKey(sessionRef.nodeId, sessionRef.sessionId);

  return (
    <div
      className="block-terminal"
      aria-label={`terminal: ${descriptor.title}`}
    >
      <Terminal
        sessionId={sessionRef.sessionId}
        sessionKey={sessionKey}
        useTmux={true}
        isActive={true}
      />
    </div>
  );
};

export default TerminalBlock;
