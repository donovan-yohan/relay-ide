import type { Action, ActionContext } from './types.js';

export type ParsedShortcut = {
  mod: boolean;
  shift: boolean;
  key: string;
};

export function parseShortcut(shortcutKey: string): ParsedShortcut {
  const parts = shortcutKey.toLowerCase().split('+');
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    key: parts.filter(p => p !== 'mod' && p !== 'shift').join('+') || shortcutKey,
  };
}

export function matchesShortcut(
  event: KeyboardEvent,
  parsed: ParsedShortcut,
  isMac: boolean,
): boolean {
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  if (parsed.mod && !modPressed) return false;
  if (!parsed.mod && modPressed) return false;
  if (parsed.shift !== event.shiftKey) return false;
  return event.key.toLowerCase() === parsed.key.toLowerCase();
}

export function formatShortcut(shortcutKey: string, isMac: boolean): string {
  const parts = shortcutKey.split('+');
  const formatted = parts.map(p => {
    switch (p.toLowerCase()) {
      case 'mod': return isMac ? '⌘' : 'ctrl';
      case 'shift': return isMac ? '⇧' : 'shift';
      default: return p.length === 1 ? p.toUpperCase() : p;
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
  isMac: boolean,
): () => void {
  const onKeydown = (e: KeyboardEvent) => {
    const modPressed = isMac ? e.metaKey : e.ctrlKey;
    if (!modPressed) return; // all registry shortcuts require mod

    // Don't intercept from text inputs unless the shortcut is global
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

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
        result.catch(err => console.error(`Shortcut action "${action.id}" failed:`, err));
      }
      return;
    }
  };

  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}
