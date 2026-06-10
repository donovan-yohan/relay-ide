// @vitest-environment happy-dom

// EmptyState secondary action behavior (#862) — the empty-state surface gains an
// optional ghost-variant secondary action used for the "start a terminal on a
// node" entry point. The primary "+ add project" CTA must stay unchanged.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyState } from '../../frontend/src/components/EmptyState.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('<EmptyState /> secondary action (#862)', () => {
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

  function buttons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('button'));
  }

  it('renders a ghost-variant secondary action alongside the primary one', () => {
    act(() => {
      root.render(
        React.createElement(EmptyState, {
          heading: 'add a project to get started',
          actionLabel: '+ add project',
          onAction: vi.fn(),
          secondaryActionLabel: 'start a terminal on a node',
          onSecondaryAction: vi.fn(),
        })
      );
    });

    const labels = buttons().map((b) => b.textContent);
    expect(labels).toContain('+ add project');
    expect(labels).toContain('start a terminal on a node');

    const secondary = buttons().find(
      (b) => b.textContent === 'start a terminal on a node'
    );
    // Ghost variant per DESIGN.md so it reads as the lower-emphasis action.
    expect(secondary?.className).toContain('tui-btn--ghost');
  });

  it('fires onSecondaryAction when the secondary button is clicked', () => {
    const onAction = vi.fn();
    const onSecondaryAction = vi.fn();
    act(() => {
      root.render(
        React.createElement(EmptyState, {
          heading: 'add a project to get started',
          actionLabel: '+ add project',
          onAction,
          secondaryActionLabel: 'start a terminal on a node',
          onSecondaryAction,
        })
      );
    });

    const secondary = buttons().find(
      (b) => b.textContent === 'start a terminal on a node'
    ) as HTMLButtonElement;
    act(() => {
      secondary.click();
    });
    expect(onSecondaryAction).toHaveBeenCalledTimes(1);
    // The primary action must not fire when only the secondary is clicked.
    expect(onAction).not.toHaveBeenCalled();
  });

  it('omits the secondary button when no secondary action is supplied', () => {
    act(() => {
      root.render(
        React.createElement(EmptyState, {
          heading: 'add a project to get started',
          actionLabel: '+ add project',
          onAction: vi.fn(),
        })
      );
    });
    expect(buttons().map((b) => b.textContent)).toEqual(['+ add project']);
  });
});
