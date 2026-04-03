import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import TuiButton from '../TuiButton.js';
import WorkspaceEditor, { type WorkspaceEditorValues } from './WorkspaceEditor.js';
import { updateWorkspaceSettings, fetchBranches, fetchMergedWorkspaceSettings } from '../../lib/api.js';
import type { WorkspaceSettings, BranchInfo } from '../../lib/types.js';
import './WorkspaceSettingsDialog.css';

export interface WorkspaceSettingsDialogHandle {
  open(path: string, name: string): Promise<void>;
  close(): void;
}

interface Props {
  onRemoveWorkspace: (path: string) => void;
}

const EMPTY_VALUES: WorkspaceEditorValues = {
  defaultBranch: '', remote: '', branchPrefix: '', defaultAgent: 'claude',
  defaultContinue: false, defaultYolo: false, launchInTmux: false,
  promptCodeReview: '', promptCreatePr: '', promptBranchRename: '', promptGeneral: '',
};

const SESSION_DEFAULT_KEYS = ['defaultAgent', 'defaultContinue', 'defaultYolo', 'launchInTmux'];

function settingsToValues(s: WorkspaceSettings): WorkspaceEditorValues {
  return {
    defaultBranch: s.defaultBranch ?? '', remote: s.remote ?? '', branchPrefix: s.branchPrefix ?? '',
    defaultAgent: (s.defaultAgent === 'codex' ? 'codex' : 'claude') as 'claude' | 'codex', defaultContinue: s.defaultContinue ?? false,
    defaultYolo: s.defaultYolo ?? false, launchInTmux: s.launchInTmux ?? false,
    promptCodeReview: s.promptCodeReview ?? '', promptCreatePr: s.promptCreatePr ?? '',
    promptBranchRename: s.promptBranchRename ?? '', promptGeneral: s.promptGeneral ?? '',
  };
}

function buildSavePayload(values: WorkspaceEditorValues, original: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  if (values.defaultAgent !== original['defaultAgent']) settings['defaultAgent'] = values.defaultAgent;
  if (values.defaultContinue !== original['defaultContinue']) settings['defaultContinue'] = values.defaultContinue;
  if (values.defaultYolo !== original['defaultYolo']) settings['defaultYolo'] = values.defaultYolo;
  if (values.launchInTmux !== original['launchInTmux']) settings['launchInTmux'] = values.launchInTmux;
  if (values.defaultBranch) settings['defaultBranch'] = values.defaultBranch;
  if (values.remote) settings['remote'] = values.remote;
  if (values.branchPrefix) settings['branchPrefix'] = values.branchPrefix;
  if (values.promptCodeReview) settings['promptCodeReview'] = values.promptCodeReview;
  if (values.promptCreatePr) settings['promptCreatePr'] = values.promptCreatePr;
  if (values.promptBranchRename) settings['promptBranchRename'] = values.promptBranchRename;
  if (values.promptGeneral) settings['promptGeneral'] = values.promptGeneral;
  return settings;
}

interface DialogHeaderProps {
  workspaceName: string;
  onClose: () => void;
}

function DialogHeader({ workspaceName, onClose }: DialogHeaderProps) {
  return (
    <div className="workspace-settings-dialog-header">
      <h2 className="workspace-settings-dialog-title">
        <span className="workspace-settings-gear-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" width="14" height="14">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
        {workspaceName}
      </h2>
      <button className="workspace-settings-close-btn" aria-label="Close settings" onClick={onClose}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" width="14" height="14">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

const WorkspaceSettingsDialog = forwardRef<WorkspaceSettingsDialogHandle, Props>(
  function WorkspaceSettingsDialog({ onRemoveWorkspace }, ref) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const [workspacePath, setWorkspacePath] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [branches, setBranches] = useState<BranchInfo[]>([]);
    const [overriddenKeys, setOverriddenKeys] = useState<string[]>([]);
    const [originalSettings, setOriginalSettings] = useState<Record<string, unknown>>({});
    const [values, setValues] = useState<WorkspaceEditorValues>(EMPTY_VALUES);

    useImperativeHandle(ref, () => ({
      async open(path: string, name: string) {
        setWorkspacePath(path); setWorkspaceName(name);
        setError(''); setSaveSuccess(false); setSaving(false); setValues(EMPTY_VALUES);
        dialogRef.current?.showModal();
        try {
          const [mergedResult, branchList] = await Promise.all([
            fetchMergedWorkspaceSettings(path),
            fetchBranches(path).catch(() => [] as BranchInfo[]),
          ]);
          setBranches(branchList);
          setValues(settingsToValues(mergedResult.settings));
          setOriginalSettings({ defaultAgent: mergedResult.settings.defaultAgent, defaultContinue: mergedResult.settings.defaultContinue, defaultYolo: mergedResult.settings.defaultYolo, launchInTmux: mergedResult.settings.launchInTmux });
          setOverriddenKeys(mergedResult.overridden);
        } catch {
          setError('Failed to load workspace settings.');
        }
      },
      close() { dialogRef.current?.close(); },
    }));

    function handleChange<K extends keyof WorkspaceEditorValues>(key: K, value: WorkspaceEditorValues[K]) {
      setValues((prev) => ({ ...prev, [key]: value }));
    }

    async function handleSave() {
      setSaving(true); setError(''); setSaveSuccess(false);
      try {
        const settings = buildSavePayload(values, originalSettings);
        if (Object.keys(settings).length > 0) await updateWorkspaceSettings(workspacePath, settings);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save settings.');
      } finally { setSaving(false); }
    }

    async function handleResetSessionDefaults() {
      setSaving(true); setError('');
      try {
        await updateWorkspaceSettings(workspacePath, { defaultAgent: null, defaultContinue: null, defaultYolo: null, launchInTmux: null } as unknown as Record<string, unknown>);
        const merged = await fetchMergedWorkspaceSettings(workspacePath);
        setValues(settingsToValues(merged.settings));
        setOriginalSettings({ defaultAgent: merged.settings.defaultAgent, defaultContinue: merged.settings.defaultContinue, defaultYolo: merged.settings.defaultYolo, launchInTmux: merged.settings.launchInTmux });
        setOverriddenKeys(merged.overridden);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reset settings.');
      } finally { setSaving(false); }
    }

    const hasOverriddenDefaults = overriddenKeys.some((k) => SESSION_DEFAULT_KEYS.includes(k));

    return (
      <dialog ref={dialogRef} className="workspace-settings-dialog" onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
        <div className="workspace-settings-dialog-content">
          <DialogHeader workspaceName={workspaceName} onClose={() => dialogRef.current?.close()} />
          <div className="workspace-settings-dialog-body">
            <WorkspaceEditor values={values} onChange={handleChange} branches={branches} overriddenKeys={overriddenKeys} error={error} />
          </div>
          <div className="workspace-settings-dialog-footer">
            <TuiButton variant="danger" onClick={() => { dialogRef.current?.close(); onRemoveWorkspace(workspacePath); }}>Remove Workspace</TuiButton>
            <div className="workspace-settings-footer-right">
              {hasOverriddenDefaults && <TuiButton variant="ghost" onClick={() => void handleResetSessionDefaults()} disabled={saving}>Reset to Global</TuiButton>}
              {saveSuccess && <span className="workspace-settings-save-success">Saved</span>}
              <TuiButton variant="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving\u2026' : 'Save'}</TuiButton>
            </div>
          </div>
        </div>
      </dialog>
    );
  },
);

export default WorkspaceSettingsDialog;
