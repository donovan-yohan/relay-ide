import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage before importing the store
const storage: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
      clear: () => { for (const key of Object.keys(storage)) delete storage[key]; },
      get length() { return Object.keys(storage).length; },
      key: (index: number) => Object.keys(storage)[index] ?? null,
    },
    configurable: true,
  });
}

import {
  useUiStore,
  fileTabKey,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_RIGHT_SIDEBAR_WIDTH,
  DEFAULT_FILE_VIEWER_RATIO,
  DEFAULT_TERMINAL_FONT_SIZE,
} from '../../frontend/src/lib/stores/ui.js';

function resetStore() {
  for (const key of Object.keys(storage)) delete storage[key];
  useUiStore.setState({
    sidebarOpen: false,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
    searchQuery: '',
    activeRepoPath: null,
    activeWorkspaceId: null,
    terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
    hasHardwareKeyboard: false,
    keyboardOpen: false,
    fullPageDiff: null,
    fileDiffSource: 'working',
    fileDiffDefaultBranch: 'main',
    fileDiffViewMode: 'unified',
    fileWordWrap: false,
    rightSidebarVisible: true,
    rightSidebarCollapsed: false,
    rightSidebarWidth: DEFAULT_RIGHT_SIDEBAR_WIDTH,
    rightSidebarTab: 'changes',
    openFileTabs: [],
    activeFileTabKey: null,
    fileViewerRatio: DEFAULT_FILE_VIEWER_RATIO,
    sendToTargetSessionId: null,
    lastChangedFiles: [],
    collapsedWorkspaces: new Set(),
  });
}

describe('ui Zustand store', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('sidebar', () => {
    it('openSidebar sets sidebarOpen to true', () => {
      useUiStore.getState().openSidebar();
      assert.strictEqual(useUiStore.getState().sidebarOpen, true);
    });

    it('closeSidebar sets sidebarOpen to false', () => {
      useUiStore.getState().openSidebar();
      useUiStore.getState().closeSidebar();
      assert.strictEqual(useUiStore.getState().sidebarOpen, false);
    });

    it('toggleSidebarCollapsed flips collapsed state', () => {
      assert.strictEqual(useUiStore.getState().sidebarCollapsed, false);
      useUiStore.getState().toggleSidebarCollapsed();
      assert.strictEqual(useUiStore.getState().sidebarCollapsed, true);
      useUiStore.getState().toggleSidebarCollapsed();
      assert.strictEqual(useUiStore.getState().sidebarCollapsed, false);
    });

    it('toggleSidebarCollapsed persists to localStorage', () => {
      useUiStore.getState().toggleSidebarCollapsed();
      assert.strictEqual(storage['claude-remote-sidebar-collapsed'], 'true');
      useUiStore.getState().toggleSidebarCollapsed();
      assert.strictEqual(storage['claude-remote-sidebar-collapsed'], 'false');
    });
  });

  describe('right sidebar', () => {
    it('toggleRightSidebarCollapsed flips collapsed state', () => {
      assert.strictEqual(useUiStore.getState().rightSidebarCollapsed, false);
      useUiStore.getState().toggleRightSidebarCollapsed();
      assert.strictEqual(useUiStore.getState().rightSidebarCollapsed, true);
      useUiStore.getState().toggleRightSidebarCollapsed();
      assert.strictEqual(useUiStore.getState().rightSidebarCollapsed, false);
    });

    it('toggleRightSidebarCollapsed persists to localStorage', () => {
      useUiStore.getState().toggleRightSidebarCollapsed();
      assert.strictEqual(storage['claude-remote-right-sidebar-collapsed'], 'true');
    });
  });

  describe('active workspace', () => {
    it('setActiveRepoPath stores and persists value', () => {
      useUiStore.getState().setActiveRepoPath('/home/user/repo');
      assert.strictEqual(useUiStore.getState().activeRepoPath, '/home/user/repo');
      assert.strictEqual(storage['claude-remote-active-workspace'], '/home/user/repo');
    });

    it('setActiveRepoPath with null clears value', () => {
      useUiStore.getState().setActiveRepoPath('/home/user/repo');
      useUiStore.getState().setActiveRepoPath(null);
      assert.strictEqual(useUiStore.getState().activeRepoPath, null);
      assert.strictEqual(storage['claude-remote-active-workspace'], undefined);
    });

    it('setActiveWorkspaceId stores and persists value', () => {
      useUiStore.getState().setActiveWorkspaceId('ws-123');
      assert.strictEqual(useUiStore.getState().activeWorkspaceId, 'ws-123');
      assert.strictEqual(storage['claude-remote-active-workspace-group'], 'ws-123');
    });
  });

  describe('file tabs', () => {
    it('openFileTab adds a new tab', () => {
      useUiStore.getState().openFileTab('src/app.ts', false);
      const { openFileTabs, activeFileTabKey } = useUiStore.getState();
      assert.strictEqual(openFileTabs.length, 1);
      assert.strictEqual(openFileTabs[0]!.filePath, 'src/app.ts');
      assert.strictEqual(openFileTabs[0]!.fileName, 'app.ts');
      assert.strictEqual(openFileTabs[0]!.isChanged, false);
      assert.strictEqual(activeFileTabKey, fileTabKey('src/app.ts', 'code'));
    });

    it('openFileTab with isChanged creates a diff tab', () => {
      useUiStore.getState().openFileTab('src/index.ts', true);
      const { openFileTabs } = useUiStore.getState();
      assert.strictEqual(openFileTabs[0]!.tabType, 'diff');
    });

    it('openFileTab re-selects existing tab without duplicating', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().openFileTab('src/b.ts', false);
      useUiStore.getState().openFileTab('src/a.ts', false);
      assert.strictEqual(useUiStore.getState().openFileTabs.length, 2);
      assert.strictEqual(useUiStore.getState().activeFileTabKey, fileTabKey('src/a.ts', 'code'));
    });

    it('closeFileTab removes tab and activates previous', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().openFileTab('src/b.ts', false);
      useUiStore.getState().closeFileTab('src/b.ts', 'code');
      const { openFileTabs, activeFileTabKey } = useUiStore.getState();
      assert.strictEqual(openFileTabs.length, 1);
      assert.strictEqual(activeFileTabKey, fileTabKey('src/a.ts', 'code'));
    });

    it('closeFileTab with no remaining tabs clears activeFileTabKey', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().closeFileTab('src/a.ts', 'code');
      assert.strictEqual(useUiStore.getState().openFileTabs.length, 0);
      assert.strictEqual(useUiStore.getState().activeFileTabKey, null);
    });

    it('closeAllFileTabs clears everything', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().openFileTab('src/b.ts', true);
      useUiStore.getState().closeAllFileTabs();
      assert.strictEqual(useUiStore.getState().openFileTabs.length, 0);
      assert.strictEqual(useUiStore.getState().activeFileTabKey, null);
    });

    it('openHtmlTab creates an html-type tab', () => {
      useUiStore.getState().openHtmlTab('preview.html', 'tok-1');
      const { openFileTabs } = useUiStore.getState();
      assert.strictEqual(openFileTabs.length, 1);
      assert.strictEqual(openFileTabs[0]!.tabType, 'html');
      assert.strictEqual(openFileTabs[0]!.token, 'tok-1');
    });

    it('refreshHtmlTab increments refreshVersion', () => {
      useUiStore.getState().openHtmlTab('preview.html', 'tok-1');
      useUiStore.getState().refreshHtmlTab('preview.html');
      const tab = useUiStore.getState().openFileTabs[0]!;
      assert.strictEqual(tab.refreshVersion, 1);
      useUiStore.getState().refreshHtmlTab('preview.html');
      const tab2 = useUiStore.getState().openFileTabs[0]!;
      assert.strictEqual(tab2.refreshVersion, 2);
    });
  });

  describe('diff view settings', () => {
    it('setFileDiffViewMode changes mode and persists', () => {
      useUiStore.getState().setFileDiffViewMode('side-by-side');
      assert.strictEqual(useUiStore.getState().fileDiffViewMode, 'side-by-side');
      assert.strictEqual(storage['claude-remote-diff-view-mode'], 'side-by-side');
    });

    it('setFileWordWrap changes wrap and persists', () => {
      useUiStore.getState().setFileWordWrap(true);
      assert.strictEqual(useUiStore.getState().fileWordWrap, true);
      assert.strictEqual(storage['claude-remote-word-wrap'], 'true');
    });
  });

  describe('workspace collapse', () => {
    it('toggleWorkspaceCollapse adds and removes', () => {
      useUiStore.getState().toggleWorkspaceCollapse('/repo/a');
      assert.strictEqual(useUiStore.getState().isWorkspaceCollapsed('/repo/a'), true);
      useUiStore.getState().toggleWorkspaceCollapse('/repo/a');
      assert.strictEqual(useUiStore.getState().isWorkspaceCollapsed('/repo/a'), false);
    });

    it('persists collapsed workspaces to localStorage', () => {
      useUiStore.getState().toggleWorkspaceCollapse('/repo/x');
      const stored = JSON.parse(storage['claude-remote-collapsed-workspaces']!);
      assert.deepStrictEqual(stored, ['/repo/x']);
    });
  });

  describe('fileTabKey', () => {
    it('defaults to code type', () => {
      assert.strictEqual(fileTabKey('src/app.ts'), 'code::src/app.ts');
    });

    it('uses specified type', () => {
      assert.strictEqual(fileTabKey('src/app.ts', 'diff'), 'diff::src/app.ts');
      assert.strictEqual(fileTabKey('preview.html', 'html'), 'html::preview.html');
    });
  });
});
