import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchHubNodes } from '../lib/api.js';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type { HubNodeSummary } from '../../../shared/relay-node-protocol.js';
import { nodeShellBlockReason } from './dialogs/CustomizeSessionDialog.js';
import './TerminalNodePicker.css';

export interface TerminalNodePickerProps {
  /**
   * Called with the chosen nodeId — DEFAULT_LOCAL_NODE_ID for "this host",
   * or a paired node's id for cross-node terminals. Only fires when the
   * user selects an enabled (online + capability-ready) choice.
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
  /**
   * #467: `true` when the node advertises a session-resume backend
   * (tmux today, server-side canonical terminal in phase 2). Drives
   * the "resumable" badge on the menu item.
   */
  resumable: boolean;
}

/**
 * Determines whether a node can accept terminal sessions.
 * Delegates to nodeShellBlockReason from CustomizeSessionDialog — shell + tmux
 * availability is the sole gate. Agent availability is NOT checked here
 * because this picker is terminal-only.
 */
function nodeBlockReasonForTerminal(node: HubNodeSummary): string | null {
  return nodeShellBlockReason(node);
}

function isResumable(node: HubNodeSummary): boolean {
  // Pre-#467 nodes do not publish `sessionResume`. Treat missing as
  // 'none' (no resume) rather than guessing from tmux availability —
  // the capability flag is the sole source of truth so frontend code
  // never references tmux verbs.
  const resume = node.capabilities.sessionResume ?? 'none';
  return resume !== 'none';
}

export function buildChoices(nodes: HubNodeSummary[]): NodeChoice[] {
  const choices: NodeChoice[] = [
    {
      nodeId: DEFAULT_LOCAL_NODE_ID,
      label: 'this host',
      status: 'this host',
      disabled: false,
      resumable: false,
    },
  ];
  for (const node of nodes) {
    const reason = nodeBlockReasonForTerminal(node);
    choices.push({
      nodeId: node.nodeId,
      label: node.displayName || node.nodeId,
      status: node.status,
      disabled: reason !== null,
      resumable: isResumable(node),
      ...(reason ? { disabledReason: reason } : {}),
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
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null
  );
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionIdPrefix = useId();

  // Click-outside: menu is portal-rendered, so we explicitly inspect both
  // the trigger wrapper and the menu listbox to keep them as a single
  // logical surface.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const { data: nodes = [] } = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    enabled: open,
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
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

  // Position the portal-rendered menu under the trigger and keep it in sync
  // with scroll/resize while open. Anchoring via fixed coords avoids the
  // tab bar's `overflow: hidden` clipping that an in-flow absolute child
  // would suffer from.
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({
        top: rect.bottom + 2,
        right: window.innerWidth - rect.right,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Focus the listbox container so the keyboard handler receives ArrowUp/Down.
  useEffect(() => {
    if (open && menuPos) listRef.current?.focus();
  }, [open, menuPos]);

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

  const menu =
    open && menuPos
      ? createPortal(
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            className="ws-node-picker__menu"
            style={{ top: menuPos.top, right: menuPos.right }}
            {...(focusedIndex >= 0
              ? { 'aria-activedescendant': optionId(focusedIndex) }
              : {})}
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
                  {choice.resumable && (
                    <span
                      className="ws-node-picker__resumable"
                      title="reloads reattach to the same shell"
                    >
                      resumable
                    </span>
                  )}
                  {choice.status !== 'this host' && (
                    <span className="ws-node-picker__status">
                      {choice.status}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={wrapperRef} className="ws-node-picker">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ?? 'ws-tabs__add'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerAriaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLabel}
      </button>
      {menu}
    </div>
  );
}

export default TerminalNodePicker;
