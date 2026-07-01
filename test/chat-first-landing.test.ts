// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ChatFirstLanding from '../frontend/src/components/ChatFirstLanding.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useUiStore.getState().closeSidebar();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChatFirstLanding', () => {
  it('renders a chat-first entry with a new-topic action', () => {
    act(() => root.render(React.createElement(ChatFirstLanding)));
    expect(container.querySelector('.chat-first-landing')).not.toBeNull();
    expect(container.textContent).toContain('start with a topic');
    const cta = container.querySelector('.chat-first-landing__cta');
    expect(cta?.textContent).toBe('new topic');
  });

  it('opens the sidebar create panel when new-topic is clicked', () => {
    let opened = false;
    const listener = () => {
      opened = true;
    };
    window.addEventListener('relay:open-topic-task-room', listener);
    try {
      act(() => root.render(React.createElement(ChatFirstLanding)));
      const cta = container.querySelector(
        '.chat-first-landing__cta'
      ) as HTMLButtonElement;
      act(() => cta.click());
      expect(opened).toBe(true);
      expect(useUiStore.getState().sidebarOpen).toBe(true);
    } finally {
      window.removeEventListener('relay:open-topic-task-room', listener);
    }
  });
});
