import React from 'react';
import { createRoot } from 'react-dom/client';
import PrTopBar from './components/PrTopBar.js';

function App() {
  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>PrTopBar Test</h1>

      <div className="test-section">
        <h2>Basic (no PR yet — will fetch)</h2>
        <PrTopBar
          workspacePath="/projects/my-project"
          branchName="feat/auth"
          sessionId="session-1"
          agentRunning={false}
          onArchive={() => alert('archive')}
        />
      </div>

      <div className="test-section">
        <h2>Agent running (disabled state)</h2>
        <PrTopBar
          workspacePath="/projects/my-project"
          branchName="fix/bug"
          sessionId="session-2"
          agentRunning={true}
        />
      </div>

      <div className="test-section">
        <h2>Empty branch name (will auto-detect from git)</h2>
        <PrTopBar
          workspacePath="/projects/my-project"
          branchName=""
          sessionId="session-3"
          agentRunning={false}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
