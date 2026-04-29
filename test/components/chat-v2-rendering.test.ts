// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';

const mocks = vi.hoisted(() => ({
  session: null as AgentSessionV2 | null,
  approve: vi.fn(),
  sendMessage: vi.fn(),
  interrupt: vi.fn(),
}));

vi.mock('../../frontend/src/hooks/useAgentChatSocket.js', () => ({
  useAgentChatSocket: () => ({
    session: mocks.session,
    connected: true,
    send: vi.fn(),
    sendMessage: mocks.sendMessage,
    interrupt: mocks.interrupt,
    approve: mocks.approve,
    answer: vi.fn(),
  }),
}));

const { ChatView } =
  await import('../../frontend/src/components/chat/ChatView.js');

function timestamp(offsetMs = 0): string {
  return new Date(Date.UTC(2026, 3, 27, 12, 0, 0, offsetMs)).toISOString();
}

function makeSession(overrides: Partial<AgentSessionV2> = {}): AgentSessionV2 {
  return {
    id: 'session-1',
    provider: 'mock',
    capabilities: {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      slashCommands: true,
      queue: true,
      interrupt: true,
      cancelQueued: false,
      compact: true,
    },
    config: { cwd: '/tmp/repo', model: 'mock-model' },
    live: {
      status: 'waiting',
      activeTurnId: 'turn-2',
      waitingOn: 'approval',
      activeRequestIds: ['approval-1'],
      proposedPlanItemId: null,
      queueLength: 2,
      fastModeAvailable: true,
      error: null,
    },
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        inputMessageId: 'user-turn-1',
        startedAt: timestamp(),
        completedAt: timestamp(500),
        durationMs: 500,
        usage: { inputTokens: 12, outputTokens: 34, contextPercent: 42 },
        items: [
          {
            id: 'user-turn-1',
            type: 'userMessage',
            text: 'add a /skill command',
            status: 'completed',
          },
          {
            id: 'thinking-turn-1-0',
            type: 'reasoning',
            summary: 'Need to inspect composer and command parsing.',
            visibility: 'summary',
            status: 'completed',
          },
          {
            id: 'assistant-turn-1',
            type: 'assistantMessage',
            text: 'I will wire the slash palette first.',
            status: 'completed',
          },
          {
            id: 'exec-tool-1',
            type: 'commandExecution',
            command: 'npm test -- test/components/chat-v2-rendering.test.tsx',
            output: 'PASS chat rendering',
            exitCode: 0,
            durationMs: 88,
            status: 'completed',
          },
          {
            id: 'file-tool-1',
            type: 'fileChange',
            paths: [
              {
                path: 'frontend/src/components/chat/Composer.tsx',
                status: 'edited',
              },
            ],
            patch: '@@ -1 +1 @@\n-old\n+new',
            applyStatus: 'applied',
            status: 'completed',
          },
          {
            id: 'dynamic-tool-1',
            type: 'dynamicToolCall',
            namespace: 'mock',
            tool: 'grep',
            arguments: { pattern: 'slash' },
            result: { matches: 1 },
            status: 'completed',
          },
        ],
      },
      {
        id: 'turn-2',
        status: 'waiting',
        inputMessageId: 'user-turn-2',
        startedAt: timestamp(1000),
        items: [
          {
            id: 'user-turn-2',
            type: 'userMessage',
            text: 'run the tests',
            status: 'completed',
          },
          {
            id: 'approval-1',
            type: 'approval',
            requestId: 'approval-1',
            kind: 'command',
            description: 'run targeted chat tests',
            target: 'npm test -- test/components/chat-v2-rendering.test.tsx',
            detail: 'cwd: /tmp/repo',
            status: 'pending',
          },
          {
            id: 'ext-1',
            type: 'providerExtension',
            namespace: 'claude',
            payload: { kind: 'FastModeUnavailable', reason: 'model' },
            status: 'completed',
          },
          {
            id: 'ext-trace-1',
            type: 'providerExtension',
            namespace: 'claude',
            payload: { type: 'stream_event', event: { type: 'message_stop' } },
            metadata: { eventVisibility: 'trace' },
            status: 'completed',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('chat v2 rendering against chat.html primitives', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.session = makeSession();
    mocks.approve.mockClear();
    mocks.sendMessage.mockClear();
    mocks.interrupt.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mocks.session = null;
  });

  async function renderChat() {
    await act(async () => {
      root.render(React.createElement(ChatView, { sessionId: 'session-1' }));
    });
  }

  it('renders the chat.html timeline, tool, file, approval, live, queue, slash, and composer primitives', async () => {
    await renderChat();

    for (const selector of [
      '.tl',
      '.turn',
      '.turn-header',
      '.turn-footer',
      '.tl-text--user',
      '.tcard',
      '.tcard__h',
      '.tcard__body',
      '.fc-row',
      '.acard',
      '.turn-footer--running',
      '.queue',
      '.slash',
      '.composer',
      '.composer__bar',
      '.cbar-trigger',
    ]) {
      expect(container.querySelector(selector), selector).toBeTruthy();
    }

    expect(container.textContent).toContain('add a /skill command');
    expect(container.textContent).toContain(
      'I will wire the slash palette first.'
    );
    expect(container.textContent).toContain(
      'frontend/src/components/chat/Composer.tsx'
    );
    expect(container.textContent).toContain('2 queued');
  });

  it('forwards all approval decisions through the v2 socket callback', async () => {
    await renderChat();

    const clickByText = async (text: string) => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === text
      );
      expect(button, `button ${text}`).toBeTruthy();
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    };

    await clickByText('allow');
    await clickByText('allow always');
    await clickByText('deny');

    expect(mocks.approve).toHaveBeenCalledWith('approval-1', { kind: 'accept', scope: 'once' });
    expect(mocks.approve).toHaveBeenCalledWith('approval-1', { kind: 'accept', scope: 'permanent' });
    expect(mocks.approve).toHaveBeenCalledWith('approval-1', { kind: 'decline' });
  });

  it('hides queued-message cancel buttons when the provider cannot cancel queued messages', async () => {
    mocks.session = makeSession({
      capabilities: { ...makeSession().capabilities, cancelQueued: false },
    });

    await renderChat();

    expect(container.querySelector('.queue')).toBeTruthy();
    expect(container.querySelector('.queue__cancel')).toBeNull();
  });

  it('hides trace provider events by default and reveals them via /relay-verbosity trace', async () => {
    await renderChat();

    expect(container.textContent).not.toContain('message_stop');

    const textarea = container.querySelector<HTMLTextAreaElement>('.composer__ta');
    expect(textarea).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(textarea, '/relay-verbosity trace');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });

    expect(container.textContent).toContain('message_stop');
    expect(mocks.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/relay-verbosity')
    );
  });
});
