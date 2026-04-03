import { describe, it, expect } from 'vitest';
import {
  parseShortcut,
  matchesShortcut,
  formatShortcut,
} from '../../frontend/src/lib/actions/shortcuts.js';

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
