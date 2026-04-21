import React from 'react';
import { getAction } from '../lib/actions/registry.js';
import { formatShortcut } from '../lib/actions/shortcuts.js';
import { isMac } from '../lib/utils.js';
import './ShortcutHint.css';

export interface ShortcutHintProps {
  actionId: string;
  className?: string;
}

export const ShortcutHint: React.FC<ShortcutHintProps> = ({ actionId, className = '' }) => {
  const action = getAction(actionId);
  
  if (!action?.shortcut) {
    return null;
  }
  
  const shortcut = formatShortcut(action.shortcut.key, isMac);
  
  return (
    <kbd className={`shortcut-hint ${className}`.trim()}>
      {shortcut}
    </kbd>
  );
};

export default ShortcutHint;