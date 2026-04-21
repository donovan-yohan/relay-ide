import React from 'react';
import './SettingRow.css';

interface Props {
  name: string;
  description?: string;
  children: React.ReactNode;
}

export default function SettingRow({ name, description, children }: Props) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <p className="setting-name">{name}</p>
        {description && <p className="setting-description">{description}</p>}
      </div>
      <div className="setting-action">{children}</div>
    </div>
  );
}
