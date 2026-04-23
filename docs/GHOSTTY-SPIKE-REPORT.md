# Spike Report: ghostty-web Compatibility Prototype for Relay Terminal

**Epic:** #250 — Mux-inspired workspace shell + ghostty-web evaluation  
**Spike:** #256 — ghostty-web compatibility prototype for Relay terminal  
**Date:** 2026-04-22  
**Status:** Ready for prototype implementation

---

## Executive Summary

**Recommendation: Dual-support strategy with a phased migration path.**

ghostty-web covers ~70% of Relay's xterm.js API surface out of the box, but three blockers prevent a one-shot swap:

1. **Custom scrollbar breakage** — ghostty-web stubs `buffer.active.viewportY` and `buffer.active.baseY` to `0`, and its own built-in scrollbar conflicts with Relay's custom implementation.
2. **Flow control regression** — `write(data, callback)` fires the callback via `requestAnimationFrame`, not when parsing completes. This breaks Relay's production backpressure system.
3. **Parser sanitizers missing** — No `parser.registerCsiHandler` / `registerOscHandler` surface. Kitty keyboard queries, OSC 66, and DECRQM sanitizers must move upstream.

The pragmatic path is to build an **adapter layer** (`TerminalAdapter`) that abstracts both engines, run both side-by-side in a feature branch, and gate ghostty behind an opt-in flag until the blockers are resolved.

---

## ghostty-web API Surface (from Source Analysis)

Analyzed `coder/ghostty-web` at `main` — `lib/terminal.ts` (1904 lines), `lib/buffer.ts`, `lib/interfaces.ts`.

### Fully Supported (Low Risk)

| Feature | ghostty-web Support | Notes |
|---------|---------------------|-------|
| Constructor options (`cursorBlink`, `fontSize`, `fontFamily`, `scrollback`, `theme`) | ✅ | Direct map |
| `cols`, `rows`, `element`, `textarea` | ✅ | Public properties |
| `open(container)`, `dispose()`, `focus()`, `blur()` | ✅ | Standard lifecycle |
| `write(data)`, `writeln(data)` | ✅ | Direct to WASM |
| `paste(text)`, `reset()`, `clear()` | ✅ | Standard methods |
| `resize(cols, rows)` | ✅ | Native WASM resize |
| `scrollLines(n)`, `scrollPages(n)`, `scrollToTop()`, `scrollToBottom()`, `scrollToLine(n)` | ✅ | Native smooth-scroll |
| `onData`, `onScroll`, `onResize`, `onSelectionChange`, `onKey`, `onTitleChange`, `onBell`, `onCursorMove` | ✅ | Event emitters |
| `attachCustomKeyEventHandler(fn)` | ✅ | Intercepts before input handler |
| `attachCustomWheelEventHandler(fn)` | ✅ | Ghostty-specific addition |
| `registerLinkProvider(provider)` | ✅ | `LinkDetector` system, same shape as xterm.js |
| `loadAddon(addon)` | ✅ | `ITerminalAddon` interface with `activate(term)` / `dispose()` |
| `buffer.active.type` (`'normal'` / `'alternate'`) | ✅ | Queries WASM `isAlternateScreen()` |
| `buffer.active.getLine(y)` → `translateToString()` | ✅ | Wraps WASM `getScrollbackLine()` / `getLine()` |
| `getSelection()`, `hasSelection()`, `clearSelection()`, `selectAll()`, `select()`, `selectLines()`, `getSelectionPosition()` | ✅ | `SelectionManager` |
| `hasMouseTracking()`, `hasBracketedPaste()`, `hasFocusEvents()`, `getMode(n, isAnsi)` | ✅ | WASM mode queries |

### Partially Supported / Changed Semantics (Medium Risk)

| Feature | ghostty-web Support | Notes |
|---------|---------------------|-------|
| `options.fontSize = n` (runtime mutation) | ⚠️ | Uses Proxy, triggers `handleOptionChange`. May not resize renderer immediately without explicit resize call. |
| `term.write(data, callback)` | ⚠️ | **Critical:** Callback is `requestAnimationFrame(callback)`, NOT post-parse. Breaks real backpressure. |
| `onRender` | ⚠️ | Exists but intentionally not fired in render loop to avoid perf issues. Effectively unusable. |

### Unsupported / Missing (High Risk)

| Feature | ghostty-web Support | Impact |
|---------|---------------------|--------|
| `buffer.active.baseY` | ❌ Stubbed to `0` | **Breaks custom scrollbar math** — Relay uses `baseY + rows` as total lines. |
| `buffer.active.viewportY` | ❌ Stubbed to `0` | **Breaks custom scrollbar thumb position** — Relay reads this for thumb top calculation. |
| `term.viewportY` (top-level) | ⚠️ Exists but inverted | ghostty: `0 = bottom`. xterm.js: `0 = top`. Completely different semantics. |
| `parser.registerCsiHandler(...)` | ❌ No `parser` object | **Breaks parser sanitizers** — Kitty keyboard, OSC 66, DECRQM. |
| `parser.registerOscHandler(...)` | ❌ No `parser` object | **Breaks OSC 52 clipboard handler** and OSC 66 sanitizer. |
| `refresh(start, end)` | ❌ Not implemented | Used after session reset/reconnect. Likely a no-op in ghostty anyway. |
| `modes.mouseTrackingMode` | ❌ No `modes` object | Use `hasMouseTracking()` instead. |
| `onWriteParsed` | ❌ Not implemented | Used to update scrollbar after writes. Replace with `onScroll` + RAF fallback. |
| `.xterm-viewport`, `.xterm-screen`, `.xterm-rows` DOM classes | ❌ Canvas-only renderer | **Breaks all mobile DOM patches and selection-mode CSS hacks.** |
| `WebgpuAddon` / `WebLinksAddon` / `FitAddon` | ❌ xterm.js-specific | Ghostty has its own renderer, link detection, and sizing model. |

---

## Blocker Deep-Dives

### Blocker 1: Custom Scrollbar

Relay implements a fully custom scrollbar (`useScrollbar`, `useScrollbarClick`, `useTouchScroll`) that computes thumb position from xterm.js buffer geometry:

```typescript
const totalLines = buf.baseY + term.rows;
const h = Math.max(minThumb, (term.rows / totalLines) * trackHeight);
const t = (buf.viewportY / (totalLines - term.rows)) * (trackHeight - h);
```

**ghostty-web problems:**
- `buffer.active.baseY === 0` always (stub)
- `buffer.active.viewportY === 0` always (stub)
- `term.viewportY` exists but uses **inverted semantics**: `0` means bottom, not top
- ghostty-web has its **own built-in scrollbar** with drag, auto-hide, and fade animations

**Options:**
1. **Drop custom scrollbar, use ghostty native** — simplest, but loses mobile-optimized thumb sizing (44px vs 20px) and scroll-fab buttons.
2. **Bridge via ghostty scroll metrics** — use `getScrollbackLength()` + `viewportY` (with inversion math). Requires rewriting all scrollbar hooks.
3. **Dual scrollbar (avoid)** — ghostty's built-in would fight Relay's.

**Recommendation:** Option 2 for the prototype — rewrite `useScrollbar` to query ghostty's `getScrollbackLength()` and invert `viewportY` semantics. Evaluate whether ghostty's native scrollbar can replace Relay's entirely after user testing.

### Blocker 2: Flow Control Backpressure

Relay's `ws.ts` implements production flow control:

```typescript
term.write(combined, () => {
  pendingSize -= combinedLen;
  if (paused && pendingSize < LOW_WATER_MARK) {
    paused = false;
    scheduleFlush();
  }
});
```

The callback tells Relay when xterm.js has finished parsing/rendering the chunk, enabling backpressure pause/resume.

**ghostty-web's implementation:**

```typescript
// From lib/terminal.ts
if (callback) {
  requestAnimationFrame(callback); // Just fires next frame
}
```

This is **not backpressure** — it fires after one animation frame regardless of whether the WASM parser has caught up. On a fast PTY flood, ghostty-web will call the callback while still parsing, causing unbounded memory growth and UI jank.

**Options:**
1. **Upstream sanitizer + RAF pacing** — Accept the weaker signal. Add a `setTimeout(..., 0)` or RAF-based flush loop in `ws.ts` when running ghostty. Risk: reduced backpressure effectiveness under heavy load.
2. **Ghostty write queue inspection** — ghostty-web has a private `writeQueue: Uint8Array[]`. If we can expose `writeQueue.length` or a `flush()` promise, we can rebuild backpressure. Requires patching ghostty-web or forking.
3. **Hybrid: keep xterm for high-throughput sessions** — Only use ghostty for utility terminals or lighter workloads. Adds complexity.

**Recommendation:** Option 1 for the prototype — implement a `GhosttyWritePacer` that uses `requestAnimationFrame` + `setTimeout` fallback, with a hard queue cap. Document the regression and measure before any default migration.

### Blocker 3: Parser Sanitizers

Relay registers critical CSI/OSC handlers to prevent parser stalls from OpenCode / OpenTUI / Bubble Tea:

```typescript
t.parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => true); // Kitty keyboard
t.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, (params) => {
  sendPtyData(`\x1b[${params[0]};0$y`);
  return true;
}); // DECRQM crash workaround
```

ghostty-web has **no parser hook surface**.

**Options:**
1. **Upstream interceptor in `ws.ts`** — Strip/modify raw PTY data before `term.write()`. For DECRQM, the interceptor must also synthesize responses via `sendPtyData()`.
2. **Ghostty WASM patch** — Patch ghostty's upstream Zig code to handle these sequences natively. Heavy lift, requires Zig toolchain.
3. **Rely on ghostty's robustness** — Ghostty's native parser is more correct than xterm.js. It may already handle Kitty keyboard and DECRQM gracefully. Needs testing.

**Recommendation:** Option 1 for the prototype — build a `PtyDataSanitizer` module that runs before `term.write()`. It regex-filters the three problematic sequences and synthesizes DECRQM responses. This is a clean separation: sanitizer lives in the transport layer, not the renderer.

---

## Prototype Architecture: `TerminalAdapter`

Build a **dual-support adapter** so Relay can run either engine without `#ifdef` soup in the React components.

```typescript
// frontend/src/lib/terminal-adapter/types.ts
export interface ITerminalAdapter {
  readonly cols: number;
  readonly rows: number;
  readonly element?: HTMLElement;
  readonly options: { fontSize: number; /* ... */ };

  // Lifecycle
  open(parent: HTMLElement): void;
  dispose(): void;
  focus(): void;
  reset(): void;

  // I/O
  write(data: string, callback?: () => void): void;
  paste(data: string): void;

  // Sizing
  resize(cols: number, rows: number): void;
  fit(): void; // Adapter computes cols/rows from container

  // Scrolling
  scrollToLine(line: number): void;
  scrollPages(amount: number): void;
  scrollToBottom(): void;

  // Buffer queries
  getTotalLines(): number;
  getViewportLine(): number;
  isAlternateBuffer(): boolean;
  getLineText(y: number): string | undefined;

  // Selection
  enterSelectionMode(): void;
  exitSelectionMode(): void;

  // Events
  onData: IEvent<string>;
  onScroll: IEvent<number>;
  onResize: IEvent<{ cols: number; rows: number }>;

  // Link provider
  registerFilePathProvider(onClick: (path: string) => void): void;

  // Key handling
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
}
```

### Adapter Implementations

```typescript
// frontend/src/lib/terminal-adapter/xterm-adapter.ts
// Thin wrapper around current xterm.js usage. Mostly pass-through.

// frontend/src/lib/terminal-adapter/ghostty-adapter.ts
// Wraps ghostty-web, bridges semantic gaps:
//   - fit() measures container DOM and calls ghostty.resize()
//   - getTotalLines() uses ghostty.getScrollbackLength() + ghostty.rows
//   - getViewportLine() inverts ghostty.viewportY (0=bottom → 0=top)
//   - write() wraps with RAF callback for flow control
//   - registerFilePathProvider() uses ghostty.registerLinkProvider()
//   - enter/exitSelectionMode() uses ghostty's SelectionManager API
```

### Engine Selection

```typescript
// frontend/src/lib/terminal-adapter/index.ts
import { XTermAdapter } from './xterm-adapter.js';
import { GhosttyAdapter } from './ghostty-adapter.js';

export type TerminalEngine = 'xterm' | 'ghostty';

export async function createTerminalAdapter(
  engine: TerminalEngine,
  options: TerminalOptions
): Promise<ITerminalAdapter> {
  if (engine === 'ghostty') {
    const { init } = await import('ghostty-web');
    await init();
    return new GhosttyAdapter(options);
  }
  return new XTermAdapter(options);
}
```

---

## Files to Change

| File | Change |
|------|--------|
| `frontend/src/lib/terminal-adapter/` | **New directory** — types, xterm-adapter, ghostty-adapter, factory |
| `frontend/src/lib/pty-sanitizer.ts` | **New** — upstream CSI/OSC sanitizer (Kitty keyboard, OSC 66, DECRQM) |
| `frontend/src/lib/ws.ts` | Integrate `PtyDataSanitizer`; adapt flow control for ghostty's weak write callback |
| `frontend/src/components/Terminal.tsx` | Replace direct xterm.js imports with `ITerminalAdapter`; rewrite scrollbar hooks to use adapter queries instead of `buffer.active.*` |
| `frontend/src/lib/stores/config.ts` | Add `terminalEngine: 'xterm' \| 'ghostty'` preference |
| `package.json` | Add `ghostty-web` dependency |

---

## Acceptance Criteria for Prototype PR

- [ ] `TerminalAdapter` interface exists with xterm and ghostty implementations
- [ ] Relay builds and passes existing tests with xterm adapter (no regression)
- [ ] Ghostty adapter renders a basic terminal session end-to-end
- [ ] Parser sanitizers run upstream in `ws.ts` and work for both engines
- [ ] Custom scrollbar works with ghostty (using `getScrollbackLength()` + inverted `viewportY`)
- [ ] Flow control uses RAF pacing for ghostty with documented backpressure regression
- [ ] File path link provider works via `registerLinkProvider`
- [ ] Mobile touch scroll reimplemented without `.xterm-*` DOM queries
- [ ] Engine toggle exists in config (default: xterm)
- [ ] Performance benchmark: ghostty vs xterm on a 10k-line `cat` of a large file

---

## Recommendation: migrate, dual-support, or defer?

**Phase 1 (Now): Dual-support with opt-in ghostty**

- Build the adapter layer and ghostty prototype behind a config flag.
- Run it internally for 2–4 weeks on utility terminals and light sessions.
- Measure: rendering performance, memory usage, flow control stability, mobile touch behavior.

**Phase 2 (Decision gate):**

- **If** ghostty performs better AND the three blockers have clean resolutions → default to ghostty, keep xterm as fallback.
- **If** blockers prove intractable (e.g., ghostty never exposes real backpressure) → keep dual-support indefinitely, or defer full migration.
- **If** ghostty regresses on critical paths (mobile selection, heavy PTY output) → document findings and defer.

**Why not one-shot swap:** The flow control regression alone is a production risk. Relay's custom xterm fork has hard-won fixes for real bugs (DECRQM crash, parser stalls). Moving to ghostty without a safety net would be reckless.

**Why not defer entirely:** ghostty-web's grapheme handling, XTPUSHSGR support, and native rendering are genuinely better. The adapter investment is reusable even if ghostty isn't the final answer — it decouples Relay's UI from any single terminal engine.
