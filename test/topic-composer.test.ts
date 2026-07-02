// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveTopicTitleFromPrompt,
  effectiveDraftTitle,
  TOPIC_ROOM_DRAFT_EMPTY,
} from '../frontend/src/lib/topic-create.js';

vi.mock('../frontend/src/lib/api.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    fetchHubNodes: vi.fn().mockResolvedValue([]),
    createWorkspaceTopicRoomAndMaybeLaunch: vi.fn(),
    launchWorkspaceTopicRoom: vi.fn(),
  };
});

import { createWorkspaceTopicRoomAndMaybeLaunch } from '../frontend/src/lib/api.js';
import TopicComposer from '../frontend/src/components/TopicComposer.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('topic title derivation', () => {
  it('derives the title from the first message line, code-point capped', () => {
    expect(deriveTopicTitleFromPrompt('fix the login bug\nmore detail')).toBe(
      'fix the login bug'
    );
    const long = '💡'.repeat(61) + 'x';
    const derived = deriveTopicTitleFromPrompt(long);
    expect(derived.endsWith('…')).toBe(true);
    expect((derived as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(
      true
    );
  });

  it('prefers an explicit title override over the message', () => {
    expect(
      effectiveDraftTitle({ ...TOPIC_ROOM_DRAFT_EMPTY, prompt: 'hello world' })
    ).toBe('hello world');
    expect(
      effectiveDraftTitle({ title: ' custom ', prompt: 'hello world' })
    ).toBe('custom');
  });
});

describe('TopicComposer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  function renderComposer() {
    act(() =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicComposer, {})
        )
      )
    );
  }

  it('renders the centered message box with start disabled until typed', () => {
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    const start = container.querySelector(
      '.topic-composer__bar button[type="submit"]'
    ) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    act(() => setNativeValue(ta, 'ship the thing'));
    expect(start.disabled).toBe(false);
  });

  it('keeps the metadata fields behind the advanced disclosure', () => {
    renderComposer();
    expect(container.querySelector('.topic-composer__advanced')).toBeNull();
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => toggle.click());
    const advanced = container.querySelector('.topic-composer__advanced');
    expect(advanced).not.toBeNull();
    expect(advanced?.textContent).toContain('provider');
    expect(advanced?.textContent).toContain('node');
    expect(advanced?.textContent).toContain('task ref');
  });

  it('creates and launches with the derived title on submit', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValue({
      status: 'created',
      topic: { id: 'topic:1' },
      workContext: { id: 'wc:1' },
    } as never);
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    act(() => setNativeValue(ta, 'triage the reconnect flake'));
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(createWorkspaceTopicRoomAndMaybeLaunch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mock
      .calls[0]?.[0] as {
      room: { topic: { title: string } };
      launch?: unknown;
    };
    expect(call.room.topic.title).toBe('triage the reconnect flake');
    expect(call.launch).toBeDefined();
  });
});
