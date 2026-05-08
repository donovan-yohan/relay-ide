// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RepoSourceDot from '../frontend/src/components/RepoSourceDot.js';
import { getPulseClass } from '../frontend/src/components/SessionIndicator.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('RepoSourceDot', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderDot(
    props: React.ComponentProps<typeof RepoSourceDot>
  ): Promise<HTMLElement> {
    await act(async () => {
      root.render(React.createElement(RepoSourceDot, props));
    });
    const dot = container.querySelector('[data-testid="repo-source-dot"]');
    expect(dot).toBeTruthy();
    return dot as HTMLElement;
  }

  it('renders visual states with lowercase tooltip labels', async () => {
    const states = [
      ['live', 'live via webhook'],
      ['manual', 'manual fetch · enable webhook for live updates'],
      ['limited', 'manual fetch · no admin on this repo'],
      ['error', 'webhook broken: not-found · click to retry'],
    ] as const;

    for (const [state, title] of states) {
      const dot = await renderDot({
        status: state,
        error: state === 'error' ? 'not-found' : undefined,
      });
      expect(dot.getAttribute('title')).toBe(title);
      expect(dot.getAttribute('aria-label')).toBe(title);
      expect(dot.className).toContain(`repo-source-dot--${state}`);
      expect(dot.textContent).toBe(
        state === 'live' ? '●' : state === 'error' ? '!' : '○'
      );
      expect(dot.querySelector('.repo-source-dot__lock')).toBe(
        state === 'limited' ? dot.querySelector('svg') : null
      );
    }
  });

  it('only enables click actions for manual and error states', async () => {
    const onManual = vi.fn();
    const onRetry = vi.fn();

    const manual = await renderDot({
      status: 'manual',
      onManualSetup: onManual,
      onRetry,
    });
    manual.click();
    expect(onManual).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    const limited = await renderDot({
      status: 'limited',
      onManualSetup: onManual,
      onRetry,
    });
    limited.click();
    expect(onManual).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    const error = await renderDot({
      status: 'error',
      onManualSetup: onManual,
      onRetry,
    });
    error.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('lets non-actionable states bubble clicks to the row', async () => {
    const onRowClick = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(
          'button',
          { type: 'button', onClick: onRowClick },
          React.createElement(RepoSourceDot, { status: 'limited' })
        )
      );
    });

    const dot = container.querySelector(
      '[data-testid="repo-source-dot"]'
    ) as HTMLElement | null;
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute('tabindex')).toBeNull();

    dot?.click();

    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('only stops handled keyboard actions for actionable dots', async () => {
    const onManual = vi.fn();
    const onParentKeyDown = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          { onKeyDown: onParentKeyDown },
          React.createElement(RepoSourceDot, {
            status: 'manual',
            onManualSetup: onManual,
          })
        )
      );
    });

    const dot = container.querySelector(
      '[data-testid="repo-source-dot"]'
    ) as HTMLElement | null;
    expect(dot).toBeTruthy();

    dot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(onManual).not.toHaveBeenCalled();

    dot?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    expect(onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(onManual).toHaveBeenCalledTimes(1);
  });
});

describe('SessionIndicator boot animation', () => {
  it('pulses initializing sessions so starting chips are redundant', () => {
    expect(getPulseClass('initializing')).toBe('pulse-slow');
  });
});
