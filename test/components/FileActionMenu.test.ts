// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileActionMenu } from '../../frontend/src/components/FileActionMenu.js';
import { buildFilesReadCommand } from '../../frontend/src/lib/editor-affordances.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let writeText: ReturnType<typeof vi.fn>;

function installClipboard(): void {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function menuLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.tui-menu-item')).map((el) =>
    (el.textContent ?? '').replace(/^>/, '').trim()
  );
}

function openMenu(container: HTMLElement): void {
  const trigger = container.querySelector(
    '.context-menu-trigger'
  ) as HTMLButtonElement | null;
  if (!trigger) throw new Error('menu trigger not rendered');
  act(() => trigger.click());
}

describe('FileActionMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installClipboard();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keyboard-reachable: trigger is a button advertising a popup', () => {
    act(() => {
      root.render(
        React.createElement(FileActionMenu, {
          filePath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
          sessionId: 'sess-1',
        })
      );
    });
    const trigger = container.querySelector(
      '.context-menu-trigger'
    ) as HTMLButtonElement;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('true');
  });

  it('editable surface exposes the full action set', () => {
    const onSave = vi.fn();
    const onReload = vi.fn();
    const onShowChanges = vi.fn();
    act(() => {
      root.render(
        React.createElement(FileActionMenu, {
          filePath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
          sessionId: 'sess-1',
          editable: true,
          dirty: true,
          saving: false,
          canShowChanges: true,
          onSave,
          onReload,
          onShowChanges,
        })
      );
    });
    openMenu(container);
    const labels = menuLabels(container);
    expect(labels).toEqual([
      'save',
      'reload from disk',
      'show changes',
      'copy relative path',
      'copy absolute path',
      'copy files-read command',
      'copy files-write command',
    ]);
    // Menu items are focusable for keyboard navigation.
    const items = container.querySelectorAll('.tui-menu-item');
    items.forEach((el) => expect(el.getAttribute('tabindex')).toBe('0'));
  });

  it('keyboard activation (Enter / Space) on a focused item fires its action', () => {
    const onSave = vi.fn();
    act(() => {
      root.render(
        React.createElement(FileActionMenu, {
          filePath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
          sessionId: 'sess-1',
          editable: true,
          dirty: true,
          saving: false,
          onSave,
        })
      );
    });

    const saveItem = (): HTMLElement =>
      Array.from(container.querySelectorAll('.tui-menu-item')).find((el) =>
        (el.textContent ?? '').includes('save')
      ) as HTMLElement;

    openMenu(container);
    const first = saveItem();
    first.focus();
    act(() => {
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    // Selecting closes the menu; reopen and confirm Space activates too.
    openMenu(container);
    const second = saveItem();
    second.focus();
    act(() => {
      second.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true })
      );
    });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('read-only surface only exposes copy affordances, no save/reload/write', () => {
    act(() => {
      root.render(
        React.createElement(FileActionMenu, {
          filePath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
          sessionId: null,
        })
      );
    });
    openMenu(container);
    const labels = menuLabels(container);
    expect(labels).toEqual([
      'copy relative path',
      'copy absolute path',
      'copy files-read command',
    ]);
    expect(labels).not.toContain('save');
    expect(labels).not.toContain('reload from disk');
    expect(labels).not.toContain('copy files-write command');
  });

  it('copies the relative path to the clipboard', () => {
    act(() => {
      root.render(
        React.createElement(FileActionMenu, {
          filePath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
          sessionId: 'sess-1',
        })
      );
    });
    openMenu(container);
    const item = Array.from(container.querySelectorAll('.tui-menu-item')).find(
      (el) => (el.textContent ?? '').includes('copy relative path')
    );
    act(() => (item as HTMLElement).click());
    expect(writeText).toHaveBeenCalledWith('src/app.ts');
  });

  it('read-only and editable surfaces emit the SAME files-read command (no drift)', () => {
    // read-only
    act(() => {
      root.render(
        React.createElement(FileActionMenu, {
          filePath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
          sessionId: 'sess-9',
        })
      );
    });
    openMenu(container);
    const readItem = Array.from(
      container.querySelectorAll('.tui-menu-item')
    ).find((el) => (el.textContent ?? '').includes('copy files-read command'));
    act(() => (readItem as HTMLElement).click());

    const expected = buildFilesReadCommand({
      sessionId: 'sess-9',
      path: '/repo/src/app.ts',
    });
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(expected).toContain('relay-ide v1 files read');
  });
});
