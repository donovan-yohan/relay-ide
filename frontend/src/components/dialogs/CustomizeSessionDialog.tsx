import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import TuiCheckbox from '../TuiCheckbox.js';
import { estimateTerminalDimensions } from '../../lib/utils.js';
import { useConfigStore } from '../../lib/stores/config.js';
import { useUiStore } from '../../lib/stores/ui.js';
import { createAgentSession } from '../../lib/session-utils.js';
import type { AgentType, FrameworkInfo } from '../../lib/types.js';
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

type SessionLaunchMode = 'pty' | 'web';

export interface SessionModeOption {
  value: SessionLaunchMode;
  label: string;
  disabled?: boolean;
  reason?: string;
}

export function isFrameworkAvailable(framework: FrameworkInfo): boolean {
  return framework.availability?.installed !== false;
}

export function isFrameworkWebAvailable(framework: FrameworkInfo): boolean {
  return framework.webAvailability?.available !== false;
}

export function selectLaunchAgent(
  frameworks: FrameworkInfo[],
  preferredAgent: AgentType
): AgentType {
  const preferred = frameworks.find((f) => f.id === preferredAgent);
  if (!preferred || isFrameworkAvailable(preferred)) return preferredAgent;
  return frameworks.find(isFrameworkAvailable)?.id ?? preferredAgent;
}

export function getSessionModeOptions(
  frameworks: FrameworkInfo[],
  selectedAgent: AgentType
): SessionModeOption[] {
  const selectedFramework = frameworks.find((f) => f.id === selectedAgent);
  if (selectedFramework?.capabilities.supportsWebSessions === true) {
    const webAvailable = isFrameworkWebAvailable(selectedFramework);
    return [
      { value: 'pty', label: 'tui' },
      {
        value: 'web',
        label: webAvailable ? 'web' : 'web (unavailable)',
        ...(!webAvailable ? { disabled: true } : {}),
        ...(selectedFramework.webAvailability?.reason
          ? { reason: selectedFramework.webAvailability.reason }
          : {}),
      },
    ];
  }
  return [{ value: 'pty', label: 'tui' }];
}

export function defaultSessionModeForAgent(
  frameworks: FrameworkInfo[],
  selectedAgent: AgentType
): SessionLaunchMode {
  const supportsWeb = getSessionModeOptions(frameworks, selectedAgent).some(
    (option) => option.value === 'web' && !option.disabled
  );
  return selectedAgent === 'hermes' && supportsWeb ? 'web' : 'pty';
}

interface FormState {
  claudeArgsInput: string;
  selectedAgent: AgentType;
  sessionMode: SessionLaunchMode;
  yoloMode: boolean;
  continueExisting: boolean;
}

function defaultForm(): FormState {
  return {
    claudeArgsInput: '',
    selectedAgent: 'claude',
    sessionMode: 'pty',
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
    mode: form.sessionMode,
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
            command: form.selectedAgent,
            capabilities: {
              supportsContinue: false,
              supportsYolo: false,
              supportsHooks: false,
              supportsTelemetry: false,
              supportsWebSessions: false,
            },
            eventSource: 'parser',
          } satisfies FrameworkInfo,
        ];

  const modeOptions = getSessionModeOptions(
    frameworkOptions,
    form.selectedAgent
  );
  const selectedFramework = frameworkOptions.find(
    (framework) => framework.id === form.selectedAgent
  );
  const selectedUnavailable =
    selectedFramework && !isFrameworkAvailable(selectedFramework);
  const selectedWebUnavailable =
    selectedFramework &&
    form.sessionMode === 'web' &&
    !isFrameworkWebAvailable(selectedFramework);

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
          onChange={(e) => {
            const selectedAgent = e.currentTarget.value as AgentType;
            onFormChange({
              selectedAgent,
              sessionMode: defaultSessionModeForAgent(
                frameworkOptions,
                selectedAgent
              ),
            });
          }}
        >
          {frameworkOptions.map((framework) => (
            <option
              key={framework.id}
              value={framework.id}
              disabled={!isFrameworkAvailable(framework)}
            >
              {framework.displayName}
              {!isFrameworkAvailable(framework) ? ' (not installed)' : ''}
            </option>
          ))}
        </select>
        {selectedUnavailable && (
          <div className="customize-session-field-note">
            {selectedFramework.availability?.reason ??
              `${selectedFramework.displayName} is not installed`}
          </div>
        )}
      </div>
      {modeOptions.length > 1 && (
        <div className="customize-session-dialog-field">
          <label className="customize-session-dialog-label" htmlFor="cs-mode">
            interface
          </label>
          <select
            id="cs-mode"
            className="customize-session-dialog-select"
            data-track="dialog.customize-session.mode"
            value={form.sessionMode}
            onChange={(e) =>
              onFormChange({
                sessionMode: e.currentTarget.value as SessionLaunchMode,
              })
            }
          >
            {modeOptions.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
          </select>
          {selectedWebUnavailable && (
            <div className="customize-session-field-note">
              {selectedFramework.webAvailability?.reason ??
                `${selectedFramework.displayName} web runtime is not available`}
            </div>
          )}
        </div>
      )}
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
    const frameworks = useConfigStore((state) => state.frameworks);

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
        const selectedAgent = selectLaunchAgent(
          config.frameworks,
          preselectedFramework ?? (config.defaultAgent as AgentType)
        );
        setForm({
          claudeArgsInput: '',
          selectedAgent,
          sessionMode: defaultSessionModeForAgent(
            config.frameworks,
            selectedAgent
          ),
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
      const selectedFramework = frameworks.find(
        (framework) => framework.id === form.selectedAgent
      );
      if (selectedFramework && !isFrameworkAvailable(selectedFramework)) {
        setError(
          selectedFramework.availability?.reason ??
            `${selectedFramework.displayName} is not installed`
        );
        return;
      }
      if (
        selectedFramework &&
        form.sessionMode === 'web' &&
        !isFrameworkWebAvailable(selectedFramework)
      ) {
        setError(
          selectedFramework.webAvailability?.reason ??
            `${selectedFramework.displayName} web runtime is not available`
        );
        return;
      }
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
          disabled={
            !workspacePath ||
            creating ||
            frameworks.some(
              (framework) =>
                framework.id === form.selectedAgent &&
                (!isFrameworkAvailable(framework) ||
                  (form.sessionMode === 'web' &&
                    !isFrameworkWebAvailable(framework)))
            )
          }
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
