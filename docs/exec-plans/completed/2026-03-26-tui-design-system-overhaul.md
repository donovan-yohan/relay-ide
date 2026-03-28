# TUI Design System Overhaul

> **Status**: Active | **Created**: 2026-03-26 | **Last Updated**: 2026-03-26
> **Design Doc**: `docs/design-docs/2026-03-25-tui-design-system-overhaul-design.md`
> **Consulted Learnings**: L-20260323-tanstack-query-untrack, L-20260325-dual-mobile-mechanism
> **For Claude:** Use /harness:orchestrate to execute this plan.

**Goal:** Build a TUI-native component library (9 new primitives) that replaces duplicated patterns, adds terminal micro-interactions, and enforces alignment through architecture — not discipline.

**Architecture:** New Svelte 5 primitives compose bottom-up: tokens (app.css) → primitives (TuiButton, CipherText, etc.) → composites (IntegrationRow) → consumers (existing components). Each phase is independently safe. All animations CSS-only or lightweight JS, all under 400ms, all respect `prefers-reduced-motion`.

**Tech Stack:** Svelte 5 (runes), CSS custom properties, Unicode box-drawing characters, ResizeObserver, `node:test` for logic tests (per ADR-005).

---

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-25 | Design | All lowercase labels, 0px border-radius, outline-only buttons | TUI-native terminal aesthetic |
| 2026-03-25 | Design | Box-drawing button corners with double-line hover | Most distinctive visual change — no other web app does this |
| 2026-03-25 | Design | Cipher-decode replaces skeleton loading | Terminal-native loading pattern vs generic gray bars |
| 2026-03-26 | Eng Review | Keep dropdowns separate, share TuiMenuPanel + TuiMenuItem | Different positioning/selection/async behavior; visual-only primitives prevent drift without coupling |
| 2026-03-26 | Eng Review | TuiRow layout primitive enforces alignment | Structural enforcement vs CSS utilities that can be forgotten |
| 2026-03-26 | Eng Review | CipherText is smart (loading prop) | Encapsulates lifecycle, matches TanStack Query isLoading pattern |
| 2026-03-26 | Codex | Tests use node:test not Vitest | ADR-005 mandates Node built-in test runner |
| 2026-03-26 | Codex | Skip .btn bridge, go straight to TuiButton | Avoid touching same surfaces twice |
| 2026-03-26 | Codex | TuiMenuItem uses onmousedown not onclick | Preserves dropdown blur timing |
| 2026-03-26 | Codex | TuiButton/TuiInput forward attributes via {...rest} | Existing buttons use aria-*, title, data-track |
| 2026-03-26 | Codex | StatusDot variants match display-state.ts model | Real states: initializing, unseen-idle, seen-idle, permission, inactive |
| 2026-03-26 | Codex | TuiInput rollout: PinGate first (simplest) | Don't test custom cursor hack on fragile popover inputs first |

## Progress

- [x] Task 1: Layout tokens and spacing scale in app.css _(completed 2026-03-26)_
- [x] Task 2: Font-size normalization (20 files) _(completed 2026-03-26)_
- [x] Task 3: Fix hardcoded colors and debug values _(completed 2026-03-26)_
- [x] Task 4: TuiButton component _(completed 2026-03-26)_
- [x] Task 5: TuiRow layout primitive _(completed 2026-03-26)_
- [x] Task 6: TuiMenuPanel + TuiMenuItem primitives _(completed 2026-03-26)_
- [x] Task 7: CipherText component _(completed 2026-03-26)_
- [x] Task 8: MarqueeText component _(completed 2026-03-26)_
- [x] Task 9: TuiInput component _(completed 2026-03-26)_
- [x] Task 10: TuiProgress component _(completed 2026-03-26)_
- [x] Task 11: IntegrationRow component _(completed 2026-03-26)_
- [x] Task 12: StatusDot variant extension _(completed 2026-03-26)_
- [x] Task 13: TuiButton adoption (dialogs) _(completed 2026-03-26)_
- [x] Task 14: TuiButton adoption (dashboards + toolbar) _(completed 2026-03-26)_
- [x] Task 15: CipherText adoption _(completed 2026-03-26)_
- [x] Task 16: StatusDot consolidation _(completed 2026-03-26)_
- [x] Task 17: IntegrationRow adoption _(completed 2026-03-26)_
- [x] Task 18: MarqueeText + TuiInput adoption _(completed 2026-03-26)_
- [x] Task 19: TuiMenuItem adoption in dropdowns _(completed 2026-03-26)_
- [x] Task 20: CRT scanline overlay _(completed 2026-03-26)_
- [x] Task 21: Padding normalization to 4px grid _(completed 2026-03-26)_

## Surprises & Discoveries

_None yet — updated during execution by /harness:orchestrate._

## Plan Drift

_None yet — updated when tasks deviate from plan during execution._

---

### Task 1: Layout tokens and spacing scale in app.css

**Files:**
- Modify: `frontend/src/app.css`

- [ ] **Step 1: Add layout alignment tokens**

Add after existing `:root` variables in app.css:

```css
/* Alignment architecture */
--sidebar-padding-x: 16px;
--content-padding-x: 20px;
--row-padding-y: 10px;
--icon-slot-width: 24px;
--action-slot-width: 36px;
--row-min-height: 44px;

/* Spacing scale (4px grid) */
--space-2xs: 2px;
--space-xs: 4px;
--space-sm: 8px;
--space-md: 16px;
--space-lg: 24px;
--space-xl: 32px;
--space-2xl: 48px;
```

- [ ] **Step 2: Build verify**

Run: `npm run build`
Expected: PASS (CSS-only change)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app.css
git commit -m "feat(design): add layout alignment tokens and spacing scale to app.css"
```

---

### Task 2: Font-size normalization (20 files)

**Files:** ~20 component files with hardcoded rem values

Mapping:
- `0.55-0.75rem` → `var(--font-size-xs)` (0.75rem)
- `0.8-0.88rem` → `var(--font-size-sm)` (0.8125rem)
- `0.875-0.95rem` → `var(--font-size-base)` (0.875rem)
- `1.0-1.5rem` → `var(--font-size-lg)` (1rem)

- [ ] **Step 1: Grep for all hardcoded font-sizes**

Run: `grep -rn "font-size:.*rem" frontend/src/components/ | grep -v "var(--font-size"` to get the full list.

- [ ] **Step 2: Replace in each file**

For each match, replace the hardcoded value with the nearest CSS variable per the mapping above. Use judgment: `0.65rem` for tiny metadata → `var(--font-size-xs)`. `0.88rem` for body text → `var(--font-size-sm)`.

- [ ] **Step 3: Build verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/
git commit -m "refactor(design): normalize all hardcoded font-sizes to CSS variable scale"
```

---

### Task 3: Fix hardcoded colors and debug values

**Files:**
- Modify: `frontend/src/components/WorkspaceItem.svelte` (replace `#555` → `var(--border)`)
- Modify: `frontend/src/components/MobileInput.svelte` (remove `#0f0` debug border)

- [ ] **Step 1: Fix WorkspaceItem**

Search for `#555` in WorkspaceItem.svelte, replace with `var(--border)`.

- [ ] **Step 2: Fix MobileInput**

Search for `#0f0` in MobileInput.svelte, replace with `var(--border)` or remove the debug border entirely.

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add frontend/src/components/WorkspaceItem.svelte frontend/src/components/MobileInput.svelte
git commit -m "fix(design): remove hardcoded border colors and debug values"
```

---

### Task 4: TuiButton component

**Files:**
- Create: `frontend/src/components/TuiButton.svelte`

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    variant = 'primary',
    size = 'default',
    disabled = false,
    type = 'button',
    href,
    onclick,
    children,
    ...rest
  }: {
    variant?: 'primary' | 'ghost' | 'danger' | 'success' | 'info';
    size?: 'default' | 'sm';
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    href?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
    [key: string]: unknown;
  } = $props();

  let hovered = $state(false);

  const corners = $derived(hovered && !disabled
    ? { tl: '\u2554', tr: '\u2557', bl: '\u255A', br: '\u255D' }
    : { tl: '\u250C', tr: '\u2510', bl: '\u2514', br: '\u2518' }
  );
</script>

{#if href && !disabled}
  <a
    class="tui-btn tui-btn--{variant}"
    class:tui-btn--sm={size === 'sm'}
    {href}
    onmouseenter={() => hovered = true}
    onmouseleave={() => hovered = false}
    {...rest}
  >
    <span class="tui-btn__left"><span>{corners.tl}</span><span>{corners.bl}</span></span>
    <span class="tui-btn__inner" class:double={hovered}>{@render children()}</span>
    <span class="tui-btn__right"><span>{corners.tr}</span><span>{corners.br}</span></span>
  </a>
{:else}
  <button
    class="tui-btn tui-btn--{variant}"
    class:tui-btn--sm={size === 'sm'}
    {disabled}
    {type}
    {onclick}
    onmouseenter={() => hovered = true}
    onmouseleave={() => hovered = false}
    {...rest}
  >
    <span class="tui-btn__left"><span>{corners.tl}</span><span>{corners.bl}</span></span>
    <span class="tui-btn__inner" class:double={hovered}>{@render children()}</span>
    <span class="tui-btn__right"><span>{corners.tr}</span><span>{corners.br}</span></span>
  </button>
{/if}

<style>
  .tui-btn {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: none;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    cursor: pointer;
    padding: 0;
    line-height: 1;
    text-decoration: none;
    color: inherit;
  }

  .tui-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tui-btn__inner {
    padding: 6px 14px;
    border-top: 1px solid currentColor;
    border-bottom: 1px solid currentColor;
    transition: background 0.12s;
  }

  .tui-btn__inner.double {
    border-top-style: double;
    border-bottom-style: double;
  }

  .tui-btn__left, .tui-btn__right {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    user-select: none;
    line-height: 1;
    font-size: 0.9em;
  }

  .tui-btn__left { margin-right: -1px; }
  .tui-btn__right { margin-left: -1px; }

  .tui-btn:hover:not(:disabled) .tui-btn__inner {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }

  .tui-btn--sm .tui-btn__inner { padding: 3px 10px; font-size: var(--font-size-xs); }

  /* Variant colors */
  .tui-btn--primary { color: var(--accent); }
  .tui-btn--ghost { color: var(--text-muted); }
  .tui-btn--danger { color: color-mix(in srgb, var(--status-error) 70%, transparent); }
  .tui-btn--danger:hover { color: var(--status-error); }
  .tui-btn--success { color: var(--status-success); }
  .tui-btn--info { color: var(--status-info); }

  @media (prefers-reduced-motion: reduce) {
    .tui-btn__inner { transition: none; }
  }
</style>
```

- [ ] **Step 2: Build verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/TuiButton.svelte
git commit -m "feat(design): add TuiButton with box-drawing corners and double-line hover"
```

---

### Task 5: TuiRow layout primitive

**Files:**
- Create: `frontend/src/components/TuiRow.svelte`

- [ ] **Step 1: Create the component**

Enforces `|-- padding --|-- icon (24px) --|-- content (flex:1) --|-- action (36px) --|-- padding --|` grid.

Props: `icon?: Snippet`, `action?: Snippet`, `children: Snippet`, `onclick?: (e: MouseEvent) => void`, `minHeight?: string`, `paddingX?: string`, `class?: string`

Omitted icon/action slots still reserve their width (alignment consistency). Content fills remaining space with `min-width: 0` (enables text truncation).

- [ ] **Step 2: Build verify + commit**

---

### Task 6: TuiMenuPanel + TuiMenuItem primitives

**Files:**
- Create: `frontend/src/components/TuiMenuPanel.svelte`
- Create: `frontend/src/components/TuiMenuItem.svelte`

- [ ] **Step 1: TuiMenuPanel**

Simple container: `border: 1px solid var(--border); background: var(--surface); padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.4)`. Parent handles positioning.

- [ ] **Step 2: TuiMenuItem**

Props: `danger?: boolean`, `disabled?: boolean`, `onmousedown?: (e: Event) => void`, `icon?: Snippet`, `children: Snippet`. Uses `onmousedown` (not onclick) to preserve dropdown blur timing. Built-in fzf `>` cursor: `transform: translateX(-6px); opacity: 0` → on hover: `translateX(0); opacity: 1` with 120ms ease-out.

- [ ] **Step 3: Build verify + commit**

---

### Task 7: CipherText component

**Files:**
- Create: `frontend/src/components/CipherText.svelte`

- [ ] **Step 1: Create the component**

Props: `text: string`, `loading?: boolean`, `duration?: number` (default 400), `animate?: boolean` (default true).

Smart loading lifecycle:
- `loading=true`: cycle random ASCII glyphs matching text length at 40ms intervals
- `loading` → `false`: resolve left-to-right at ~10ms/char
- `text` changes while `loading=false` and `animate=true`: scramble old → resolve new (~200-300ms)
- `prefers-reduced-motion`: instant, no animation
- `aria-live="polite"` for screen reader accessibility (Codex fix #9)

Uses `$effect` with cleanup for interval management. Per L-20260323-tanstack-query-untrack: be careful with reactive proxy interactions in effects.

Glyph set: `!@#$%^&*()_+-=[]{}|;:,.<>?/~\`0123456789abcdef`

- [ ] **Step 2: Build verify + commit**

---

### Task 8: MarqueeText component

**Files:**
- Create: `frontend/src/components/MarqueeText.svelte`

- [ ] **Step 1: Create the component**

Props: `speed?: number` (default 50 px/sec), `fadeWidth?: number` (default 24px), `overscroll?: number` (default 32px), `children: Snippet`.

Uses `ResizeObserver` in `$effect` to detect overflow (`scrollWidth - clientWidth`). On hover: CSS `transition` on `transform: translateX(-${overflow + overscroll}px)`. On leave: animate back to `translateX(0)`. Trailing fade via `mask-image: linear-gradient(...)`. Per L-20260325-dual-mobile-mechanism: use CSS-only for hover detection, no JS matchMedia for mobile.

- [ ] **Step 2: Build verify + commit**

---

### Task 9: TuiInput component

**Files:**
- Create: `frontend/src/components/TuiInput.svelte`

- [ ] **Step 1: Create the component**

Props: `value?: string`, `placeholder?: string`, `type?: 'text' | 'password'`, `disabled?: boolean`, `id?: string`, `oninput?`, `onkeydown?`, `{...rest}` for attribute forwarding (Codex fix #7).

Native `<input>` with `caret-color: transparent`. Block cursor `█` overlay: positioned via text width measurement using hidden `<span>`. Wrapper has `overflow: hidden` (Codex cursor escape fix). Solid while typing, blinks after 530ms idle. `prefers-reduced-motion`: no blink.

- [ ] **Step 2: Build verify + commit**

---

### Task 10: TuiProgress component

**Files:**
- Create: `frontend/src/components/TuiProgress.svelte`

- [ ] **Step 1: Create the component**

Props: `variant?: 'bar' | 'knight-rider' | 'braille' | 'line'`, `value?: number` (0-100 for bar), `width?: number` (char width, default 16).

Variants:
- `bar`: `[████████░░░░░░░░] 52%` using `\u2588` and `\u2591`
- `knight-rider`: bouncing block, 60ms interval
- `braille`: `\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F` at 80ms
- `line`: `| / - \` at 120ms

All interval-based variants clean up via `$effect` return. `prefers-reduced-motion`: static first frame.

- [ ] **Step 2: Build verify + commit**

---

### Task 11: IntegrationRow component

**Files:**
- Create: `frontend/src/components/dialogs/integrations/IntegrationRow.svelte`

- [ ] **Step 1: Create the component**

Props: `name: string`, `statusText: string`, `connected: boolean`, `loading?: boolean`, `expanded?: boolean`, `onToggle?: () => void`, `headerActions?: Snippet`, `children: Snippet`.

Composes: `<StatusDot>` for indicator, `<CipherText>` for status text, CSS grid transition (`grid-template-rows: 0fr → 1fr`) for accordion. Uses TuiRow for alignment.

- [ ] **Step 2: Build verify + commit**

---

### Task 12: StatusDot variant extension

**Files:**
- Modify: `frontend/src/components/StatusDot.svelte`
- Read: `frontend/src/lib/state/display-state.ts` (for real state model)

- [ ] **Step 1: Read display-state.ts for actual session states**

Map actual display states to StatusDot variants (Codex fix #5):
- `initializing` → pulsing muted dot
- `unseen-idle` → blue (info)
- `seen-idle` → muted border-only
- `permission` / `permission-prompt` → yellow (warning) with pulse
- `inactive` → transparent with border
- `running` → green (success)
- `connected` → green (for integration cards)
- `disconnected` → border-only (for integration cards)

- [ ] **Step 2: Add variants to StatusDot.svelte + commit**

---

### Task 13: TuiButton adoption — dialogs (~8 files)

**Files:**
- Modify: `frontend/src/components/dialogs/DialogShell.svelte` (remove `:global(.btn*)` CSS)
- Modify: `frontend/src/components/dialogs/WorkspaceSettingsDialog.svelte`
- Modify: `frontend/src/components/StartWorkModal.svelte`
- Modify: `frontend/src/components/StatusMappingModal.svelte`
- Modify: `frontend/src/components/dialogs/DeleteWorktreeDialog.svelte`
- Modify: `frontend/src/components/dialogs/CustomizeSessionDialog.svelte`
- Modify: `frontend/src/components/dialogs/AddWorkspaceDialog.svelte`
- Modify: `frontend/src/components/dialogs/RenameWarningModal.svelte`

- [ ] **Step 1: Replace all `<button class="btn ...">` with `<TuiButton variant="...">`**

Import TuiButton. Replace each button. Remove local `.btn` CSS definitions. Remove DialogShell's `:global(.btn*)` rules.

- [ ] **Step 2: Build verify + visual check + commit**

---

### Task 14: TuiButton adoption — dashboards + toolbar (~7 files)

**Files:**
- Modify: `frontend/src/components/RepoDashboard.svelte` (`.pr-action-pill`, `.cta-btn`)
- Modify: `frontend/src/components/OrgDashboard.svelte` (`.pr-action-pill`)
- Modify: `frontend/src/components/PrTopBar.svelte` (`.action-btn`)
- Modify: `frontend/src/components/Toolbar.svelte` (`.tb-enter`)
- Modify: `frontend/src/components/Sidebar.svelte` (`.add-workspace-btn`)
- Modify: `frontend/src/components/EmptyState.svelte`
- Modify: `frontend/src/components/ImageToast.svelte`
- Modify: `frontend/src/components/UpdateToast.svelte`

- [ ] **Step 1: Replace all button patterns with TuiButton + remove local CSS**
- [ ] **Step 2: Build verify + commit**

---

### Task 15: CipherText adoption (~6 files)

**Files:**
- Modify: `frontend/src/components/SessionItem.svelte` (replace shimmer overlay)
- Modify: `frontend/src/components/dialogs/integrations/JiraIntegration.svelte` (replace skeleton bars)
- Modify: `frontend/src/components/dialogs/integrations/GitHubIntegration.svelte` (replace "Loading...")
- Modify: `frontend/src/components/dialogs/integrations/WebhookIntegration.svelte` (replace "Loading...")
- Modify: `frontend/src/components/PrTopBar.svelte` (replace "..." ellipsis)
- Modify: `frontend/src/components/BranchSwitcher.svelte` (replace "Loading...")
- Modify: `frontend/src/app.css` (NOW remove `.skeleton-line` + `skeleton-pulse` — safe after consumers replaced)

- [ ] **Step 1: Replace loading patterns with CipherText in each file**
- [ ] **Step 2: Remove skeleton CSS from app.css (Codex fix #1 — sequencing)**
- [ ] **Step 3: Build verify + commit**

---

### Task 16: StatusDot consolidation (~5 files)

**Files:**
- Modify: `frontend/src/components/SessionItem.svelte` (remove local `.status-dot` CSS, use StatusDot component)
- Modify: `frontend/src/components/dialogs/integrations/GitHubIntegration.svelte`
- Modify: `frontend/src/components/dialogs/integrations/WebhookIntegration.svelte`
- Modify: `frontend/src/components/dialogs/integrations/JiraIntegration.svelte`
- Modify: `frontend/src/components/TicketCard.svelte` (remove local `.dot` CSS)

- [ ] **Step 1: Import StatusDot and replace all local dot implementations**
- [ ] **Step 2: Build verify + commit**

---

### Task 17: IntegrationRow adoption (3 files)

**Files:**
- Modify: `frontend/src/components/dialogs/integrations/GitHubIntegration.svelte`
- Modify: `frontend/src/components/dialogs/integrations/WebhookIntegration.svelte`
- Modify: `frontend/src/components/dialogs/integrations/JiraIntegration.svelte`

- [ ] **Step 1: Refactor each integration to use IntegrationRow**

Keep integration-specific logic (device flow, webhook URL, Jira config). Move shared accordion/header/status structure to IntegrationRow. Remove duplicated CSS.

- [ ] **Step 2: Build verify + visual check + commit**

---

### Task 18: MarqueeText + TuiInput adoption

**Files:**
- Modify: `frontend/src/components/SessionItem.svelte` (MarqueeText for session name)
- Modify: `frontend/src/components/PinGate.svelte` (TuiInput — Codex fix: start with simplest)
- Modify: `frontend/src/components/Spotlight.svelte` (TuiInput for search)
- Modify: `frontend/src/lib/actions.ts` (deprecate/remove `scrollOnHover`)

- [ ] **Step 1: Wrap session names in MarqueeText, replace scrollOnHover**
- [ ] **Step 2: Replace PinGate input with TuiInput (simplest first — Codex fix #8)**
- [ ] **Step 3: Replace Spotlight search input with TuiInput**
- [ ] **Step 4: Build verify + commit**

---

### Task 19: TuiMenuItem adoption in dropdowns (4 files)

**Files:**
- Modify: `frontend/src/components/ContextMenu.svelte`
- Modify: `frontend/src/components/BranchSwitcher.svelte`
- Modify: `frontend/src/components/SearchableSelect.svelte`
- Modify: `frontend/src/components/TargetBranchSwitcher.svelte` (Codex fix #4 — was missing)

- [ ] **Step 1: Replace menu item rendering with TuiMenuItem in each dropdown**

Import TuiMenuPanel + TuiMenuItem. Replace `.context-menu-item` / `.branch-option` / `.ss-option` with TuiMenuItem. Preserve existing positioning and selection logic. FZF `>` cursor comes built-in via TuiMenuItem.

- [ ] **Step 2: Build verify + visual check + commit**

---

### Task 20: CRT scanline overlay on Sidebar

**Files:**
- Modify: `frontend/src/components/Sidebar.svelte`

- [ ] **Step 1: Add scanline overlay**

Add `<div class="scanline-overlay">` with continuously drifting scanline pattern (8s cycle, opacity 0.02-0.03). Slow sweep on workspace item hover (800ms). `prefers-reduced-motion`: disabled.

- [ ] **Step 2: Build verify + commit**

---

### Task 21: Padding normalization to 4px grid

**Files:** ~30 component files

- [ ] **Step 1: Audit all padding/gap values**

Grep for non-4px-grid values. Map: 3px→4px, 5px→4px, 6px→8px, 7px→8px, 9px→8px, 10px→8px or 12px, 14px→12px or 16px, 18px→16px or 20px.

- [ ] **Step 2: Apply fixes file by file, visually verifying each**
- [ ] **Step 3: Build verify + commit**

---

## Deliverable Traceability

| Design Doc Deliverable | Plan Task |
|----------------------|-----------|
| 1. Layout tokens in app.css | Task 1 |
| 2. Global button CSS (extracted from DialogShell) | Task 13 (remove during TuiButton adoption, skip bridge — Codex) |
| 3. Font-size normalization | Task 2 |
| 4. TuiButton component | Task 4 |
| 5. TuiRow layout primitive | Task 5 |
| 6. TuiMenuPanel + TuiMenuItem | Task 6 |
| 7. CipherText component | Task 7 |
| 8. MarqueeText component | Task 8 |
| 9. TuiInput component | Task 9 |
| 10. TuiProgress component | Task 10 |
| 11. IntegrationRow component | Task 11 |
| 12. StatusDot extended variants | Task 12 |
| 13. TuiButton adopted across consumers | Tasks 13-14 |
| 14. CipherText adopted across consumers | Task 15 |
| 15. StatusDot consolidated | Task 16 |
| 16. IntegrationRow adopted | Task 17 |
| 17. MarqueeText adopted in SessionItem | Task 18 |
| 18. TuiInput adopted | Task 18 |
| 19. FZF cursor via TuiMenuItem | Task 19 |
| 20. CRT scanline overlay | Task 20 |
| 21. Alignment audit using TuiRow | Task 5 + Tasks 13-19 (TuiRow used during adoption) |
| 22. Padding normalization | Task 21 |
| 23. Logic tests (node:test) | Deferred — Codex noted ADR conflict; tests written inline with components if testable logic exists |

---

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
-

**What didn't:**
-

**Learnings to codify:**
-
