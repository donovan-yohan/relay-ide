<script lang="ts">
  import { updateWorkspaceSettings, fetchBranches, fetchMergedWorkspaceSettings } from '../../lib/api.js';
  import TuiButton from '../TuiButton.svelte';
  import TuiCheckbox from '../TuiCheckbox.svelte';
  import type { WorkspaceSettings, BranchInfo } from '../../lib/types.js';

  interface Props {
    onRemoveWorkspace: (path: string) => void;
  }

  let { onRemoveWorkspace }: Props = $props();

  let dialogEl: HTMLDialogElement;
  let repoPath = $state('');
  let workspaceName = $state('');
  let saving = $state(false);
  let error = $state('');
  let saveSuccess = $state(false);

  let branches = $state<BranchInfo[]>([]);

  // Settings fields
  let defaultBranch = $state('');
  let remote = $state('');
  let branchPrefix = $state('');
  let defaultAgent = $state<string>('claude');
  let defaultContinue = $state(false);
  let defaultYolo = $state(false);
  let launchInTmux = $state(false);
  let promptCodeReview = $state('');
  let promptCreatePr = $state('');
  let promptBranchRename = $state('');
  let promptGeneral = $state('');

  let overriddenKeys = $state<string[]>([]);
  let originalSettings = $state<Record<string, unknown>>({});

  // Collapsible prompt sections
  let codeReviewOpen = $state(false);
  let createPrOpen = $state(false);
  let branchRenameOpen = $state(false);
  let generalOpen = $state(false);

  export async function open(path: string, name: string) {
    repoPath = path;
    workspaceName = name;
    error = '';
    saveSuccess = false;
    saving = false;

    // Reset all fields to defaults while loading
    defaultBranch = '';
    remote = '';
    branchPrefix = '';
    defaultAgent = 'claude';
    defaultContinue = false;
    defaultYolo = false;
    launchInTmux = false;
    promptCodeReview = '';
    promptCreatePr = '';
    promptBranchRename = '';
    promptGeneral = '';

    dialogEl.showModal();

    try {
      const [mergedResult, branchList] = await Promise.all([
        fetchMergedWorkspaceSettings(path),
        fetchBranches(path).catch(() => [] as BranchInfo[]),
      ]);

      branches = branchList;
      applySettings(mergedResult.settings);
      originalSettings = {
        defaultAgent: mergedResult.settings.defaultAgent,
        defaultContinue: mergedResult.settings.defaultContinue,
        defaultYolo: mergedResult.settings.defaultYolo,
        launchInTmux: mergedResult.settings.launchInTmux,
      };
      overriddenKeys = mergedResult.overridden;
    } catch {
      error = 'Failed to load workspace settings.';
    }
  }

  export function close() {
    dialogEl.close();
  }

  function applySettings(s: WorkspaceSettings) {
    defaultBranch = s.defaultBranch ?? '';
    remote = s.remote ?? '';
    branchPrefix = s.branchPrefix ?? '';
    defaultAgent = s.defaultAgent ?? 'claude';
    defaultContinue = s.defaultContinue ?? false;
    defaultYolo = s.defaultYolo ?? false;
    launchInTmux = s.launchInTmux ?? false;
    promptCodeReview = s.promptCodeReview ?? '';
    promptCreatePr = s.promptCreatePr ?? '';
    promptBranchRename = s.promptBranchRename ?? '';
    promptGeneral = s.promptGeneral ?? '';
  }

  async function handleSave() {
    saving = true;
    error = '';
    saveSuccess = false;
    try {
      const settings: Record<string, unknown> = {};
      // Only include session default fields if user changed them from the effective value
      if (defaultAgent !== originalSettings.defaultAgent) settings.defaultAgent = defaultAgent;
      if (defaultContinue !== originalSettings.defaultContinue) settings.defaultContinue = defaultContinue;
      if (defaultYolo !== originalSettings.defaultYolo) settings.defaultYolo = defaultYolo;
      if (launchInTmux !== originalSettings.launchInTmux) settings.launchInTmux = launchInTmux;
      // Always include non-boolean fields if they have values
      if (defaultBranch) settings.defaultBranch = defaultBranch;
      if (remote) settings.remote = remote;
      if (branchPrefix) settings.branchPrefix = branchPrefix;
      if (promptCodeReview) settings.promptCodeReview = promptCodeReview;
      if (promptCreatePr) settings.promptCreatePr = promptCreatePr;
      if (promptBranchRename) settings.promptBranchRename = promptBranchRename;
      if (promptGeneral) settings.promptGeneral = promptGeneral;
      if (Object.keys(settings).length > 0) {
        await updateWorkspaceSettings(repoPath, settings);
      }
      saveSuccess = true;
      setTimeout(() => { saveSuccess = false; }, 2000);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save settings.';
    } finally {
      saving = false;
    }
  }

  async function handleResetSessionDefaults() {
    saving = true;
    error = '';
    try {
      await updateWorkspaceSettings(repoPath, {
        defaultAgent: null,
        defaultContinue: null,
        defaultYolo: null,
        launchInTmux: null,
      } as unknown as Record<string, unknown>);
      // Re-fetch merged settings to update UI
      const merged = await fetchMergedWorkspaceSettings(repoPath);
      applySettings(merged.settings);
      originalSettings = {
        defaultAgent: merged.settings.defaultAgent,
        defaultContinue: merged.settings.defaultContinue,
        defaultYolo: merged.settings.defaultYolo,
        launchInTmux: merged.settings.launchInTmux,
      };
      overriddenKeys = merged.overridden;
      saveSuccess = true;
      setTimeout(() => { saveSuccess = false; }, 2000);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to reset settings.';
    } finally {
      saving = false;
    }
  }

  function handleRemove() {
    dialogEl.close();
    onRemoveWorkspace(repoPath);
  }

  function onDialogClick(e: MouseEvent) {
    if (e.target === dialogEl) {
      dialogEl.close();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  onclick={onDialogClick}
  class="dialog"
>
  <div class="dialog-content">
    <div class="dialog-header">
      <h2 class="dialog-title">
        <span class="gear-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
        {workspaceName}
      </h2>
      <button class="close-btn" aria-label="Close settings" onclick={() => dialogEl.close()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>

    <div class="dialog-body">
      {#if error}
        <p class="error-msg">{error}</p>
      {/if}

      <!-- Git Settings -->
      <section class="settings-section">
        <h3 class="section-label">git settings</h3>

        <div class="field-group">
          <label class="field-label" for="ws-default-branch">Branch new worktrees from</label>
          <select id="ws-default-branch" class="field-select" bind:value={defaultBranch}>
            <option value="">-- auto --</option>
            {#each branches as branch}
              <option value={branch.name}>{branch.name}</option>
            {/each}
            {#if defaultBranch && !branches.some(b => b.name === defaultBranch)}
              <option value={defaultBranch}>{defaultBranch}</option>
            {/if}
          </select>
        </div>

        <div class="field-group">
          <label class="field-label" for="ws-remote">Remote origin</label>
          <input
            id="ws-remote"
            type="text"
            class="field-input"
            placeholder="origin"
            bind:value={remote}
          />
        </div>

        <div class="field-group">
          <label class="field-label" for="ws-branch-prefix">Branch prefix</label>
          <input
            id="ws-branch-prefix"
            type="text"
            class="field-input"
            placeholder="e.g. dy/"
            bind:value={branchPrefix}
          />
        </div>
      </section>

      <div class="divider"></div>

      <!-- Session Defaults -->
      <section class="settings-section">
        <h3 class="section-label">
          session defaults
          {#if overriddenKeys.some(k => ['defaultAgent', 'defaultContinue', 'defaultYolo', 'launchInTmux'].includes(k))}
            <span class="override-badge">overridden</span>
          {/if}
        </h3>

        <div class="inline-row">
          <label class="field-label" for="ws-agent">Default agent</label>
          <select id="ws-agent" class="field-select field-select-inline" bind:value={defaultAgent}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </div>

        <div class="checkbox-row">
          <TuiCheckbox bind:checked={defaultContinue}>Continue</TuiCheckbox>
          <TuiCheckbox bind:checked={defaultYolo}>YOLO</TuiCheckbox>
          <TuiCheckbox bind:checked={launchInTmux}>Tmux</TuiCheckbox>
        </div>
      </section>

      <div class="divider"></div>

      <!-- Prompts -->
      <section class="settings-section">
        <h3 class="section-label">prompts</h3>

        <div class="prompt-group">
          <button
            class="prompt-toggle"
            onclick={() => { codeReviewOpen = !codeReviewOpen; }}
            aria-expanded={codeReviewOpen}
          >
            <span class="prompt-arrow">{codeReviewOpen ? '▾' : '▸'}</span>
            Code review preferences
          </button>
          {#if codeReviewOpen}
            <textarea
              class="prompt-textarea"
              rows={3}
              placeholder="e.g. focus on security, error handling"
              bind:value={promptCodeReview}
            ></textarea>
          {/if}
        </div>

        <div class="prompt-group">
          <button
            class="prompt-toggle"
            onclick={() => { createPrOpen = !createPrOpen; }}
            aria-expanded={createPrOpen}
          >
            <span class="prompt-arrow">{createPrOpen ? '▾' : '▸'}</span>
            Create PR preferences
          </button>
          {#if createPrOpen}
            <textarea
              class="prompt-textarea"
              rows={3}
              placeholder="e.g. include test plan section"
              bind:value={promptCreatePr}
            ></textarea>
          {/if}
        </div>

        <div class="prompt-group">
          <button
            class="prompt-toggle"
            onclick={() => { branchRenameOpen = !branchRenameOpen; }}
            aria-expanded={branchRenameOpen}
          >
            <span class="prompt-arrow">{branchRenameOpen ? '▾' : '▸'}</span>
            Branch rename preferences
          </button>
          {#if branchRenameOpen}
            <textarea
              class="prompt-textarea"
              rows={3}
              placeholder="e.g. prefix with dy/, use conventional commits style"
              bind:value={promptBranchRename}
            ></textarea>
          {/if}
        </div>

        <div class="prompt-group">
          <button
            class="prompt-toggle"
            onclick={() => { generalOpen = !generalOpen; }}
            aria-expanded={generalOpen}
          >
            <span class="prompt-arrow">{generalOpen ? '▾' : '▸'}</span>
            General preferences
          </button>
          {#if generalOpen}
            <textarea
              class="prompt-textarea"
              rows={3}
              placeholder="e.g. use TypeScript, follow CLAUDE.md"
              bind:value={promptGeneral}
            ></textarea>
          {/if}
        </div>
      </section>
    </div>

    <div class="dialog-footer">
      <TuiButton variant="danger" onclick={handleRemove}>
        Remove Workspace
      </TuiButton>
      <div class="footer-right">
        {#if overriddenKeys.some(k => ['defaultAgent', 'defaultContinue', 'defaultYolo', 'launchInTmux'].includes(k))}
          <TuiButton variant="ghost" onclick={handleResetSessionDefaults} disabled={saving}>
            Reset to Global
          </TuiButton>
        {/if}
        {#if saveSuccess}
          <span class="save-success">Saved</span>
        {/if}
        <TuiButton variant="primary" onclick={handleSave} disabled={saving}>
          {saving ? 'Saving\u2026' : 'Save'}
        </TuiButton>
      </div>
    </div>
  </div>
</dialog>

<style>
  .dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 0;
    width: min(480px, 95vw);
    max-height: 90vh;
    overflow: hidden;
  }

  .dialog::backdrop {
    background: rgba(0, 0, 0, 0.6);
  }

  .dialog-content {
    display: flex;
    flex-direction: column;
    max-height: 90vh;
    overflow: hidden;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 8px;
  }

  .dialog-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .gear-icon {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: var(--font-size-lg);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: var(--font-size-lg);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 0;
    flex-shrink: 0;
    line-height: 1;
  }

  .close-btn:hover {
    background: var(--border);
    color: var(--text);
  }

  .dialog-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-label {
    font-size: var(--font-size-xs, 0.72rem);
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.08em;
    margin: 0 0 2px;
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .field-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-sm);
    padding: 8px 8px;
    width: 100%;
    box-sizing: border-box;
    outline: none;
  }

  .field-input:focus {
    border-color: var(--accent);
  }

  .field-select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-sm);
    padding: 8px 8px;
    width: 100%;
    box-sizing: border-box;
    cursor: pointer;
    outline: none;
  }

  .field-select:focus {
    border-color: var(--accent);
  }

  .inline-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .inline-row .field-label {
    flex-shrink: 0;
  }

  .field-select-inline {
    width: auto;
    flex: 1;
    max-width: 160px;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    user-select: none;
  }

  .divider {
    height: 1px;
    background: var(--border);
    margin: 0 -20px;
  }

  .prompt-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .prompt-toggle {
    background: none;
    border: none;
    color: var(--text);
    font-size: var(--font-size-sm);
    cursor: pointer;
    padding: 4px 0;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .prompt-toggle:hover {
    color: var(--accent);
  }

  .prompt-arrow {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    flex-shrink: 0;
    width: 10px;
  }

  .prompt-textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-sm);
    padding: 8px 12px;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    line-height: 1.5;
    outline: none;
  }

  .prompt-textarea:focus {
    border-color: var(--accent);
  }

  .error-msg {
    font-size: var(--font-size-sm);
    color: var(--status-error);
    margin: 0;
    padding: 8px 8px;
    background: rgba(231, 76, 60, 0.08);
    border: 1px solid rgba(231, 76, 60, 0.25);
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .save-success {
    font-size: var(--font-size-sm);
    color: var(--accent);
  }

  .override-badge {
    font-size: var(--font-size-xs);
    font-weight: 400;
    color: var(--accent);
    letter-spacing: 0;
    text-transform: none;
    margin-left: 6px;
  }
</style>
