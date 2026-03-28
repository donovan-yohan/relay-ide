<script lang="ts">
  import type { GitHubIssue, JiraIssue, AnyIssue, Repo } from '../lib/types.js';
  import { createSession, ConflictError, fetchWorkspaces } from '../lib/api.js';
  import TuiButton from './TuiButton.svelte';

  let {
    issue,
    open = false,
    onClose,
    onSessionCreated,
  }: {
    issue: AnyIssue;
    open: boolean;
    onClose: () => void;
    onSessionCreated: (sessionId: string) => void;
  } = $props();

  function detectSource(i: AnyIssue): 'github' | 'jira' {
    if ('number' in i && 'labels' in i) return 'github';
    return 'jira';
  }

  let source = $derived(detectSource(issue));

  let ticketDisplay = $derived(
    source === 'github' ? `#${(issue as GitHubIssue).number} — ${issue.title}` :
    `${(issue as JiraIssue).key} — ${issue.title}`
  );

  let defaultBranch = $derived(
    source === 'github' ? `gh-${(issue as GitHubIssue).number}` :
    (issue as JiraIssue).key.toLowerCase()
  );

  // For Jira, user selects a workspace since issues are cross-repo
  let workspaces = $state<Repo[]>([]);
  let selectedWorkspacePath = $state('');

  let repoPath = $derived(
    source === 'github' ? (issue as GitHubIssue).repoPath : selectedWorkspacePath
  );
  let repoName = $derived.by(() => {
    if (source === 'github') return (issue as GitHubIssue).repoName;
    const ws = workspaces.find(w => w.path === selectedWorkspacePath);
    return ws?.name ?? '';
  });

  let branchName = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Load workspaces for Jira, and initialize branch name
  let branchInitialized = false;
  $effect(() => {
    if (open && !branchInitialized) {
      branchName = defaultBranch;
      branchInitialized = true;
    }
    if (!open) {
      branchInitialized = false;
    }
    if (source !== 'github' && open) {
      fetchWorkspaces().then(ws => {
        workspaces = ws;
        if (ws.length > 0 && !selectedWorkspacePath) {
          selectedWorkspacePath = ws[0]!.path;
        }
      }).catch(() => {});
    }
  });

  function buildTicketContext() {
    if (source === 'github') {
      const gh = issue as GitHubIssue;
      return {
        ticketId: `GH-${gh.number}`,
        title: gh.title,
        url: gh.url,
        source: 'github' as const,
        repoPath: gh.repoPath,
        repoName: gh.repoName,
      };
    } else {
      const jira = issue as JiraIssue;
      return {
        ticketId: jira.key,
        title: jira.title,
        url: jira.url,
        source: 'jira' as const,
        repoPath: repoPath,
        repoName: repoName,
      };
    }
  }

  async function handleStart() {
    if (loading) return;

    if (!repoPath) {
      error = 'No workspace selected. Jira tickets require a workspace context.';
      return;
    }

    loading = true;
    error = null;

    try {
      const session = await createSession({
        repoPath: repoPath,
        worktreePath: null,
        type: 'agent',
        branchName,
        ticketContext: buildTicketContext(),
      });

      onSessionCreated(session.id);
      onClose();
    } catch (err) {
      if (err instanceof ConflictError) {
        onSessionCreated(err.sessionId);
        onClose();
        return;
      }
      error = err instanceof Error ? err.message : 'Failed to start work';
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && !loading) handleStart();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onkeydown={handleKeydown} onclick={onClose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <span class="modal-title">Start Work</span>
        <button class="modal-close" onclick={onClose}>&times;</button>
      </div>

      <div class="modal-body">
        <div class="ticket-info">
          <span class="ticket-info-label">Ticket</span>
          <span class="ticket-info-value">{ticketDisplay}</span>
        </div>

        {#if source === 'github'}
          <div class="ticket-info">
            <span class="ticket-info-label">Repo</span>
            <span class="ticket-info-value">{repoName}</span>
          </div>
        {:else}
          <div class="field">
            <label class="field-label" for="workspace-select">Workspace</label>
            {#if workspaces.length > 0}
              <select
                id="workspace-select"
                class="field-input"
                bind:value={selectedWorkspacePath}
              >
                {#each workspaces as ws (ws.path)}
                  <option value={ws.path}>{ws.name}</option>
                {/each}
              </select>
            {:else}
              <span class="ticket-info-value" style="opacity: 0.5">Loading workspaces...</span>
            {/if}
          </div>
        {/if}

        <div class="field">
          <label class="field-label" for="branch-name">Branch Name</label>
          <input
            id="branch-name"
            class="field-input"
            type="text"
            bind:value={branchName}
            placeholder={defaultBranch}
          />
        </div>

        {#if error}
          <div class="error-msg">{error}</div>
        {/if}
      </div>

      <div class="modal-footer">
        <TuiButton variant="ghost" onclick={onClose} disabled={loading}>Cancel</TuiButton>
        <TuiButton variant="primary" onclick={handleStart} disabled={loading}>
          {#if loading}Starting...{:else}Start Work{/if}
        </TuiButton>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    width: 90%;
    max-width: 420px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 16px;
    border-bottom: 1px solid var(--border);
  }

  .modal-title {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text);
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .modal-close:hover {
    color: var(--text);
  }

  .modal-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ticket-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ticket-info-label {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.06em;
  }

  .ticket-info-value {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    color: var(--text);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.06em;
  }

  .field-input {
    padding: 8px 12px;
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    outline: none;
    transition: border-color 0.12s;
  }

  .field-input:focus {
    border-color: var(--accent);
  }

  .error-msg {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--status-error);
    padding: 8px 8px;
    background: rgba(255, 100, 100, 0.1);
    border-radius: 0;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }

</style>
