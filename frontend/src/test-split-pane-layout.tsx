import React from 'react';
import { createRoot } from 'react-dom/client';
import SplitPaneLayout from './components/SplitPaneLayout.js';

function App() {
  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>SplitPaneLayout Test</h1>

      <div className="test-section">
        <h2>Horizontal split — terminal + file viewer + right sidebar</h2>
        <div style={{ height: '300px', border: '1px solid var(--border)' }}>
          <SplitPaneLayout
            fileViewerOpen={true}
            rightSidebarCollapsed={false}
            fileViewerRatio={0.4}
            rightSidebarWidth={240}
            terminal={
              <div style={{ background: '#111', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', height: '100%' }}>
                Terminal Pane
              </div>
            }
            fileViewer={
              <div style={{ background: '#1a1a2e', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--status-info)', height: '100%' }}>
                File Viewer Pane
              </div>
            }
            rightSidebar={
              <div style={{ background: '#1e1e1e', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: '8px' }}>
                Right Sidebar
              </div>
            }
          />
        </div>
      </div>

      <div className="test-section">
        <h2>Terminal only — no file viewer, no right sidebar</h2>
        <div style={{ height: '200px', border: '1px solid var(--border)' }}>
          <SplitPaneLayout
            fileViewerOpen={false}
            rightSidebarCollapsed={true}
            terminal={
              <div style={{ background: '#111', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', height: '100%' }}>
                Terminal Only
              </div>
            }
          />
        </div>
      </div>

      <div className="test-section">
        <h2>Terminal + right sidebar only (no file viewer)</h2>
        <div style={{ height: '200px', border: '1px solid var(--border)' }}>
          <SplitPaneLayout
            fileViewerOpen={false}
            rightSidebarCollapsed={false}
            rightSidebarWidth={200}
            terminal={
              <div style={{ background: '#111', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', height: '100%' }}>
                Terminal
              </div>
            }
            rightSidebar={
              <div style={{ background: '#1e1e1e', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: '8px' }}>
                Sidebar
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
