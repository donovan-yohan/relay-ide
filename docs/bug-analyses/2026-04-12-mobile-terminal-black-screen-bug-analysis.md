# Bug Analysis: Mobile terminal content invisible — black screen, cursor only

> **Status**: Confirmed | **Date**: 2026-04-12
> **Severity**: High
> **Affected Area**: `frontend/src/components/Terminal.tsx` — WebGPU renderer initialization
> **Issue**: [#236](https://github.com/donovan-yohan/relay-ide/issues/236)

## Symptoms

- Terminal area renders entirely black on Android mobile
- Cursor is visible and positioned correctly
- Typing input works (characters advance the cursor)
- Status bar (`-% [idle]`) is visible at bottom
- All terminal content/output (prompt, command history, Claude Code output) is invisible

## Reproduction Steps

1. Open relay-ide on an Android mobile device (Chrome 121+)
2. Navigate to a terminal running Claude Code
3. Observe the terminal area — black screen with only cursor visible

## Root Cause

The WebGPU renderer addon (`@xterm/addon-webgpu`) is loaded on Android mobile Chrome where it either silently fails to render text or initializes with a non-functional GPU pipeline. The fallback to the DOM renderer never activates because the synchronous initialization succeeds.

### Detailed Trace

The renderer selection logic in `Terminal.tsx:776-799`:

```typescript
// Try WebGPU renderer first, fall back to default DOM renderer
let webgpuAddon: WebgpuAddon | undefined;
if ('gpu' in navigator) {
  // ← truthy on Android Chrome 121+
  try {
    webgpuAddon = new WebgpuAddon();
    t.loadAddon(webgpuAddon); // ← activate() is synchronous — succeeds
    t.open(container); // ← creates DOM element — succeeds
  } catch (e) {
    // Only catches SYNCHRONOUS errors
    webgpuAddon?.dispose();
    webgpuAddon = undefined;
  }
}
if (!t.element) {
  // ← t.element EXISTS — DOM fallback skipped
  t.open(container);
}
```

The WebGPU addon's `activate()` method is synchronous, but it starts `_initializeWebgpu()` asynchronously:

```javascript
async _initializeWebgpu() {
  let t = navigator.gpu;
  let r = await t?.requestAdapter();   // ← async — may return null on mobile
  if (!r) { this._onContextLoss.fire(); return; }
  this._device = await r.requestDevice();
  // ... canvas setup
}
```

**Two failure modes on Android mobile:**

1. **`requestAdapter()` returns null**: The `onContextLoss` handler fires, disposes the addon. But the terminal may not properly restore its DOM renderer after the WebGPU addon has already replaced the render service during `activate()`.

2. **`requestAdapter()` succeeds but rendering silently fails**: WebGPU initializes "successfully" (device created, canvas set up), but the GPU pipeline does not actually paint text to the canvas. Mobile GPU drivers have known issues with WebGPU text rendering. The `onContextLoss` handler never fires because there is no explicit GPU context loss — the context exists, it just produces no visible output.

**Why cursor is visible but text isn't:** In xterm.js with a GPU renderer addon, the cursor is rendered as a DOM element with CSS animation, while text content is rendered on a GPU-accelerated canvas. When the canvas fails to paint, only the text disappears.

**Why status bar is visible:** The status bar is a React component outside of xterm.js, unaffected by the terminal renderer.

**Why input works:** The data flow (keyboard → `sendPtyData()`) is independent of rendering.

## Evidence

- **Commit `ae620c5`** (2026-04-09): Introduced WebGPU renderer addon — 2 days before bug report
- **`Terminal.tsx:778`**: Guard `'gpu' in navigator` — truthy on Android Chrome 121+ (released Jan 2024)
- **`Terminal.tsx:776-792`**: try/catch only catches synchronous errors; async `_initializeWebgpu()` failures are uncaught
- **`Terminal.tsx:790-792`**: DOM fallback checks `!t.element` which is always truthy after `t.open(container)` on line 782
- **WebGPU addon source**: `activate()` sync, `_initializeWebgpu()` async with `await requestAdapter()`
- **No `@xterm/addon-webgpu` in package.json**: Bundled inside custom xterm fork, resolved via Vite alias at `frontend/vite.config.ts:12-14`

## Impact Assessment

- **All mobile users on Android Chrome** are affected — terminal is completely unusable
- Desktop users unaffected (WebGPU likely works correctly with desktop GPU drivers)
- iOS Safari unaffected (`navigator.gpu` does not exist, guard short-circuits)
- Severity is high: terminal is the core interaction surface of relay-ide

## Recommended Fix Direction

**Immediate fix**: Skip WebGPU on mobile devices entirely:

```typescript
if ('gpu' in navigator && !isMobileDevice) {
```

Mobile devices should use the default DOM renderer which works reliably.

**Robust fix**: Add async error handling for WebGPU initialization — even on desktop, the async init can fail. Options:

1. Wrap the addon activation in a timeout that verifies text actually rendered after N ms
2. Use a "canary write" — write a known string, read it back from the buffer, verify the canvas painted it
3. Listen for the addon's internal ready event before committing to the WebGPU renderer

## Architecture Review

### Systemic Spread

None — isolated to this call site. The WebGPU addon is loaded in exactly one place (`Terminal.tsx:776-799`). No other components attempt GPU-accelerated rendering.

### Design Gap

**The `'gpu' in navigator` feature detection is too coarse for renderer selection.** The presence of `navigator.gpu` indicates the browser _exposes_ the WebGPU API, not that the GPU can reliably render a terminal text atlas. Feature detection for GPU rendering should verify actual rendering capability, not just API availability. The current pattern — sync try/catch around async initialization with a "check element exists" fallback — structurally cannot catch async or silent rendering failures.

A better design would be:

1. **Device-class gating**: Skip GPU renderers on mobile entirely (mobile GPUs are a different capability tier)
2. **Verified initialization**: After loading the addon, verify that a test frame actually painted visible content before committing to the renderer
3. **Async-aware fallback**: The fallback decision must happen after the async initialization completes, not based on synchronous state

### Testing Gaps

- **Missing test cases**: No test verifies renderer fallback behavior. A test that mocks `navigator.gpu` as present but `requestAdapter()` returning null would catch failure mode 1. A test that verifies terminal content is visible after initialization would catch failure mode 2.
- **Infrastructure gaps**: No e2e tests run on mobile viewports or with mobile user agents. The existing `test/e2e/components/Terminal.spec.ts` does not test renderer selection. There are zero tests for the WebGPU addon integration despite it being a new feature added 2 days prior.

### Harness Context Gaps

- **ARCHITECTURE.md** mentions "xterm.js renders output in browser" (line 114) but says nothing about the WebGPU renderer, the fallback chain, or mobile rendering behavior
- **FRONTEND.md** does not mention the WebGPU addon, Vite alias for `@xterm/addon-webgpu`, or the custom xterm fork
- **CLAUDE.md** does not mention the custom xterm.js fork or its implications for terminal rendering
- No documentation captures the renderer selection strategy or its mobile limitations

## Harness Trace

Insufficient run history — harness trace unavailable. The `.harness/` runtime directory does not exist in this repository.
