import React from 'react';
import { createRoot } from 'react-dom/client';
import SessionItem from './components/SessionItem.js';
import type { ItemVariant } from './components/SessionItem.js';

const activeVariant: ItemVariant = {
  kind: 'active',
  session: {
    id: 'session-1',
    type: 'agent',
    agent: 'claude',
    repoName: 'my-project',
    repoPath: '/projects/my-project',
    worktreePath: '/projects/my-project/.git/worktrees/feat-auth',
    cwd: '/projects/my-project',
    branchName: 'feat/auth',
    displayName: 'feat/auth',
    createdAt: new Date(Date.now() - 60000).toISOString(),
    lastActivity: new Date(Date.now() - 30000).toISOString(),
    idle: false,
  },
  status: 'running',
  isSelected: true,
};

const activeIdleVariant: ItemVariant = {
  kind: 'active',
  session: {
    id: 'session-2',
    type: 'agent',
    agent: 'claude',
    repoName: 'my-project',
    repoPath: '/projects/my-project',
    worktreePath: null,
    cwd: '/projects/my-project',
    branchName: 'main',
    displayName: 'my-project',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    lastActivity: new Date(Date.now() - 1800000).toISOString(),
    idle: true,
  },
  status: 'idle',
  isSelected: false,
};

const inactiveWorktreeVariant: ItemVariant = {
  kind: 'inactive-worktree',
  worktree: {
    name: 'fix-login-bug',
    path: '/projects/my-project/.git/worktrees/fix-login-bug',
    repoName: 'my-project',
    repoPath: '/projects/my-project',
    displayName: 'fix-login-bug',
    lastActivity: new Date(Date.now() - 86400000).toISOString(),
    branchName: 'fix/login-bug',
  },
};

const idleRepoVariant: ItemVariant = {
  kind: 'idle-repo',
  repo: {
    name: 'my-project',
    path: '/projects/my-project',
    root: '/projects/my-project',
    defaultBranch: 'main',
  },
};

function App() {
  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>SessionItem Test</h1>

      <div className="test-section">
        <h2>Active — running + selected</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, background: 'var(--surface)', width: '280px' }}>
          <SessionItem
            variant={activeVariant}
            gitStatus={{ prState: 'open', additions: 42, deletions: 8 }}
            onClick={() => alert('clicked')}
          />
        </ul>
      </div>

      <div className="test-section">
        <h2>Active — idle + unselected</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, background: 'var(--surface)', width: '280px' }}>
          <SessionItem
            variant={activeIdleVariant}
            gitStatus={{ prState: null, additions: 0, deletions: 0 }}
            onClick={() => {}}
          />
        </ul>
      </div>

      <div className="test-section">
        <h2>Attention state</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, background: 'var(--surface)', width: '280px' }}>
          <SessionItem
            variant={{ ...activeVariant, status: 'attention', isSelected: false }}
            onClick={() => {}}
          />
        </ul>
      </div>

      <div className="test-section">
        <h2>Inactive worktree</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, background: 'var(--surface)', width: '280px' }}>
          <SessionItem
            variant={inactiveWorktreeVariant}
            onClick={() => {}}
          />
        </ul>
      </div>

      <div className="test-section">
        <h2>Idle repo</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, background: 'var(--surface)', width: '280px' }}>
          <SessionItem
            variant={idleRepoVariant}
            onClick={() => {}}
          />
        </ul>
      </div>

      <div className="test-section">
        <h2>Loading state</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, background: 'var(--surface)', width: '280px' }}>
          <SessionItem
            variant={activeVariant}
            isLoading={true}
            onClick={() => {}}
          />
        </ul>
      </div>

      <div className="test-section">
        <h2>With merged PR status</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, background: 'var(--surface)', width: '280px' }}>
          <SessionItem
            variant={activeIdleVariant}
            gitStatus={{ prState: 'merged', additions: 100, deletions: 50 }}
            onClick={() => {}}
          />
        </ul>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
