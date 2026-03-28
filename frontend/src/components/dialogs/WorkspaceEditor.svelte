<script lang="ts">
  import type { Workspace, Repo } from '../../lib/types.js';

  const THEME_COLORS = [
    { name: 'terracotta', value: '#c2714f' },
    { name: 'sage', value: '#6b8f71' },
    { name: 'slate', value: '#64748b' },
    { name: 'amber', value: '#d97706' },
    { name: 'rose', value: '#e11d48' },
    { name: 'sky', value: '#0ea5e9' },
    { name: 'violet', value: '#7c3aed' },
    { name: 'lime', value: '#65a30d' },
  ];

  let { workspace, repos, onsave, ondelete }: {
    workspace: Workspace;
    repos: Repo[];
    onsave: (updates: Partial<Workspace>) => void;
    ondelete: () => void;
  } = $props();

  let name = $state('');
  let selectedRepos = $state<string[]>([]);
  let themeColor = $state('');
  let expanded = $state(false);

  // Sync local editable state when the workspace prop changes (e.g. after a save/reload)
  $effect(() => {
    name = workspace.name;
    selectedRepos = workspace.repos ?? [];
    themeColor = workspace.themeColor ?? '';
  });

  function handleNameBlur() {
    if (name !== workspace.name) {
      onsave({ name });
    }
  }

  function handleRepoToggle(repoPath: string, checked: boolean) {
    if (checked) {
      selectedRepos = [...selectedRepos, repoPath];
    } else {
      selectedRepos = selectedRepos.filter(r => r !== repoPath);
    }
    onsave({ repos: selectedRepos });
  }

  function handleColorSelect(color: string) {
    themeColor = color;
    onsave({ themeColor: color });
  }
</script>

<div class="workspace-editor">
  <div class="workspace-header">
    <button
      class="expand-btn"
      onclick={() => expanded = !expanded}
      aria-expanded={expanded}
    >
      <span class="expand-icon">{expanded ? '[-]' : '[+]'}</span>
      {#if themeColor}
        <span class="color-dot" style="background: {themeColor};"></span>
      {/if}
      <span class="workspace-name-preview">{workspace.name}</span>
      <span class="repo-count">{workspace.repos?.length ?? 0} repos</span>
    </button>
  </div>

  {#if expanded}
    <div class="workspace-body">
      <div class="field-group">
        <label class="field-label" for="ws-name-{workspace.id}">name</label>
        <input
          id="ws-name-{workspace.id}"
          class="text-input"
          type="text"
          bind:value={name}
          onblur={handleNameBlur}
        />
      </div>

      <div class="field-group">
        <p class="field-label">repos</p>
        <div class="repo-list">
          {#if repos.length === 0}
            <p class="empty-note">no repos available</p>
          {:else}
            {#each repos as repo (repo.path)}
              <label class="repo-checkbox-row">
                <input
                  type="checkbox"
                  checked={selectedRepos.includes(repo.path)}
                  onchange={(e) => handleRepoToggle(repo.path, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="repo-label">{repo.name}</span>
                <span class="repo-path">{repo.path}</span>
              </label>
            {/each}
          {/if}
        </div>
      </div>

      <div class="field-group">
        <p class="field-label">color</p>
        <div class="color-palette">
          {#each THEME_COLORS as color (color.value)}
            <button
              class="color-swatch"
              class:selected={themeColor === color.value}
              style="background: {color.value};"
              title={color.name}
              onclick={() => handleColorSelect(color.value)}
              aria-label={color.name}
            ></button>
          {/each}
          {#if themeColor}
            <button
              class="color-clear"
              onclick={() => { themeColor = ''; onsave({ themeColor: '' }); }}
              title="clear color"
            >[x]</button>
          {/if}
        </div>
      </div>

      <div class="workspace-actions">
        <button class="danger-btn" onclick={ondelete}>[ delete workspace ]</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .workspace-editor {
    border: 1px solid var(--border);
    margin-bottom: 8px;
  }

  .workspace-header {
    display: flex;
    align-items: center;
  }

  .expand-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    padding: 10px 12px;
    cursor: pointer;
    text-align: left;
  }

  .expand-btn:hover {
    background: var(--border);
  }

  .expand-icon {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .color-dot {
    width: 8px;
    height: 8px;
    border-radius: 0;
    flex-shrink: 0;
  }

  .workspace-name-preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo-count {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    flex-shrink: 0;
  }

  .workspace-body {
    border-top: 1px solid var(--border);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-family: var(--font-mono);
    margin: 0;
  }

  .text-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    padding: 6px 8px;
    width: 100%;
    box-sizing: border-box;
    outline: none;
  }

  .text-input:focus {
    border-color: var(--accent);
  }

  .repo-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 160px;
    overflow-y: auto;
  }

  .repo-checkbox-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    cursor: pointer;
    padding: 3px 0;
  }

  .repo-checkbox-row input[type="checkbox"] {
    flex-shrink: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .repo-label {
    font-size: var(--font-size-sm);
    color: var(--text);
    font-family: var(--font-mono);
  }

  .repo-path {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-note {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-family: var(--font-mono);
    margin: 0;
  }

  .color-palette {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .color-swatch {
    width: 18px;
    height: 18px;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
  }

  .color-swatch:hover {
    border-color: var(--text);
  }

  .color-swatch.selected {
    border-color: var(--text);
    outline: 1px solid var(--bg);
    outline-offset: -3px;
  }

  .color-clear {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    cursor: pointer;
    padding: 0 2px;
  }

  .color-clear:hover {
    color: var(--text);
  }

  .workspace-actions {
    display: flex;
    justify-content: flex-end;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }

  .danger-btn {
    background: none;
    border: 1px solid var(--status-error);
    color: var(--status-error);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    padding: 6px 10px;
    cursor: pointer;
  }

  .danger-btn:hover {
    background: var(--status-error);
    color: var(--bg);
  }
</style>
