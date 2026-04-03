import React, { useState } from 'react';
import TuiCheckbox from '../TuiCheckbox.js';
import type { BranchInfo } from '../../lib/types.js';
import './WorkspaceEditor.css';

export interface WorkspaceEditorValues {
  defaultBranch: string;
  remote: string;
  branchPrefix: string;
  defaultAgent: 'claude' | 'codex' | 'opencode';
  defaultContinue: boolean;
  defaultYolo: boolean;
  launchInTmux: boolean;
  promptCodeReview: string;
  promptCreatePr: string;
  promptBranchRename: string;
  promptGeneral: string;
}

type ChangeHandler = <K extends keyof WorkspaceEditorValues>(key: K, value: WorkspaceEditorValues[K]) => void;

interface Props {
  values: WorkspaceEditorValues;
  onChange: ChangeHandler;
  branches: BranchInfo[];
  overriddenKeys: string[];
  error?: string;
}

interface PromptGroupProps {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}

function PromptGroup({ label, value, placeholder, onChange }: PromptGroupProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="workspace-editor__prompt-group">
      <button className="workspace-editor__prompt-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="workspace-editor__prompt-arrow">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && <textarea className="workspace-editor__prompt-textarea" rows={3} placeholder={placeholder} value={value} onChange={(e) => onChange(e.currentTarget.value)} />}
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
        <label className="workspace-editor__field-label" htmlFor="ws-default-branch">Branch new worktrees from</label>
        <select id="ws-default-branch" className="workspace-editor__field-select" value={values.defaultBranch} onChange={(e) => onChange('defaultBranch', e.currentTarget.value)}>
          <option value="">-- auto --</option>
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          {values.defaultBranch && !branches.some((b) => b.name === values.defaultBranch) && (
            <option value={values.defaultBranch}>{values.defaultBranch}</option>
          )}
        </select>
      </div>
      <div className="workspace-editor__field">
        <label className="workspace-editor__field-label" htmlFor="ws-remote">Remote origin</label>
        <input id="ws-remote" type="text" className="workspace-editor__field-input" placeholder="origin" value={values.remote} onChange={(e) => onChange('remote', e.currentTarget.value)} />
      </div>
      <div className="workspace-editor__field">
        <label className="workspace-editor__field-label" htmlFor="ws-branch-prefix">Branch prefix</label>
        <input id="ws-branch-prefix" type="text" className="workspace-editor__field-input" placeholder="e.g. dy/" value={values.branchPrefix} onChange={(e) => onChange('branchPrefix', e.currentTarget.value)} />
      </div>
    </section>
  );
}

const SESSION_DEFAULT_KEYS = ['defaultAgent', 'defaultContinue', 'defaultYolo', 'launchInTmux'];

interface SessionDefaultsSectionProps {
  values: WorkspaceEditorValues;
  overriddenKeys: string[];
  onChange: ChangeHandler;
}

function SessionDefaultsSection({ values, overriddenKeys, onChange }: SessionDefaultsSectionProps) {
  const hasOverride = overriddenKeys.some((k) => SESSION_DEFAULT_KEYS.includes(k));
  return (
    <section className="workspace-editor__section">
      <h3 className="workspace-editor__section-label">
        session defaults
        {hasOverride && <span className="workspace-editor__override-badge">overridden</span>}
      </h3>
      <div className="workspace-editor__inline-row">
        <label className="workspace-editor__field-label" htmlFor="ws-agent">Default agent</label>
        <select id="ws-agent" className={['workspace-editor__field-select', 'workspace-editor__field-select-inline'].join(' ')} value={values.defaultAgent} onChange={(e) => onChange('defaultAgent', e.currentTarget.value as 'claude' | 'codex' | 'opencode')}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
      </div>
      <div className="workspace-editor__checkbox-row">
        <TuiCheckbox checked={values.defaultContinue} onChange={(v) => onChange('defaultContinue', v)}>Continue</TuiCheckbox>
        <TuiCheckbox checked={values.defaultYolo} onChange={(v) => onChange('defaultYolo', v)}>YOLO</TuiCheckbox>
        <TuiCheckbox checked={values.launchInTmux} onChange={(v) => onChange('launchInTmux', v)}>Tmux</TuiCheckbox>
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
      <PromptGroup label="Code review preferences" value={values.promptCodeReview} placeholder="e.g. focus on security, error handling" onChange={(v) => onChange('promptCodeReview', v)} />
      <PromptGroup label="Create PR preferences" value={values.promptCreatePr} placeholder="e.g. include test plan section" onChange={(v) => onChange('promptCreatePr', v)} />
      <PromptGroup label="Branch rename preferences" value={values.promptBranchRename} placeholder="e.g. prefix with dy/, use conventional commits style" onChange={(v) => onChange('promptBranchRename', v)} />
      <PromptGroup label="General preferences" value={values.promptGeneral} placeholder="e.g. use TypeScript, follow CLAUDE.md" onChange={(v) => onChange('promptGeneral', v)} />
    </section>
  );
}

export default function WorkspaceEditor({ values, onChange, branches, overriddenKeys, error }: Props) {
  return (
    <div className="workspace-editor">
      {error && <p className="workspace-editor__error-msg">{error}</p>}
      <GitSettingsSection values={values} branches={branches} onChange={onChange} />
      <div className="workspace-editor__divider" />
      <SessionDefaultsSection values={values} overriddenKeys={overriddenKeys} onChange={onChange} />
      <div className="workspace-editor__divider" />
      <PromptsSection values={values} onChange={onChange} />
    </div>
  );
}
