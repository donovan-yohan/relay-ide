// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RepoSourceDot from '../frontend/src/components/RepoSourceDot.js';
import { getPulseClass } from '../frontend/src/components/SessionIndicator.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

    const rendered: string[] = [];
    for (const [state, title] of states) {
      const dot = await renderDot({
        status: state,
        error: state === 'error' ? 'not-found' : undefined,
      });
      expect(dot.getAttribute('title')).toBe(title);
      expect(dot.getAttribute('aria-label')).toBe(title);
      expect(dot.className).toContain(`repo-source-dot--${state}`);
      rendered.push(dot.outerHTML);
    }

    expect(rendered).toMatchInlineSnapshot(`
      [
        "<span class=\"repo-source-dot repo-source-dot--live\" data-testid=\"repo-source-dot\" title=\"live via webhook\" aria-label=\"live via webhook\" role=\"img\">●</span>",
        "<span class=\"repo-source-dot repo-source-dot--manual\" data-testid=\"repo-source-dot\" title=\"manual fetch · enable webhook for live updates\" aria-label=\"manual fetch · enable webhook for live updates\" role=\"img\">○</span>",
        "<span class=\"repo-source-dot repo-source-dot--limited\" data-testid=\"repo-source-dot\" title=\"manual fetch · no admin on this repo\" aria-label=\"manual fetch · no admin on this repo\" role=\"img\">○<svg class=\"repo-source-dot__lock\" viewBox=\"0 0 8 8\" aria-hidden=\"true\"><rect x=\"1.5\" y=\"3.5\" width=\"5\" height=\"3\" fill=\"none\"></rect><path d=\"M2.5 3.5V2.5a1.5 1.5 0 0 1 3 0v1\" fill=\"none\"></path></svg></span>",
        "<span class=\"repo-source-dot repo-source-dot--error\" data-testid=\"repo-source-dot\" title=\"webhook broken: not-found · click to retry\" aria-label=\"webhook broken: not-found · click to retry\" role=\"img\">!</span>",
      ]
    `);
  });

  it('only enables click actions for manual and error states', async () => {
    const onManual = vi.fn();
    const onRetry = vi.fn();

    const manual = await renderDot({ status: 'manual', onManualSetup: onManual, onRetry });
    manual.click();
    expect(onManual).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    const limited = await renderDot({ status: 'limited', onManualSetup: onManual, onRetry });
    limited.click();
    expect(onManual).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    const error = await renderDot({ status: 'error', onManualSetup: onManual, onRetry });
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

    const dot = container.querySelector('[data-testid="repo-source-dot"]') as HTMLElement | null;
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute('tabindex')).toBeNull();

    dot?.click();

    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});

describe('SessionIndicator boot animation', () => {
  it('pulses initializing sessions so starting chips are redundant', () => {
    expect(getPulseClass('initializing')).toBe('pulse-slow');
  });
});
