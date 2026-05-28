// @vitest-environment happy-dom

import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileFeedbackPanel from '../../frontend/src/components/FileFeedbackPanel.js';
import type { SessionSummary } from '../../frontend/src/lib/types.js';

const apiMocks = vi.hoisted(() => ({
  createContextPacket: vi.fn(),
  previewInboxMessages: vi.fn(),
  sendInboxMessage: vi.fn(),
  updateInboxMessageState: vi.fn(),
}));

vi.mock('../../frontend/src/lib/api.js', () => ({
  createContextPacket: apiMocks.createContextPacket,
  previewInboxMessages: apiMocks.previewInboxMessages,
  sendInboxMessage: apiMocks.sendInboxMessage,
  updateInboxMessageState: apiMocks.updateInboxMessageState,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function session(
  id: string,
  type: SessionSummary['type'] = 'agent',
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    type,
    agent: type === 'agent' ? 'claude' : 'shell',
    cwd: '/repo',
    displayName: id,
    createdAt: '2026-05-28T00:00:00.000Z',
    lastActivity: '2026-05-28T00:00:00.000Z',
    idle: false,
    nodeId: 'local',
    ...overrides,
  };
}

type PanelProps = React.ComponentProps<typeof FileFeedbackPanel>;

function props(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    filePath: 'README.md',
    workspacePath: '/repo',
    content: 'hello\nworld',
    language: 'markdown',
    sessions: [],
    preferredTargetSessionId: null,
    selectedLine: null,
    onSelectedLineConsumed: vi.fn(),
    ...overrides,
  };
}

describe('FileFeedbackPanel live target send guard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiMocks.createContextPacket.mockResolvedValue({
      id: 'cp:test',
      kind: 'file-anchor',
      createdAt: '2026-05-28T00:00:00.000Z',
      createdBy: 'relay-web',
    });
    apiMocks.previewInboxMessages.mockResolvedValue([]);
    apiMocks.sendInboxMessage.mockResolvedValue({
      id: 'im:test',
      targetSessionId: 'local:fallback-agent',
      contextPacketIds: ['cp:test'],
      state: 'queued',
      createdAt: '2026-05-28T00:00:00.000Z',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function sendButton(): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'send feedback'
    );
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it('disables and refuses a stale selected target when all sessions disappear before passive retargeting', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          FileFeedbackPanel,
          props({ sessions: [session('removed-agent')] })
        )
      );
    });

    await act(async () => {
      flushSync(() => {
        root.render(React.createElement(FileFeedbackPanel, props({ sessions: [] })));
      });

      expect(sendButton().disabled).toBe(true);
      sendButton().click();
    });

    expect(apiMocks.createContextPacket).not.toHaveBeenCalled();
    expect(apiMocks.sendInboxMessage).not.toHaveBeenCalled();
  });

  it('uses a live fallback target instead of a removed selected target before passive retargeting runs', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          FileFeedbackPanel,
          props({ sessions: [session('removed-agent')] })
        )
      );
    });

    await act(async () => {
      flushSync(() => {
        root.render(
          React.createElement(
            FileFeedbackPanel,
            props({ sessions: [session('fallback-agent')] })
          )
        );
      });

      sendButton().click();
    });

    expect(apiMocks.sendInboxMessage).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetSessionId: 'local:fallback-agent' })
    );
    expect(apiMocks.sendInboxMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetSessionId: 'local:removed-agent' })
    );
  });
});
