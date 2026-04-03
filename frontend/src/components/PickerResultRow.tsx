import React from 'react';
import type { SessionIntent } from '../lib/session-intent.js';
import type { StatusColor } from '../lib/pr-state.js';
import type { PrDotStatus } from '../lib/pr-status.js';
import { StatusDot } from './StatusDot.js';
import { TuiButton } from './TuiButton.js';
import './PickerResultRow.css';

interface PickerResultRowProps {
  label: string;
  sublabel?: string;
  dotStatus?: PrDotStatus;
  intents: SessionIntent[];
  focused?: boolean;
  onSelectIntent: (intent: SessionIntent) => void;
  onRowClick?: () => void;
}

function colorToVariant(color: StatusColor): 'primary' | 'ghost' | 'danger' | 'success' | 'info' {
  if (color === 'success') return 'success';
  if (color === 'error') return 'danger';
  if (color === 'info') return 'info';
  if (color === 'accent') return 'primary';
  return 'ghost';
}

export function PickerResultRow({
  label,
  sublabel = '',
  dotStatus,
  intents,
  focused = false,
  onSelectIntent,
  onRowClick,
}: PickerResultRowProps) {
  const primary = intents[0];
  const secondary = intents.slice(1);

  const handleRowClick = () => {
    if (primary) {
      onSelectIntent(primary);
    } else {
      onRowClick?.();
    }
  };

  const rowClass = ['picker-row', focused && 'focused'].filter(Boolean).join(' ');

  return (
    <div
      className={rowClass}
      role="option"
      aria-selected={focused}
      onClick={handleRowClick}
    >
      <div className="row-left">
        {dotStatus ? (
          <StatusDot status={dotStatus} size={7} />
        ) : (
          <span className="row-icon">&#9656;</span>
        )}
        <div className="row-text">
          <span className="row-label">{label}</span>
          {sublabel && <span className="row-sublabel">{sublabel}</span>}
        </div>
      </div>
      <div className="row-actions">
        {secondary.map((intent, i) => (
          <TuiButton
            key={i}
            variant={colorToVariant(intent.color)}
            size="sm"
            onClick={(e) => { e.stopPropagation(); onSelectIntent(intent); }}
          >
            {intent.label}
          </TuiButton>
        ))}
        {primary && primary.label && (
          <TuiButton
            variant={colorToVariant(primary.color)}
            size="sm"
            onClick={(e) => { e.stopPropagation(); onSelectIntent(primary); }}
          >
            {primary.label}
          </TuiButton>
        )}
      </div>
    </div>
  );
}

export default PickerResultRow;
