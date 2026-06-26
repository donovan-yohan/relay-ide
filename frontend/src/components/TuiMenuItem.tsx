import React from 'react';
import './TuiMenuItem.css';

export interface TuiMenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
  danger?: boolean;
  disabled?: boolean;
  ariaSelected?: boolean;
  icon?: React.ReactNode;
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onmousedown?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onclick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}

export function TuiMenuItem({
  danger = false,
  disabled = false,
  onMouseDown,
  onClick,
  onmousedown,
  onclick,
  role = 'menuitem',
  ariaSelected,
  icon,
  children,
  className = '',
  ...rest
}: TuiMenuItemProps) {
  const handleMouseDown = onMouseDown ?? onmousedown;
  const handleClick = onClick ?? onclick;

  const classes = [
    'tui-menu-item',
    danger && 'tui-menu-item--danger',
    disabled && 'tui-menu-item--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      // Fall back to the click handler when no mousedown handler is wired
      // (e.g. ContextMenu passes only onClick) so keyboard activation actually
      // fires the item's action instead of silently no-op'ing.
      const activate = handleMouseDown ?? handleClick;
      activate?.(e as unknown as React.MouseEvent<HTMLDivElement>);
    }
  };

  return (
    <div
      className={classes}
      role={role}
      aria-selected={ariaSelected}
      tabIndex={disabled ? -1 : 0}
      onMouseDown={disabled ? undefined : handleMouseDown}
      onClick={disabled ? undefined : handleClick}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      <span className="fzf-cursor" aria-hidden="true">
        &gt;
      </span>

      {icon ? <span className="tui-menu-item__icon">{icon}</span> : null}

      <span className="tui-menu-item__content">{children}</span>
    </div>
  );
}

export default TuiMenuItem;
