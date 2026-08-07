// @vitest-environment happy-dom

import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const shikiMocks = vi.hoisted(() => ({
  tokenizeCode: vi.fn(async (code: string) => [
    [{ content: code, color: '#e0e0e0' }],
  ]),
}));

vi.mock('../../frontend/src/lib/shiki.js', () => ({
  tokenizeCode: shikiMocks.tokenizeCode,
}));

const [{ useShikiHighlight }, { useShikiGcStore }] = await Promise.all([
  import('../../frontend/src/hooks/useShikiHighlight.js'),
  import('../../frontend/src/lib/stores/shiki-gc.js'),
]);

function Harness({
  code,
  language = 'typescript',
}: {
  code: string;
  language?: string;
}): React.ReactElement {
  const { tokens } = useShikiHighlight('stable-code-card', code, language);
  return React.createElement(
    'div',
    null,
    tokens?.flatMap((line) => line.map((token) => token.content)).join('') ??
      `plain:${code}`
  );
}

describe('useShikiHighlight current-source fence', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    shikiMocks.tokenizeCode.mockClear();
    shikiMocks.tokenizeCode.mockImplementation(async (code: string) => [
      [{ content: code, color: '#e0e0e0' }],
    ]);
    useShikiGcStore.setState({ entries: new Map() });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('never renders token text cached for the previous source', async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { code: 'old source' }));
    });
    expect(host.textContent).toBe('old source');

    // Inspect the commit before passive effects can replace the cache entry.
    // The new raw source must render immediately; old token bytes must not.
    act(() => {
      flushSync(() => {
        root.render(React.createElement(Harness, { code: 'new source' }));
      });
      expect(host.textContent).toBe('plain:new source');
    });

    await act(async () => {});
    expect(host.textContent).toBe('new source');

    act(() => {
      flushSync(() => {
        root.render(
          React.createElement(Harness, {
            code: 'new source',
            language: 'json',
          })
        );
      });
      expect(host.textContent).toBe('plain:new source');
    });

    await act(async () => {});
    expect(host.textContent).toBe('new source');
    expect(shikiMocks.tokenizeCode).toHaveBeenLastCalledWith(
      'new source',
      'json'
    );
  });

  it('rejects an older unmounted instance resolving after a newer shared-cache writer', async () => {
    const pending = new Map<
      string,
      (tokens: Array<Array<{ content: string; color: string }>>) => void
    >();
    shikiMocks.tokenizeCode.mockImplementation(
      (code: string) =>
        new Promise((resolve) => {
          pending.set(code, (tokens) => {
            pending.delete(code);
            resolve(tokens);
          });
        })
    );

    const olderHost = document.createElement('div');
    document.body.appendChild(olderHost);
    const olderRoot = createRoot(olderHost);
    let olderMounted = true;

    try {
      await act(async () => {
        olderRoot.render(
          React.createElement(Harness, { code: 'older source' })
        );
      });
      act(() => olderRoot.unmount());
      olderMounted = false;
      olderHost.remove();
      await act(async () => {
        root.render(React.createElement(Harness, { code: 'newer source' }));
      });

      await act(async () => {
        pending.get('newer source')?.([
          [{ content: 'newer tokens', color: '#e0e0e0' }],
        ]);
        await Promise.resolve();
      });
      expect(host.textContent).toBe('newer tokens');

      await act(async () => {
        pending.get('older source')?.([
          [{ content: 'stale older tokens', color: '#e0e0e0' }],
        ]);
        await Promise.resolve();
      });

      expect(host.textContent).toBe('newer tokens');
      expect(
        useShikiGcStore.getState().entries.get('stable-code-card')
          ?.highlightOutput
      ).toEqual([[{ content: 'newer tokens', color: '#e0e0e0' }]]);
      expect(pending.size).toBe(0);
    } finally {
      if (olderMounted) act(() => olderRoot.unmount());
      olderHost.remove();
      await act(async () => {
        for (const settle of [...pending.values()]) settle([]);
        await Promise.resolve();
      });
    }
  });
});
