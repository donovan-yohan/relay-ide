import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import TuiCheckbox from '../TuiCheckbox.js';
import { createSession } from '../../lib/api.js';
import { estimateTerminalDimensions } from '../../lib/utils.js';
import { useSessionsStore } from '../../lib/stores/sessions.js';
import { useConfigStore } from '../../lib/stores/config.js';
import type { AgentType, Workspace } from '../../lib/types.js';
import './CustomizeSessionDialog.css';

export interface CustomizeSessionDialogHandle {
  open(workspace: { name: string; path: string }): Promise<void>;
  close(): void;
}

interface Props {
  onSessionCreated?: (sessionId: string) => void;
}

interface FormState {
  claudeArgsInput: string;
  selectedAgent: AgentType;
  yoloMode: boolean;
  continueExisting: boolean;
  useTmux: boolean;
}

function defaultForm(): FormState {
  return { claudeArgsInput: '', selectedAgent: 'claude', yoloMode: false, continueExisting: false, useTmux: false };
}

async function createSessionFromForm(workspacePath: string, form: FormState) {
  const claudeArgs = form.claudeArgsInput.trim().split(/\s+/).filter(Boolean);
  const { cols, rows } = estimateTerminalDimensions();
  return createSession({
    repoPath: workspacePath,
    worktreePath: null,
    type: 'agent',
    continue: form.continueExisting,
    yolo: form.yoloMode,
    claudeArgs: claudeArgs.length > 0 ? claudeArgs : undefined,
    agent: form.selectedAgent,
    useTmux: form.useTmux,
    cols,
    rows,
  });
}

interface BodyProps {
  workspaceName: string;
  form: FormState;
  onFormChange: (patch: Partial<FormState>) => void;
}

function CustomizeSessionBody({ workspaceName, form, onFormChange }: BodyProps) {
  return (
    <div className="customize-session-body-fields">
      {workspaceName && <p className="customize-session-workspace-name">— {workspaceName}</p>}
      <div className="customize-session-dialog-field">
        <label className="customize-session-dialog-label" htmlFor="cs-agent">Coding agent</label>
        <select id="cs-agent" className="customize-session-dialog-select" data-track="dialog.customize-session.agent" value={form.selectedAgent} onChange={(e) => onFormChange({ selectedAgent: e.currentTarget.value as AgentType })}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
      </div>
      <TuiCheckbox checked={form.continueExisting} onChange={(checked) => onFormChange({ continueExisting: checked })}>Continue existing session</TuiCheckbox>
      <TuiCheckbox checked={form.yoloMode} onChange={(checked) => onFormChange({ yoloMode: checked })}>Yolo mode (skip permission checks)</TuiCheckbox>
      <TuiCheckbox checked={form.useTmux} onChange={(checked) => onFormChange({ useTmux: checked })}>Launch in tmux</TuiCheckbox>
      <div className="customize-session-dialog-field">
        <label className="customize-session-dialog-label" htmlFor="cs-args">Extra args (optional)</label>
        <input id="cs-args" type="text" className="customize-session-dialog-input" placeholder="e.g. --verbose" value={form.claudeArgsInput} onChange={(e) => onFormChange({ claudeArgsInput: e.currentTarget.value })} autoComplete="off" />
      </div>
    </div>
  );
}

const CustomizeSessionDialog = forwardRef<CustomizeSessionDialogHandle, Props>(
  function CustomizeSessionDialog({ onSessionCreated }, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const [workspacePath, setWorkspacePath] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');
    const [form, setForm] = useState<FormState>(defaultForm());
    const [creating, setCreating] = useState(false);

    useImperativeHandle(ref, () => ({
      async open(workspace: { name: string; path: string }) {
        setForm(defaultForm());
        setWorkspacePath(workspace.path);
        setWorkspaceName(workspace.name);
        await useConfigStore.getState().refreshConfig();
        const config = useConfigStore.getState();
        setForm({ claudeArgsInput: '', selectedAgent: config.defaultAgent as AgentType, yoloMode: config.defaultYolo, continueExisting: config.defaultContinue, useTmux: config.launchInTmux });
        shellRef.current?.open();
      },
      close() { shellRef.current?.close(); },
    }));

    async function handleSubmit() {
      if (!workspacePath || creating) return;
      setCreating(true);
      try {
        const session = await createSessionFromForm(workspacePath, form);
        shellRef.current?.close();
        await useSessionsStore.getState().refreshAll();
        if (session?.id) onSessionCreated?.(session.id);
      } catch (err: unknown) {
        if (err instanceof Error && 'sessionId' in err) {
          const conflictErr = err as Error & { sessionId?: string };
          shellRef.current?.close();
          await useSessionsStore.getState().refreshAll();
          if (conflictErr.sessionId) onSessionCreated?.(conflictErr.sessionId);
        }
      } finally {
        setCreating(false);
      }
    }

    const footer = (
      <div className="customize-session-footer-row">
        <TuiButton variant="ghost" onClick={() => shellRef.current?.close()} disabled={creating}>Cancel</TuiButton>
        <TuiButton variant="primary" data-track="dialog.customize-session.create" onClick={handleSubmit} disabled={!workspacePath || creating}>
          {creating ? 'Creating...' : 'Start Session'}
        </TuiButton>
      </div>
    );

    return (
      <DialogShell ref={shellRef} width="480px" title="Customize Session" footer={footer}>
        <CustomizeSessionBody workspaceName={workspaceName} form={form} onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
      </DialogShell>
    );
  },
);

export default CustomizeSessionDialog;
