import React, { useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { DialogShell } from './components/dialogs/DialogShell.js';
import type { DialogShellHandle } from './components/dialogs/DialogShell.js';
import './components/dialogs/DialogShell.css';

function TestPage() {
  const compactRef = useRef<DialogShellHandle>(null);
  const fullscreenRef = useRef<DialogShellHandle>(null);
  const footerRef = useRef<DialogShellHandle>(null);

  return (
    <div className="test-page">
      <div className="test-section" id="test-container">
        <h2>DialogShell — variants</h2>

        <div className="button-row" style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <button
            onClick={() => compactRef.current?.open()}
            style={{ padding: '8px 16px', background: '#333', color: '#fff', border: '1px solid #555', cursor: 'pointer' }}
          >
            open compact
          </button>
          <button
            onClick={() => fullscreenRef.current?.open()}
            style={{ padding: '8px 16px', background: '#333', color: '#fff', border: '1px solid #555', cursor: 'pointer' }}
          >
            open fullscreen
          </button>
          <button
            onClick={() => footerRef.current?.open()}
            style={{ padding: '8px 16px', background: '#333', color: '#fff', border: '1px solid #555', cursor: 'pointer' }}
          >
            open with footer
          </button>
        </div>
      </div>

      <DialogShell ref={compactRef} title="compact dialog" variant="compact">
        <p>This is the compact dialog body content.</p>
        <p>Click outside or press Escape to close.</p>
      </DialogShell>

      <DialogShell ref={fullscreenRef} title="fullscreen dialog" variant="fullscreen">
        <p>This is the fullscreen dialog body content.</p>
      </DialogShell>

      <DialogShell
        ref={footerRef}
        title="dialog with footer"
        variant="compact"
        headerExtra={<span style={{ color: '#888', fontSize: 12 }}>header extra</span>}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => footerRef.current?.close()} style={{ padding: '6px 14px', cursor: 'pointer' }}>
              cancel
            </button>
            <button style={{ padding: '6px 14px', background: '#00ff88', color: '#000', cursor: 'pointer' }}>
              confirm
            </button>
          </div>
        }
      >
        <p>Dialog with header extra and footer content.</p>
      </DialogShell>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <TestPage />
  </React.StrictMode>
);
