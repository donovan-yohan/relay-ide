// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';

const mocks = vi.hoisted(() => ({
  session: null as AgentSessionV2 | null,
  approve: vi.fn(),
  answer: vi.fn(),
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
    answer: mocks.answer,
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
    mocks.answer.mockClear();
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

  async function setTextareaDraft(
    textarea: HTMLTextAreaElement,
    value: string
  ) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(textarea, value);
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function makeBeforeInputEvent(inputType: string): InputEvent {
    if (typeof InputEvent === 'function') {
      return new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: null,
        inputType,
      });
    }

    const event = new Event('beforeinput', {
      bubbles: true,
      cancelable: true,
    }) as InputEvent;
    Object.defineProperty(event, 'inputType', { value: inputType });
    Object.defineProperty(event, 'data', { value: null });
    Object.defineProperty(event, 'isComposing', { value: false });
    return event;
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

    expect(mocks.approve).toHaveBeenCalledWith('approval-1', {
      kind: 'accept',
      scope: 'once',
    });
    expect(mocks.approve).toHaveBeenCalledWith('approval-1', {
      kind: 'accept',
      scope: 'permanent',
    });
    expect(mocks.approve).toHaveBeenCalledWith('approval-1', {
      kind: 'decline',
    });
  });

  it('forwards question-card submissions through the v2 socket answer callback', async () => {
    mocks.session = makeSession({
      turns: [
        {
          id: 'turn-question',
          status: 'waiting',
          inputMessageId: 'user-question',
          startedAt: timestamp(),
          items: [
            {
              id: 'user-question',
              type: 'userMessage',
              text: 'go ahead',
              status: 'completed',
            },
            {
              id: 'question-1',
              type: 'question',
              requestId: 'input-1',
              question: 'pick one',
              fields: [
                { id: 'choice', prompt: 'pick one', options: ['a', 'b'] },
              ],
              status: 'pending',
            },
          ],
        },
      ],
    });

    await renderChat();

    const optionButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'a'
    );
    expect(optionButton).toBeTruthy();
    await act(async () => {
      optionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const submitButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'submit'
    );
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.answer).toHaveBeenCalledWith('input-1', { choice: ['a'] });
  });

  it('hides queued-message cancel buttons when the provider cannot cancel queued messages', async () => {
    mocks.session = makeSession({
      capabilities: { ...makeSession().capabilities, cancelQueued: false },
    });

    await renderChat();

    expect(container.querySelector('.queue')).toBeTruthy();
    expect(container.querySelector('.queue__cancel')).toBeNull();
  });

  it('submits mobile textarea send-key beforeinput line-break intents', async () => {
    await renderChat();

    const textarea =
      container.querySelector<HTMLTextAreaElement>('.composer__ta');
    expect(textarea).toBeTruthy();
    expect(textarea?.getAttribute('enterkeyhint')).toBe('send');

    await setTextareaDraft(textarea!, 'mobile reply');

    const event = makeBeforeInputEvent('insertLineBreak');
    await act(async () => {
      textarea!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls[0]?.[1]).toBe('mobile reply');
    expect(textarea!.value).toBe('');
  });

  it('sends with a fallback turn id when crypto.randomUUID is unavailable', async () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'crypto'
    );
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });
    try {
      await renderChat();

      const textarea =
        container.querySelector<HTMLTextAreaElement>('.composer__ta');
      expect(textarea).toBeTruthy();
      await setTextareaDraft(textarea!, 'fallback id reply');

      const event = makeBeforeInputEvent('insertLineBreak');
      await act(async () => {
        textarea!.dispatchEvent(event);
      });

      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
      expect(mocks.sendMessage.mock.calls[0]?.[0]).toMatch(/^turn-/);
      expect(mocks.sendMessage.mock.calls[0]?.[1]).toBe('fallback id reply');
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'crypto');
      }
    }
  });

  it('applies the highlighted slash command on mobile send-key beforeinput while the palette is visible', async () => {
    mocks.session = makeSession({
      slashCommands: [
        {
          name: 'review',
          description: 'Pre-landing PR review.',
          argumentHint: '<scope>',
        },
      ],
    });
    await renderChat();

    const textarea =
      container.querySelector<HTMLTextAreaElement>('.composer__ta');
    expect(textarea).toBeTruthy();

    await setTextareaDraft(textarea!, '/rev');
    expect(container.textContent).toContain('/review');

    const event = makeBeforeInputEvent('insertLineBreak');
    await act(async () => {
      textarea!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(textarea!.value).toBe('/review');
  });

  it('keeps Shift+Enter available for composer newlines', async () => {
    await renderChat();

    const textarea =
      container.querySelector<HTMLTextAreaElement>('.composer__ta');
    expect(textarea).toBeTruthy();

    await setTextareaDraft(textarea!, 'line one');
    await act(async () => {
      textarea!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    const event = makeBeforeInputEvent('insertLineBreak');
    await act(async () => {
      textarea!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('hides trace provider events by default and reveals them via /relay-verbosity trace', async () => {
    await renderChat();

    expect(container.textContent).not.toContain('message_stop');

    const textarea =
      container.querySelector<HTMLTextAreaElement>('.composer__ta');
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

  it('renders assistantMessage text as sanitized markdown (bold, links, inline code, code fences)', async () => {
    mocks.session = makeSession({
      turns: [
        {
          id: 'turn-md',
          status: 'completed',
          inputMessageId: 'user-md',
          startedAt: timestamp(),
          items: [
            {
              id: 'user-md',
              type: 'userMessage',
              text: 'explain the fix',
              status: 'completed',
            },
            {
              id: 'assistant-md',
              type: 'assistantMessage',
              text: [
                '**bold** and a [link](https://example.com/doc) and `inline code`.',
                '',
                '```ts',
                'const x = 1;',
                '```',
                '',
                '<img src="x" onerror="window.__pwned = true">',
              ].join('\n'),
              status: 'completed',
            },
          ],
        },
      ],
    });

    await renderChat();

    const bold = container.querySelector('.tl-markdown strong');
    expect(bold?.textContent).toBe('bold');

    const link = container.querySelector<HTMLAnchorElement>('.tl-markdown a');
    expect(link?.getAttribute('href')).toBe('https://example.com/doc');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');

    expect(container.querySelector('.tl-md-code')?.textContent).toBe(
      'inline code'
    );

    expect(container.querySelector('.tl-md-pre .code-block')).toBeTruthy();
    expect(container.textContent).toContain('const x = 1;');

    // Raw HTML is never parsed into live elements — it's shown as inert text.
    expect(container.querySelector('.tl-markdown img')).toBeNull();
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('preserves newlines in language-less and indented code blocks', async () => {
    mocks.session = makeSession({
      turns: [
        {
          id: 'turn-md-bare',
          status: 'completed',
          inputMessageId: 'user-md-bare',
          startedAt: timestamp(),
          items: [
            {
              id: 'user-md-bare',
              type: 'userMessage',
              text: 'show the output',
              status: 'completed',
            },
            {
              id: 'assistant-md-bare',
              type: 'assistantMessage',
              text: [
                '```',
                'line1',
                'line2',
                '```',
                '',
                '    indented1',
                '    indented2',
              ].join('\n'),
              status: 'completed',
            },
          ],
        },
      ],
    });

    await renderChat();

    // Both blocks must go through the CodeBlock/<pre> path (which preserves
    // whitespace via the UA `pre` stylesheet) rather than the inline
    // `.tl-md-code` path (which inherits `white-space: normal` from
    // `.tl-markdown` and collapses newlines to spaces).
    const preBlocks = container.querySelectorAll('.tl-md-pre .code-block');
    expect(preBlocks.length).toBe(2);
    expect(container.querySelector('.tl-markdown > .tl-md-code')).toBeNull();

    const preText = Array.from(preBlocks).map((el) => el.textContent);
    expect(preText[0]).toContain('line1');
    expect(preText[0]).toContain('line2');
    expect(preText[1]).toContain('indented1');
    expect(preText[1]).toContain('indented2');
  });

  it('renders markdown images as click-to-load links, never a live <img>', async () => {
    mocks.session = makeSession({
      turns: [
        {
          id: 'turn-md-img',
          status: 'completed',
          inputMessageId: 'user-md-img',
          startedAt: timestamp(),
          items: [
            {
              id: 'user-md-img',
              type: 'userMessage',
              text: 'show me',
              status: 'completed',
            },
            {
              id: 'assistant-md-img',
              type: 'assistantMessage',
              text: '![a diagram](https://attacker.example/pixel.png)',
              status: 'completed',
            },
          ],
        },
      ],
    });

    await renderChat();

    expect(container.querySelector('.tl-markdown img')).toBeNull();
    const imgLink = container.querySelector<HTMLAnchorElement>(
      '.tl-markdown a.tl-md-img-link'
    );
    expect(imgLink?.getAttribute('href')).toBe(
      'https://attacker.example/pixel.png'
    );
    expect(imgLink?.getAttribute('target')).toBe('_blank');
    expect(imgLink?.getAttribute('rel')).toContain('noopener');
    expect(imgLink?.textContent).toContain('a diagram');
  });

  it('shows a truncated reasoning summary in <summary>, falling back to "thinking"', async () => {
    const longSummary =
      'Investigating the composer regression across every provider adapter and slash-command handler before proposing a fix';
    mocks.session = makeSession({
      turns: [
        {
          id: 'turn-reasoning',
          status: 'completed',
          inputMessageId: 'user-reasoning',
          startedAt: timestamp(),
          items: [
            {
              id: 'user-reasoning',
              type: 'userMessage',
              text: 'why did this fail?',
              status: 'completed',
            },
            {
              id: 'thinking-short',
              type: 'reasoning',
              summary: 'checking the socket reconnect path',
              visibility: 'summary',
              status: 'completed',
            },
            {
              id: 'thinking-long',
              type: 'reasoning',
              summary: longSummary,
              visibility: 'summary',
              status: 'completed',
            },
            {
              id: 'thinking-empty',
              type: 'reasoning',
              summary: '',
              visibility: 'summary',
              status: 'completed',
            },
          ],
        },
      ],
    });

    await renderChat();

    const summaries = Array.from(
      container.querySelectorAll('.reasoning summary')
    ).map((el) => el.textContent);

    expect(summaries[0]).toBe('checking the socket reconnect path');
    expect(summaries[1]).toBe(`${longSummary.slice(0, 79)}…`);
    expect(summaries[1]?.length).toBeLessThanOrEqual(80);
    expect(summaries[2]).toBe('thinking');
  });

  it('auto-follows the bottom as streamed content resizes the timeline, without yanking a scrolled-up reader', async () => {
    class ResizeObserverStub {
      static instances: ResizeObserverStub[] = [];
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        ResizeObserverStub.instances.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      trigger() {
        this.callback([], this as unknown as ResizeObserver);
      }
    }
    ResizeObserverStub.instances = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const scrollSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});

    try {
      await renderChat();

      const timeline = container.querySelector('.tl') as HTMLElement;
      expect(timeline).toBeTruthy();
      const observerInstance = ResizeObserverStub.instances.at(-1);
      expect(observerInstance).toBeTruthy();

      // Reader is near the bottom when a stream delta grows the content.
      Object.defineProperty(timeline, 'scrollHeight', {
        value: 1000,
        configurable: true,
      });
      Object.defineProperty(timeline, 'clientHeight', {
        value: 400,
        configurable: true,
      });
      Object.defineProperty(timeline, 'scrollTop', {
        value: 650,
        configurable: true,
      });
      scrollSpy.mockClear();
      await act(async () => {
        observerInstance?.trigger();
      });
      expect(scrollSpy).toHaveBeenCalled();

      // Reader scrolled up to read history — a resize (more streamed
      // content) must not yank them back down.
      Object.defineProperty(timeline, 'scrollTop', {
        value: 50,
        configurable: true,
      });
      scrollSpy.mockClear();
      await act(async () => {
        observerInstance?.trigger();
      });
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
