import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import TuiCheckbox from '../TuiCheckbox.js';
import { estimateTerminalDimensions } from '../../lib/utils.js';
import { useConfigStore } from '../../lib/stores/config.js';
import { useUiStore } from '../../lib/stores/ui.js';
import { createAgentSession } from '../../lib/session-utils.js';
import type { AgentType } from '../../lib/types.js';
import './CustomizeSessionDialog.css';

export interface CustomizeSessionDialogHandle {
  open(
    workspace: { name: string; path: string },
    worktreePath?: string | null,
    preselectedFramework?: AgentType
  ): Promise<void>;
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
}

function defaultForm(): FormState {
  return {
    claudeArgsInput: '',
    selectedAgent: 'claude',
    yoloMode: false,
    continueExisting: false,
  };
}

async function createSessionFromForm(
  workspacePath: string,
  worktreePath: string | null,
  form: FormState
) {
  const claudeArgs = form.claudeArgsInput.trim().split(/\s+/).filter(Boolean);
  const { cols, rows } = estimateTerminalDimensions(
    useUiStore.getState().terminalFontSize
  );
  return createAgentSession({
    repoPath: workspacePath,
    worktreePath,
    type: 'agent',
    mode: form.selectedAgent === 'hermes' ? 'web' : 'pty',
    continue: form.continueExisting,
    yolo: form.yoloMode,
    claudeArgs: claudeArgs.length > 0 ? claudeArgs : undefined,
    agent: form.selectedAgent,
    cols,
    rows,
  });
}

interface BodyProps {
  workspaceName: string;
  form: FormState;
  onFormChange: (patch: Partial<FormState>) => void;
}

function CustomizeSessionBody({
  workspaceName,
  form,
  onFormChange,
}: BodyProps) {
  const frameworks = useConfigStore((state) => state.frameworks);
  const frameworkOptions =
    frameworks.length > 0
      ? frameworks
      : [
          {
            id: form.selectedAgent,
            displayName: form.selectedAgent,
          },
        ];

  return (
    <div className="customize-session-body-fields">
      {workspaceName && (
        <p className="customize-session-workspace-name">— {workspaceName}</p>
      )}
      <div className="customize-session-dialog-field">
        <label className="customize-session-dialog-label" htmlFor="cs-agent">
          Coding agent
        </label>
        <select
          id="cs-agent"
          className="customize-session-dialog-select"
          data-track="dialog.customize-session.agent"
          value={form.selectedAgent}
          onChange={(e) =>
            onFormChange({ selectedAgent: e.currentTarget.value as AgentType })
          }
        >
          {frameworkOptions.map((framework) => (
            <option key={framework.id} value={framework.id}>
              {framework.displayName}
            </option>
          ))}
        </select>
      </div>
      <TuiCheckbox
        checked={form.continueExisting}
        onChange={(checked) => onFormChange({ continueExisting: checked })}
      >
        Continue existing session
      </TuiCheckbox>
      <TuiCheckbox
        checked={form.yoloMode}
        onChange={(checked) => onFormChange({ yoloMode: checked })}
      >
        Yolo mode (skip permission checks)
      </TuiCheckbox>
      <div className="customize-session-dialog-field">
        <label className="customize-session-dialog-label" htmlFor="cs-args">
          Extra args (optional)
        </label>
        <input
          id="cs-args"
          type="text"
          className="customize-session-dialog-input"
          placeholder="e.g. --verbose"
          value={form.claudeArgsInput}
          onChange={(e) =>
            onFormChange({ claudeArgsInput: e.currentTarget.value })
          }
          autoComplete="off"
        />
      </div>
    </div>
  );
}

const CustomizeSessionDialog = forwardRef<CustomizeSessionDialogHandle, Props>(
  function CustomizeSessionDialog({ onSessionCreated }, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const [workspacePath, setWorkspacePath] = useState('');
    const [worktreePath, setWorktreePath] = useState<string | null>(null);
    const [workspaceName, setWorkspaceName] = useState('');
    const [form, setForm] = useState<FormState>(defaultForm());
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      async open(
        workspace: { name: string; path: string },
        nextWorktreePath?: string | null,
        preselectedFramework?: AgentType
      ) {
        setError(null);
        setForm(defaultForm());
        setWorkspacePath(workspace.path);
        setWorktreePath(nextWorktreePath ?? null);
        setWorkspaceName(workspace.name);
        await useConfigStore.getState().refreshConfig();
        const config = useConfigStore.getState();
        setForm({
          claudeArgsInput: '',
          selectedAgent:
            preselectedFramework ?? (config.defaultAgent as AgentType),
          yoloMode: config.defaultYolo,
          continueExisting: config.defaultContinue,
        });
        shellRef.current?.open();
      },
      close() {
        shellRef.current?.close();
      },
    }));

    async function handleSubmit() {
      if (!workspacePath || creating) return;
      setCreating(true);
      setError(null);
      const { session, error: submitError } = await createSessionFromForm(
        workspacePath,
        worktreePath,
        form
      );
      try {
        if (submitError && !session) {
          setError(
            submitError instanceof Error
              ? submitError.message
              : 'Failed to create session'
          );
          return;
        }
        shellRef.current?.close();
        if (session?.id) onSessionCreated?.(session.id);
      } finally {
        setCreating(false);
      }
    }

    const footer = (
      <div className="customize-session-footer-row">
        <TuiButton
          variant="ghost"
          onClick={() => shellRef.current?.close()}
          disabled={creating}
        >
          Cancel
        </TuiButton>
        <TuiButton
          variant="primary"
          data-track="dialog.customize-session.create"
          onClick={handleSubmit}
          disabled={!workspacePath || creating}
        >
          {creating ? 'Creating...' : 'Start Session'}
        </TuiButton>
      </div>
    );

    return (
      <DialogShell
        ref={shellRef}
        width="480px"
        title="Customize Session"
        footer={footer}
      >
        {error && (
          <div className="customize-session-error" role="alert">
            {error}
          </div>
        )}
        <CustomizeSessionBody
          workspaceName={workspaceName}
          form={form}
          onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        />
      </DialogShell>
    );
  }
);

export default CustomizeSessionDialog;
