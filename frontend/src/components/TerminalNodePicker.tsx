import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchHubNodes } from '../lib/api.js';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type { HubNodeSummary } from '../../../shared/relay-node-protocol.js';
import useClickOutside from '../hooks/useClickOutside.js';
import './TerminalNodePicker.css';

export interface TerminalNodePickerProps {
  /**
   * Invoked with the chosen nodeId. Pass DEFAULT_LOCAL_NODE_ID for "this host".
   * Empty fires when picker has no remote nodes — the caller may default to
   * hub-local without prompting.
   */
  onSelect: (nodeId: string) => void;
  /** Label for the trigger button. */
  triggerLabel?: string;
  /** Optional ARIA label for the trigger. */
  triggerAriaLabel?: string;
  /** Optional className for the trigger. */
  triggerClassName?: string;
}

export interface NodeChoice {
  nodeId: string;
  label: string;
  status: 'this host' | HubNodeSummary['status'];
  disabled: boolean;
  disabledReason?: string;
}

export function buildChoices(nodes: HubNodeSummary[]): NodeChoice[] {
  const choices: NodeChoice[] = [
    {
      nodeId: DEFAULT_LOCAL_NODE_ID,
      label: 'this host',
      status: 'this host',
      disabled: false,
    },
  ];
  for (const node of nodes) {
    const online = node.status === 'online';
    choices.push({
      nodeId: node.nodeId,
      label: node.displayName || node.nodeId,
      status: node.status,
      disabled: !online,
      ...(online ? {} : { disabledReason: node.status }),
    });
  }
  return choices;
}

export function TerminalNodePicker({
  onSelect,
  triggerLabel = '+',
  triggerAriaLabel = 'add terminal on node',
  triggerClassName,
}: TerminalNodePickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapperRef, () => setOpen(false), open);

  const { data: nodes = [] } = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const choices = useMemo(() => buildChoices(nodes), [nodes]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const handleSelect = (choice: NodeChoice) => {
    if (choice.disabled) return;
    setOpen(false);
    onSelect(choice.nodeId);
  };

  return (
    <div ref={wrapperRef} className="ws-node-picker">
      <button
        type="button"
        className={triggerClassName ?? 'ws-tabs__add'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerAriaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLabel}
      </button>
      {open && (
        <div role="listbox" className="ws-node-picker__menu">
          <div className="ws-node-picker__hint">new terminal on…</div>
          {choices.map((choice) => (
            <button
              key={choice.nodeId}
              type="button"
              role="option"
              aria-selected={false}
              aria-disabled={choice.disabled}
              disabled={choice.disabled}
              className="ws-node-picker__item"
              onClick={() => handleSelect(choice)}
              title={
                choice.disabledReason
                  ? `node ${choice.label} is ${choice.disabledReason}`
                  : undefined
              }
            >
              <span
                className={`ws-node-picker__dot ws-node-picker__dot--${choice.status === 'this host' ? 'local' : choice.status}`}
                aria-hidden
              />
              <span className="ws-node-picker__label">{choice.label}</span>
              {choice.status !== 'this host' && (
                <span className="ws-node-picker__status">{choice.status}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default TerminalNodePicker;
