import React, { useEffect, useState } from 'react';
import TuiCheckbox from '../TuiCheckbox.js';
import type { BranchInfo } from '../../lib/types.js';
import { useConfigStore } from '../../lib/stores/config.js';
import { isFrameworkAvailable } from './CustomizeSessionDialog.js';
import './WorkspaceEditor.css';

export interface WorkspaceEditorValues {
  defaultBranch: string;
  remote: string;
  branchPrefix: string;
  defaultAgent: string;
  defaultContinue: boolean;
  defaultYolo: boolean;
  promptCodeReview: string;
  promptCreatePr: string;
  promptBranchRename: string;
  promptGeneral: string;
  portVariables: string[];
}

type ChangeHandler = <K extends keyof WorkspaceEditorValues>(
  key: K,
  value: WorkspaceEditorValues[K]
) => void;

export const WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS = {
  remote: 'default: origin',
  branchPrefix: 'default: none',
  prompt: 'default: none',
  portVariable: 'additional var (default: PORT)',
} as const;

interface Props {
  values: WorkspaceEditorValues;
  onChange: ChangeHandler;
  branches: BranchInfo[];
  overriddenKeys: string[];
  error?: string;
  /** Called when validation state changes, with map of field -> error message (empty if valid) */
  onValidationChange?: (errors: Record<string, string>) => void;
}

interface PromptGroupProps {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}

function PromptGroup({
  label,
  value,
  placeholder,
  onChange,
}: PromptGroupProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="workspace-editor__prompt-group">
      <button
        className="workspace-editor__prompt-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="workspace-editor__prompt-arrow">
          {open ? '▾' : '▸'}
        </span>
        {label}
      </button>
      {open && (
        <textarea
          className="workspace-editor__prompt-textarea"
          rows={3}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
    </div>
  );
}

interface GitSectionProps {
  values: WorkspaceEditorValues;
  branches: BranchInfo[];
  onChange: ChangeHandler;
}

function GitSettingsSection({ values, branches, onChange }: GitSectionProps) {
  return (
    <section className="workspace-editor__section">
      <h3 className="workspace-editor__section-label">git settings</h3>
      <div className="workspace-editor__field">
        <label
          className="workspace-editor__field-label"
          htmlFor="ws-default-branch"
        >
          Branch new worktrees from
        </label>
        <select
          id="ws-default-branch"
          className="workspace-editor__field-select"
          value={values.defaultBranch}
          onChange={(e) => onChange('defaultBranch', e.currentTarget.value)}
        >
          <option value="">-- auto --</option>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
          {values.defaultBranch &&
            !branches.some((b) => b.name === values.defaultBranch) && (
              <option value={values.defaultBranch}>
                {values.defaultBranch}
              </option>
            )}
        </select>
      </div>
      <div className="workspace-editor__field">
        <label className="workspace-editor__field-label" htmlFor="ws-remote">
          Remote origin
        </label>
        <input
          id="ws-remote"
          type="text"
          className="workspace-editor__field-input"
          placeholder={WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.remote}
          value={values.remote}
          onChange={(e) => onChange('remote', e.currentTarget.value)}
        />
      </div>
      <div className="workspace-editor__field">
        <label
          className="workspace-editor__field-label"
          htmlFor="ws-branch-prefix"
        >
          Branch prefix
        </label>
        <input
          id="ws-branch-prefix"
          type="text"
          className="workspace-editor__field-input"
          placeholder={WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.branchPrefix}
          value={values.branchPrefix}
          onChange={(e) => onChange('branchPrefix', e.currentTarget.value)}
        />
      </div>
    </section>
  );
}

const SESSION_DEFAULT_KEYS = ['defaultAgent', 'defaultContinue', 'defaultYolo'];

interface SessionDefaultsSectionProps {
  values: WorkspaceEditorValues;
  overriddenKeys: string[];
  onChange: ChangeHandler;
}

function SessionDefaultsSection({
  values,
  overriddenKeys,
  onChange,
}: SessionDefaultsSectionProps) {
  const frameworks = useConfigStore((state) => state.frameworks);
  const hasOverride = overriddenKeys.some((k) =>
    SESSION_DEFAULT_KEYS.includes(k)
  );
  return (
    <section className="workspace-editor__section">
      <h3 className="workspace-editor__section-label">
        session defaults
        {hasOverride && (
          <span className="workspace-editor__override-badge">overridden</span>
        )}
      </h3>
      <div className="workspace-editor__inline-row">
        <label className="workspace-editor__field-label" htmlFor="ws-agent">
          Default agent
        </label>
        <select
          id="ws-agent"
          className={[
            'workspace-editor__field-select',
            'workspace-editor__field-select-inline',
          ].join(' ')}
          value={values.defaultAgent}
          onChange={(e) => onChange('defaultAgent', e.currentTarget.value)}
        >
          {(frameworks.length > 0
            ? frameworks
            : [
                { id: 'claude', displayName: 'Claude' },
                { id: 'codex', displayName: 'Codex' },
                { id: 'opencode', displayName: 'OpenCode' },
              ]
          ).map((framework) => (
            <option
              key={framework.id}
              value={framework.id}
              disabled={
                'availability' in framework &&
                !isFrameworkAvailable(framework as (typeof frameworks)[number])
              }
            >
              {framework.displayName}
              {'availability' in framework &&
              !isFrameworkAvailable(framework as (typeof frameworks)[number])
                ? ' (not installed)'
                : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="workspace-editor__checkbox-row">
        <TuiCheckbox
          checked={values.defaultContinue}
          onChange={(v) => onChange('defaultContinue', v)}
        >
          Continue
        </TuiCheckbox>
        <TuiCheckbox
          checked={values.defaultYolo}
          onChange={(v) => onChange('defaultYolo', v)}
        >
          YOLO
        </TuiCheckbox>
      </div>
    </section>
  );
}

interface PromptsSectionProps {
  values: WorkspaceEditorValues;
  onChange: ChangeHandler;
}

function PromptsSection({ values, onChange }: PromptsSectionProps) {
  return (
    <section className="workspace-editor__section">
      <h3 className="workspace-editor__section-label">prompts</h3>
      <PromptGroup
        label="Code review preferences"
        value={values.promptCodeReview}
        placeholder={WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.prompt}
        onChange={(v) => onChange('promptCodeReview', v)}
      />
      <PromptGroup
        label="Create PR preferences"
        value={values.promptCreatePr}
        placeholder={WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.prompt}
        onChange={(v) => onChange('promptCreatePr', v)}
      />
      <PromptGroup
        label="Branch rename preferences"
        value={values.promptBranchRename}
        placeholder={WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.prompt}
        onChange={(v) => onChange('promptBranchRename', v)}
      />
      <PromptGroup
        label="General preferences"
        value={values.promptGeneral}
        placeholder={WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.prompt}
        onChange={(v) => onChange('promptGeneral', v)}
      />
    </section>
  );
}

/** Validation regex for env var names: must start with uppercase letter, followed by uppercase letters, digits, or underscores */
const ENV_VAR_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/** Validate a single env var name, returns error message or empty string if valid */
export function validateEnvPortVarName(name: string): string {
  if (!name.trim()) return 'Name cannot be empty';
  if (!ENV_VAR_NAME_REGEX.test(name)) {
    return 'Must start with uppercase letter and contain only A-Z, 0-9, _';
  }
  return '';
}

/** Validate all env port var names, returns map of index -> error message */
export function validateEnvPortVarNames(
  names: string[]
): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();

  names.forEach((name, index) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return; // Empty entries are allowed (will be filtered on save)
    }
    if (!ENV_VAR_NAME_REGEX.test(trimmed)) {
      errors[index] = 'Invalid format';
    }
    if (seen.has(trimmed)) {
      errors[index] = 'Duplicate';
    }
    seen.add(trimmed);
  });

  return errors;
}

interface EnvironmentPortsSectionProps {
  values: WorkspaceEditorValues;
  onChange: ChangeHandler;
  onValidationChange?: ((errors: Record<string, string>) => void) | undefined;
}

function EnvironmentPortsSection({
  values,
  onChange,
  onValidationChange,
}: EnvironmentPortsSectionProps) {
  const [newName, setNewName] = useState('');
  const [newNameError, setNewNameError] = useState('');

  useEffect(() => {
    const allErrors = validateEnvPortVarNames(values.portVariables);
    onValidationChange?.(
      Object.keys(allErrors).length > 0
        ? { portVariables: `${Object.keys(allErrors).length} invalid entries` }
        : {}
    );
  }, [values.portVariables, onValidationChange]);

  function handleAdd() {
    const trimmed = newName.trim();
    if (!trimmed) return;

    const validationError = validateEnvPortVarName(trimmed);
    if (validationError) {
      setNewNameError(validationError);
      return;
    }

    if (values.portVariables.includes(trimmed)) {
      setNewNameError('Already in list');
      return;
    }

    const updated = [...values.portVariables, trimmed];
    onChange('portVariables', updated);
    setNewName('');
    setNewNameError('');
  }

  function handleRemove(index: number) {
    const updated = values.portVariables.filter((_, i) => i !== index);
    onChange('portVariables', updated);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  }

  return (
    <section className="workspace-editor__section">
      <h3 className="workspace-editor__section-label">environment ports</h3>
      <p className="workspace-editor__hint">
        Environment variable names to scan for port allocation. Default:{' '}
        <code>PORT</code>
      </p>
      <div className="workspace-editor__list">
        {values.portVariables.length === 0 ? (
          <div className="workspace-editor__list-empty">
            using default: <code>PORT</code>
          </div>
        ) : (
          values.portVariables.map((name, index) => (
            <div key={index} className="workspace-editor__list-item">
              <span className="workspace-editor__list-item-value">{name}</span>
              <button
                type="button"
                className="workspace-editor__list-item-remove"
                onClick={() => handleRemove(index)}
                aria-label={`Remove ${name}`}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
      <div className="workspace-editor__add-row">
        <input
          type="text"
          className={`workspace-editor__field-input workspace-editor__add-input${newNameError ? ' workspace-editor__field-input--error' : ''}`}
          placeholder={WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.portVariable}
          value={newName}
          onChange={(e) => {
            setNewName(e.currentTarget.value);
            setNewNameError('');
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="workspace-editor__add-btn"
          onClick={handleAdd}
          disabled={!newName.trim()}
        >
          Add
        </button>
      </div>
      {newNameError && (
        <p className="workspace-editor__field-error">{newNameError}</p>
      )}
    </section>
  );
}

export default function WorkspaceEditor({
  values,
  onChange,
  branches,
  overriddenKeys,
  error,
  onValidationChange,
}: Props) {
  return (
    <div className="workspace-editor">
      {error && <p className="workspace-editor__error-msg">{error}</p>}
      <GitSettingsSection
        values={values}
        branches={branches}
        onChange={onChange}
      />
      <div className="workspace-editor__divider" />
      <SessionDefaultsSection
        values={values}
        overriddenKeys={overriddenKeys}
        onChange={onChange}
      />
      <div className="workspace-editor__divider" />
      <EnvironmentPortsSection
        values={values}
        onChange={onChange}
        onValidationChange={onValidationChange}
      />
      <div className="workspace-editor__divider" />
      <PromptsSection values={values} onChange={onChange} />
    </div>
  );
}
