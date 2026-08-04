import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJiraStatuses } from '../lib/api.js';
import type { JiraStatus } from '../lib/types.js';
import { TuiButton } from './TuiButton.js';
import './StatusMappingModal.css';

export interface StatusMappingModalProps {
  provider: 'jira';
  open: boolean;
  onClose: () => void;
  onSave: (mappings: Record<string, string>) => void;
  projectKey?: string;
}

type LoadStatus = 'loading' | 'error' | 'done';

const FIELD_ROWS: Array<{ key: string; label: string }> = [
  { key: 'in-progress', label: 'In Progress' },
  { key: 'code-review', label: 'Code Review' },
  { key: 'ready-for-qa', label: 'Ready for QA' },
];

const INITIAL_MAPPINGS: Record<string, string> = {
  'in-progress': '',
  'code-review': '',
  'ready-for-qa': '',
};

function useStatusLoader(open: boolean, projectKey: string | undefined) {
  const [statuses, setStatuses] = useState<JiraStatus[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoadStatus('loading');
    setErrorMsg(null);
    setStatuses([]);

    const key = projectKey ?? '';
    if (!key) {
      setErrorMsg('Configure a Jira project key first (set integrations.jira.projectKey in config).');
      setLoadStatus('error');
      return;
    }

    fetchJiraStatuses(key)
      .then((result) => {
        setStatuses(result);
        setLoadStatus('done');
      })
      .catch((err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load Jira statuses');
        setLoadStatus('error');
      });
  }, [open, projectKey]);

  return { statuses, loadStatus, errorMsg };
}

function ModalBody({
  loadStatus,
  errorMsg,
  statuses,
  mappings,
  onMappingChange,
}: {
  loadStatus: LoadStatus;
  errorMsg: string | null;
  statuses: JiraStatus[];
  mappings: Record<string, string>;
  onMappingChange: (key: string, value: string) => void;
}) {
  if (loadStatus === 'loading') {
    return <div className="loading-msg">Loading statuses...</div>;
  }
  if (loadStatus === 'error') {
    return <div className="error-msg">{errorMsg}</div>;
  }
  return (
    <>
      {FIELD_ROWS.map((row) => (
        <div className="field" key={row.key}>
          <label className="field-label" htmlFor={`mapping-${row.key}`}>{row.label}</label>
          <select
            id={`mapping-${row.key}`}
            className="field-select"
            value={mappings[row.key] ?? ''}
            onChange={(e) => onMappingChange(row.key, e.target.value)}
          >
            <option value="">Not mapped</option>
            {statuses.map((status) => (
              <option key={status.id} value={status.name}>{status.name}</option>
            ))}
          </select>
        </div>
      ))}
    </>
  );
}

export function StatusMappingModal({ provider: _provider, open, onClose, onSave, projectKey }: StatusMappingModalProps) {
  const [mappings, setMappings] = useState<Record<string, string>>(INITIAL_MAPPINGS);
  const { statuses, loadStatus, errorMsg } = useStatusLoader(open, projectKey);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [open, onClose]);

  const handleMappingChange = useCallback((key: string, value: string) => {
    setMappings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(() => {
    onSave({ ...mappings });
    onClose();
  }, [mappings, onSave, onClose]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="status-mapping-modal-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className="status-mapping-modal">
        <div className="modal-header">
          <span className="modal-title">Map Jira Statuses</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <ModalBody
            loadStatus={loadStatus}
            errorMsg={errorMsg}
            statuses={statuses}
            mappings={mappings}
            onMappingChange={handleMappingChange}
          />
        </div>
        <div className="modal-footer">
          <TuiButton variant="ghost" onClick={onClose}>Cancel</TuiButton>
          <TuiButton variant="primary" onClick={handleSave} disabled={loadStatus === 'loading'}>Save</TuiButton>
        </div>
      </div>
    </div>
  );
}

export default StatusMappingModal;
