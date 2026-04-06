import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { connectPtySocket, sendPtyData, sendPtyResize } from '../lib/ws.js';
import { isMobileDevice } from '../lib/utils.js';
import { uploadImage } from '../lib/api.js';
import { useUiStore, DEFAULT_TERMINAL_FONT_SIZE } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { clampFontSize, zoomPercentage } from '../lib/terminal-zoom.js';
import './Terminal.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TerminalHandle {
  getTerm: () => XTerminal | null;
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

// ── useScrollbar hook ─────────────────────────────────────────────────────────

interface ScrollbarState {
  thumbHeight: number;
  thumbTop: number;
  thumbVisible: boolean;
}

function useScrollbar(termRef: React.RefObject<XTerminal | null>) {
  const [state, setState] = useState<ScrollbarState>({
    thumbHeight: 0,
    thumbTop: 0,
    thumbVisible: false,
  });
  const rafRef = useRef(false);

  const update = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = true;
    requestAnimationFrame(() => {
      rafRef.current = false;
      const term = termRef.current;
      if (!term) return;
      const buf = term.buffer.active;
      const totalLines = buf.baseY + term.rows;
      if (totalLines <= term.rows) {
        setState((s) => ({ ...s, thumbVisible: false }));
        return;
      }
      const trackHeight =
        document.querySelector<HTMLElement>('.terminal-scrollbar')
          ?.clientHeight ?? 0;
      const minThumb = isMobileDevice ? 44 : 20;
      const h = Math.max(minThumb, (term.rows / totalLines) * trackHeight);
      const t = (buf.viewportY / (totalLines - term.rows)) * (trackHeight - h);
      setState({ thumbHeight: h, thumbTop: t, thumbVisible: true });
    });
  }, [termRef]);

  return { scrollbarState: state, updateScrollbar: update };
}

// ── useTerminalZoom hook ──────────────────────────────────────────────────────

function useTerminalZoom(
  termRef: React.RefObject<XTerminal | null>,
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

// ── useTouchScroll hook ───────────────────────────────────────────────────────

interface TouchScrollState {
  contentScrolling: boolean;
  contentTouchStartY: number;
  contentScrollStartLine: number;
  contentTouchMoved: boolean;
  contentScrollAccumulator: number;
  contentLastTouchY: number;
  scrollbarDragging: boolean;
  scrollbarDragStartY: number;
  scrollbarDragStartTop: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  longPressStartX: number;
  longPressStartY: number;
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

// Scrollbar drag handler (extracted to reduce nesting depth)
function handleScrollbarDrag(
  e: TouchEvent,
  touch: Touch,
  s: TouchScrollState,
  term: XTerminal,
  scrollbarEl: HTMLDivElement
) {
  e.preventDefault();
  const deltaY = touch.clientY - s.scrollbarDragStartY;
  const buf = term.buffer.active;
  const totalLines = buf.baseY + term.rows;
  if (totalLines <= term.rows) return;
  const trackHeight = scrollbarEl.clientHeight;
  const th = Math.max(44, (term.rows / totalLines) * trackHeight);
  const trackUsable = trackHeight - th;
  const newTop = Math.max(
    0,
    Math.min(trackUsable, s.scrollbarDragStartTop + deltaY)
  );
  const ratio = newTop / trackUsable;
  term.scrollToLine(Math.round(ratio * (totalLines - term.rows)));
}

// Alternate-buffer scroll (extracted to reduce nesting depth)
function handleAlternateBufferScroll(
  e: TouchEvent,
  touch: Touch,
  s: TouchScrollState,
  term: XTerminal,
  lineHeight: number
) {
  const incrementalDelta = s.contentLastTouchY - touch.clientY;
  s.contentLastTouchY = touch.clientY;
  s.contentScrollAccumulator += incrementalDelta / lineHeight;
  const rawLines = Math.trunc(s.contentScrollAccumulator);
  if (rawLines === 0) return;
  s.contentScrollAccumulator -= rawLines;
  const button = rawLines > 0 ? 65 : 64;
  const col = Math.max(1, Math.round(term.cols / 2));
  const row = Math.max(1, Math.round(term.rows / 2));
  const seq = `\x1b[<${button};${col};${row}M`;
  const count = Math.min(Math.abs(rawLines), 5);
  for (let i = 0; i < count; i++) sendPtyData(seq);
  void e;
}

// Extracted helpers to keep useTouchScroll under 100 lines
function doExitSelectionMode(
  container: HTMLElement | null,
  setSelectionMode: (v: boolean) => void
) {
  setSelectionMode(false);
  if (!container) return;
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  if (screen) {
    screen.style.userSelect = '';
    screen.style.webkitUserSelect = '';
  }
  container.querySelectorAll<HTMLElement>('canvas').forEach((c) => {
    c.style.pointerEvents = '';
  });
  window.getSelection()?.removeAllRanges();
}

function doEnterSelectionMode(
  container: HTMLElement | null,
  setSelectionMode: (v: boolean) => void
) {
  setSelectionMode(true);
  if (!container) return;
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  if (screen) {
    screen.style.userSelect = 'text';
    screen.style.webkitUserSelect = 'text';
  }
  container.querySelectorAll<HTMLElement>('canvas').forEach((c) => {
    c.style.pointerEvents = 'none';
  });
  const rows = container.querySelector('.xterm-rows');
  if (!rows) return;
  const range = document.createRange();
  range.selectNodeContents(rows);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function useTouchScroll(
  termRef: React.RefObject<XTerminal | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  scrollbarRef: React.RefObject<HTMLDivElement | null>,
  thumbTop: number,
  useTmux: boolean,
  onCopyModeChange?: (active: boolean) => void
) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [inCopyMode, setInCopyMode] = useState(false);
  const stateRef = useRef<TouchScrollState>({
    contentScrolling: false,
    contentTouchStartY: 0,
    contentScrollStartLine: 0,
    contentTouchMoved: false,
    contentScrollAccumulator: 0,
    contentLastTouchY: 0,
    scrollbarDragging: false,
    scrollbarDragStartY: 0,
    scrollbarDragStartTop: 0,
    longPressTimer: null,
    longPressStartX: 0,
    longPressStartY: 0,
  });

  const exitSelectionMode = useCallback(() => {
    doExitSelectionMode(containerRef.current, setSelectionMode);
  }, [containerRef]);

  const enterSelectionMode = useCallback(() => {
    const s = stateRef.current;
    if (s.longPressTimer) {
      clearTimeout(s.longPressTimer);
      s.longPressTimer = null;
    }
    s.contentScrolling = false;
    if (navigator.vibrate) navigator.vibrate(50);
    if (useTmux) {
      setInCopyMode(true);
      onCopyModeChange?.(true);
      sendPtyData('\x02[');
      return;
    }
    doEnterSelectionMode(containerRef.current, setSelectionMode);
  }, [containerRef, useTmux, onCopyModeChange]);

  const exitCopyMode = useCallback(() => {
    if (inCopyMode) {
      setInCopyMode(false);
      onCopyModeChange?.(false);
    }
  }, [inCopyMode, onCopyModeChange]);

  const onTerminalTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const s = stateRef.current;
      const term = termRef.current;
      if (selectionMode) {
        const selectedText = window.getSelection()?.toString() ?? '';
        if (selectedText.trim().length > 0) {
          navigator.clipboard.writeText(selectedText).catch(() => {
            /* ignore */
          });
          if (navigator.vibrate) navigator.vibrate(30);
        }
        exitSelectionMode();
        return;
      }
      if (inCopyMode) return;
      const target = e.target as HTMLElement;
      if (
        target.closest('.terminal-scrollbar') ||
        target.closest('.scroll-fabs')
      )
        return;
      if (!term) return;
      const touch = e.touches[0];
      if (!touch) return;
      s.contentTouchStartY = touch.clientY;
      s.contentLastTouchY = touch.clientY;
      s.contentScrollStartLine = term.buffer.active.viewportY;
      s.contentTouchMoved = false;
      s.contentScrollAccumulator = 0;
      s.contentScrolling = true;
      s.longPressStartX = touch.clientX;
      s.longPressStartY = touch.clientY;
      if (s.longPressTimer) clearTimeout(s.longPressTimer);
      s.longPressTimer = setTimeout(enterSelectionMode, LONG_PRESS_MS);
    },
    [termRef, selectionMode, inCopyMode, exitSelectionMode, enterSelectionMode]
  );

  const onTerminalTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const s = stateRef.current;
      if (s.scrollbarDragging || s.contentTouchMoved) return;
      const target = e.target as HTMLElement;
      if (
        target.closest('.terminal-scrollbar') ||
        target.closest('.scroll-fabs') ||
        selectionMode
      )
        return;
      termRef.current?.focus();
      e.preventDefault();
    },
    [termRef, selectionMode]
  );

  const onThumbTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const s = stateRef.current;
      s.scrollbarDragging = true;
      s.scrollbarDragStartY = touch.clientY;
      s.scrollbarDragStartTop = thumbTop;
    },
    [thumbTop]
  );

  useTouchScrollListeners(
    termRef,
    containerRef,
    scrollbarRef,
    stateRef,
    selectionMode
  );

  return {
    selectionMode,
    inCopyMode,
    exitCopyMode,
    onTerminalTouchStart,
    onTerminalTouchEnd,
    onThumbTouchStart,
  };
}

// ── useTouchScrollListeners hook ──────────────────────────────────────────────

function useTouchScrollListeners(
  termRef: React.RefObject<XTerminal | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  scrollbarRef: React.RefObject<HTMLDivElement | null>,
  stateRef: React.RefObject<TouchScrollState>,
  selectionMode: boolean
) {
  useEffect(() => {
    if (!isMobileDevice) return undefined;
    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const s = stateRef.current;
      const term = termRef.current;
      const scrollbarEl = scrollbarRef.current;
      if (s.scrollbarDragging && term && scrollbarEl) {
        handleScrollbarDrag(e, touch, s, term, scrollbarEl);
        return;
      }
      const container = containerRef.current;
      if (!s.contentScrolling || !term || selectionMode || !container) return;
      if (s.longPressTimer) {
        const moveX = Math.abs(touch.clientX - s.longPressStartX);
        const moveY = Math.abs(touch.clientY - s.longPressStartY);
        if (
          moveX > LONG_PRESS_MOVE_TOLERANCE ||
          moveY > LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearTimeout(s.longPressTimer);
          s.longPressTimer = null;
        }
      }
      if (term.rows === 0 || container.clientHeight === 0) return;
      const deltaY = s.contentTouchStartY - touch.clientY;
      if (Math.abs(deltaY) <= 5) return;
      s.contentTouchMoved = true;
      e.preventDefault();
      const lineHeight = container.clientHeight / term.rows;
      if (term.buffer.active.type === 'alternate') {
        handleAlternateBufferScroll(e, touch, s, term, lineHeight);
      } else {
        const lineDelta = deltaY / lineHeight;
        const maxScroll = term.buffer.active.baseY;
        term.scrollToLine(
          Math.max(
            0,
            Math.min(
              maxScroll,
              Math.round(s.contentScrollStartLine + lineDelta)
            )
          )
        );
      }
    };
    const handleTouchEnd = () => {
      const s = stateRef.current;
      if (s.longPressTimer) {
        clearTimeout(s.longPressTimer);
        s.longPressTimer = null;
      }
      s.scrollbarDragging = false;
      s.contentScrolling = false;
      s.contentTouchMoved = false;
      s.contentScrollAccumulator = 0;
    };
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [termRef, containerRef, scrollbarRef, stateRef, selectionMode]);
}

// ── useScrollbarClick hook ────────────────────────────────────────────────────

function useScrollbarClick(
  termRef: React.RefObject<XTerminal | null>,
  scrollbarRef: React.RefObject<HTMLDivElement | null>,
  thumbRef: React.RefObject<HTMLDivElement | null>,
  thumbTop: number
) {
  const scrollToY = useCallback(
    (clientY: number) => {
      const term = termRef.current;
      const scrollbarEl = scrollbarRef.current;
      if (!term || !scrollbarEl) return;
      const rect = scrollbarEl.getBoundingClientRect();
      const buf = term.buffer.active;
      const totalLines = buf.baseY + term.rows;
      if (totalLines <= term.rows) return;
      const trackHeight = scrollbarEl.clientHeight;
      const th = Math.max(
        isMobileDevice ? 44 : 20,
        (term.rows / totalLines) * trackHeight
      );
      const trackUsable = trackHeight - th;
      const relativeY = clientY - rect.top - th / 2;
      const ratio = Math.max(0, Math.min(1, relativeY / trackUsable));
      term.scrollToLine(Math.round(ratio * (totalLines - term.rows)));
    },
    [termRef, scrollbarRef]
  );

  const onScrollbarClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === thumbRef.current) return;
      scrollToY(e.clientY);
    },
    [thumbRef, scrollToY]
  );

  void thumbTop;

  const onScrollFabMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const term = termRef.current;
      if (!term) return;
      const dir = btn.dataset['dir'];
      if (term.buffer.active.type === 'alternate') {
        const col = Math.max(1, Math.round(term.cols / 2));
        const row = Math.max(1, Math.round(term.rows / 2));
        if (dir === 'up' || dir === 'down') {
          const button = dir === 'down' ? 65 : 64;
          const seq = `\x1b[<${button};${col};${row}M`;
          const count = Math.max(1, Math.round(term.rows / 2));
          for (let i = 0; i < count; i++) sendPtyData(seq);
        } else if (dir === 'bottom') {
          const seq = `\x1b[<65;${col};${row}M`;
          for (let i = 0; i < term.rows; i++) sendPtyData(seq);
        }
      } else {
        if (dir === 'up') term.scrollPages(-1);
        else if (dir === 'down') term.scrollPages(1);
        else if (dir === 'bottom') term.scrollToBottom();
      }
    },
    [termRef]
  );

  return { onScrollbarClick, onScrollFabMouseDown };
}

// ── useTerminalSetup hook ─────────────────────────────────────────────────────

// Extracted: read clipboard for possible image paste (ctrl+v on non-mac)
function readClipboardForPaste(t: XTerminal) {
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

// Extracted: attach clipboard paste handler to avoid key handler complexity
function attachClipboardKeyHandler(t: XTerminal, isMac: boolean) {
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
}

// Extracted: register file path link provider
function registerFileLinkProvider(
  t: XTerminal,
  onFilePathClick?: (path: string) => void
) {
  t.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = t.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: import('@xterm/xterm').ILink[] = [];
      for (const m of text.matchAll(FILE_EXT_PATTERN)) {
        if (m.index === undefined) continue;
        const delimiter = m[1] || '';
        if (m.index > 0 && !delimiter) continue;
        const pathStart = m.index + delimiter.length;
        const pathText = m[0].slice(delimiter.length);
        const pathEnd = pathStart + pathText.length;
        links.push({
          range: {
            start: { x: pathStart + 1, y: lineNumber },
            end: { x: pathEnd + 1, y: lineNumber },
          },
          text: pathText,
          activate(_event, linkText) {
            onFilePathClick?.(linkText.replace(/:\d+(?::\d+)?$/, ''));
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}

// Extracted: mobile-specific DOM patches after t.open()
function applyMobilePatches(container: HTMLDivElement, t: XTerminal) {
  const viewport = container.querySelector<HTMLElement>('.xterm-viewport');
  if (viewport) {
    viewport.style.touchAction = 'none';
    viewport.style.overflowY = 'hidden';
  }
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return;
  screen.addEventListener(
    'wheel',
    (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    { capture: true, passive: false }
  );
  const suppress = (e: Event) => {
    if (t.modes.mouseTrackingMode !== 'none') e.stopImmediatePropagation();
  };
  for (const evt of ['mousedown', 'mouseup', 'mousemove'] as const)
    screen.addEventListener(evt, suppress, { capture: true });
}

function useTerminalSetup(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  companionMode: boolean,
  onFilePathClick: ((path: string) => void) | undefined,
  updateScrollbar: () => void
) {
  const termRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);

  const fit = useCallback(() => {
    const term = termRef.current;
    const fa = fitAddonRef.current;
    if (!term || !fa) return;
    const buf = term.buffer.active;
    const wasAtBottom = buf.viewportY >= buf.baseY;
    const savedViewportY = buf.viewportY;
    fa.fit();
    if (wasAtBottom) term.scrollToBottom();
    else term.scrollToLine(savedViewportY);
    sendPtyResize(term.cols, term.rows);
    updateScrollbar();
  }, [updateScrollbar]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
    const t = new XTerminal({
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
    const fa = new FitAddon();
    fitAddonRef.current = fa;
    t.loadAddon(fa);
    t.loadAddon(new WebLinksAddon());
    registerFileLinkProvider(t, onFilePathClick);
    t.open(container);
    if (isMobileDevice) applyMobilePatches(container, t);
    fa.fit();
    t.onData((data) => sendPtyData(data));
    attachClipboardKeyHandler(t, isMac);
    t.parser.registerOscHandler(52, (data) => {
      const semicolonIdx = data.indexOf(';');
      if (semicolonIdx === -1) return true;
      const payload = data.slice(semicolonIdx + 1);
      if (!payload || payload === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        navigator.clipboard
          ?.writeText(new TextDecoder('utf-8').decode(bytes))
          .catch(() => {
            /* ignore */
          });
      } catch {
        /* ignore */
      }
      return true;
    });
    t.onScroll(updateScrollbar);
    t.onWriteParsed(updateScrollbar);
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(
        () => {
          const buf = t.buffer.active;
          const wasAtBottom = buf.viewportY >= buf.baseY;
          const savedViewportY = buf.viewportY;
          fa.fit();
          if (wasAtBottom) t.scrollToBottom();
          else t.scrollToLine(savedViewportY);
          sendPtyResize(t.cols, t.rows);
          updateScrollbar();
        },
        isMobileDevice ? 150 : 0
      );
    });
    ro.observe(container);
    termRef.current = t;
    return () => {
      if (roTimer) clearTimeout(roTimer);
      ro.disconnect();
      t.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // intentionally empty: terminal is created once per mount

  // React to sessionId changes
  useEffect(() => {
    const term = termRef.current;
    if (sessionId && term && !companionMode) {
      // Reset terminal modes before switching sessions:
      // - Exit alternate screen buffer (?1049l)
      // - Disable mouse tracking modes (?1000l normal, ?1002l button-event,
      //   ?1003l any-event, ?1006l SGR format, ?1015l URXVT format)
      // - Disable bracketed paste (?2004l)
      // Without this, an app like OpenCode that enables mouse tracking will
      // leave xterm.js generating mouse escape sequences that get echoed as
      // garbage text in the next session's PTY.
      term.write(
        '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l',
        () => {
          term.clear();
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
      );
    }
  }, [sessionId, companionMode]);

  return { termRef, fitAddonRef, fit };
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
  termRef: React.RefObject<XTerminal | null>,
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
    const scrollbarRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);

    const claudeFullscreen = useConfigStore((s) => s.claudeFullscreen);
    const activeAgent = useSessionsStore((s) =>
      s.sessions.find((sess) => sess.id === sessionId)?.agent
    );
    const isFullscreenTerminal =
      claudeFullscreen && activeAgent === 'claude';

    const { termRef, fit } = useTerminalSetup(
      containerRef,
      sessionId,
      companionMode,
      onFilePathClick,
      () => updateSb()
    );
    const { scrollbarState: sbState, updateScrollbar: updateSb } =
      useScrollbar(termRef);
    const { zoomVisible, zoomText, applyZoom } = useTerminalZoom(termRef, fit);
    const { handleImageUpload } = useImageUpload(sessionId, onImageUpload);
    const {
      selectionMode,
      inCopyMode: _inCopyMode,
      exitCopyMode,
      onTerminalTouchStart,
      onTerminalTouchEnd,
      onThumbTouchStart,
    } = useTouchScroll(
      termRef,
      containerRef,
      scrollbarRef,
      sbState.thumbTop,
      useTmux,
      onCopyModeChange
    );
    const { onScrollbarClick, onScrollFabMouseDown } = useScrollbarClick(
      termRef,
      scrollbarRef,
      thumbRef,
      sbState.thumbTop
    );
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
        exitCopyMode,
        handleImageUpload,
      }),
      [termRef, fit, exitCopyMode, handleImageUpload]
    );

    const wrapperClass = [
      'terminal-wrapper',
      dragOver ? 'drag-over' : '',
      selectionMode ? 'selection-mode' : '',
      isFullscreenTerminal ? 'terminal-fullscreen' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        className={wrapperClass}
        data-track="terminal.focus"
        onTouchStart={isMobileDevice ? onTerminalTouchStart : undefined}
        onTouchEnd={isMobileDevice ? onTerminalTouchEnd : undefined}
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
        <div
          className="terminal-scrollbar"
          ref={scrollbarRef}
          onClick={onScrollbarClick}
          role="scrollbar"
          aria-valuenow={0}
          aria-orientation="vertical"
        >
          <div
            className="terminal-scrollbar-thumb"
            ref={thumbRef}
            style={{
              display: sbState.thumbVisible ? 'block' : 'none',
              height: sbState.thumbHeight,
              top: sbState.thumbTop,
            }}
            onTouchStart={onThumbTouchStart}
            role="presentation"
          />
        </div>
        {isMobileDevice && sbState.thumbVisible && (
          <div className="scroll-fabs" onMouseDown={onScrollFabMouseDown}>
            <button
              className="scroll-fab"
              data-dir="up"
              data-track="terminal.scroll-up"
              aria-label="Page up"
            >
              &#9650;
            </button>
            <button
              className="scroll-fab"
              data-dir="down"
              data-track="terminal.scroll-down"
              aria-label="Page down"
            >
              &#9660;
            </button>
            <button
              className="scroll-fab scroll-fab-bottom"
              data-dir="bottom"
              data-track="terminal.scroll-bottom"
              aria-label="Skip to bottom"
            >
              &#8615;
            </button>
          </div>
        )}
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
