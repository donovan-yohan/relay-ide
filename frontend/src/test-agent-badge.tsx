import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgentBadge } from './components/AgentBadge.js';
import './components/AgentBadge.css';

function TestPage() {
  return (
    <div className="test-page">
      <div className="test-section" id="test-container">
        <h2>AgentBadge — all variants</h2>
        <div className="badge-row">
          <span className="badge-label">claude:</span>
          <AgentBadge agent="claude" />
        </div>
        <div className="badge-row">
          <span className="badge-label">codex:</span>
          <AgentBadge agent="codex" />
        </div>
        <div className="badge-row">
          <span className="badge-label">opencode:</span>
          <AgentBadge agent="opencode" />
        </div>
        <div className="badge-row">
          <span className="badge-label">unknown (fallback):</span>
          <AgentBadge agent="myagent" />
        </div>
        <div className="badge-row">
          <span className="badge-label">empty string (fallback):</span>
          <AgentBadge agent="" />
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
