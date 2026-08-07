import { useEffect, useRef, useState } from 'react';
import { EDITOR_SHORTCUTS } from '../lib/editor-affordances.js';
import { formatShortcut } from '../lib/actions/shortcuts.js';
import { isMac } from '../lib/utils.js';

/**
 * Editor keyboard-shortcut legend (#1004).
 *
 * Reads the honest `EDITOR_SHORTCUTS` catalogue so the panel documents exactly
 * what the CodeMirror keymap binds — shortcuts that are not wired yet (e.g.
 * in-file search) render dimmed with a follow-up note rather than being claimed
 * as working. Rendered only on the editable editor surface; the popover is
 * keyboard-reachable (button → Enter opens, Escape closes and restores focus).
 */
export function EditorShortcutHelp() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [open]);

  return (
    <div className="cm-file-editor__help">
      <button
        ref={triggerRef}
        type="button"
        className="cm-file-editor__help-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="keyboard shortcuts"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <>
          <div
            className="cm-file-editor__help-backdrop"
            onClick={() => setOpen(false)}
          />
          <div
            className="cm-file-editor__help-panel"
            role="dialog"
            aria-label="editor keyboard shortcuts"
          >
            <div className="cm-file-editor__help-title">editor shortcuts</div>
            <ul className="cm-file-editor__help-list">
              {EDITOR_SHORTCUTS.map((shortcut) => (
                <li
                  key={shortcut.id}
                  className={
                    shortcut.available
                      ? 'cm-file-editor__help-item'
                      : 'cm-file-editor__help-item cm-file-editor__help-item--unavailable'
                  }
                >
                  <kbd className="cm-file-editor__help-keys">
                    {formatShortcut(shortcut.combo, isMac)}
                  </kbd>
                  <span className="cm-file-editor__help-desc">
                    {shortcut.description}
                    {!shortcut.available && shortcut.note
                      ? ` — ${shortcut.note}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

export default EditorShortcutHelp;
