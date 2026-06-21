// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetIdCounters,
  createDefaultWorkspaceLayout,
  workspaceTabId,
  type WorkspacePane,
  type WorkspaceTab,
} from '../frontend/src/lib/workspace-layout.js';
import { useWorkspaceLayoutStore } from '../frontend/src/lib/stores/workspace-layout-store.js';
import { fileTabKey, useUiStore } from '../frontend/src/lib/stores/ui.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  ConflictError: class ConflictError extends Error {},
  FileContentConflictError: class FileContentConflictError extends Error {},
  FileContentOversizeError: class FileContentOversizeError extends Error {
    maxBytes?: number;
  },
  fetchHubNodes: vi.fn(),
}));

vi.mock('../frontend/src/hooks/useFileContent.js', () => ({
  useFileContent: () => ({
    content: '# readme\n',
    mtimeMs: 1,
    binary: false,
    truncated: false,
    loading: false,
    error: null,
  }),
  useInvalidateFileContent: () => vi.fn(),
  useSaveFileContent: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock('../frontend/src/hooks/useFileDiff.js', () => ({
  useFileDiff: () => ({ diff: '', loading: false, error: null }),
  useInvalidateFileDiff: () => vi.fn(),
}));

vi.mock('../frontend/src/lib/session-utils.js', () => ({
  createAgentSession: vi.fn(),
  getCurrentSessionContext: () => ({ currentActiveWorkspace: null }),
}));

vi.mock('../frontend/src/components/WorkspaceLayout.js', async () => {
  const ReactModule = await import('react');
  return { WorkspaceLayout: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/WorkspaceContentLayer.js', async () => {
  const ReactModule = await import('react');
  return { WorkspaceContentLayer: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/TerminalNodePicker.js', async () => {
  const ReactModule = await import('react');
  return {
    TerminalNodePicker: () => ReactModule.createElement('button', null, '+'),
  };
});

vi.mock('../frontend/src/components/Terminal.js', async () => {
  const ReactModule = await import('react');
  return { Terminal: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/chat/ChatView.js', async () => {
  const ReactModule = await import('react');
  return { ChatView: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/FileFeedbackPanel.js', async () => {
  const ReactModule = await import('react');
  return { default: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/CodeMirrorFileEditor.js', async () => {
  const ReactModule = await import('react');
  return {
    default: () =>
      ReactModule.createElement('textarea', { 'aria-label': 'mock editor' }),
  };
});

const { WorkspaceArea } =
  await import('../frontend/src/components/WorkspaceArea.js');

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    type: 'agent',
    name: 'Agent 1',
    displayName: 'Agent 1',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    status: 'running',
    cwd: '/repo',
    repoPath: '/repo',
    worktreePath: '/repo',
    branchName: 'main',
    agent: 'claude',
    agentState: 'idle',
    ...overrides,
  } as SessionSummary;
}

describe('WorkspaceArea file tab reconciliation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const s = session();

  beforeEach(() => {
    _resetIdCounters();
    container = document.createElement('div');
    document.body.appendChild(container);

    useUiStore.setState({
      openFileTabs: [],
      activeFileTabKey: null,
      codeTabDirty: {},
      codeTabPendingContent: {},
    });
    const initialLayout = createDefaultWorkspaceLayout([
      { kind: 'session', sessionId: s.id, sessionType: s.type } as WorkspaceTab,
    ]);
    useWorkspaceLayoutStore.setState({
      layout: initialLayout,
      activePaneId: initialLayout.id,
      splitSizes: {},
    });
    useSessionsStore.setState({
      sessions: [s],
      activeSessionId: s.id,
    });

    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('adds and activates a code file tab even when activePaneId is stale', async () => {
    await act(async () => {
      root.render(
        React.createElement(WorkspaceArea, {
          workspacePath: '/repo',
          sessions: [s],
          onImageUpload: () => {},
          onCopyModeChange: () => {},
          onFilePathClick: () => {},
          onCloseSession: () => {},
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      useWorkspaceLayoutStore.setState({ activePaneId: 'stale-pane' });
      useUiStore.getState().openFileTab('README.md', false);
      await Promise.resolve();
    });

    const layout = useWorkspaceLayoutStore.getState().layout as WorkspacePane;
    const fileTab = {
      kind: 'file',
      filePath: 'README.md',
      tabType: 'code',
    } as WorkspaceTab;
    expect(layout.tabs.map(workspaceTabId)).toContain(workspaceTabId(fileTab));
    expect(layout.activeTabId).toBe(`file::${fileTabKey('README.md', 'code')}`);
  });
});
