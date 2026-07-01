// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveWorkEmpty } from '../frontend/src/components/ActiveWorkSurface.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ActiveWorkEmpty', () => {
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
    vi.clearAllMocks();
  });

  it('renders a centered next-action panel with a start-topic CTA', () => {
    const onStartTopic = vi.fn();
    act(() =>
      root.render(React.createElement(ActiveWorkEmpty, { onStartTopic }))
    );
    expect(container.querySelector('.active-work-empty__panel')).not.toBeNull();
    expect(container.textContent).toContain('no active work yet');
    const cta = container.querySelector(
      '.active-work-empty__cta'
    ) as HTMLButtonElement;
    expect(cta).not.toBeNull();
    expect(cta.textContent).toContain('new topic');
  });

  it('invokes the start-topic action when the CTA is clicked', () => {
    const onStartTopic = vi.fn();
    act(() =>
      root.render(React.createElement(ActiveWorkEmpty, { onStartTopic }))
    );
    const cta = container.querySelector(
      '.active-work-empty__cta'
    ) as HTMLButtonElement;
    act(() => cta.click());
    expect(onStartTopic).toHaveBeenCalledTimes(1);
  });
});
