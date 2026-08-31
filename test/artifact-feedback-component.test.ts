// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArtifactFeedbackPanel from '../frontend/src/components/ArtifactFeedbackPanel.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

const apiMocks = vi.hoisted(() => ({
  createContextPacket: vi.fn(),
  previewInboxMessages: vi.fn(),
  sendInboxMessage: vi.fn(),
  updateInboxMessageState: vi.fn(),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  createContextPacket: apiMocks.createContextPacket,
  previewInboxMessages: apiMocks.previewInboxMessages,
  sendInboxMessage: apiMocks.sendInboxMessage,
  updateInboxMessageState: apiMocks.updateInboxMessageState,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function session(id: string): SessionSummary {
  return {
    id,
    type: 'terminal',
    cwd: '/repo',
    displayName: id,
    createdAt: '2026-06-10T00:00:00.000Z',
    lastActivity: '2026-06-10T00:00:00.000Z',
    idle: false,
    activityState: 'idle',
    nodeId: 'local',
  };
}

type PanelProps = React.ComponentProps<typeof ArtifactFeedbackPanel>;

function props(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    artifactRef: {
      artifactId: 'art-42',
      workContextId: 'wc-1',
      payloadSha256: 'abcdef0123',
      kind: 'report',
      title: 'qa evidence',
    },
    artifactLabel: 'report · qa evidence',
    sessions: [session('agent-1')],
    preferredTargetSessionId: null,
    ...overrides,
  };
}

describe('ArtifactFeedbackPanel (#898)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiMocks.createContextPacket.mockResolvedValue({
      id: 'cp:art',
      kind: 'artifact-ref',
      createdAt: '2026-06-10T00:00:00.000Z',
      createdBy: 'relay-web',
    });
    apiMocks.previewInboxMessages.mockResolvedValue([]);
    apiMocks.sendInboxMessage.mockResolvedValue({
      id: 'im:art',
      targetSessionId: 'local:agent-1',
      contextPacketIds: ['cp:art'],
      state: 'delivered',
      text: 'report · qa evidence',
      createdAt: '2026-06-10T00:00:00.000Z',
    });
    apiMocks.updateInboxMessageState.mockResolvedValue({
      id: 'im:art',
      targetSessionId: 'local:agent-1',
      contextPacketIds: ['cp:art'],
      state: 'acknowledged',
      text: 'report · qa evidence',
      createdAt: '2026-06-10T00:00:00.000Z',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function buttonByText(text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === text
    );
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it('mints an artifact-ref context packet carrying the artifactId and queues it to the target', async () => {
    await act(async () => {
      root.render(React.createElement(ArtifactFeedbackPanel, props()));
    });

    await act(async () => {
      buttonByText('send feedback').click();
    });

    expect(apiMocks.createContextPacket).toHaveBeenCalledTimes(1);
    expect(apiMocks.createContextPacket).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'artifact-ref',
        createdBy: 'relay-web',
        artifactRef: expect.objectContaining({
          artifactId: 'art-42',
          workContextId: 'wc-1',
          payloadSha256: 'abcdef0123',
          kind: 'report',
          title: 'qa evidence',
        }),
      })
    );
    expect(apiMocks.sendInboxMessage).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionId: 'local:agent-1',
        contextPacketIds: ['cp:art'],
        createdBy: 'relay-web',
      })
    );
  });

  it('renders the queued inbox message after send and transitions it on ack', async () => {
    await act(async () => {
      root.render(React.createElement(ArtifactFeedbackPanel, props()));
    });

    await act(async () => {
      buttonByText('send feedback').click();
    });

    const messages = container.querySelector('.artifact-feedback__messages');
    expect(messages!.textContent).toContain('delivered');

    await act(async () => {
      buttonByText('ack').click();
    });

    expect(apiMocks.updateInboxMessageState).toHaveBeenCalledWith(
      'im:art',
      'ack'
    );
    expect(messages!.textContent).toContain('acknowledged');
  });

  it('does not send when there is no live target session', async () => {
    await act(async () => {
      root.render(
        React.createElement(ArtifactFeedbackPanel, props({ sessions: [] }))
      );
    });

    await act(async () => {
      buttonByText('send feedback').click();
    });

    expect(apiMocks.createContextPacket).not.toHaveBeenCalled();
    expect(apiMocks.sendInboxMessage).not.toHaveBeenCalled();
  });

  it('shows the empty-inbox copy before any send when sessions are available', async () => {
    // previewInboxMessages returns [] (set in beforeEach); no send has happened.
    await act(async () => {
      root.render(React.createElement(ArtifactFeedbackPanel, props()));
    });

    const emptyEl = container.querySelector('.artifact-feedback__empty');
    expect(emptyEl).toBeTruthy();
    expect(emptyEl!.textContent).toContain('no inbox feedback loaded');
  });
});
