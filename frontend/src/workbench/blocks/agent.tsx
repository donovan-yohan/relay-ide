/**
 * AgentBlock — Workbench slice 2 of epic #612.
 *
 * Shows one actor/runtime session and its latest bounded state.
 * Reuses the existing ChatView component (agent chat surface) keyed on the
 * session id from actorRef.sessionRef. ChatView connects to /ws/:sessionId;
 * passing an actor identifier (actorRef.id) instead would route to a
 * non-existent socket. actorRef.sessionRef carries the live Relay session
 * that backs this actor.
 *
 * When actorRef.sessionRef is absent (actor has no attached live session),
 * ChatView receives null and renders its disconnected state.
 *
 * No raw global paths escape this component.
 */

import React from 'react';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import { ChatView } from '../../components/chat/ChatView.js';

import './agent.css';

export const AgentBlock: WorkbenchBlockRenderer<'agent'> = ({
  descriptor,
  context: _context,
}) => {
  const { actorRef } = descriptor.meta;
  // Use the session id from the actor's live sessionRef for socket routing.
  // actorRef.id is an actor identifier, not a Relay session id.
  const sessionId = actorRef.sessionRef?.sessionId ?? null;

  return (
    <div className="block-agent" aria-label={`agent: ${descriptor.title}`}>
      <div className="block-agent__header">
        <span className="block-agent__actor">
          {actorRef.displayName ?? actorRef.id}
        </span>
      </div>
      <div className="block-agent__chat">
        <ChatView sessionId={sessionId} />
      </div>
    </div>
  );
};

export default AgentBlock;
