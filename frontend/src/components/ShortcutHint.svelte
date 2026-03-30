<script lang="ts">
  import { getAction } from '../lib/actions/registry.svelte.js';
  import { formatShortcut } from '../lib/actions/shortcuts.js';
  import { isMac } from '../lib/utils.js';

  let { actionId }: { actionId: string } = $props();

  let shortcut = $derived.by(() => {
    const action = getAction(actionId);
    if (!action?.shortcut) return null;
    return formatShortcut(action.shortcut.key, isMac);
  });
</script>

{#if shortcut}
  <kbd class="shortcut-hint">{shortcut}</kbd>
{/if}

<style>
  .shortcut-hint {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 1px 4px;
    border-radius: 0;
    white-space: nowrap;
  }
</style>
