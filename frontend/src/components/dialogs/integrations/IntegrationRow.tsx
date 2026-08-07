import React, { useState } from 'react';
import StatusDot from '../../StatusDot.js';
import './IntegrationRow.css';

interface Props {
  name: string;
  statusText: string;
  connected: boolean;
  loading?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onToggle?: () => void;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}

export default function IntegrationRow({
  name,
  statusText,
  connected,
  loading = false,
  expanded: expandedProp,
  onExpandedChange,
  onToggle,
  headerActions,
  children,
}: Props) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = expandedProp !== undefined ? expandedProp : internalExpanded;

  function toggle() {
    const next = !expanded;
    if (onExpandedChange) {
      onExpandedChange(next);
    } else {
      setInternalExpanded(next);
    }
    onToggle?.();
  }

  function handleKeydown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  }

  return (
    <div className="integration-row">
      <div
        className="integration-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={handleKeydown}
      >
        <span className="icon-slot">
          <StatusDot status={connected ? 'connected' : 'disconnected'} size={8} />
        </span>
        <div className="integration-label">
          <span className="integration-name">{name}</span>
          <span
            className={[
              'integration-status',
              loading ? 'integration-status--loading' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {loading ? <span className="loading-text">loading...</span> : statusText}
          </span>
        </div>
        <div className="chevron" aria-hidden="true">
          {expanded ? '▴' : '▾'}
        </div>
        {headerActions && (
          <div
            className="header-actions"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            {headerActions}
          </div>
        )}
      </div>

      <div
        className={['integration-body', expanded ? 'integration-body--open' : '']
          .filter(Boolean)
          .join(' ')}
        aria-hidden={!expanded}
      >
        <div className="integration-body-inner">{children}</div>
      </div>
    </div>
  );
}
