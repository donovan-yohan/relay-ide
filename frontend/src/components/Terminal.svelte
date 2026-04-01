<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import '@xterm/xterm/css/xterm.css';
  import { connectPtySocket, sendPtyData, sendPtyResize } from '../lib/ws.js';
  import { isMobileDevice } from '../lib/utils.js';
  import { uploadImage } from '../lib/api.js';
  import { getUi, saveTerminalFontSize, DEFAULT_TERMINAL_FONT_SIZE } from '../lib/state/ui.svelte.js';
  import { clampFontSize, zoomPercentage } from '../lib/terminal-zoom.js';

  let {
    sessionId,
    onImageUpload,
    useTmux = false,
    onCopyModeChange,
    onFilePathClick,
    companionMode = false,
  }: {
    sessionId: string | null;
    onImageUpload?: ((text: string, showInsert: boolean, path?: string) => void) | undefined;
    useTmux?: boolean;
    onCopyModeChange?: ((active: boolean) => void) | undefined;
    onFilePathClick?: ((path: string) => void) | undefined;
    companionMode?: boolean;
  } = $props();

  let containerEl: HTMLDivElement;
  let term: Terminal | null = $state(null);
  let fitAddon: FitAddon;
  let imageUploadInProgress = false;

  const ui = getUi();

  // ── Terminal zoom overlay + shortcuts (desktop only) ────────────────────────
  let zoomOverlayVisible = $state(false);
  let zoomOverlayText = $state('100%');
  let zoomOverlayTimer: ReturnType<typeof setTimeout> | null = null;

  function applyZoom(newSize: number) {
    if (!term) return;
    const clamped = clampFontSize(newSize);
    if (clamped === term.options.fontSize) return;
    term.options.fontSize = clamped;
    ui.terminalFontSize = clamped;
    saveTerminalFontSize();
    fitTerm();
    zoomOverlayText = zoomPercentage(clamped) + '%';
    zoomOverlayVisible = true;
    if (zoomOverlayTimer) clearTimeout(zoomOverlayTimer);
    zoomOverlayTimer = setTimeout(() => { zoomOverlayVisible = false; }, 1500);
  }

  // Expose term instance for MobileInput
  export function getTerm() {
    return term;
  }

  export function focusTerm() {
    term?.focus();
  }

  export function fitTerm() {
    if (!term) return;
    const buf = term.buffer.active;
    const wasAtBottom = buf.viewportY >= buf.baseY;
    const savedViewportY = buf.viewportY;
    fitAddon?.fit();
    if (wasAtBottom) {
      term.scrollToBottom();
    } else {
      term.scrollToLine(savedViewportY);
    }
    sendPtyResize(term.cols, term.rows);
    updateScrollbar();
  }

  onMount(() => {
    const t = new Terminal({
      cursorBlink: true,
      fontSize: isMobileDevice ? 12 : ui.terminalFontSize,
      fontFamily: 'Menlo, monospace',
      scrollback: 10000,
      theme: {
        background: '#000000',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    });

    fitAddon = new FitAddon();
    t.loadAddon(fitAddon);
    t.loadAddon(new WebLinksAddon());

    // File path link provider — matches paths like src/foo.ts or /abs/path.html
    // and opens them in the in-app file viewer on click
    const fileExtPattern = /(?:^|(?<=[\s'"(`\[{]))(\/?(?:\.\/)?(?:[\w.@~-]+\/)*(?:[\w.@~-]+\.(?:ts|tsx|js|jsx|svelte|html|htm|css|scss|json|yaml|yml|toml|md|txt|py|rs|go|rb|java|c|cpp|h|sh|sql|graphql|xml|csv|env|log|cfg|conf|ini)|(?:Makefile|Dockerfile|Vagrantfile|Rakefile|Gemfile|Procfile|Brewfile|Justfile|Taskfile|Containerfile)(?:\.\w+)?))(?::(\d+)(?::(\d+))?)?/;
    t.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const line = t.buffer.active.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        const links: import('@xterm/xterm').ILink[] = [];
        // Scan for all file path matches in the line
        let offset = 0;
        let remaining = text;
        while (remaining.length > 0) {
          const m = remaining.match(fileExtPattern);
          if (!m || m.index === undefined) break;
          const matchStart = offset + m.index;
          const fullMatch = m[0];
          const matchEnd = matchStart + fullMatch.length;
          links.push({
            range: {
              start: { x: matchStart + 1, y: lineNumber },
              end: { x: matchEnd + 1, y: lineNumber },
            },
            text: fullMatch,
            activate(_event, linkText) {
              // Strip trailing :line:col suffix to get clean path
              const cleanPath = linkText.replace(/:\d+(?::\d+)?$/, '');
              onFilePathClick?.(cleanPath);
            },
          });
          offset = matchEnd;
          remaining = text.slice(offset);
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

    t.open(containerEl);
    if (isMobileDevice) {
      // Disable xterm's internal touch scroll — it scrolls one line at a time.
      // We implement our own smooth content-area touch scroll instead.
      const xtermViewport = containerEl.querySelector('.xterm-viewport') as HTMLElement | null;
      if (xtermViewport) {
        xtermViewport.style.touchAction = 'none';
        xtermViewport.style.overflowY = 'hidden';
      }
      // Suppress xterm.js mouse event conversion when mouse tracking is active
      // (tmux, vim). Wheel events always suppressed (our touch handler handles scroll).
      const xtermScreen = containerEl.querySelector('.xterm-screen') as HTMLElement | null;
      if (xtermScreen) {
        xtermScreen.addEventListener('wheel', (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
        }, { capture: true, passive: false });
        const suppressIfTracking = (e: Event) => {
          if (t.modes.mouseTrackingMode !== 'none') {
            e.stopImmediatePropagation();
          }
        };
        for (const evt of ['mousedown', 'mouseup', 'mousemove'] as const) {
          xtermScreen.addEventListener(evt, suppressIfTracking, { capture: true });
        }
      }
    }
    fitAddon.fit();

    // Wire xterm's input to PTY — xterm handles keyboard/IME/composition natively
    t.onData((data) => sendPtyData(data));

    {
      const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
      t.attachCustomKeyEventHandler((e) => {
        // ── Zoom shortcuts (desktop only: Cmd+=/- on Mac, Ctrl+=/- elsewhere) ──
        if (!isMobileDevice && e.type === 'keydown') {
          // Allow shift because Cmd+Shift+= produces '+' on US keyboards
          const onlyMod = isMac
            ? e.metaKey && !e.ctrlKey && !e.altKey
            : e.ctrlKey && !e.metaKey && !e.altKey;
          if (onlyMod) {
            if (e.key === '=' || e.key === '+') {
              e.preventDefault();
              applyZoom((t.options.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE) + 1);
              return false;
            }
            if (e.key === '-') {
              e.preventDefault();
              applyZoom((t.options.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE) - 1);
              return false;
            }
            if (e.key === '0') {
              e.preventDefault();
              applyZoom(DEFAULT_TERMINAL_FONT_SIZE);
              return false;
            }
          }
        }

        // ── Ctrl+V clipboard/image paste (non-Mac) ──
        if (
          !isMac &&
          e.type === 'keydown' &&
          e.ctrlKey &&
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          (e.key === 'v' || e.key === 'V')
        ) {
          if (navigator.clipboard && navigator.clipboard.read) {
            navigator.clipboard
              .read()
              .then((clipboardItems) => {
                let imageBlob: ClipboardItem | null = null;
                let imageType: string | null = null;
                for (const item of clipboardItems) {
                  for (const type of item.types) {
                    if (type.startsWith('image/')) {
                      imageType = type;
                      imageBlob = item;
                      break;
                    }
                  }
                  if (imageBlob) break;
                }
                if (imageBlob && imageType) {
                  imageBlob.getType(imageType).then((blob) => handleImageUpload(blob, imageType!));
                } else {
                  navigator.clipboard.readText().then((text) => {
                    if (text) t.paste(text);
                  });
                }
              })
              .catch(() => {
                if (navigator.clipboard.readText) {
                  navigator.clipboard.readText().then((text) => {
                    if (text) t.paste(text);
                  }).catch(() => { /* ignore */ });
                }
              });
            return false;
          }
        }
        return true;
      });
    }  // end keyboard handler block

    // OSC 52 clipboard handler — intercepts tmux clipboard sequences and writes to browser clipboard
    t.parser.registerOscHandler(52, (data) => {
      // OSC 52 format: Pc;Pd where Pc is clipboard selection (c/p/s) and Pd is base64-encoded text
      const semicolonIdx = data.indexOf(';');
      if (semicolonIdx === -1) return true;
      const payload = data.slice(semicolonIdx + 1);
      if (!payload || payload === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
        const text = new TextDecoder('utf-8').decode(bytes);
        navigator.clipboard?.writeText(text).catch(() => { /* ignore — clipboard API may be blocked */ });
      } catch { /* ignore invalid base64 */ }
      return true;
    });

    // Scrollbar updates
    t.onScroll(updateScrollbar);
    t.onWriteParsed(updateScrollbar);

    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        const buf = t.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        const savedViewportY = buf.viewportY;
        fitAddon.fit();
        if (wasAtBottom) {
          t.scrollToBottom();
        } else {
          t.scrollToLine(savedViewportY);
        }
        sendPtyResize(t.cols, t.rows);
        updateScrollbar();
      }, isMobileDevice ? 150 : 0);
    });
    ro.observe(containerEl);

    // On mobile, register document-level touch handlers with { passive: false }
    // so e.preventDefault() works. Svelte's <svelte:document ontouchmove> registers
    // as passive by default on Chrome/Android, silently ignoring preventDefault.
    if (isMobileDevice) {
      document.addEventListener('touchmove', onDocumentTouchMove, { passive: false });
      document.addEventListener('touchend', onDocumentTouchEnd);
      document.addEventListener('touchcancel', onDocumentTouchEnd);
    }

    term = t;

    return () => {
      if (roTimer) clearTimeout(roTimer);
      if (longPressTimer) clearTimeout(longPressTimer);
      if (zoomOverlayTimer) clearTimeout(zoomOverlayTimer);
      ro.disconnect();
      t.dispose();
      term = null;
      contentScrolling = false;
      scrollbarDragging = false;
      if (isMobileDevice) {
        document.removeEventListener('touchmove', onDocumentTouchMove);
        document.removeEventListener('touchend', onDocumentTouchEnd);
        document.removeEventListener('touchcancel', onDocumentTouchEnd);
      }
    };
  });

  // React to sessionId changes
  $effect(() => {
    if (sessionId && term && !companionMode) {
      term.write('\x1b[?1049l'); // Exit alternate screen buffer if active
      term.clear();
      connectPtySocket(
        sessionId,
        term,
        () => {
          if (term) sendPtyResize(term.cols, term.rows);
        },
        () => { /* session ended */ },
      );
    }
  });

  // ── Scrollbar state ──────────────────────────────────────────────────────────
  let scrollbarDragging = false;
  let scrollbarDragStartY = 0;
  let scrollbarDragStartTop = 0;
  let thumbHeight = $state(0);
  let thumbTop = $state(0);
  let thumbVisible = $state(false);

  // ── Content-area touch scroll state (mobile) ───────────────────────────────
  let contentScrolling = false;
  let contentTouchStartY = 0;
  let contentScrollStartLine = 0;
  let contentTouchMoved = false;
  let contentScrollAccumulator = 0;
  let contentLastTouchY = 0; // tracks previous touchmove Y for incremental delta

  // Long-press text selection state (mobile)
  let selectionMode = $state(false);
  let inCopyMode = $state(false);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStartX = 0;
  let longPressStartY = 0;
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_TOLERANCE = 10;

  let scrollbarRafPending = false;

  function updateScrollbar() {
    if (scrollbarRafPending) return;
    scrollbarRafPending = true;
    requestAnimationFrame(updateScrollbarNow);
  }

  function updateScrollbarNow() {
    scrollbarRafPending = false;
    if (!term) return;
    const buf = term.buffer.active;
    const totalLines = buf.baseY + term.rows;
    const viewportTop = buf.viewportY;
    const trackEl = scrollbarEl;
    if (!trackEl) return;
    const trackHeight = trackEl.clientHeight;

    if (totalLines <= term.rows) {
      thumbVisible = false;
      return;
    }
    thumbVisible = true;
    thumbHeight = Math.max(isMobileDevice ? 44 : 20, (term.rows / totalLines) * trackHeight);
    thumbTop = (viewportTop / (totalLines - term.rows)) * (trackHeight - thumbHeight);
  }

  function scrollbarScrollToY(clientY: number) {
    if (!term || !scrollbarEl) return;
    const rect = scrollbarEl.getBoundingClientRect();
    const buf = term.buffer.active;
    const totalLines = buf.baseY + term.rows;
    if (totalLines <= term.rows) return;

    const trackHeight = scrollbarEl.clientHeight;
    const th = Math.max(isMobileDevice ? 44 : 20, (term.rows / totalLines) * trackHeight);
    const trackUsable = trackHeight - th;
    const relativeY = clientY - rect.top - th / 2;
    const ratio = Math.max(0, Math.min(1, relativeY / trackUsable));
    const targetLine = Math.round(ratio * (totalLines - term.rows));
    term.scrollToLine(targetLine);
  }

  function onThumbTouchStart(e: TouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;
    // Note: e.preventDefault() is not called here because Svelte 5 registers
    // ontouchstart as passive. Browser default scroll is already prevented by
    // touch-action: none on .terminal-container via CSS.
    scrollbarDragging = true;
    scrollbarDragStartY = touch.clientY;
    scrollbarDragStartTop = thumbTop;
  }

  export function exitCopyMode() {
    if (inCopyMode) {
      inCopyMode = false;
      onCopyModeChange?.(false);
    }
  }

  function enterSelectionMode() {
    longPressTimer = null;
    contentScrolling = false;
    if (navigator.vibrate) navigator.vibrate(50);

    // tmux sessions: enter tmux copy-mode instead of browser-native selection
    if (useTmux) {
      inCopyMode = true;
      onCopyModeChange?.(true);
      // Ctrl-b [ enters tmux copy-mode
      sendPtyData('\x02[');
      return;
    }

    // Non-tmux fallback: browser-native selection
    selectionMode = true;

    // Enable text selection on xterm screen
    const xtermScreen = containerEl.querySelector('.xterm-screen') as HTMLElement | null;
    if (xtermScreen) {
      xtermScreen.style.userSelect = 'text';
      xtermScreen.style.webkitUserSelect = 'text';
    }

    // Make canvas layers pass-through so touches reach the text layer (.xterm-rows)
    containerEl.querySelectorAll('canvas').forEach((canvas) => {
      (canvas as HTMLElement).style.pointerEvents = 'none';
    });

    // Programmatically select all visible text so the user can adjust handles
    const rows = containerEl.querySelector('.xterm-rows');
    if (rows) {
      const range = document.createRange();
      range.selectNodeContents(rows);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  function exitSelectionMode() {
    selectionMode = false;
    const xtermScreen = containerEl.querySelector('.xterm-screen') as HTMLElement | null;
    if (xtermScreen) {
      xtermScreen.style.userSelect = '';
      xtermScreen.style.webkitUserSelect = '';
    }

    // Restore canvas pointer events
    containerEl.querySelectorAll('canvas').forEach((canvas) => {
      (canvas as HTMLElement).style.pointerEvents = '';
    });

    window.getSelection()?.removeAllRanges();
  }

  function onTerminalTouchStart(e: TouchEvent) {
    if (selectionMode) {
      // Any tap exits selection mode — copy selected text first
      const selectedText = window.getSelection()?.toString() ?? '';
      if (selectedText.trim().length > 0) {
        navigator.clipboard.writeText(selectedText).catch(() => { /* ignore */ });
        if (navigator.vibrate) navigator.vibrate(30);
      }
      exitSelectionMode();
      return;
    }
    // In tmux copy-mode, don't start long-press timer — let normal scroll work
    if (inCopyMode) return;
    if ((e.target as HTMLElement).closest('.terminal-scrollbar')) return;
    if ((e.target as HTMLElement).closest('.scroll-fabs')) return;
    if (!term) return;
    const touch = e.touches[0];
    if (!touch) return;
    contentTouchStartY = touch.clientY;
    contentLastTouchY = touch.clientY;
    contentScrollStartLine = term.buffer.active.viewportY;
    contentTouchMoved = false;
    contentScrollAccumulator = 0;
    contentScrolling = true;
    // Long-press detection
    longPressStartX = touch.clientX;
    longPressStartY = touch.clientY;
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      enterSelectionMode();
    }, LONG_PRESS_MS);
  }

  function onDocumentTouchMove(e: TouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;

    // Scrollbar thumb drag
    if (scrollbarDragging) {
      if (!term || !scrollbarEl) return;
      e.preventDefault();
      const deltaY = touch.clientY - scrollbarDragStartY;
      const buf = term.buffer.active;
      const totalLines = buf.baseY + term.rows;
      if (totalLines <= term.rows) return;
      const trackHeight = scrollbarEl.clientHeight;
      const th = Math.max(44, (term.rows / totalLines) * trackHeight);
      const trackUsable = trackHeight - th;
      const newTop = Math.max(0, Math.min(trackUsable, scrollbarDragStartTop + deltaY));
      const ratio = newTop / trackUsable;
      const targetLine = Math.round(ratio * (totalLines - term.rows));
      term.scrollToLine(targetLine);
      return;
    }

    // Content-area touch scroll
    if (contentScrolling && term && !selectionMode) {
      if (longPressTimer) {
        const moveX = Math.abs(touch.clientX - longPressStartX);
        const moveY = Math.abs(touch.clientY - longPressStartY);
        if (moveX > LONG_PRESS_MOVE_TOLERANCE || moveY > LONG_PRESS_MOVE_TOLERANCE) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }
      if (term.rows === 0 || containerEl.clientHeight === 0) return;
      const deltaY = contentTouchStartY - touch.clientY;
      if (Math.abs(deltaY) > 5) {
        contentTouchMoved = true;
        e.preventDefault();
        const lineHeight = containerEl.clientHeight / term.rows;

        if (term.buffer.active.type === 'alternate') {
          // Alternate screen (tmux, Claude Code, vim, less): send SGR mouse wheel sequences.
          // Use INCREMENTAL delta (since last touchmove), not total delta from touchstart,
          // because we send relative wheel events — total delta would grow quadratically.
          // Wheel events work regardless of whether mouse tracking is enabled — TUI apps
          // that use alternate screen (Claude Code, vim) handle wheel events for scrolling.
          const incrementalDelta = contentLastTouchY - touch.clientY;
          contentLastTouchY = touch.clientY;
          const lineDelta = incrementalDelta / lineHeight;
          contentScrollAccumulator += lineDelta;
          const rawLines = Math.trunc(contentScrollAccumulator);
          if (rawLines !== 0) {
            contentScrollAccumulator -= rawLines;
            // SGR mouse wheel: button 64 = wheel up, 65 = wheel down
            const button = rawLines > 0 ? 65 : 64;
            const col = Math.max(1, Math.round(term.cols / 2));
            const row = Math.max(1, Math.round(term.rows / 2));
            const seq = `\x1b[<${button};${col};${row}M`;
            const count = Math.min(Math.abs(rawLines), 5);
            for (let i = 0; i < count; i++) sendPtyData(seq);
          }
        } else {
          // Normal screen: scroll xterm.js scrollback buffer
          const lineDelta = deltaY / lineHeight;
          const maxScroll = term.buffer.active.baseY;
          const targetLine = Math.max(0, Math.min(maxScroll, Math.round(contentScrollStartLine + lineDelta)));
          term.scrollToLine(targetLine);
        }
      }
    }
  }

  function onDocumentTouchEnd() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    scrollbarDragging = false;
    contentScrolling = false;
    contentTouchMoved = false;
    contentScrollAccumulator = 0;
  }

  function onScrollbarClick(e: MouseEvent) {
    if (e.target === thumbEl) return;
    scrollbarScrollToY(e.clientY);
  }

  function onScrollFabMouseDown(e: MouseEvent) {
    e.preventDefault();
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || !term) return;
    const dir = btn.dataset['dir'];

    if (term.buffer.active.type === 'alternate') {
      // Alternate screen (Claude Code, vim, tmux): send SGR mouse wheel sequences
      // scrollPages/scrollToBottom are no-ops here since baseY=0
      const col = Math.max(1, Math.round(term.cols / 2));
      const row = Math.max(1, Math.round(term.rows / 2));
      if (dir === 'up' || dir === 'down') {
        const button = dir === 'down' ? 65 : 64;
        const seq = `\x1b[<${button};${col};${row}M`;
        // Send enough wheel events to approximate a page scroll
        const count = Math.max(1, Math.round(term.rows / 2));
        for (let i = 0; i < count; i++) sendPtyData(seq);
      } else if (dir === 'bottom') {
        // Send a burst of wheel-down events to jump to bottom
        const seq = `\x1b[<65;${col};${row}M`;
        for (let i = 0; i < term.rows; i++) sendPtyData(seq);
      }
    } else {
      // Normal screen: use xterm.js scrollback
      if (dir === 'up') term.scrollPages(-1);
      else if (dir === 'down') term.scrollPages(1);
      else if (dir === 'bottom') term.scrollToBottom();
    }
  }

  let scrollbarEl: HTMLDivElement;
  let thumbEl: HTMLDivElement;

  // ── Image upload ─────────────────────────────────────────────────────────────

  export async function handleImageUpload(blob: Blob, mimeType: string) {
    if (imageUploadInProgress || !sessionId) return;
    imageUploadInProgress = true;
    onImageUpload?.('Pasting image\u2026', false);

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1]!;
      try {
        const data = await uploadImage(sessionId!, base64, mimeType);
        if (data.clipboardSet) {
          onImageUpload?.('Image pasted', false);
        } else {
          onImageUpload?.(data.path, true, data.path);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Image upload failed';
        onImageUpload?.(msg, false);
      } finally {
        imageUploadInProgress = false;
      }
    };
    reader.readAsDataURL(blob);
  }

  function onContainerPaste(e: ClipboardEvent) {
    if (!e.clipboardData?.items) return;
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        e.stopPropagation();
        const blob = item.getAsFile();
        if (blob) handleImageUpload(blob, item.type);
        return;
      }
    }
  }

  let dragOver = $state(false);

  function onContainerDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      dragOver = true;
    }
  }

  function onContainerDragLeave() {
    dragOver = false;
  }

  function onContainerDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (!e.dataTransfer?.files.length) return;
    const file = e.dataTransfer.files[0]!;
    if (file.type.startsWith('image/')) handleImageUpload(file, file.type);
  }

  // Touch: tap on terminal area to open keyboard (focuses xterm's native textarea)

  function onTerminalTouchEnd(e: TouchEvent) {
    if (scrollbarDragging) return;
    if (contentTouchMoved) return;
    if ((e.target as HTMLElement).closest('.terminal-scrollbar')) return;
    if ((e.target as HTMLElement).closest('.scroll-fabs')) return;
    if (selectionMode) return;
    term?.focus();
    // Suppress synthetic mousedown/click that Android fires after touchend —
    // without this, the browser defocuses the input immediately.
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="terminal-wrapper"
  class:drag-over={dragOver}
  class:selection-mode={selectionMode}
  data-track="terminal.focus"
  ontouchstart={isMobileDevice ? onTerminalTouchStart : undefined}
  ontouchend={isMobileDevice ? onTerminalTouchEnd : undefined}
>
  <div
    class="terminal-container"
    bind:this={containerEl}
    onpaste={onContainerPaste}
    ondragover={onContainerDragOver}
    ondragleave={onContainerDragLeave}
    ondrop={onContainerDrop}
    role="presentation"
  ></div>
  <div
    class="terminal-scrollbar"
    bind:this={scrollbarEl}
    onclick={onScrollbarClick}
    role="scrollbar"
    aria-valuenow={0}
    aria-orientation="vertical"
  >
    <div
      class="terminal-scrollbar-thumb"
      bind:this={thumbEl}
      style:display={thumbVisible ? 'block' : 'none'}
      style:height={thumbHeight + 'px'}
      style:top={thumbTop + 'px'}
      ontouchstart={onThumbTouchStart}
      role="presentation"
    ></div>
  </div>
  {#if isMobileDevice && thumbVisible}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="scroll-fabs" onmousedown={onScrollFabMouseDown}>
      <button class="scroll-fab" data-dir="up" data-track="terminal.scroll-up" aria-label="Page up">&#9650;</button>
      <button class="scroll-fab" data-dir="down" data-track="terminal.scroll-down" aria-label="Page down">&#9660;</button>
      <button class="scroll-fab scroll-fab-bottom" data-dir="bottom" data-track="terminal.scroll-bottom" aria-label="Skip to bottom">&#8615;</button>
    </div>
  {/if}
  {#if !isMobileDevice}
    <div class="zoom-overlay" class:visible={zoomOverlayVisible}>
      {zoomOverlayText}
    </div>
  {/if}
</div>

<style>
  .terminal-wrapper {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  .terminal-container {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: 4px;
  }

  .terminal-wrapper.drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }

  .terminal-scrollbar {
    width: 8px;
    background: transparent;
    position: relative;
    flex-shrink: 0;
  }

  .terminal-scrollbar-thumb {
    position: absolute;
    right: 0;
    width: 6px;
    background: var(--border);
    border-radius: 0;
    cursor: pointer;
  }

  @media (hover: none) {
    .terminal-wrapper.selection-mode .terminal-container {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .terminal-container {
      touch-action: none;
    }
    .terminal-scrollbar {
      width: 12px;
    }
    .terminal-scrollbar-thumb {
      width: 8px;
      min-height: 44px;
    }
    .scroll-fabs {
      position: absolute;
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 1;
      opacity: 0.6;
      pointer-events: auto;
    }
    .scroll-fab {
      width: 44px;
      height: 44px;
      border-radius: 0;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-user-select: none;
      user-select: none;
    }
    .scroll-fab:active {
      opacity: 1;
      background: var(--border);
    }
    .scroll-fab-bottom {
      margin-top: 4px;
    }
  }

  .zoom-overlay {
    position: absolute;
    top: 8px;
    right: 16px;
    background: rgba(255, 255, 255, 0.12);
    color: #d4d4d4;
    font-size: 12px;
    font-family: Menlo, monospace;
    padding: 2px 8px;
    border-radius: 0;
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
    z-index: 2;
  }
  .zoom-overlay.visible {
    opacity: 1;
  }
</style>
