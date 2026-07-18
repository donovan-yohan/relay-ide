// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelComposer } from '../../frontend/src/components/chat/ChannelComposer.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

interface RenderOpts {
  onSend?: (text: string, clientMessageId: string) => Promise<void>;
  postPending?: boolean;
  storeDown?: boolean;
  archived?: boolean;
  onRestore?: () => void;
  restorePending?: boolean;
}

async function renderComposer(opts: RenderOpts = {}): Promise<void> {
  // ChannelComposer lazily fetches the @mention roster via useQuery, so it must
  // render under a QueryClientProvider even when the palette never opens.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ChannelComposer, {
          channelId: 'topic:general',
          channelTitle: 'general',
          onSend: opts.onSend ?? (() => Promise.resolve()),
          postPending: opts.postPending ?? false,
          storeDown: opts.storeDown ?? false,
          archived: opts.archived ?? false,
          onRestore: opts.onRestore ?? (() => {}),
          restorePending: opts.restorePending ?? false,
        })
      )
    );
  });
}

async function typeAndEnter(text: string): Promise<void> {
  const ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
  await act(async () => {
    setNativeValue(ta, text);
  });
  await act(async () => {
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function enterAgain(): Promise<void> {
  const ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
  await act(async () => {
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChannelComposer (#1178)', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('reuses the same clientMessageId on retry after a failed send, then rotates on success', async () => {
    const ids: string[] = [];
    let failNext = true;
    const onSend = vi.fn(async (_text: string, clientMessageId: string) => {
      ids.push(clientMessageId);
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
    });

    await renderComposer({ onSend });

    await typeAndEnter('hello world');
    expect(onSend).toHaveBeenCalledTimes(1);

    // Draft is preserved after the failure so the user can retry.
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe('hello world');

    // Retry (press Enter again) → SAME clientMessageId so the server dedupes.
    await enterAgain();
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(ids[0]).toBe(ids[1]);

    // Success cleared the draft and rotated the idempotency key.
    expect(ta.value).toBe('');
    await typeAndEnter('second message');
    expect(onSend).toHaveBeenCalledTimes(3);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('shows the 503 store-unavailable banner while keeping the input live', async () => {
    await renderComposer({ storeDown: true });
    const banner = container.querySelector('.ch-composer__banner');
    expect(banner?.textContent).toContain('unavailable');
    // Input stays present (not replaced) so a queued draft is not lost.
    expect(container.querySelector('.ch-composer__ta')).not.toBeNull();
  });

  it('replaces the composer with a restore bar when 409 archived', async () => {
    const onRestore = vi.fn();
    await renderComposer({ archived: true, onRestore });
    expect(container.querySelector('.ch-composer--archived')).not.toBeNull();
    // The textarea is gone in the archived state.
    expect(container.querySelector('.ch-composer__ta')).toBeNull();

    const restore = container.querySelector(
      '.ch-composer__restore'
    ) as HTMLButtonElement;
    await act(async () => restore.click());
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
