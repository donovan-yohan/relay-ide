import { useEffect, useMemo } from 'react';
import type { SessionSummary } from '../lib/types.js';
import { workspaceTabId, type WorkspaceTab } from '../lib/workspace-layout.js';
import { useWorkspaceLayoutStore } from '../lib/stores/workspace-layout-store.js';
import type { SummaryContext } from '../lib/workspace-summary.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import { WorkspaceContentLayer } from './WorkspaceContentLayer.js';
import './WorkspaceLayoutDemo.css';

const DEMO_REPO_PATH = '/Users/demo/relay-ide';
const NOW = new Date().toISOString();

const MOCK_SESSIONS: SessionSummary[] = [
  {
    id: 'sess-claude-1',
    type: 'agent',
    agent: 'claude',
    repoName: 'relay-ide',
    repoPath: DEMO_REPO_PATH,
    worktreePath: null,
    cwd: DEMO_REPO_PATH,
    branchName: 'feat/slash-commands',
    displayName: 'add slash-command palette',
    createdAt: NOW,
    lastActivity: NOW,
    idle: false,
    agentState: 'processing',
  },
  {
    id: 'sess-codex-1',
    type: 'agent',
    agent: 'codex',
    repoName: 'relay-ide',
    repoPath: DEMO_REPO_PATH,
    worktreePath: null,
    cwd: DEMO_REPO_PATH,
    branchName: 'refactor/use-tokens',
    displayName: 'refactor useComposerState',
    createdAt: NOW,
    lastActivity: NOW,
    idle: false,
    agentState: 'waiting-for-input',
  },
  {
    id: 'sess-term-1',
    type: 'terminal',
    agent: 'bash',
    repoName: 'relay-ide',
    repoPath: DEMO_REPO_PATH,
    worktreePath: null,
    cwd: DEMO_REPO_PATH,
    branchName: '',
    displayName: 'pnpm dev',
    createdAt: NOW,
    lastActivity: NOW,
    idle: false,
  },
];

const MOCK_TABS: WorkspaceTab[] = [
  { kind: 'session', sessionId: 'sess-claude-1', sessionType: 'agent' },
  { kind: 'session', sessionId: 'sess-codex-1', sessionType: 'agent' },
  { kind: 'session', sessionId: 'sess-term-1', sessionType: 'terminal' },
  {
    kind: 'file',
    filePath: 'frontend/src/components/Composer.tsx',
    tabType: 'code',
  },
  {
    kind: 'file',
    filePath: 'frontend/src/lib/useComposerState.ts',
    tabType: 'code',
  },
  { kind: 'file', filePath: 'main…feat/slash-commands', tabType: 'diff' },
  { kind: 'file', filePath: 'mock/preview.html', tabType: 'html' },
];

const CHANGED_FILES = new Set([
  'frontend/src/components/Composer.tsx',
  'frontend/src/lib/useComposerState.ts',
]);

function MockSessionContent({ session }: { session: SessionSummary }) {
  return (
    <div className="ws-demo-mock ws-demo-mock--session">
      <div className="ws-demo-mock__head">
        <span className="ws-demo-mock__label">
          {session.type === 'terminal' ? 'terminal' : 'agent'}
        </span>
        <span className="ws-demo-mock__title">{session.displayName}</span>
        <span className="ws-demo-mock__meta">
          {session.agent} · {session.agentState ?? 'idle'}
        </span>
      </div>
      <div className="ws-demo-mock__body">
        <pre>{`session id: ${session.id}
branch: ${session.branchName || '(none)'}
cwd: ${session.cwd}
last activity: ${new Date(session.lastActivity).toLocaleTimeString()}

[mock content — replace with real <SessionContent /> in production wire]`}</pre>
      </div>
    </div>
  );
}

function MockFileContent({
  tab,
}: {
  tab: Extract<WorkspaceTab, { kind: 'file' }>;
}) {
  return (
    <div className="ws-demo-mock ws-demo-mock--file">
      <div className="ws-demo-mock__head">
        <span className="ws-demo-mock__label">{tab.tabType}</span>
        <span className="ws-demo-mock__title">{tab.filePath}</span>
        {CHANGED_FILES.has(tab.filePath) && (
          <span className="ws-demo-mock__pill">unsaved</span>
        )}
      </div>
      <div className="ws-demo-mock__body">
        <pre>{`path: ${tab.filePath}
type: ${tab.tabType}

[mock content — replace with real <FileTabContent /> in production wire]

Try:
  • drag this tab to another pane's tab bar to move it
  • drag to a pane edge (top/bottom/left/right) to split
  • close with × button
  • click the + button on a tab bar to add a new mock tab`}</pre>
      </div>
    </div>
  );
}

export function WorkspaceLayoutDemo() {
  const resetLayout = useWorkspaceLayoutStore((s) => s.resetLayout);
  const addTab = useWorkspaceLayoutStore((s) => s.addTab);
  const layout = useWorkspaceLayoutStore((s) => s.layout);

  useEffect(() => {
    resetLayout(MOCK_TABS);
  }, [resetLayout]);

  const summaryContext = useMemo<SummaryContext>(
    () => ({
      findSession: (id) => MOCK_SESSIONS.find((s) => s.id === id),
      isFileChanged: (path) => CHANGED_FILES.has(path),
      repoLabel: 'R',
      repoColor: '#d97757',
    }),
    []
  );

  const renderTab = (tab: WorkspaceTab) => {
    if (tab.kind === 'session') {
      const session = MOCK_SESSIONS.find((s) => s.id === tab.sessionId);
      if (!session) return <div className="ws-demo-mock">unknown session</div>;
      return <MockSessionContent session={session} />;
    }
    return <MockFileContent tab={tab} />;
  };

  const onAddTabRequest = (paneId: string) => {
    const counter = (Math.random() * 1000) | 0;
    const tab: WorkspaceTab = {
      kind: 'file',
      filePath: `mock/scratch-${counter}.ts`,
      tabType: 'code',
    };
    addTab(paneId, tab);
  };

  const tabCount = useMemo(() => {
    function count(node: typeof layout): number {
      if (node.type === 'pane') return node.tabs.length;
      return node.children.reduce((s, c) => s + count(c), 0);
    }
    return count(layout);
  }, [layout]);

  return (
    <div className="ws-demo">
      <header className="ws-demo__bar">
        <span className="ws-demo__brand">workspace layout · demo</span>
        <span className="ws-demo__sep">·</span>
        <span className="ws-demo__hint">
          drag tab onto another tab bar to move · onto an edge to split
        </span>
        <span className="ws-demo__spacer" />
        <span className="ws-demo__stat">{tabCount} tabs</span>
        <button className="ws-demo__btn" onClick={() => resetLayout(MOCK_TABS)}>
          reset
        </button>
        <a className="ws-demo__btn" href="?">
          exit demo
        </a>
      </header>
      <main className="ws-demo__main">
        <WorkspaceLayout
          summaryContext={summaryContext}
          onAddTabRequest={onAddTabRequest}
        />
        <WorkspaceContentLayer renderTab={renderTab} />
      </main>
    </div>
  );
}

export default WorkspaceLayoutDemo;

// Helper used during workspace tab id calc when seeding new tabs.
export const _seedTabId = workspaceTabId;
