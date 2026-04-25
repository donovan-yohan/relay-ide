// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTimeline } from '../frontend/src/components/chat-v2/AgentTimeline.js';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  type AgentPatchV2,
  type AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';

function timestamp(): string {
  return new Date('2026-04-25T12:00:00.000Z').toISOString();
}

function reducePatches(patches: AgentPatchV2[]): AgentSessionV2 {
  return patches.reduce(
    applyAgentPatchV2,
    emptyAgentSessionV2({
      id: 'session-1',
      provider: 'mock',
      cwd: '/tmp/repo',
    })
  );
}

describe('AgentTimeline v2 renderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders v2 user and assistant transcript items', async () => {
    const session = reducePatches([
      {
        type: 'agent-turn-started-v2',
        sessionId: 'session-1',
        timestamp: timestamp(),
        turn: {
          id: 'turn-1',
          status: 'running',
          inputMessageId: 'user-turn-1',
          items: [],
          startedAt: timestamp(),
        },
      },
      {
        type: 'agent-item-started-v2',
        sessionId: 'session-1',
        timestamp: timestamp(),
        turnId: 'turn-1',
        item: {
          type: 'userMessage',
          id: 'user-turn-1',
          text: 'hello browser',
          status: 'completed',
          completedAt: timestamp(),
        },
      },
      {
        type: 'agent-item-started-v2',
        sessionId: 'session-1',
        timestamp: timestamp(),
        turnId: 'turn-1',
        item: {
          type: 'assistantMessage',
          id: 'assistant-turn-1',
          text: 'visible response',
          phase: 'answer',
          status: 'completed',
          completedAt: timestamp(),
        },
      },
    ]);

    await act(async () => {
      root.render(
        React.createElement(AgentTimeline, {
          session,
          onApprove: vi.fn(),
        })
      );
    });

    expect(container.textContent).toContain('hello browser');
    expect(container.textContent).toContain('visible response');
  });

  it('renders v2 approval requests and forwards decisions', async () => {
    const onApprove = vi.fn();
    const session = reducePatches([
      {
        type: 'agent-turn-started-v2',
        sessionId: 'session-1',
        timestamp: timestamp(),
        turn: {
          id: 'turn-approval',
          status: 'running',
          inputMessageId: 'user-turn-approval',
          items: [],
          startedAt: timestamp(),
        },
      },
      {
        type: 'agent-item-started-v2',
        sessionId: 'session-1',
        timestamp: timestamp(),
        turnId: 'turn-approval',
        item: {
          type: 'approval',
          id: 'approval-turn-approval',
          requestId: 'approval-turn-approval',
          kind: 'command',
          description: 'Run tests',
          target: 'npm test',
          status: 'pending',
          startedAt: timestamp(),
        },
      },
    ]);

    await act(async () => {
      root.render(
        React.createElement(AgentTimeline, {
          session,
          onApprove,
        })
      );
    });

    const allowButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'allow'
    );
    expect(allowButton).toBeTruthy();

    await act(async () => {
      allowButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onApprove).toHaveBeenCalledWith('approval-turn-approval', 'allow');
  });
});
