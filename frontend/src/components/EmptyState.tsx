import React from 'react';
import { TuiButton } from './TuiButton';
import './EmptyState.css';

export interface EmptyStateProps {
  icon?: string;
  heading: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon,
  heading,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && (
        <div className="empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}

      <div className="empty-heading">{heading}</div>

      {description && <p className="empty-description">{description}</p>}

      {actionLabel && onAction && (
        <TuiButton variant="primary" onClick={onAction}>
          {actionLabel}
        </TuiButton>
      )}
    </div>
  );
}

export default EmptyState;