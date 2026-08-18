// @vitest-environment happy-dom

import React, { act } from 'react';
import * as fs from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelSearchPanel from '../../frontend/src/components/ChannelSearchPanel.js';
import { useChannelSearchPanelStore } from '../../frontend/src/lib/stores/channel-search-panel.js';
import { useUiStore } from '../../frontend/src/lib/stores/ui.js';
import {
  CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
  CHANNEL_SEARCH_HIGHLIGHT_OPEN,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WAIT_MS = 220;

describe('<ChannelSearchPanel />', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let urls: string[];

  beforeEach(() => {
    urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.startsWith('/workspace-topics')) {
          return Response.json({
            topics: [],
            truncated: false,
            derived: false,
          });
        }
        if (url.startsWith('/channels/search')) {
          return Response.json({
            query: 'anchor',
            truncated: false,
            results: [
              {
                messageId: 'chm:one',
                channelId: 'topic:relay',
                threadId: null,
                seq: 4,
                snippet: `stable ${CHANNEL_SEARCH_HIGHLIGHT_OPEN}anchor${CHANNEL_SEARCH_HIGHLIGHT_CLOSE}`,
                senderKind: 'agent',
                senderId: 'agent-profile:codex:default',
                providerId: 'codex',
                createdAt: '2026-08-17T00:00:00.000Z',
                score: -1,
                channelTitle: 'relay ide',
                archived: false,
              },
              {
                messageId: 'chm:two',
                channelId: 'topic:relay',
                threadId: null,
                seq: 3,
                snippet: 'another anchor result',
                senderKind: 'human',
                senderId: 'human:operator',
                createdAt: '2026-08-16T00:00:00.000Z',
                score: -0.5,
                channelTitle: 'relay ide',
                archived: false,
              },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    useChannelSearchPanelStore.setState({
      open: true,
      query: 'in:relay-ide ',
      autoSeeded: true,
      seedPrefix: 'in:relay-ide ',
      boundChannelId: 'topic:relay',
    });
    useUiStore.setState({
      activeChannelId: 'topic:relay',
      pendingChannelMessage: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderPanel() {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ChannelSearchPanel, { open: true })
        )
      );
    });
  }

  it('guides on a scope-only seed without issuing an FTS request', async () => {
    await renderPanel();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    });

    expect(container.textContent).toContain('scope set — add search terms');
    expect(container.textContent).toContain('ready');
    expect(urls.some((url) => url.startsWith('/channels/search'))).toBe(false);
    expect(
      container
        .querySelector('.channel-search-panel__body')
        ?.hasAttribute('aria-live')
    ).toBe(false);
  });

  it('binds an untouched generated scope to the exact channel and renders navigable results', async () => {
    await renderPanel();
    await act(async () => {
      useChannelSearchPanelStore.getState().setQuery('in:relay-ide anchor');
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (container.querySelector('.channel-search-result')) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    const searchUrl = urls.find((url) => url.startsWith('/channels/search'));
    expect(searchUrl).toContain('channelId=topic%3Arelay');
    expect(
      container.querySelector('.channel-search-result__hit')?.textContent
    ).toBe('anchor');

    const row = container.querySelector(
      '.channel-search-result'
    ) as HTMLButtonElement;
    await act(async () => row.click());
    expect(useUiStore.getState().pendingChannelMessage).toEqual({
      channelId: 'topic:relay',
      messageId: 'chm:one',
    });
  });

  it('moves focus through results and restores the exact opener on Escape', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'open search';
    document.body.appendChild(opener);
    opener.focus();
    await renderPanel();
    await act(async () => {
      useChannelSearchPanelStore.getState().setQuery('in:relay-ide anchor');
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (container.querySelectorAll('.channel-search-result').length === 2)
        break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    const input = container.querySelector(
      '#channel-search-panel-input'
    ) as HTMLInputElement;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    const rows = container.querySelectorAll<HTMLButtonElement>(
      '.channel-search-result'
    );
    expect(document.activeElement).toBe(rows[0]);
    rows[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    expect(document.activeElement).toBe(rows[1]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(useChannelSearchPanelStore.getState().open).toBe(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('draws a visible accent focus outline on result rows', () => {
    const css = fs.readFileSync(
      'frontend/src/components/ChannelSearchPanel.css',
      'utf8'
    );
    expect(css).toMatch(
      /\.channel-search-result:focus-visible\s*{[\s\S]*outline:\s*2px solid var\(--accent\)/
    );
  });
});
