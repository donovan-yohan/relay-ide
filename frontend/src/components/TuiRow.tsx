import React from 'react';
import './TuiRow.css';

export interface TuiRowProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  action?: React.ReactNode;
  minHeight?: string;
  paddingX?: string;
}

export function TuiRow({
  icon,
  action,
  children,
  onClick,
  minHeight = 'var(--row-min-height)',
  paddingX = 'var(--sidebar-padding-x)',
  className = '',
  style,
  ...rest
}: TuiRowProps) {
  const isInteractive = onClick !== undefined;

  const classes = ['tui-row', className, isInteractive && 'tui-row--interactive']
    .filter(Boolean)
    .join(' ');

  const rowStyle = {
    ...(style ?? {}),
    '--row-padding-x': paddingX,
    '--row-min-height-override': minHeight,
  } as React.CSSProperties;

  return (
    <div className={classes} style={rowStyle} onClick={onClick} {...rest}>
      <span className="tui-row__icon-slot">{icon}</span>

      <span className="tui-row__content">{children}</span>

      {action ? <span className="tui-row__action-slot">{action}</span> : null}
    </div>
  );
}

export default TuiRow;
