import type { Action, ActionContext } from './types.js';
import { createLogger } from '../logger.js';

export type ParsedShortcut = {
  mod: boolean;
  shift: boolean;
  key: string;
};

const logger = createLogger('shortcuts');

export function parseShortcut(shortcutKey: string): ParsedShortcut {
  const parts = shortcutKey.toLowerCase().split('+');
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    key:
      parts.filter((p) => p !== 'mod' && p !== 'shift').join('+') ||
      shortcutKey,
  };
}

const SHIFTED_KEY_MAP: Record<string, string> = {
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
};

export function matchesShortcut(
  event: KeyboardEvent,
  parsed: ParsedShortcut,
  isMac: boolean
): boolean {
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  if (parsed.mod && !modPressed) return false;
  if (!parsed.mod && modPressed) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (event.key.toLowerCase() === parsed.key.toLowerCase()) return true;
  if (parsed.shift) {
    const shiftedVariant = SHIFTED_KEY_MAP[parsed.key.toLowerCase()];
    if (shiftedVariant && event.key === shiftedVariant) return true;
  }
  return false;
}

export function formatShortcut(shortcutKey: string, isMac: boolean): string {
  const parts = shortcutKey.split('+');
  const formatted = parts.map((p) => {
    switch (p.toLowerCase()) {
      case 'mod':
        return isMac ? '⌘' : 'ctrl';
      case 'shift':
        return isMac ? '⇧' : 'shift';
      default:
        return p.length === 1 ? p.toUpperCase() : p;
    }
  });
  return isMac ? formatted.join('') : formatted.join('+');
}

/**
 * Sets up a single global keydown listener that dispatches to registered actions.
 * Returns a cleanup function to remove the listener.
 */
export function setupShortcutListener(
  getActions: () => Action[],
  getContext: () => ActionContext,
  isMac: boolean
): () => void {
  const onKeydown = (e: KeyboardEvent) => {
    const modPressed = isMac ? e.metaKey : e.ctrlKey;
    if (!modPressed) return; // all registry shortcuts require mod

    // Don't intercept from text inputs unless the shortcut is global. The
    // CodeMirror file editor (#1004) focuses a contenteditable host rather than
    // a <textarea>, so include isContentEditable — matching the sibling guard in
    // useAppShortcuts — to keep registry shortcuts (mod+w, mod+shift+[ ]) from
    // leaking into the focused editor while editing.
    const active = document.activeElement as HTMLElement | null;
    const inInput =
      active?.tagName === 'INPUT' ||
      active?.tagName === 'TEXTAREA' ||
      active?.isContentEditable === true;

    const actions = getActions();
    for (const action of actions) {
      if (!action.shortcut) continue;
      const parsed = parseShortcut(action.shortcut.key);
      if (!matchesShortcut(e, parsed, isMac)) continue;
      if (inInput && !action.shortcut.global) continue;

      const ctx = getContext();
      if (action.when && !action.when(ctx)) continue;

      e.preventDefault();
      const result = action.handler(ctx);
      if (result instanceof Promise) {
        result.catch((err) =>
          logger.error(`Shortcut action "${action.id}" failed`, err)
        );
      }
      return;
    }
  };

  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}
