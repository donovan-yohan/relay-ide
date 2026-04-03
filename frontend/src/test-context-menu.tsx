import React, { useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ContextMenu } from './components/ContextMenu.js';
import type { ContextMenuHandle, MenuItem } from './components/ContextMenu.js';
import './components/ContextMenu.css';
import './components/TuiMenuItem.css';
import './components/TuiMenuPanel.css';

const sampleItems: MenuItem[] = [
  { label: 'open session', action: () => { /* noop for test */ } },
  { label: 'rename', action: () => { /* noop for test */ } },
  { label: 'archive', action: () => { /* noop for test */ }, danger: true },
  { label: 'disabled option', action: () => { /* noop for test */ }, disabled: true },
];

function TestPage() {
  const menuRef = useRef<ContextMenuHandle>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [lastAction, setLastAction] = useState('');

  const itemsWithLog: MenuItem[] = sampleItems.map((item) => ({
    ...item,
    action: () => { setLastAction('action: ' + item.label); item.action(); },
  }));

  const handleProgrammaticOpen = () => {
    if (anchorRef.current) {
      menuRef.current?.openAt(anchorRef.current);
    }
  };

  return (
    <div className="test-page">
      <div className="test-section" id="test-container">
        <h2>ContextMenu — variants</h2>
        <div style={{ marginBottom: 12, color: '#888', fontSize: 12 }}>
          Last action: {lastAction || '(none)'}
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 24 }}>
          <span style={{ color: '#888', fontSize: 12 }}>With trigger:</span>
          <ContextMenu items={itemsWithLog} />
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 24 }}>
          <span style={{ color: '#888', fontSize: 12 }}>Programmatic (hideTrigger):</span>
          <button
            ref={anchorRef}
            onClick={handleProgrammaticOpen}
            style={{ padding: '6px 12px', background: '#333', color: '#fff', border: '1px solid #555', cursor: 'pointer' }}
          >
            open at anchor
          </button>
          <ContextMenu ref={menuRef} items={itemsWithLog} hideTrigger={true} />
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: 12 }}>Danger items only:</span>
          <ContextMenu
            items={[
              { label: 'delete', action: () => setLastAction('delete'), danger: true },
              { label: 'destroy', action: () => setLastAction('destroy'), danger: true },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <TestPage />
  </React.StrictMode>
);
