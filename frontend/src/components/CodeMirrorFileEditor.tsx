import { useEffect, useRef, useState } from 'react';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  type LanguageSupport,
} from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import './CodeMirrorFileEditor.css';

interface CodeMirrorFileEditorProps {
  filePath: string;
  value: string;
  language: string;
  wordWrap: boolean;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  diskConflict: boolean;
  resetKey: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onReloadDisk: () => void;
  onOverwrite: () => void;
}

async function loadLanguage(
  language: string
): Promise<LanguageSupport | Extension | null> {
  switch (language) {
    case 'typescript':
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({
        typescript: true,
        jsx: language === 'tsx',
      });
    case 'javascript':
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({
        jsx: language === 'jsx',
      });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'css':
    case 'scss':
      return (await import('@codemirror/lang-css')).css();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust();
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'bash':
    case 'sh': {
      const [{ StreamLanguage }, { shell }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/shell'),
      ]);
      return StreamLanguage.define(shell);
    }
    case 'toml': {
      const [{ StreamLanguage }, { toml }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/toml'),
      ]);
      return StreamLanguage.define(toml);
    }
    case 'ruby': {
      const [{ StreamLanguage }, { ruby }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/ruby'),
      ]);
      return StreamLanguage.define(ruby);
    }
    default:
      return null;
  }
}

const relayEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg, #000)',
    color: 'var(--text, #e0e0e0)',
    fontFamily: "var(--font-mono, 'SF Mono', 'Cascadia Code', monospace)",
    fontSize: 'var(--font-size-sm, 0.8125rem)',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
  },
  '.cm-content': {
    caretColor: 'var(--accent, #d97757)',
    padding: '12px 0',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg, #000)',
    color: 'var(--text-muted, #888)',
    borderRight: '1px solid var(--border, #333)',
  },
  '.cm-activeLine': {
    backgroundColor:
      'color-mix(in srgb, var(--accent, #d97757) 8%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor:
      'color-mix(in srgb, var(--accent, #d97757) 12%, transparent)',
    color: 'var(--accent, #d97757)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--accent, #d97757)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor:
      'color-mix(in srgb, var(--accent, #d97757) 35%, transparent)',
  },
});

export function CodeMirrorFileEditor({
  filePath,
  value,
  language,
  wordWrap,
  dirty,
  saving,
  saveError,
  diskConflict,
  resetKey,
  onChange,
  onSave,
  onReloadDisk,
  onOverwrite,
}: CodeMirrorFileEditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const [languageExtension, setLanguageExtension] = useState<Extension | null>(
    null
  );

  valueRef.current = value;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    let cancelled = false;
    setLanguageExtension(null);
    loadLanguage(language)
      .then((extension) => {
        if (!cancelled) setLanguageExtension(extension);
      })
      .catch(() => {
        if (!cancelled) setLanguageExtension(null);
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    const parent = mountRef.current;
    if (!parent) return undefined;

    viewRef.current?.destroy();

    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      relayEditorTheme,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
    ];
    if (wordWrap) extensions.push(EditorView.lineWrapping);
    if (languageExtension) extensions.push(languageExtension);

    const view = new EditorView({
      state: EditorState.create({ doc: valueRef.current, extensions }),
      parent,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [filePath, languageExtension, resetKey, wordWrap]);

  const status = saving ? 'saving' : dirty ? 'unsaved' : 'saved';

  return (
    <div className="cm-file-editor" data-file-path={filePath}>
      <div className="cm-file-editor__toolbar">
        <span
          className={`cm-file-editor__status cm-file-editor__status--${status}`}
        >
          {status}
        </span>
        <span className="cm-file-editor__language">{language}</span>
        {saveError && !diskConflict && (
          <span className="cm-file-editor__error">{saveError}</span>
        )}
        <button
          type="button"
          className="cm-file-editor__save"
          onClick={onSave}
          disabled={saving || !dirty}
        >
          save
        </button>
      </div>
      {diskConflict && (
        <div className="cm-file-editor__conflict" role="alert">
          <span>file changed on disk</span>
          <button type="button" onClick={onReloadDisk} disabled={saving}>
            reload disk version
          </button>
          <button type="button" onClick={onOverwrite} disabled={saving}>
            keep mine, overwrite
          </button>
        </div>
      )}
      <div ref={mountRef} className="cm-file-editor__mount" />
    </div>
  );
}

export default CodeMirrorFileEditor;
