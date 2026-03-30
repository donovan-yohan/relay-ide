import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShortcut, matchesShortcut, formatShortcut } from '../../frontend/src/lib/actions/shortcuts.js';

describe('ShortcutListener', () => {
  describe('parseShortcut', () => {
    it('parses mod+t into platform-aware key combo', () => {
      const result = parseShortcut('mod+t');
      assert.deepStrictEqual(result, { mod: true, shift: false, key: 't' });
    });

    it('parses mod+shift+[ into key combo', () => {
      const result = parseShortcut('mod+shift+[');
      assert.deepStrictEqual(result, { mod: true, shift: true, key: '[' });
    });

    it('parses single key', () => {
      const result = parseShortcut('escape');
      assert.deepStrictEqual(result, { mod: false, shift: false, key: 'escape' });
    });
  });

  describe('matchesShortcut', () => {
    it('matches mod+t when metaKey is true on mac', () => {
      const parsed = parseShortcut('mod+t');
      const event = { metaKey: true, ctrlKey: false, shiftKey: false, key: 't' };
      assert.ok(matchesShortcut(event as KeyboardEvent, parsed, true));
    });

    it('matches mod+t when ctrlKey is true on non-mac', () => {
      const parsed = parseShortcut('mod+t');
      const event = { metaKey: false, ctrlKey: true, shiftKey: false, key: 't' };
      assert.ok(matchesShortcut(event as KeyboardEvent, parsed, false));
    });

    it('does not match when shift is required but not pressed', () => {
      const parsed = parseShortcut('mod+shift+[');
      const event = { metaKey: true, ctrlKey: false, shiftKey: false, key: '[' };
      assert.ok(!matchesShortcut(event as KeyboardEvent, parsed, true));
    });

    it('matches mod+shift+[ when Linux/Windows produces { due to key transform', () => {
      const parsed = parseShortcut('mod+shift+[');
      const event = { metaKey: false, ctrlKey: true, shiftKey: true, key: '{' };
      assert.ok(matchesShortcut(event as KeyboardEvent, parsed, false));
    });

    it('matches mod+shift+] when Linux/Windows produces } due to key transform', () => {
      const parsed = parseShortcut('mod+shift+]');
      const event = { metaKey: false, ctrlKey: true, shiftKey: true, key: '}' };
      assert.ok(matchesShortcut(event as KeyboardEvent, parsed, false));
    });
  });

  describe('formatShortcut', () => {
    it('formats mod+t as ⌘T on mac', () => {
      assert.strictEqual(formatShortcut('mod+t', true), '⌘T');
    });

    it('formats mod+t as ctrl+T on non-mac', () => {
      assert.strictEqual(formatShortcut('mod+t', false), 'ctrl+T');
    });

    it('formats mod+shift+[ with shift symbol on mac', () => {
      assert.strictEqual(formatShortcut('mod+shift+[', true), '⌘⇧[');
    });

    it('formats mod+w on non-mac', () => {
      assert.strictEqual(formatShortcut('mod+w', false), 'ctrl+W');
    });
  });
});
