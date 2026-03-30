<script lang="ts">
  import type { SessionIntent } from '../lib/session-intent.js';
  import type { StatusColor } from '../lib/pr-state.js';
  import StatusDot from './StatusDot.svelte';
  import TuiButton from './TuiButton.svelte';
  import type { PrDotStatus } from '../lib/pr-status.js';

  let {
    label,
    sublabel = '',
    dotStatus,
    intents,
    focused = false,
    onSelectIntent,
    onRowClick,
  }: {
    label: string;
    sublabel?: string;
    dotStatus?: PrDotStatus;
    intents: SessionIntent[];
    focused?: boolean;
    onSelectIntent: (intent: SessionIntent) => void;
    onRowClick?: () => void;
  } = $props();

  function colorToVariant(color: StatusColor): 'primary' | 'ghost' | 'danger' | 'success' | 'info' {
    if (color === 'success') return 'success';
    if (color === 'error') return 'danger';
    if (color === 'info') return 'info';
    if (color === 'accent') return 'primary';
    return 'ghost';
  }

  let primary = $derived(intents[0]);
  let secondary = $derived(intents.slice(1));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="picker-row"
  class:focused
  role="option"
  aria-selected={focused}
  onclick={() => {
    if (primary) onSelectIntent(primary);
    else onRowClick?.();
  }}
>
  <div class="row-left">
    {#if dotStatus}
      <StatusDot status={dotStatus} size={7} />
    {:else}
      <span class="row-icon">▸</span>
    {/if}
    <div class="row-text">
      <span class="row-label">{label}</span>
      {#if sublabel}
        <span class="row-sublabel">{sublabel}</span>
      {/if}
    </div>
  </div>
  <div class="row-actions">
    {#each secondary as intent}
      <TuiButton
        variant={colorToVariant(intent.color)}
        size="sm"
        onclick={(e) => { e.stopPropagation(); onSelectIntent(intent); }}
      >
        {intent.label}
      </TuiButton>
    {/each}
    {#if primary}
      <TuiButton
        variant={colorToVariant(primary.color)}
        size="sm"
        onclick={(e) => { e.stopPropagation(); onSelectIntent(primary); }}
      >
        {primary.label}
      </TuiButton>
    {/if}
  </div>
</div>

<style>
  .picker-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    min-height: 44px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    transition: background 0.08s;
    gap: 8px;
  }

  .picker-row:hover,
  .picker-row.focused {
    background: var(--surface-hover);
    color: var(--text);
  }

  .row-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .row-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.6;
  }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-sublabel {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  @media (max-width: 600px) {
    .picker-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }

    .row-actions {
      align-self: flex-end;
    }
  }
</style>
