import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import DiffFileSidebar from './components/DiffFileSidebar.js';
import type { ChangedFile } from './lib/types.js';

const sampleFiles: ChangedFile[] = [
  { path: 'frontend/src/components/SplitPaneLayout.tsx', status: 'added', additions: 120, deletions: 0 },
  { path: 'frontend/src/components/SessionItem.tsx', status: 'modified', additions: 45, deletions: 12 },
  { path: 'frontend/src/lib/utils.ts', status: 'modified', additions: 3, deletions: 1 },
  { path: 'frontend/src/components/OldComponent.tsx', status: 'deleted', additions: 0, deletions: 88 },
  { path: 'frontend/src/lib/api.ts', status: 'modified', additions: 22, deletions: 8 },
  { path: 'frontend/src/components/WorkspaceItem.tsx', status: 'added', additions: 200, deletions: 0 },
  { path: 'DESIGN.md', status: 'modified', additions: 10, deletions: 5 },
  { path: 'server/session-manager.ts', status: 'renamed', additions: 15, deletions: 15 },
];

function App() {
  const [activeFile, setActiveFile] = useState<string | null>('frontend/src/components/SessionItem.tsx');

  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>DiffFileSidebar Test</h1>

      <div className="test-section">
        <h2>Sample file list with additions/deletions</h2>
        <div style={{ display: 'flex', gap: '20px' }}>
          <DiffFileSidebar
            files={sampleFiles}
            activeFile={activeFile}
            onSelectFile={(f) => setActiveFile(f.path)}
          />
          <div style={{ flex: 1, padding: '12px', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '12px' }}>
            Active file: <strong style={{ color: 'var(--accent)' }}>{activeFile ?? 'none'}</strong>
          </div>
        </div>
      </div>

      <div className="test-section">
        <h2>Empty state</h2>
        <DiffFileSidebar
          files={[]}
          activeFile={null}
          onSelectFile={() => {}}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
