<script lang="ts">
  import { createSession, fetchMergedWorkspaceSettings } from '../../lib/api.js';
  import { estimateTerminalDimensions } from '../../lib/utils.js';
  import { refreshAll } from '../../lib/state/sessions.svelte.js';
  import type { AgentType, Repo } from '../../lib/types.js';
  import DialogShell from './DialogShell.svelte';
  import TuiButton from '../TuiButton.svelte';
  import TuiCheckbox from '../TuiCheckbox.svelte';

  let {
    onSessionCreated,
  }: {
    onSessionCreated?: (sessionId: string) => void;
  } = $props();

  let shellRef = $state<DialogShell | undefined>(undefined);

  // Repo info
  let repoPath = $state('');
  let worktreePath = $state<string | null>(null);
  let workspaceName = $state('');

  // Form state
  let claudeArgsInput = $state('');
  let selectedAgent = $state<AgentType>('claude');
  let yoloMode = $state(false);
  let continueExisting = $state(false);
  let useTmux = $state(false);
  let creating = $state(false);

  function reset() {
    claudeArgsInput = '';
    yoloMode = false;
    continueExisting = false;
    useTmux = false;
  }

  export async function open(workspace: Pick<Repo, 'name' | 'path'>, activeWorktreePath?: string | null) {
    reset();
    repoPath = workspace.path;
    worktreePath = activeWorktreePath ?? null;
    workspaceName = workspace.name;

    const merged = await fetchMergedWorkspaceSettings(repoPath).catch(() => null);
    selectedAgent = (merged?.settings.defaultAgent ?? 'claude') as AgentType;
    yoloMode = merged?.settings.defaultYolo ?? false;
    continueExisting = merged?.settings.defaultContinue ?? false;
    useTmux = merged?.settings.launchInTmux ?? false;

    shellRef?.open();
  }

  export function close() {
    shellRef?.close();
  }

  async function handleSubmit() {
    if (!repoPath || creating) return;
    creating = true;

    const claudeArgs = claudeArgsInput.trim().split(/\s+/).filter(Boolean);
    const { cols, rows } = estimateTerminalDimensions();

    try {
      const session = await createSession({
        repoPath,
        worktreePath,
        type: 'agent',
        continue: continueExisting,
        yolo: yoloMode,
        claudeArgs: claudeArgs.length > 0 ? claudeArgs : undefined,
        agent: selectedAgent,
        useTmux,
        cols,
        rows,
      });
      shellRef?.close();
      await refreshAll();
      if (session?.id) {
        onSessionCreated?.(session.id);
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'sessionId' in err) {
        const conflictErr = err as Error & { sessionId?: string };
        shellRef?.close();
        await refreshAll();
        if (conflictErr.sessionId) {
          onSessionCreated?.(conflictErr.sessionId);
        }
      }
    } finally {
      creating = false;
    }
  }
</script>

<DialogShell
  bind:this={shellRef}
  width="480px"
  title="Customize Session"
>
  {#snippet footer()}
    <div class="footer-row">
      <TuiButton variant="ghost" onclick={() => shellRef?.close()} disabled={creating}>Cancel</TuiButton>
      <TuiButton
        variant="primary"
        data-track="dialog.customize-session.create"
        onclick={handleSubmit}
        disabled={!repoPath || creating}
      >
        {creating ? 'Creating...' : 'Start Session'}
      </TuiButton>
    </div>
  {/snippet}

  <div class="body-fields">
    {#if workspaceName}
      <p class="workspace-name">— {workspaceName}</p>
    {/if}

    <!-- Coding agent select -->
    <div class="dialog-field">
      <label class="dialog-label" for="cs-agent">Coding agent</label>
      <select
        id="cs-agent"
        class="dialog-select"
        data-track="dialog.customize-session.agent"
        bind:value={selectedAgent}
      >
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
    </div>

    <!-- Continue existing -->
    <TuiCheckbox bind:checked={continueExisting}>Continue existing session</TuiCheckbox>

    <!-- Yolo mode -->
    <TuiCheckbox bind:checked={yoloMode}>Yolo mode (skip permission checks)</TuiCheckbox>

    <!-- Launch in tmux -->
    <TuiCheckbox bind:checked={useTmux}>Launch in tmux</TuiCheckbox>

    <!-- Extra args -->
    <div class="dialog-field">
      <label class="dialog-label" for="cs-args">Extra args (optional)</label>
      <input
        id="cs-args"
        type="text"
        class="dialog-input"
        placeholder="e.g. --verbose"
        bind:value={claudeArgsInput}
        autocomplete="off"
      />
    </div>
  </div>
</DialogShell>

<style>
  .footer-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .workspace-name {
    font-weight: 400;
    color: var(--text-muted);
    font-size: var(--font-size-base);
    margin: 0 0 4px;
  }

  .body-fields {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .dialog-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dialog-field--inline {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .dialog-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .dialog-label-inline {
    font-size: var(--font-size-base);
    cursor: pointer;
  }

  .dialog-select,
  .dialog-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-size: var(--font-size-base);
    font-family: var(--font-mono);
    padding: 8px 8px;
    width: 100%;
    box-sizing: border-box;
  }

  .dialog-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
