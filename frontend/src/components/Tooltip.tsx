import React, { useId } from 'react';
import { getAction } from '../lib/actions/registry.js';
import { formatShortcut } from '../lib/actions/shortcuts.js';
import { isMac } from '../lib/utils.js';
import './Tooltip.css';

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  children: React.ReactElement;
  label?: string;
  description?: string;
  actionId?: string;
  shortcut?: string;
  side?: TooltipSide;
  disabled?: boolean;
  className?: string;
}

export function Tooltip({
  children,
  label,
  description,
  actionId,
  shortcut,
  side = 'top',
  disabled = false,
  className = '',
}: TooltipProps) {
  const tooltipId = useId();
  const action = actionId ? getAction(actionId) : undefined;
  const tooltipLabel = label ?? action?.label;
  const tooltipDescription = description ?? action?.description;
  const shortcutKey = shortcut ?? action?.shortcut?.key;
  const formattedShortcut = shortcutKey
    ? formatShortcut(shortcutKey, isMac)
    : null;

  if (
    disabled ||
    (!tooltipLabel && !tooltipDescription && !formattedShortcut)
  ) {
    return children;
  }

  const child = React.cloneElement(children, {
    'aria-describedby': tooltipId,
    title: undefined,
  } as Partial<React.HTMLAttributes<HTMLElement>>);

  return (
    <span
      className={['tui-tooltip', `tui-tooltip--${side}`, className]
        .filter(Boolean)
        .join(' ')}
    >
      {child}
      <span id={tooltipId} role="tooltip" className="tui-tooltip__bubble">
        <span className="tui-tooltip__main">
          {tooltipLabel ? (
            <span className="tui-tooltip__label">{tooltipLabel}</span>
          ) : null}
          {formattedShortcut ? (
            <kbd className="tui-tooltip__shortcut">{formattedShortcut}</kbd>
          ) : null}
        </span>
        {tooltipDescription ? (
          <span className="tui-tooltip__description">{tooltipDescription}</span>
        ) : null}
      </span>
    </span>
  );
}

export default Tooltip;
