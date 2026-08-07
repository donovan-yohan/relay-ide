import React from 'react';
import { TuiButton } from './TuiButton';
import './EmptyState.css';

export interface EmptyStateProps {
  icon?: string;
  heading: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /**
   * Optional secondary action rendered as a ghost button beneath the primary
   * one (#862). Used for the empty-state "start a terminal on a node" path so
   * the primary "+ add project" CTA stays unchanged.
   */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  hint?: React.ReactNode;
}

export function EmptyState({
  icon,
  heading,
  description,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  hint,
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

      {hint && <div className="empty-hint">{hint}</div>}

      {actionLabel && onAction && (
        <TuiButton variant="primary" onClick={onAction}>
          {actionLabel}
        </TuiButton>
      )}

      {secondaryActionLabel && onSecondaryAction && (
        <TuiButton variant="ghost" onClick={onSecondaryAction}>
          {secondaryActionLabel}
        </TuiButton>
      )}
    </div>
  );
}

export default EmptyState;