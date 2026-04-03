import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceItem from './components/WorkspaceItem.js';
import type { Repo, SessionSummary, WorktreeInfo } from './lib/types.js';

const repo: Repo = {
  path: '/projects/my-project',
  name: 'my-project',
  isGitRepo: true,
  defaultBranch: 'main',
  currentBranch: 'feat/auth',
};

const sessions: SessionSummary[] = [
  {
    id: 's1', type: 'agent', agent: 'claude', repoName: 'my-project', repoPath: '/projects/my-project',
    worktreePath: '/projects/my-project/.git/worktrees/feat-auth',
    cwd: '/projects/my-project', branchName: 'feat/auth', displayName: 'feat/auth',
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), idle: false,
  },
  {
    id: 's2', type: 'terminal', agent: '', repoName: 'my-project', repoPath: '/projects/my-project',
    worktreePath: '/projects/my-project/.git/worktrees/feat-auth',
    cwd: '/projects/my-project', branchName: 'feat/auth', displayName: 'feat/auth',
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), idle: false,
  },
];

const worktrees: WorktreeInfo[] = [
  {
    name: 'fix-bug', path: '/projects/my-project/.git/worktrees/fix-bug', repoName: 'my-project',
    repoPath: '/projects/my-project', displayName: 'fix/bug',
    lastActivity: new Date(Date.now() - 86400000).toISOString(), branchName: 'fix/bug',
  },
  {
    name: 'docs-update', path: '/projects/my-project/.git/worktrees/docs-update', repoName: 'my-project',
    repoPath: '/projects/my-project', displayName: 'docs/update',
    lastActivity: new Date(Date.now() - 3600000).toISOString(), branchName: 'docs/update',
  },
];

const sessionGroupsWithActive = new Map<string, SessionSummary[]>([
  ['/projects/my-project', []],
  ['/projects/my-project/.git/worktrees/feat-auth', sessions],
]);

const sessionGroupsEmpty = new Map<string, SessionSummary[]>([
  ['/projects/my-project', []],
]);

function App() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>('s1');

  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>WorkspaceItem Test</h1>

      <div className="test-section">
        <h2>Active session group (2 sessions) + inactive worktrees</h2>
        <div style={{ width: '280px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <WorkspaceItem
            workspace={repo}
            sessionGroups={sessionGroupsWithActive}
            inactiveWorktrees={worktrees}
            isActive={true}
            activeSessionId={activeSessionId}
            onSelectWorkspace={(p) => alert('workspace: ' + p)}
            onSelectSession={setActiveSessionId}
            onNewWorktree={(r) => alert('new worktree: ' + r.name)}
            onOpenSettings={(r) => alert('settings: ' + r?.name)}
            onResumeWorktree={(wt) => alert('resume: ' + wt.name)}
          />
        </div>
      </div>

      <div className="test-section">
        <h2>No active sessions (repo root entry only)</h2>
        <div style={{ width: '280px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <WorkspaceItem
            workspace={repo}
            sessionGroups={sessionGroupsEmpty}
            inactiveWorktrees={[worktrees[0]!]}
            isActive={false}
            onSelectWorkspace={() => {}}
            onSelectSession={() => {}}
            onNewWorktree={() => {}}
            onOpenSettings={() => {}}
          />
        </div>
      </div>

      <div className="test-section">
        <h2>Idle repo (no sessions, no worktrees)</h2>
        <div style={{ width: '280px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <WorkspaceItem
            workspace={{ ...repo, name: 'idle-repo' }}
            sessionGroups={sessionGroupsEmpty}
            inactiveWorktrees={[]}
            isActive={false}
            onSelectWorkspace={() => {}}
            onSelectSession={() => {}}
            onNewWorktree={() => {}}
            onOpenSettings={() => {}}
          />
        </div>
      </div>

      <div className="test-section">
        <h2>Loading state (worktree resuming)</h2>
        <div style={{ width: '280px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <WorkspaceItem
            workspace={repo}
            sessionGroups={sessionGroupsEmpty}
            inactiveWorktrees={worktrees}
            isActive={false}
            loadingItems={new Set([worktrees[0]!.path])}
            onSelectWorkspace={() => {}}
            onSelectSession={() => {}}
            onNewWorktree={() => {}}
            onOpenSettings={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
