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

async function waitForFrame() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

// Stub /workspaces/files-list — FilePicker calls global fetch via useQuery.
const fetchMock = vi.fn(
  async () =>
    new Response(
      JSON.stringify({
        files: ['src/a.ts', 'src/b.ts'],
        truncated: false,
        total: 2,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
);
globalThis.fetch = fetchMock as unknown as typeof fetch;

const { FilePicker } =
  await import('../../frontend/src/components/FilePicker.js');

describe('FilePicker', () => {
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

  async function renderPicker(open: boolean) {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FilePicker, {
            open,
            workspacePath: '/repo/a',
            onClose: () => {},
            onSelect: () => {},
          })
        )
      );
    });
    await act(async () => {
      await flush();
      await waitForFrame();
      await flush();
    });
  }

  it('focuses the search input when opened so printable keys filter the list (issue #350)', async () => {
    // Mount closed first so the input is not in the DOM yet.
    await renderPicker(false);
    expect(container.querySelector('.tui-input')).toBeNull();

    // Open the picker — focus must land on the search input automatically.
    await renderPicker(true);
    const input = container.querySelector(
      '.tui-input'
    ) as HTMLInputElement | null;
    expect(input, 'search input must render when open').toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('updates query state when the input receives keystrokes', async () => {
    await renderPicker(true);
    const input = container.querySelector(
      '.tui-input'
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    // Use React's native input-value setter so the input event is observed
    // as a real user keystroke. Setting `.value` directly bypasses React's
    // change tracker and the synthetic onChange never fires — which would
    // make the test green even with a broken handler.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    expect(setter, 'native value setter must exist').toBeTruthy();

    await act(async () => {
      setter!.call(input, 'zzz-no-match');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait past the 100ms debounce timer; wrap inside act so the
    // post-timeout setDebouncedQuery state update flushes before assertion.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await act(async () => {
      await flush();
    });

    // The empty-results branch only renders when debouncedQuery is non-empty
    // AND the scored results are empty — so this asserts the full
    // onChange → setQuery → debounce → setDebouncedQuery → scoring loop fired.
    expect(container.textContent).toContain('no results for "zzz-no-match"');
  });
});
