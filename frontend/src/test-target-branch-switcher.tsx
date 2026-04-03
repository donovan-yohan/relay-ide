import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TargetBranchSwitcher from './components/TargetBranchSwitcher.js';

function App() {
  const [base, setBase] = useState('main');

  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>TargetBranchSwitcher Test</h1>

      <div className="test-section">
        <h2>Active — current base: {base}</h2>
        <TargetBranchSwitcher
          workspacePath="/fake/repo"
          currentBase={base}
          prNumber={42}
          onBaseChanged={setBase}
        />
      </div>

      <div className="test-section">
        <h2>Disabled (agent running)</h2>
        <TargetBranchSwitcher
          workspacePath="/fake/repo"
          currentBase="main"
          prNumber={42}
          disabled={true}
        />
      </div>

      <div className="test-section">
        <h2>Different base branch selected</h2>
        <TargetBranchSwitcher
          workspacePath="/fake/repo"
          currentBase="develop"
          prNumber={7}
          onBaseChanged={(b) => alert('Changed to: ' + b)}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
