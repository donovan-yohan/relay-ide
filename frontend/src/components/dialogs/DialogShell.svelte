<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    variant?: 'fullscreen' | 'compact';
    width?: string;
    title: string;
    children: Snippet;
    'header-extra'?: Snippet;
    footer?: Snippet;
  }

  let {
    variant = 'compact',
    width = '460px',
    title,
    children,
    'header-extra': headerExtra,
    footer,
  }: Props = $props();

  let dialogEl = $state<HTMLDialogElement | undefined>(undefined);
  let scrolledBottom = $state(false);

  function onBodyScroll(e: Event) {
    const el = e.target as HTMLElement;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    const noOverflow = el.scrollHeight <= el.clientHeight;
    scrolledBottom = atBottom || noOverflow;
  }

  export function open() {
    if (!dialogEl) return;
    dialogEl.showModal();
    // Focus first interactive element and check scroll state after the dialog opens
    requestAnimationFrame(() => {
      if (!dialogEl) return;
      const firstFocusable = dialogEl.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
      // Check if content fits without scrolling
      const body = dialogEl.querySelector('.dialog-shell__body');
      if (body) {
        scrolledBottom = body.scrollHeight <= body.clientHeight;
      }
    });
  }

  export function close() {
    dialogEl?.close();
  }

  function onDialogClick(e: MouseEvent) {
    if (e.target === dialogEl) {
      dialogEl?.close();
    }
  }
</script>

<dialog
  bind:this={dialogEl}
  class="dialog-shell"
  class:dialog-shell--fullscreen={variant === 'fullscreen'}
  class:dialog-shell--compact={variant === 'compact'}
  style={variant === 'compact' ? `--dialog-width: ${width}` : undefined}
  onclick={onDialogClick}
  aria-modal="true"
  aria-label={title}
>
  <div class="dialog-shell__content">
    <header class="dialog-shell__header">
      <h2 class="dialog-shell__title">{title}</h2>
      {#if headerExtra}
        <div class="dialog-shell__header-extra">
          {@render headerExtra()}
        </div>
      {/if}
      <button
        class="dialog-shell__close"
        onclick={() => dialogEl?.close()}
        aria-label="Close"
        type="button"
      ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </header>

    <div class="dialog-shell__body" class:scrolled-bottom={scrolledBottom} onscroll={onBodyScroll}>
      {@render children()}
    </div>

    {#if footer}
      <footer class="dialog-shell__footer">
        {@render footer()}
      </footer>
    {/if}
  </div>
</dialog>

<style>
  /* ── Backdrop ── */
  .dialog-shell::backdrop {
    background: rgba(0, 0, 0, 0.6);
  }

  /* ── Base dialog ── */
  .dialog-shell {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 0;
    overflow: hidden;
  }

  /* ── Compact variant ── */
  .dialog-shell--compact {
    width: min(var(--dialog-width, 460px), 95vw);
    max-height: 90vh;
  }

  .dialog-shell--compact[open] {
    animation: dialog-fade-scale 150ms ease forwards;
  }

  @keyframes dialog-fade-scale {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  /* ── Fullscreen variant ── */
  /* Mobile: true full-screen */
  .dialog-shell--fullscreen {
    width: 100vw;
    height: 100vh;
    max-width: 100vw;
    max-height: 100vh;
  }

  /* Desktop: centered ~75% modal */
  @media (min-width: 601px) {
    .dialog-shell--fullscreen {
      width: 75vw;
      height: 80vh;
      max-width: 960px;
      max-height: none;
    }
  }

  .dialog-shell--fullscreen[open] {
    animation: dialog-slide-up 200ms ease forwards;
  }

  @keyframes dialog-slide-up {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* ── Inner content layout ── */
  .dialog-shell__content {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    position: relative;
  }

  .dialog-shell--compact .dialog-shell__content {
    max-height: 90vh;
  }

  /* ── Header ── */
  .dialog-shell__header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .dialog-shell__title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    margin: 0;
    flex-shrink: 0;
  }

  .dialog-shell__header-extra {
    flex: 1;
    min-width: 0;
  }

  .dialog-shell__close {
    background: none;
    border: none;
    border-radius: 0;
    color: var(--text-muted);
    font-size: var(--font-size-lg);
    font-family: var(--font-mono);
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
    flex-shrink: 0;
    margin-left: auto;
    transition: background 0.1s, color 0.1s;
  }

  .dialog-shell__close:hover {
    background: var(--border);
    color: var(--text);
  }

  /* ── Body ── */
  .dialog-shell__body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .dialog-shell--fullscreen .dialog-shell__body {
    padding: 0;
    max-width: none;
    width: 100%;
    box-sizing: border-box;
  }

  /* Scroll fade indicator — subtle gradient at bottom when content overflows */
  .dialog-shell__body {
    mask-image: linear-gradient(to bottom, black calc(100% - 24px), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 24px), transparent 100%);
  }

  /* Remove fade when scrolled to bottom (JS toggles this class) */
  .dialog-shell__body.scrolled-bottom {
    mask-image: none;
    -webkit-mask-image: none;
  }

  /* ── Footer ── */
  .dialog-shell__footer {
    padding: 12px 20px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  :global(.dialog-shell .error-msg) {
    font-size: var(--font-size-sm);
    color: var(--status-error);
    margin: 0;
  }
</style>
