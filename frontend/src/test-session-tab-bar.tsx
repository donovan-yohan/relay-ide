import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SessionTabBar from './components/SessionTabBar.js';
import type { SessionSummary } from './lib/types.js';

const baseSessions: SessionSummary[] = [
  {
    id: 'session-1',
    type: 'agent',
    agent: 'claude',
    repoName: 'my-project',
    repoPath: '/projects/my-project',
    worktreePath: null,
    cwd: '/projects/my-project',
    branchName: 'main',
    displayName: 'my-project',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    idle: false,
  },
  {
    id: 'session-2',
    type: 'agent',
    agent: 'claude',
    repoName: 'my-project',
    repoPath: '/projects/my-project',
    worktreePath: '/projects/my-project/.git/worktrees/feat-auth',
    cwd: '/projects/my-project',
    branchName: 'feat/auth',
    displayName: 'feat/auth',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    idle: true,
  },
  {
    id: 'session-3',
    type: 'terminal',
    agent: '',
    repoName: 'my-project',
    repoPath: '/projects/my-project',
    worktreePath: null,
    cwd: '/projects/my-project',
    branchName: 'main',
    displayName: '',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    idle: false,
  },
];

function App() {
  const [activeId, setActiveId] = useState<string | null>('session-1');
  const [sessions, setSessions] = useState(baseSessions);

  const handleClose = (id: string) => {
    setSessions((s) => s.filter((x) => x.id !== id));
    if (activeId === id) setActiveId(sessions.find((x) => x.id !== id)?.id ?? null);
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>SessionTabBar Test</h1>

      <div className="test-section">
        <h2>Multiple tabs — agent and terminal sessions</h2>
        <SessionTabBar
          sessions={sessions}
          activeSessionId={activeId}
          onSelectSession={setActiveId}
          onCloseSession={handleClose}
          onNewAgent={() => alert('New agent')}
          onNewTerminal={() => alert('New terminal')}
          onCustomize={() => alert('Customize')}
        />
        <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '8px' }}>
          Active: {activeId}
        </p>
      </div>

      <div className="test-section">
        <h2>Single tab active</h2>
        <SessionTabBar
          sessions={[baseSessions[0]!]}
          activeSessionId="session-1"
          onSelectSession={() => {}}
          onCloseSession={() => {}}
          onNewAgent={() => {}}
          onNewTerminal={() => {}}
          onCustomize={() => {}}
        />
      </div>

      <div className="test-section">
        <h2>Empty — no sessions</h2>
        <SessionTabBar
          sessions={[]}
          activeSessionId={null}
          onSelectSession={() => {}}
          onCloseSession={() => {}}
          onNewAgent={() => alert('New agent')}
          onNewTerminal={() => alert('New terminal')}
          onCustomize={() => {}}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
