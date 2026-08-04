// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorShortcutHelp } from '../../frontend/src/components/EditorShortcutHelp.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('EditorShortcutHelp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(EditorShortcutHelp)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function trigger(): HTMLButtonElement {
    return container.querySelector(
      '.cm-file-editor__help-trigger'
    ) as HTMLButtonElement;
  }

  it('exposes a keyboard-reachable shortcuts button', () => {
    const btn = trigger();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('keyboard shortcuts');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('lists active shortcuts and honestly marks unsupported ones', () => {
    act(() => trigger().click());
    const panel = container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    const text = panel?.textContent ?? '';
    expect(text).toContain('editor shortcuts');
    expect(text).toContain('save file');
    // Find/search is not wired yet — it must be shown as a follow-up, not a lie.
    expect(text).toMatch(/find \/ search in file.*follow-up/i);
    expect(
      container.querySelector('.cm-file-editor__help-item--unavailable')
    ).not.toBeNull();
  });

  it('closes on Escape', () => {
    act(() => trigger().click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
