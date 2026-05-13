import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
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

export function firstEnabledIndex(
  choices: NodeChoice[],
  from = 0,
  step = 1
): number {
  for (let i = from; i >= 0 && i < choices.length; i += step) {
    if (!choices[i]?.disabled) return i;
  }
  return -1;
}

export function TerminalNodePicker({
  onSelect,
  triggerLabel = '+',
  triggerAriaLabel = 'add terminal on node',
  triggerClassName,
}: TerminalNodePickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionIdPrefix = useId();
  useClickOutside(wrapperRef, () => setOpen(false), open);

  const { data: nodes = [] } = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const choices = useMemo(() => buildChoices(nodes), [nodes]);

  const optionId = useCallback(
    (i: number) => `${optionIdPrefix}-opt-${i}`,
    [optionIdPrefix]
  );

  // Reset focus to the first enabled option when the menu opens or the
  // choice set changes (paired nodes arrive after the menu is opened).
  useEffect(() => {
    if (!open) {
      setFocusedIndex(-1);
      return;
    }
    setFocusedIndex((prev) => {
      if (prev >= 0 && !choices[prev]?.disabled) return prev;
      return firstEnabledIndex(choices, 0, 1);
    });
  }, [open, choices]);

  // Focus the listbox container so the keyboard handler receives ArrowUp/Down.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const handleSelect = useCallback(
    (choice: NodeChoice | undefined) => {
      if (!choice || choice.disabled) return;
      setOpen(false);
      onSelect(choice.nodeId);
    },
    [onSelect]
  );

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      setFocusedIndex((prev) => {
        const start =
          prev < 0
            ? direction === 1
              ? 0
              : choices.length - 1
            : prev + direction;
        const next = firstEnabledIndex(choices, start, direction);
        return next >= 0 ? next : prev;
      });
    },
    [choices]
  );

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusedIndex(firstEnabledIndex(choices, 0, 1));
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusedIndex(firstEnabledIndex(choices, choices.length - 1, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelect(choices[focusedIndex]);
    }
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
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className="ws-node-picker__menu"
          aria-activedescendant={
            focusedIndex >= 0 ? optionId(focusedIndex) : undefined
          }
          onKeyDown={handleListKeyDown}
        >
          <div className="ws-node-picker__hint">new terminal on…</div>
          {choices.map((choice, i) => {
            const isFocused = i === focusedIndex;
            return (
              <button
                key={choice.nodeId}
                id={optionId(i)}
                type="button"
                role="option"
                aria-selected={isFocused}
                aria-disabled={choice.disabled}
                disabled={choice.disabled}
                className={`ws-node-picker__item${isFocused ? ' ws-node-picker__item--focused' : ''}`}
                onClick={() => handleSelect(choice)}
                onMouseEnter={() => {
                  if (!choice.disabled) setFocusedIndex(i);
                }}
                tabIndex={-1}
                {...(choice.disabledReason
                  ? {
                      title: `node ${choice.label} is ${choice.disabledReason}`,
                    }
                  : {})}
              >
                <span
                  className={`ws-node-picker__dot ws-node-picker__dot--${choice.status === 'this host' ? 'local' : choice.status}`}
                  aria-hidden
                />
                <span className="ws-node-picker__label">{choice.label}</span>
                {choice.status !== 'this host' && (
                  <span className="ws-node-picker__status">
                    {choice.status}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TerminalNodePicker;
