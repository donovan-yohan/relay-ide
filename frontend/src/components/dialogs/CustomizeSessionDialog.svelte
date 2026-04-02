<script lang="ts">
  import { createSession, fetchMergedWorkspaceSettings, fetchFrameworks } from '../../lib/api.js';
  import { estimateTerminalDimensions } from '../../lib/utils.js';
  import { refreshAll } from '../../lib/state/sessions.svelte.js';
  import type { Repo, FrameworkInfo } from '../../lib/types.js';
  import DialogShell from './DialogShell.svelte';
  import TuiButton from '../TuiButton.svelte';
  import TuiCheckbox from '../TuiCheckbox.svelte';

  const DEFAULT_FRAMEWORKS: FrameworkInfo[] = [
    {
      id: 'claude',
      displayName: 'Claude',
      command: 'claude',
      capabilities: { supportsContinue: true, supportsYolo: true, supportsHooks: true, supportsTelemetry: true },
      eventSource: 'hooks',
    },
    {
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      capabilities: { supportsContinue: true, supportsYolo: true, supportsHooks: true, supportsTelemetry: false },
      eventSource: 'hooks',
    },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      command: 'opencode',
      capabilities: { supportsContinue: true, supportsYolo: true, supportsHooks: false, supportsTelemetry: true },
      eventSource: 'plugin',
    },
  ];

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
  let selectedAgent = $state<string>('claude');
  let frameworks = $state<FrameworkInfo[]>([]);
  let yoloMode = $state(false);
  let continueExisting = $state(false);
  let useTmux = $state(false);
  let creating = $state(false);

  let selectedFramework = $derived(frameworks.find(f => f.id === selectedAgent));

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

    const [merged, fetched] = await Promise.all([
      fetchMergedWorkspaceSettings(repoPath).catch(() => null),
      fetchFrameworks().catch(() => [] as FrameworkInfo[]),
    ]);
    frameworks = fetched.length > 0 ? fetched : DEFAULT_FRAMEWORKS;
    selectedAgent = merged?.settings.defaultAgent ?? 'claude';
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
        {#each frameworks as fw}
          <option value={fw.id}>{fw.displayName}</option>
        {/each}
      </select>
    </div>

    <!-- Continue existing -->
    <TuiCheckbox bind:checked={continueExisting} disabled={!selectedFramework?.capabilities.supportsContinue}>
      Continue existing session{#if !selectedFramework?.capabilities.supportsContinue} <span class="capability-hint">(not supported by {selectedFramework?.displayName ?? selectedAgent})</span>{/if}
    </TuiCheckbox>

    <!-- Yolo mode -->
    <TuiCheckbox bind:checked={yoloMode} disabled={!selectedFramework?.capabilities.supportsYolo}>
      Yolo mode (skip permission checks){#if !selectedFramework?.capabilities.supportsYolo} <span class="capability-hint">(not supported by {selectedFramework?.displayName ?? selectedAgent})</span>{/if}
    </TuiCheckbox>

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

  .capability-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.7;
    font-family: var(--font-mono);
  }
</style>
