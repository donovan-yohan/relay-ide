import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceGroup from './components/WorkspaceGroup.js';
import type { Workspace, Repo, SessionSummary, WorktreeInfo } from './lib/types.js';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'my-workspace',
  repos: ['/projects/repo-a', '/projects/repo-b'],
  order: 0,
};

const repos: Repo[] = [
  { path: '/projects/repo-a', name: 'repo-a', isGitRepo: true, defaultBranch: 'main', currentBranch: 'main' },
  { path: '/projects/repo-b', name: 'repo-b', isGitRepo: true, defaultBranch: 'main', currentBranch: 'feat/new-ui' },
];

const sessions: SessionSummary[] = [
  {
    id: 's1', type: 'agent', agent: 'claude', repoName: 'repo-a', repoPath: '/projects/repo-a',
    worktreePath: null, cwd: '/projects/repo-a', branchName: 'main', displayName: 'repo-a',
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), idle: false,
  },
  {
    id: 's2', type: 'agent', agent: 'claude', repoName: 'repo-b', repoPath: '/projects/repo-b',
    worktreePath: null, cwd: '/projects/repo-b', branchName: 'feat/new-ui', displayName: 'repo-b',
    createdAt: new Date().toISOString(), lastActivity: new Date(Date.now() - 3600000).toISOString(), idle: true,
  },
];

const worktrees: WorktreeInfo[] = [
  {
    name: 'fix-bug', path: '/projects/repo-a/.git/worktrees/fix-bug', repoName: 'repo-a',
    repoPath: '/projects/repo-a', displayName: 'fix/bug', lastActivity: new Date(Date.now() - 86400000).toISOString(),
    branchName: 'fix/bug',
  },
];

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedLaunch, setCollapsedLaunch] = useState(false);

  return (
    <div style={{ padding: '20px', fontFamily: 'var(--font-mono)' }}>
      <h1 style={{ color: 'var(--accent)', marginBottom: '40px' }}>WorkspaceGroup Test</h1>

      <div className="test-section">
        <h2>Expanded — with sessions and worktrees</h2>
        <div style={{ width: '280px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <WorkspaceGroup
            workspace={workspace}
            repos={repos}
            sessions={sessions}
            worktrees={worktrees}
            collapsed={collapsed}
            launching={false}
            onToggleCollapse={() => setCollapsed((v) => !v)}
            onLaunchSession={(id) => alert('launch: ' + id)}
            onSelectSession={(id) => alert('select session: ' + id)}
            onSelectWorkspace={(p) => alert('select workspace: ' + p)}
            onNewWorktree={(r) => alert('new worktree: ' + r.name)}
            onOpenSettings={(r) => alert('settings: ' + r?.name)}
          />
        </div>
      </div>

      <div className="test-section">
        <h2>Collapsed state</h2>
        <div style={{ width: '280px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <WorkspaceGroup
            workspace={workspace}
            repos={repos}
            sessions={sessions}
            collapsed={true}
            launching={false}
            onToggleCollapse={() => {}}
            onLaunchSession={() => {}}
            onSelectSession={() => {}}
            onSelectWorkspace={() => {}}
            onNewWorktree={() => {}}
            onOpenSettings={() => {}}
          />
        </div>
      </div>

      <div className="test-section">
        <h2>Launching state</h2>
        <div style={{ width: '280px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <WorkspaceGroup
            workspace={workspace}
            repos={repos}
            collapsed={false}
            launching={true}
            onToggleCollapse={() => {}}
            onLaunchSession={() => {}}
            onSelectSession={() => {}}
            onSelectWorkspace={() => {}}
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
