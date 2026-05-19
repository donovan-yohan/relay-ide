/**
 * AgentBlock — Workbench slice 2 of epic #612.
 *
 * Shows one actor/runtime session and its latest bounded state.
 * Reuses the existing ChatView component (agent chat surface) keyed on the
 * actorRef's id. The actorRef.id is treated as the session id for the
 * ChatView; once ActorRef is promoted to shared/work-context.ts and the
 * actor persistence layer is wired (future slice), this mapping will be
 * formalised.
 *
 * The session id used here is the actorRef id, which is the scoped identifier
 * within the owning WorkContext. No raw global paths escape this component.
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

  return (
    <div className="block-agent" aria-label={`agent: ${descriptor.title}`}>
      <div className="block-agent__header">
        <span className="block-agent__actor">
          {actorRef.displayName ?? actorRef.id}
        </span>
      </div>
      <div className="block-agent__chat">
        <ChatView sessionId={actorRef.id} />
      </div>
    </div>
  );
};

export default AgentBlock;
