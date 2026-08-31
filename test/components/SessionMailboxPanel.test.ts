// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const fetchMock = vi.fn(async (..._args: unknown[]) =>
  new Response(
    JSON.stringify({
      messages: [
        {
          id: 'im:web-1',
          targetSessionId: 'local:session-1',
          contextPacketIds: [],
          state: 'queued',
          text: 'passive preview only',
          createdBy: 'relay-web',
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
);
globalThis.fetch = fetchMock as unknown as typeof fetch;

const { default: SessionMailboxPanel } = await import(
  '../../frontend/src/components/SessionMailboxPanel.js'
);

describe('SessionMailboxPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    fetchMock.mockClear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  it('uses the non-consuming inbox preview endpoint for passive detail reads', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(SessionMailboxPanel, {
            targetSessionId: 'local:session-1',
            title: 'primary session mailbox',
          })
        )
      );
    });

    await act(async () => {
      await flush();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/inbox/preview?targetSessionId=local%3Asession-1&limit=12'
    );
    expect(container.textContent).toContain('passive preview only');
  });
});
