import React, { useCallback, useEffect, useState } from 'react';
import { fetchAutomations, updateAutomations } from '../lib/api.js';
import type { AutomationSettings } from '../lib/types.js';
import { TuiCheckbox } from './TuiCheckbox.js';
import './AutomationPanel.css';

type QueryStatus = 'loading' | 'error' | 'success';
type MutationStatus = 'idle' | 'pending' | 'error';

function useAutomationSettings() {
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [queryStatus, setQueryStatus] = useState<QueryStatus>('loading');
  const [mutationStatus, setMutationStatus] = useState<MutationStatus>('idle');

  const load = useCallback(() => {
    setQueryStatus('loading');
    fetchAutomations()
      .then((data) => {
        setSettings(data);
        setQueryStatus('success');
      })
      .catch(() => {
        setQueryStatus('error');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mutate = useCallback((patch: Partial<AutomationSettings>) => {
    setMutationStatus('pending');
    updateAutomations(patch)
      .then((data) => {
        setSettings(data);
        setMutationStatus('idle');
      })
      .catch(() => {
        setMutationStatus('error');
        load();
      });
  }, [load]);

  return { settings, queryStatus, mutationStatus, retry: load, resetMutation: () => setMutationStatus('idle'), mutate };
}

interface ToggleRowProps {
  checked: boolean;
  disabled: boolean;
  label: string;
  desc: string;
  dimmed?: boolean;
  onChange: () => void;
}

function ToggleRow({ checked, disabled, label, desc, dimmed, onChange }: ToggleRowProps) {
  return (
    <div className={['toggle-row', dimmed && 'toggle-row--disabled'].filter(Boolean).join(' ')}>
      <TuiCheckbox checked={checked} disabled={disabled} onChange={onChange}>
        <div className="toggle-info">
          <span className="toggle-label">{label}</span>
          <span className="toggle-desc">{desc}</span>
        </div>
      </TuiCheckbox>
    </div>
  );
}

export interface AutomationPanelProps {
  className?: string;
}

export function AutomationPanel({ className }: AutomationPanelProps) {
  const { settings, queryStatus, mutationStatus, retry, resetMutation, mutate } = useAutomationSettings();

  const isPending = mutationStatus === 'pending';

  const toggleAutoCheckout = useCallback(() => {
    if (!settings) return;
    const next = !settings.autoCheckoutReviewRequests;
    mutate({
      autoCheckoutReviewRequests: next,
      ...(!next ? { autoReviewOnCheckout: false } : {}),
    });
  }, [settings, mutate]);

  const toggleAutoReview = useCallback(() => {
    if (!settings) return;
    mutate({ autoReviewOnCheckout: !settings.autoReviewOnCheckout });
  }, [settings, mutate]);

  return (
    <div className={['automation-panel', className].filter(Boolean).join(' ')}>
      <div className="panel-header">
        <span className="panel-title">Automations</span>
      </div>

      {queryStatus === 'loading' && (
        <div className="panel-loading">Loading...</div>
      )}

      {queryStatus === 'error' && (
        <div className="panel-error">
          <span>Failed to load settings.</span>
          <button className="retry-btn" onClick={retry}>Retry</button>
        </div>
      )}

      {queryStatus === 'success' && settings && (
        <div className="toggle-list">
          <ToggleRow
            checked={settings.autoCheckoutReviewRequests ?? false}
            disabled={isPending}
            label="Auto-checkout review requests"
            desc="Create a worktree when you're requested as a PR reviewer"
            onChange={toggleAutoCheckout}
          />
          <ToggleRow
            checked={settings.autoReviewOnCheckout ?? false}
            disabled={!settings.autoCheckoutReviewRequests || isPending}
            dimmed={!settings.autoCheckoutReviewRequests}
            label="Auto-review on checkout"
            desc="Run your code review prompt when a review worktree is created"
            onChange={toggleAutoReview}
          />
          {mutationStatus === 'error' && (
            <div className="panel-error">
              <span>Failed to update settings.</span>
              <button className="retry-btn" onClick={resetMutation}>Dismiss</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AutomationPanel;
