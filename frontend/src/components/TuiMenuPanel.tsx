import React from 'react';
import './TuiMenuPanel.css';

export interface TuiMenuPanelProps {
  children: React.ReactNode;
}

export function TuiMenuPanel({ children }: TuiMenuPanelProps) {
  return <div className="tui-menu-panel">{children}</div>;
}

export default TuiMenuPanel;
