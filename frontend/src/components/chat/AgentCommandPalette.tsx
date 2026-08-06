import React from 'react';
import type { AgentSlashCommandV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import './AgentCommandPalette.css';

export type AgentCommandPaletteRow =
  | { kind: 'command'; command: AgentSlashCommandV2 }
  | {
      kind: 'argument';
      value: string;
      label?: string;
      description?: string;
    }
  | { kind: 'confirm'; value: 'confirm' | 'cancel' };

interface AgentCommandPaletteProps {
  rows: readonly AgentCommandPaletteRow[];
  activeIndex: number;
  visible: boolean;
  disabled?: boolean;
  label: string;
  emptyMessage?: string;
  onSelect: (index: number) => void;
}

/**
 * Provider-aware command-preview palette for the channel composer. It is
 * intentionally presentation-first like MentionPalette: the composer owns
 * keyboard/IME semantics and dispatches dedicated controls, never messages.
 */
export const AgentCommandPalette: React.FC<AgentCommandPaletteProps> = ({
  rows,
  activeIndex,
  visible,
  disabled = false,
  label,
  emptyMessage,
  onSelect,
}) => (
  <div
    id="channel-agent-command-palette"
    className="agent-command-palette"
    role="listbox"
    aria-label={label}
    aria-disabled={disabled || undefined}
    style={{ display: visible ? undefined : 'none' }}
  >
    {rows.length === 0 ? (
      <div className="agent-command-palette__empty" role="status">
        {emptyMessage ?? 'no commands available'}
      </div>
    ) : (
      rows.map((row, index) => {
        const active = index === activeIndex;
        const id = `channel-agent-command-option-${index}`;
        const main =
          row.kind === 'command'
            ? `/${row.command.name}`
            : row.kind === 'argument'
              ? (row.label ?? row.value)
              : row.value === 'confirm'
                ? 'confirm'
                : 'cancel';
        const detail =
          row.kind === 'command'
            ? row.command.description
            : row.kind === 'argument'
              ? row.description
              : row.value === 'confirm'
                ? 'run this destructive command'
                : 'return to command choices';
        const hint =
          row.kind === 'command' ? row.command.argumentHint : undefined;
        return (
          <div
            id={id}
            key={
              row.kind === 'command'
                ? (row.command.id ?? row.command.name)
                : `${row.kind}:${row.value}`
            }
            className={`agent-command-palette__row${active ? ' agent-command-palette__row--active' : ''}`}
            role="option"
            aria-selected={active}
            aria-disabled={disabled || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!disabled) onSelect(index);
            }}
          >
            <div className="agent-command-palette__main">
              <span className="agent-command-palette__name">{main}</span>
              {hint ? (
                <span className="agent-command-palette__hint">{hint}</span>
              ) : null}
              {row.kind === 'command' && row.command.sourceLabel ? (
                <span className="agent-command-palette__source">
                  {row.command.sourceLabel}
                </span>
              ) : null}
            </div>
            {detail ? (
              <span className="agent-command-palette__detail">{detail}</span>
            ) : null}
          </div>
        );
      })
    )}
  </div>
);

export default AgentCommandPalette;
