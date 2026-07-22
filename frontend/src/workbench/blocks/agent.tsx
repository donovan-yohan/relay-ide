/**
 * AgentBlock — Workbench slice 2 of epic #612.
 *
 * Shows one actor/runtime session and its latest bounded state.
 *
 * #1224: the legacy agent-chat surface this block used to embed was retired
 * along with the rest of the web-session/Turn subtree. The Workbench AgentBlock
 * chain is statically dormant (no live launch path mounts it), so it now
 * renders a bounded placeholder that names the actor and its backing session
 * instead of the deleted chat surface. Reviving a live agent surface here
 * should target the channel timeline, not the removed legacy chat surface.
 *
 * No raw global paths escape this component.
 */

import React from 'react';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';

import './agent.css';

export const AgentBlock: WorkbenchBlockRenderer<'agent'> = ({
  descriptor,
  context: _context,
}) => {
  const { actorRef } = descriptor.meta;
  // actorRef.id is an actor identifier; actorRef.sessionRef carries the live
  // Relay session that backs this actor (absent when the actor has no attached
  // live session).
  const sessionId = actorRef.sessionRef?.sessionId ?? null;

  return (
    <div className="block-agent" aria-label={`agent: ${descriptor.title}`}>
      <div className="block-agent__header">
        <span className="block-agent__actor">
          {actorRef.displayName ?? actorRef.id}
        </span>
      </div>
      <div className="block-agent__chat">
        <p className="block-agent__placeholder">
          {sessionId ? `session ${sessionId}` : 'no live session attached'}
        </p>
      </div>
    </div>
  );
};

export default AgentBlock;
