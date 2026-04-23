import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { init, Terminal as GTerminal, FitAddon } from 'ghostty-web';
import type { ILink, ILinkProvider } from 'ghostty-web';
import { connectPtySocket, sendPtyData, sendPtyResize } from '../lib/ws.js';
import { isMobileDevice } from '../lib/utils.js';
import { uploadImage } from '../lib/api.js';
import { useUiStore, DEFAULT_TERMINAL_FONT_SIZE } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import {
  clampFontSize,
  zoomPercentage,
} from '../lib/terminal-zoom.js';
import './Terminal.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TerminalHandle {
  getTerm: () => GTerminal | null;
  focusTerm: () => void;
  fitTerm: () => void;
  exitCopyMode: () => void;
  handleImageUpload: (blob: Blob, mimeType: string) => Promise<void>;
}

export interface TerminalProps {
  sessionId: string | null;
  onImageUpload?: (text: string, showInsert: boolean, path?: string) => void;
  useTmux?: boolean;
  onCopyModeChange?: (active: boolean) => void;
  onFilePathClick?: (path: string) => void;
  companionMode?: boolean;
}

// ── File path link provider ───────────────────────────────────────────────────

const FILE_EXT_PATTERN =
  /([\s'"(`[{])?(\/?\/?(?:\.\/)?(?:[\w.@~-]+\/)*(?:[\w.@~-]+\.(?:ts|tsx|js|jsx|svelte|html|htm|css|scss|json|yaml|yml|toml|md|txt|py|rs|go|rb|java|c|cpp|h|sh|sql|graphql|xml|csv|env|log|cfg|conf|ini)|(?:Makefile|Dockerfile|Vagrantfile|Rakefile|Gemfile|Procfile|Brewfile|Justfile|Taskfile|Containerfile)(?:\.\w+)?))(?::(\d+)(?::(\d+))?)?/g;

// ── useTerminalZoom hook ──────────────────────────────────────────────────────

function useTerminalZoom(
  termRef: React.RefObject<GTerminal | null>,
  fitFn: () => void
) {
  const [zoomVisible, setZoomVisible] = useState(false);
  const [zoomText, setZoomText] = useState('100%');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setTerminalFontSize = useUiStore((s) => s.saveTerminalFontSize);

  const applyZoom = useCallback(
    (newSize: number) => {
      const term = termRef.current;
      if (!term) return;
      const clamped = clampFontSize(newSize);
      if (clamped === term.options.fontSize) return;
      term.options.fontSize = clamped;
      useUiStore.setState({ terminalFontSize: clamped });
      setTerminalFontSize();
      fitFn();
      setZoomText(zoomPercentage(clamped) + '%');
      setZoomVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setZoomVisible(false), 1500);
    },
    [termRef, fitFn, setTerminalFontSize]
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return { zoomVisible, zoomText, applyZoom };
}

// ── Clipboard helpers ─────────────────────────────────────────────────────────

function isZoomShortcut(
  e: {
    type: string;
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  },
  isMac: boolean
): boolean {
  if (isMobileDevice || e.type !== 'keydown') return false;
  const onlyMod = isMac
    ? e.metaKey && !e.ctrlKey && !e.altKey
    : e.ctrlKey && !e.metaKey && !e.altKey;
  return (
    onlyMod &&
    (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')
  );
}

function isCtrlVShortcut(
  e: {
    type: string;
    key: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  },
  isMac: boolean
): boolean {
  return (
    !isMac &&
    e.type === 'keydown' &&
    e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.key === 'v' || e.key === 'V')
  );
}

function readClipboardForPaste(t: GTerminal) {
  if (!navigator.clipboard?.read) return;
  void navigator.clipboard
    .read()
    .then((items) => {
      let blob: ClipboardItem | null = null;
      let blobType: string | null = null;
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            blobType = type;
            blob = item;
            break;
          }
        }
        if (blob) break;
      }
      if (blob && blobType) {
        void blob.getType(blobType);
      } else {
        void navigator.clipboard.readText().then((text) => {
          if (text) t.paste(text);
        });
      }
    })
    .catch(() => {
      if (navigator.clipboard.readText)
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) t.paste(text);
          })
          .catch(() => {
            /* ignore */
          });
    });
}

// ── useTerminalSetup hook ─────────────────────────────────────────────────────

function useTerminalSetup(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  companionMode: boolean,
  onFilePathClick: ((path: string) => void) | undefined,
  fitFnRef: React.MutableRefObject<(() => void) | null>
) {
  const termRef = useRef<GTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  const initRef = useRef(false);

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
    const term = termRef.current;
    if (term) {
      sendPtyResize(term.cols, term.rows);
    }
  }, []);

  useEffect(() => {
    fitFnRef.current = fit;
  }, [fit, fitFnRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || initRef.current) return undefined;
    initRef.current = true;

    let cancelled = false;
    let t: GTerminal;
    let fa: FitAddon;

    (async () => {
      await init();
      if (cancelled || !containerRef.current) return;

      const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

      try {
        t = new GTerminal({
          cursorBlink: true,
          fontSize: isMobileDevice ? 12 : terminalFontSize,
          fontFamily: 'Menlo, monospace',
          scrollback: 10000,
          theme: {
            background: '#000000',
            foreground: '#d4d4d4',
            cursor: '#d4d4d4',
          },
        });
      } catch (e) {
        console.error('Failed to create ghostty terminal:', e);
        return;
      }

      fa = new FitAddon();
      fitAddonRef.current = fa;
      t.loadAddon(fa);

      t.open(container);
      fa.observeResize();
      fa.fit();

      // File path link provider
      if (onFilePathClick) {
        const provider: ILinkProvider = {
          provideLinks(y, callback) {
            const line = t.buffer?.active?.getLine(y - 1);
            if (!line) {
              callback(undefined);
              return;
            }
            const text = line.translateToString(true);
            const links: ILink[] = [];
            for (const m of text.matchAll(FILE_EXT_PATTERN)) {
              if (m.index === undefined) continue;
              const delimiter = m[1] || '';
              if (m.index > 0 && !delimiter) continue;
              const pathStart = m.index + delimiter.length;
              const pathText = m[0].slice(delimiter.length);
              const pathEnd = pathStart + pathText.length;
            links.push({
              range: {
                start: { x: pathStart + 1, y },
                end: { x: pathEnd + 1, y },
              },
              text: pathText,
              activate(_event: MouseEvent) {
                onFilePathClick(pathText.replace(/:\d+(?::\d+)?$/, ''));
              },
            });
            }
            callback(links.length > 0 ? links : undefined);
          },
        };
        t.registerLinkProvider(provider);
      }

      // Key handler: block zoom shortcuts, intercept Ctrl+V for image paste
      t.attachCustomKeyEventHandler((e) => {
        if (isZoomShortcut(e, isMac)) {
          e.preventDefault();
          return false;
        }
        if (
          isCtrlVShortcut(e, isMac) &&
          typeof navigator.clipboard?.read === 'function'
        ) {
          readClipboardForPaste(t);
          return false;
        }
        return true;
      });

      t.onData((data) => sendPtyData(data));

      termRef.current = t;
    })();

    return () => {
      cancelled = true;
      if (fa) fa.dispose();
      if (t) t.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      initRef.current = false;
    };
  }, []); // intentionally empty: terminal is created once per mount

  // React to sessionId changes
  useEffect(() => {
    const term = termRef.current;
    if (sessionId && term && !companionMode) {
      term.reset();
      fitAddonRef.current?.fit();
      connectPtySocket(
        sessionId,
        term,
        () => {
          if (termRef.current)
            sendPtyResize(termRef.current.cols, termRef.current.rows);
        },
        () => {
          /* session ended */
        }
      );
    }
  }, [sessionId, companionMode]);

  return { termRef, fit };
}

// ── useImageUpload hook ───────────────────────────────────────────────────────

function useImageUpload(
  sessionId: string | null,
  onImageUpload?: (text: string, showInsert: boolean, path?: string) => void
) {
  const inProgressRef = useRef(false);

  const handleImageUpload = useCallback(
    async (blob: Blob, mimeType: string) => {
      if (inProgressRef.current || !sessionId) return;
      inProgressRef.current = true;
      onImageUpload?.('Pasting image\u2026', false);
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1]!;
        try {
          const data = await uploadImage(sessionId!, base64, mimeType);
          if (data.clipboardSet) onImageUpload?.('Image pasted', false);
          else onImageUpload?.(data.path, true, data.path);
        } catch (err: unknown) {
          const msg =
            err instanceof Error ? err.message : 'Image upload failed';
          onImageUpload?.(msg, false);
        } finally {
          inProgressRef.current = false;
        }
      };
      reader.readAsDataURL(blob);
    },
    [sessionId, onImageUpload]
  );

  return { handleImageUpload };
}

// ── useTerminalInteractions hook ──────────────────────────────────────────────

function useTerminalInteractions(
  termRef: React.RefObject<GTerminal | null>,
  applyZoom: (size: number) => void,
  handleImageUpload: (blob: Blob, mimeType: string) => Promise<void>
) {
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
    const onKeydown = (e: KeyboardEvent) => {
      if (isMobileDevice || e.type !== 'keydown') return;
      const onlyMod = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey
        : e.ctrlKey && !e.metaKey && !e.altKey;
      if (!onlyMod) return;
      const term = termRef.current;
      if (!term) return;
      const currentSize = term.options.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
      if (e.key === '=' || e.key === '+') applyZoom(currentSize + 1);
      else if (e.key === '-') applyZoom(currentSize - 1);
      else if (e.key === '0') applyZoom(DEFAULT_TERMINAL_FONT_SIZE);
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [termRef, applyZoom]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!e.clipboardData?.items) return;
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          const blob = item.getAsFile();
          if (blob) void handleImageUpload(blob, item.type);
          return;
        }
      }
    },
    [handleImageUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback(() => setDragOver(false), []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files[0];
      if (file?.type.startsWith('image/'))
        void handleImageUpload(file, file.type);
    },
    [handleImageUpload]
  );

  return { dragOver, handlePaste, handleDragOver, handleDragLeave, handleDrop };
}

// ── Main Component ────────────────────────────────────────────────────────────

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(
    {
      sessionId,
      onImageUpload,
      useTmux = false,
      onCopyModeChange,
      onFilePathClick,
      companionMode = false,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const fitFnRef = useRef<(() => void) | null>(null);

    const claudeFullscreen = useConfigStore((s) => s.claudeFullscreen);
    const activeAgent = useSessionsStore(
      (s) => s.sessions.find((sess) => sess.id === sessionId)?.agent
    );
    const reconnectingPtySessionId = useSessionsStore(
      (s) => s.reconnectingPtySessionId
    );
    const isFullscreenTerminal =
      (claudeFullscreen && activeAgent === 'claude') || useTmux;

    const { termRef, fit } = useTerminalSetup(
      containerRef,
      sessionId,
      companionMode,
      onFilePathClick,
      fitFnRef
    );

    const { zoomVisible, zoomText, applyZoom } = useTerminalZoom(termRef, fit);
    const { handleImageUpload } = useImageUpload(sessionId, onImageUpload);
    const {
      dragOver,
      handlePaste,
      handleDragOver,
      handleDragLeave,
      handleDrop,
    } = useTerminalInteractions(termRef, applyZoom, handleImageUpload);

    useImperativeHandle(
      ref,
      () => ({
        getTerm: () => termRef.current,
        focusTerm: () => termRef.current?.focus(),
        fitTerm: fit,
        exitCopyMode: () => {
          /* ghostty handles copy mode natively */
        },
        handleImageUpload,
      }),
      [termRef, fit, handleImageUpload]
    );

    useEffect(() => {
      if (
        sessionId &&
        reconnectingPtySessionId === sessionId &&
        termRef.current &&
        !companionMode
      ) {
        const term = termRef.current;
        term.reset();
        fit();
      }
    }, [sessionId, reconnectingPtySessionId, companionMode, fit]);

    useEffect(() => {
      if (isFullscreenTerminal) {
        fit();
      }
    }, [isFullscreenTerminal, fit]);

    const wrapperClass = [
      'terminal-wrapper',
      dragOver ? 'drag-over' : '',
      isFullscreenTerminal ? 'terminal-fullscreen' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        className={wrapperClass}
        data-track="terminal.focus"
      >
        <div
          className="terminal-container"
          ref={containerRef}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="presentation"
        />
        {!isMobileDevice && (
          <div
            className={['zoom-overlay', zoomVisible ? 'visible' : '']
              .filter(Boolean)
              .join(' ')}
          >
            {zoomText}
          </div>
        )}
      </div>
    );
  }
);

export default Terminal;
