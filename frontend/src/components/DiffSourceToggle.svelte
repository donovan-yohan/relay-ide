<script lang="ts">
  import type { DiffSource } from '../lib/types.js';

  let {
    value = 'working',
    onchange,
    defaultBranch = 'main',
  }: {
    value?: DiffSource;
    onchange: (source: DiffSource) => void;
    defaultBranch?: string;
  } = $props();

  const options: { value: DiffSource; label: string }[] = [
    { value: 'working', label: 'working tree' },
    { value: 'staged', label: 'staged' },
    { value: 'branch', label: 'branch' },
  ];
</script>

<div class="diff-source-toggle" role="radiogroup" aria-label="diff source">
  {#each options as opt (opt.value)}
    <button
      class="toggle-option"
      class:active={value === opt.value}
      role="radio"
      aria-checked={value === opt.value}
      onclick={() => onchange(opt.value)}
    >
      {opt.value === 'branch' ? `vs ${defaultBranch}` : opt.label}
    </button>
  {/each}
</div>

<style>
  .diff-source-toggle {
    display: flex;
    gap: 0;
    border: 1px solid var(--border, #333);
  }

  .toggle-option {
    padding: 2px 8px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border, #333);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    cursor: pointer;
    white-space: nowrap;
  }

  .toggle-option:last-child {
    border-right: none;
  }

  .toggle-option:hover {
    background: var(--surface-hover, #141414);
    color: var(--text, #e0e0e0);
  }

  .toggle-option.active {
    color: var(--accent, #d97757);
    background: rgba(217, 119, 87, 0.08);
  }
</style>
