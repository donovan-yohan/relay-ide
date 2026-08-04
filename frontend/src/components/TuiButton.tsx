import React from 'react';
import Tooltip from './Tooltip.js';
import type { TooltipSide } from './Tooltip.js';
import './TuiButton.css';

export type TuiButtonVariant =
  | 'primary'
  | 'ghost'
  | 'danger'
  | 'success'
  | 'info';

export interface TuiButtonProps {
  variant?: TuiButtonVariant;
  size?: 'default' | 'sm' | 'icon';
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  href?: string;
  shortcut?: string;
  tooltip?: string;
  tooltipDescription?: string;
  tooltipActionId?: string;
  tooltipShortcut?: string;
  tooltipSide?: TooltipSide;
  onClick?: (
    e: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>
  ) => void;
  onMouseEnter?: (
    e: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>
  ) => void;
  onMouseLeave?: (
    e: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>
  ) => void;
  className?: string;
  children: React.ReactNode;
  [key: string]: unknown;
}

export const TuiButton: React.FC<TuiButtonProps> = ({
  variant = 'primary',
  size = 'default',
  disabled = false,
  type = 'button',
  href,
  shortcut,
  tooltip,
  tooltipDescription,
  tooltipActionId,
  tooltipShortcut,
  tooltipSide,
  onClick,
  onMouseEnter,
  onMouseLeave,
  className = '',
  children,
  ...rest
}) => {
  const classes = [
    'tui-btn',
    `tui-btn--${variant}`,
    size === 'sm' && 'tui-btn--sm',
    size === 'icon' && 'tui-btn--icon',
    disabled && 'tui-btn--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const shortcutEl = shortcut ? (
    <kbd className="tui-btn__shortcut">{shortcut}</kbd>
  ) : null;

  function withTooltip(element: React.ReactElement) {
    if (
      !tooltip &&
      !tooltipDescription &&
      !tooltipActionId &&
      !tooltipShortcut
    ) {
      return element;
    }
    return (
      <Tooltip
        {...(tooltip ? { label: tooltip } : {})}
        {...(tooltipDescription ? { description: tooltipDescription } : {})}
        {...(tooltipActionId ? { actionId: tooltipActionId } : {})}
        {...(tooltipShortcut ? { shortcut: tooltipShortcut } : {})}
        {...(tooltipSide ? { side: tooltipSide } : {})}
      >
        {element}
      </Tooltip>
    );
  }

  if (href) {
    return withTooltip(
      <a
        className={classes}
        href={href}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        onClick={disabled ? undefined : onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
        {shortcutEl}
      </a>
    );
  }

  return withTooltip(
    <button
      className={classes}
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
      {shortcutEl}
    </button>
  );
};

export default TuiButton;
