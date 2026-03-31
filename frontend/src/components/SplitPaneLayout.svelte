<script lang="ts">
  import { getUi, saveRightSidebarWidth, saveFileViewerRatio, COLLAPSED_RIGHT_SIDEBAR_WIDTH, MIN_RIGHT_SIDEBAR_WIDTH, MAX_RIGHT_SIDEBAR_WIDTH } from '../lib/state/ui.svelte.js';
  import type { Snippet } from 'svelte';

  let {
    terminal,
    fileViewer,
    rightSidebar,
  }: {
    terminal: Snippet;
    fileViewer: Snippet;
    rightSidebar: Snippet;
  } = $props();

  const ui = getUi();

  const MIN_TERMINAL_WIDTH = 300;
  const MIN_FILE_VIEWER_WIDTH = 300;

  // ── Resize state ──
  let dragging = $state<'right-sidebar' | 'file-viewer' | null>(null);
  let containerEl = $state<HTMLDivElement | undefined>();

  // Whether file viewer is open (has open tabs)
  let fileViewerOpen = $derived(ui.openFileTabs.length > 0);

  // Right sidebar effective width
  let rightSidebarEffectiveWidth = $derived(
    ui.rightSidebarCollapsed ? COLLAPSED_RIGHT_SIDEBAR_WIDTH : ui.rightSidebarWidth
  );

  function handlePointerDown(handle: 'right-sidebar' | 'file-viewer', e: PointerEvent): void {
    e.preventDefault();
    dragging = handle;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!dragging || !containerEl) return;
    const rect = containerEl.getBoundingClientRect();

    if (dragging === 'right-sidebar') {
      const rightEdge = rect.right;
      const newRightWidth = rightEdge - e.clientX;
      const clamped = Math.max(MIN_RIGHT_SIDEBAR_WIDTH, Math.min(MAX_RIGHT_SIDEBAR_WIDTH, newRightWidth));
      ui.rightSidebarWidth = clamped;
    } else if (dragging === 'file-viewer') {
      // Available space = container width - right sidebar
      const available = rect.width - rightSidebarEffectiveWidth;
      const fileViewerWidth = rect.right - rightSidebarEffectiveWidth - e.clientX;
      const terminalWidth = e.clientX - rect.left;

      if (terminalWidth < MIN_TERMINAL_WIDTH || fileViewerWidth < MIN_FILE_VIEWER_WIDTH) return;

      ui.fileViewerRatio = fileViewerWidth / available;
    }
  }

  function handlePointerUp(): void {
    if (dragging === 'right-sidebar') {
      saveRightSidebarWidth();
    } else if (dragging === 'file-viewer') {
      saveFileViewerRatio();
    }
    dragging = null;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="split-pane-layout"
  bind:this={containerEl}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
>
  <!-- Terminal zone -->
  <div
    class="pane-terminal"
    style={fileViewerOpen ? `flex: ${1 - ui.fileViewerRatio}` : 'flex: 1'}
  >
    {@render terminal()}
  </div>

  <!-- File viewer zone (on demand) -->
  {#if fileViewerOpen}
    <div
      class="resize-handle"
      class:active={dragging === 'file-viewer'}
      role="separator"
      aria-label="resize terminal and file viewer"
      onpointerdown={(e) => handlePointerDown('file-viewer', e)}
    ></div>

    <div
      class="pane-file-viewer"
      style="flex: {ui.fileViewerRatio}"
    >
      {@render fileViewer()}
    </div>
  {/if}

  <!-- Resize handle before right sidebar -->
  {#if !ui.rightSidebarCollapsed}
    <div
      class="resize-handle"
      class:active={dragging === 'right-sidebar'}
      role="separator"
      aria-label="resize right sidebar"
      onpointerdown={(e) => handlePointerDown('right-sidebar', e)}
    ></div>
  {/if}

  <!-- Right sidebar -->
  <div class="pane-right-sidebar">
    {@render rightSidebar()}
  </div>
</div>

<style>
  .split-pane-layout {
    display: flex;
    flex-direction: row;
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .pane-terminal {
    display: flex;
    flex-direction: column;
    min-width: 300px;
    height: 100%;
    overflow: hidden;
  }

  .pane-file-viewer {
    min-width: 300px;
    height: 100%;
    overflow: hidden;
  }

  .pane-right-sidebar {
    flex-shrink: 0;
    height: 100%;
    overflow: hidden;
  }

  /* Resize handles */
  .resize-handle {
    width: 8px;
    cursor: col-resize;
    position: relative;
    flex-shrink: 0;
    z-index: 5;
  }

  .resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: var(--border, #333);
    pointer-events: none;
  }

  .resize-handle:hover::after,
  .resize-handle.active::after {
    background: var(--accent, #d97757);
  }

  /* Mobile: hide right sidebar entirely */
  @media (max-width: 767px) {
    .pane-right-sidebar {
      display: none;
    }

    .resize-handle {
      display: none;
    }
  }
</style>
