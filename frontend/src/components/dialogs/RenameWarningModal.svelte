<script lang="ts">
  import DialogShell from './DialogShell.svelte';
  import TuiButton from '../TuiButton.svelte';

  let {
    oldName,
    newName,
    repoPath,
    onClose,
  }: {
    oldName: string;
    newName: string;
    repoPath: string;
    onClose: () => void;
  } = $props();

  let shellRef = $state<DialogShell | undefined>(undefined);
  let loading = $state<'push' | 'cancel' | null>(null);
  let errorMsg = $state<string | null>(null);

  // Auto-open the dialog when the component mounts
  $effect(() => {
    shellRef?.open();
  });

  async function handlePush() {
    loading = 'push';
    errorMsg = null;
    try {
      const res = await fetch('/workspaces/push-branch?path=' + encodeURIComponent(repoPath), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: newName, deleteOldBranch: oldName }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (data.success) {
        shellRef?.close();
        onClose();
      } else {
        errorMsg = data.error ?? 'Push failed';
      }
    } catch {
      errorMsg = 'Push failed';
    } finally {
      loading = null;
    }
  }

  async function handleCancel() {
    loading = 'cancel';
    errorMsg = null;
    try {
      const res = await fetch('/workspaces/rename-branch?path=' + encodeURIComponent(repoPath), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: oldName }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (data.success) {
        shellRef?.close();
        onClose();
      } else {
        errorMsg = data.error ?? 'Failed to undo rename';
      }
    } catch {
      errorMsg = 'Failed to undo rename';
    } finally {
      loading = null;
    }
  }

  function handleIgnore() {
    shellRef?.close();
    onClose();
  }
</script>

<DialogShell bind:this={shellRef} title="Branch Renamed" width="420px">
  {#snippet footer()}
    <div class="rename-actions">
      <TuiButton
        variant="primary"
        onclick={handlePush}
        disabled={loading !== null}
      >
        {loading === 'push' ? 'Pushing...' : 'Push'}
      </TuiButton>
      <TuiButton
        variant="ghost"
        onclick={handleIgnore}
        disabled={loading !== null}
      >
        Ignore
      </TuiButton>
      <TuiButton
        variant="ghost"
        onclick={handleCancel}
        disabled={loading !== null}
      >
        {loading === 'cancel' ? 'Undoing...' : 'Cancel (undo rename)'}
      </TuiButton>
    </div>
  {/snippet}

  <div class="rename-body">
    <p class="rename-message">
      Branch renamed: <code>{oldName}</code> &rarr; <code>{newName}</code>
    </p>
    <p class="rename-detail">
      This PR's head branch no longer matches. Push the renamed branch to update GitHub?
    </p>

    {#if errorMsg}
      <p class="error-msg">{errorMsg}</p>
    {/if}
  </div>
</DialogShell>

<style>
  .rename-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rename-message {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .rename-message code {
    background: var(--surface-hover);
    padding: 2px 4px;
    border-radius: 0;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
  }

  .rename-detail {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }

  .rename-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

</style>
