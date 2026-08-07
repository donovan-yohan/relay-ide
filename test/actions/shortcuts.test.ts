// @vitest-environment happy-dom

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  parseShortcut,
  matchesShortcut,
  formatShortcut,
  setupShortcutListener,
} from '../../frontend/src/lib/actions/shortcuts.js';
import type {
  Action,
  ActionContext,
} from '../../frontend/src/lib/actions/types.js';

describe('ShortcutListener', () => {
  describe('parseShortcut', () => {
    it('parses mod+t into platform-aware key combo', () => {
      const result = parseShortcut('mod+t');
      expect(result).toEqual({ mod: true, shift: false, key: 't' });
    });

    it('parses mod+shift+[ into key combo', () => {
      const result = parseShortcut('mod+shift+[');
      expect(result).toEqual({ mod: true, shift: true, key: '[' });
    });

    it('parses single key', () => {
      const result = parseShortcut('escape');
      expect(result).toEqual({
        mod: false,
        shift: false,
        key: 'escape',
      });
    });
  });

  describe('matchesShortcut', () => {
    it('matches mod+t when metaKey is true on mac', () => {
      const parsed = parseShortcut('mod+t');
      const event = {
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        key: 't',
      };
      expect(
        matchesShortcut(event as KeyboardEvent, parsed, true)
      ).toBeTruthy();
    });

    it('matches mod+t when ctrlKey is true on non-mac', () => {
      const parsed = parseShortcut('mod+t');
      const event = {
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        key: 't',
      };
      expect(
        matchesShortcut(event as KeyboardEvent, parsed, false)
      ).toBeTruthy();
    });

    it('does not match when shift is required but not pressed', () => {
      const parsed = parseShortcut('mod+shift+[');
      const event = {
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        key: '[',
      };
      expect(
        !matchesShortcut(event as KeyboardEvent, parsed, true)
      ).toBeTruthy();
    });

    it('matches mod+shift+[ when Linux/Windows produces { due to key transform', () => {
      const parsed = parseShortcut('mod+shift+[');
      const event = { metaKey: false, ctrlKey: true, shiftKey: true, key: '{' };
      expect(
        matchesShortcut(event as KeyboardEvent, parsed, false)
      ).toBeTruthy();
    });

    it('matches mod+shift+] when Linux/Windows produces } due to key transform', () => {
      const parsed = parseShortcut('mod+shift+]');
      const event = { metaKey: false, ctrlKey: true, shiftKey: true, key: '}' };
      expect(
        matchesShortcut(event as KeyboardEvent, parsed, false)
      ).toBeTruthy();
    });
  });

  describe('setupShortcutListener: contenteditable editor guard (#1004)', () => {
    const ctx: ActionContext = { view: 'workspace' };
    let cleanup: (() => void) | null = null;
    let edited: HTMLDivElement | null = null;

    afterEach(() => {
      cleanup?.();
      cleanup = null;
      edited?.remove();
      edited = null;
    });

    function action(
      handler: () => void,
      shortcut: { key: string; global?: boolean }
    ): Action {
      return {
        id: 'session.test',
        label: 'test',
        category: 'session',
        shortcut,
        handler,
      };
    }

    function focusContentEditable(): void {
      edited = document.createElement('div');
      // happy-dom may not derive isContentEditable from the attribute, so force
      // it to model a focused CodeMirror content host deterministically.
      Object.defineProperty(edited, 'isContentEditable', { value: true });
      document.body.appendChild(edited);
      edited.focus();
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        get: () => edited,
      });
    }

    function press(key: string): void {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { ctrlKey: true, key, bubbles: true })
      );
    }

    it('fires a non-global registry shortcut when no editor is focused', () => {
      const handler = vi.fn();
      cleanup = setupShortcutListener(
        () => [action(handler, { key: 'mod+w' })],
        () => ctx,
        false
      );
      press('w');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('suppresses a non-global shortcut while the editor (contenteditable) is focused', () => {
      const handler = vi.fn();
      cleanup = setupShortcutListener(
        () => [action(handler, { key: 'mod+w' })],
        () => ctx,
        false
      );
      focusContentEditable();
      press('w');
      expect(handler).not.toHaveBeenCalled();
    });

    it('still fires a global shortcut while the editor is focused', () => {
      const handler = vi.fn();
      cleanup = setupShortcutListener(
        () => [action(handler, { key: 'mod+t', global: true })],
        () => ctx,
        false
      );
      focusContentEditable();
      press('t');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('formatShortcut', () => {
    it('formats mod+t as ⌘T on mac', () => {
      expect(formatShortcut('mod+t', true)).toBe('⌘T');
    });

    it('formats mod+t as ctrl+T on non-mac', () => {
      expect(formatShortcut('mod+t', false)).toBe('ctrl+T');
    });

    it('formats mod+shift+[ with shift symbol on mac', () => {
      expect(formatShortcut('mod+shift+[', true)).toBe('⌘⇧[');
    });

    it('formats mod+w on non-mac', () => {
      expect(formatShortcut('mod+w', false)).toBe('ctrl+W');
    });
  });
});
