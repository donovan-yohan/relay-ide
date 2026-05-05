import { describe, it, beforeEach, expect } from 'vitest';

// Mock localStorage before importing the store
const storage: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        for (const key of Object.keys(storage)) delete storage[key];
      },
      get length() {
        return Object.keys(storage).length;
      },
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
  DEFAULT_UTILITY_RAIL_WIDTH,
  MIN_UTILITY_RAIL_WIDTH,
  MAX_UTILITY_RAIL_WIDTH,
  clearUtilityRailStateCacheForTesting,
} from '../../frontend/src/lib/stores/ui.js';

function resetStore() {
  for (const key of Object.keys(storage)) delete storage[key];
  clearUtilityRailStateCacheForTesting();
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
    utilityRailByWorkspace: {},
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
      expect(useUiStore.getState().sidebarOpen).toBe(true);
    });

    it('closeSidebar sets sidebarOpen to false', () => {
      useUiStore.getState().openSidebar();
      useUiStore.getState().closeSidebar();
      expect(useUiStore.getState().sidebarOpen).toBe(false);
    });

    it('toggleSidebarCollapsed flips collapsed state', () => {
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
      useUiStore.getState().toggleSidebarCollapsed();
      expect(useUiStore.getState().sidebarCollapsed).toBe(true);
      useUiStore.getState().toggleSidebarCollapsed();
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    });

    it('toggleSidebarCollapsed persists to localStorage', () => {
      useUiStore.getState().toggleSidebarCollapsed();
      expect(storage['claude-remote-sidebar-collapsed']).toBe('true');
      useUiStore.getState().toggleSidebarCollapsed();
      expect(storage['claude-remote-sidebar-collapsed']).toBe('false');
    });
  });

  describe('right sidebar', () => {
    it('toggleRightSidebarCollapsed flips collapsed state', () => {
      expect(useUiStore.getState().rightSidebarCollapsed).toBe(false);
      useUiStore.getState().toggleRightSidebarCollapsed();
      expect(useUiStore.getState().rightSidebarCollapsed).toBe(true);
      useUiStore.getState().toggleRightSidebarCollapsed();
      expect(useUiStore.getState().rightSidebarCollapsed).toBe(false);
    });

    it('toggleRightSidebarCollapsed persists to localStorage', () => {
      useUiStore.getState().toggleRightSidebarCollapsed();
      expect(storage['claude-remote-right-sidebar-collapsed']).toBe('true');
    });
  });

  describe('utility rail', () => {
    it('stores utility rail state per workspace path', () => {
      const a = useUiStore.getState().getUtilityRailState('/repo/a');
      const b = useUiStore.getState().getUtilityRailState('/repo/b');

      expect(a).toMatchObject({
        visible: true,
        selectedRailTab: null,
        width: DEFAULT_UTILITY_RAIL_WIDTH,
        review: {
          activeFilePath: null,
          diffSource: 'working',
          defaultBranch: 'main',
          currentHunkIndex: -1,
        },
      });
      expect(b).toMatchObject({
        visible: true,
        selectedRailTab: null,
        width: DEFAULT_UTILITY_RAIL_WIDTH,
        review: {
          activeFilePath: null,
          diffSource: 'working',
          defaultBranch: 'main',
          currentHunkIndex: -1,
        },
      });

      useUiStore.getState().setSelectedUtilityRailTab('/repo/a', 'review');
      useUiStore.getState().setUtilityRailWidth('/repo/a', 999);

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        visible: true,
        selectedRailTab: 'review',
        width: MAX_UTILITY_RAIL_WIDTH,
      });
      expect(useUiStore.getState().getUtilityRailState('/repo/b')).toMatchObject({
        visible: true,
        selectedRailTab: null,
        width: DEFAULT_UTILITY_RAIL_WIDTH,
      });
      expect(storage['relay-utility-rail::/repo/a']).toContain(
        '"selectedRailTab":"review"'
      );
      expect(storage['relay-utility-rail::/repo/b']).toBe(undefined);
    });

    it('openUtilityRailTab makes the rail visible and selects the requested tab', () => {
      useUiStore.getState().setUtilityRailVisible('/repo/a', false);
      useUiStore.getState().openUtilityRailTab('/repo/a', 'branch');

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        visible: true,
        selectedRailTab: 'branch',
      });
    });

    it('openUtilityRailTab can preserve the current selected tab', () => {
      useUiStore.getState().setSelectedUtilityRailTab('/repo/a', 'logs');
      useUiStore.getState().openUtilityRailTab('/repo/a', 'stats', {
        preserveSelectedTab: true,
      });

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        visible: true,
        selectedRailTab: 'logs',
      });
    });

    it('stores the selected branch base when opening the branch rail', () => {
      useUiStore.getState().openUtilityRailTab('/repo/a', 'branch', {
        branchBase: 'origin/nightly',
      });

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        visible: true,
        selectedRailTab: 'branch',
        branchBase: 'origin/nightly',
      });
      expect(storage['relay-utility-rail::/repo/a']).toContain(
        '"branchBase":"origin/nightly"'
      );
    });

    it('setUtilityBranchBase updates a workspace branch comparison base', () => {
      useUiStore.getState().setUtilityBranchBase('/repo/a', 'origin/main');

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a').branchBase
      ).toBe('origin/main');
      expect(storage['relay-utility-rail::/repo/a']).toContain(
        '"branchBase":"origin/main"'
      );
    });

    it('clamps utility rail widths', () => {
      useUiStore.getState().setUtilityRailWidth('/repo/a', 100);
      expect(useUiStore.getState().getUtilityRailState('/repo/a').width).toBe(
        MIN_UTILITY_RAIL_WIDTH
      );

      useUiStore.getState().setUtilityRailWidth('/repo/a', 999);
      expect(useUiStore.getState().getUtilityRailState('/repo/a').width).toBe(
        MAX_UTILITY_RAIL_WIDTH
      );
    });

    it('persists utility rail width only when saved', () => {
      useUiStore.getState().hydrateUtilityRailState('/repo/a');
      useUiStore.getState().setUtilityRailWidth('/repo/a', 999);

      expect(storage['relay-utility-rail::/repo/a']).toBe(undefined);

      useUiStore.getState().saveUtilityRailState('/repo/a');
      expect(storage['relay-utility-rail::/repo/a']).toContain(
        `"width":${MAX_UTILITY_RAIL_WIDTH}`
      );
    });

    it('returns a stable default utility rail state before hydration', () => {
      const first = useUiStore.getState().getUtilityRailState('/repo/a');
      const second = useUiStore.getState().getUtilityRailState('/repo/a');

      expect(second).toBe(first);
    });

    it('clamps anchored utility pane widths and stores placements', () => {
      useUiStore
        .getState()
        .setAnchoredUtilityPaneWidth('/repo/a', 'review', 10);
      useUiStore.getState().setUtilitySurfacePlacement('/repo/a', 'review', {
        kind: 'anchored-pane',
        paneId: 'pane-1',
      });

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        anchoredPaneWidths: {
          review: MIN_UTILITY_RAIL_WIDTH,
        },
        placements: {
          review: {
            kind: 'anchored-pane',
            paneId: 'pane-1',
          },
        },
      });
    });

    it('stores review file, source, default branch, and hunk per workspace', () => {
      useUiStore.getState().openReviewWorkspace('/repo/a', {
        filePath: 'src/a.ts',
        base: 'develop',
      });
      useUiStore.getState().setReviewActiveFile('/repo/a', 'src/a2.ts');
      useUiStore.getState().setReviewCurrentHunkIndex('/repo/a', 2);
      useUiStore.getState().openReviewWorkspace('/repo/b', {
        filePath: 'src/b.ts',
        base: 'cached',
      });

      expect(useUiStore.getState().getUtilityRailState('/repo/a')).toMatchObject({
        selectedRailTab: 'review',
        review: {
          activeFilePath: 'src/a2.ts',
          diffSource: 'branch',
          defaultBranch: 'develop',
          currentHunkIndex: 2,
        },
      });
      expect(useUiStore.getState().getUtilityRailState('/repo/b')).toMatchObject({
        selectedRailTab: 'review',
        review: {
          activeFilePath: 'src/b.ts',
          diffSource: 'staged',
          defaultBranch: 'main',
          currentHunkIndex: -1,
        },
      });
    });

    it('openReviewWorkspace keeps workspace review navigation in the rail without file tabs', () => {
      useUiStore.getState().openReviewWorkspace('/repo/a', {
        filePath: 'src/changed.ts',
      });

      expect(useUiStore.getState().openFileTabs).toEqual([]);
      expect(useUiStore.getState().getUtilityRailState('/repo/a')).toMatchObject({
        visible: true,
        selectedRailTab: 'review',
        review: {
          activeFilePath: 'src/changed.ts',
          diffSource: 'working',
        },
      });
    });

    it('openReviewWorkspace can seed review state without clearing the full-page overlay guard', () => {
      useUiStore.setState({
        fullPageDiff: { workspacePath: '/repo/a', file: 'src/changed.ts' },
      });

      useUiStore.getState().openReviewWorkspace('/repo/a', {
        filePath: 'src/changed.ts',
        preserveFullPageDiff: true,
      });

      expect(useUiStore.getState().fullPageDiff).toEqual({
        workspacePath: '/repo/a',
        file: 'src/changed.ts',
      });
      expect(useUiStore.getState().getUtilityRailState('/repo/a')).toMatchObject({
        selectedRailTab: 'review',
        review: { activeFilePath: 'src/changed.ts' },
      });
    });

    it('openReviewWorkspace preserves hunk navigation when only revealing the current review panel', () => {
      useUiStore.getState().openReviewWorkspace('/repo/a', {
        filePath: 'src/changed.ts',
        base: 'develop',
      });
      useUiStore.getState().setReviewCurrentHunkIndex('/repo/a', 3);

      useUiStore.getState().openReviewWorkspace('/repo/a', {
        preserveSelectedTab: true,
      });

      expect(useUiStore.getState().getUtilityRailState('/repo/a').review).toMatchObject({
        activeFilePath: 'src/changed.ts',
        diffSource: 'branch',
        defaultBranch: 'develop',
        currentHunkIndex: 3,
      });
    });
  });

  describe('active workspace', () => {
    it('setActiveRepoPath stores and persists value', () => {
      useUiStore.getState().setActiveRepoPath('/home/user/repo');
      expect(useUiStore.getState().activeRepoPath).toBe('/home/user/repo');
      expect(storage['claude-remote-active-workspace']).toBe('/home/user/repo');
    });

    it('setActiveRepoPath with null clears value', () => {
      useUiStore.getState().setActiveRepoPath('/home/user/repo');
      useUiStore.getState().setActiveRepoPath(null);
      expect(useUiStore.getState().activeRepoPath).toBe(null);
      expect(storage['claude-remote-active-workspace']).toBe(undefined);
    });

    it('setActiveWorkspaceId stores and persists value', () => {
      useUiStore.getState().setActiveWorkspaceId('ws-123');
      expect(useUiStore.getState().activeWorkspaceId).toBe('ws-123');
      expect(storage['claude-remote-active-workspace-group']).toBe('ws-123');
    });
  });

  describe('file tabs', () => {
    it('openFileTab adds a new tab', () => {
      useUiStore.getState().openFileTab('src/app.ts', false);
      const { openFileTabs, activeFileTabKey } = useUiStore.getState();
      expect(openFileTabs.length).toBe(1);
      expect(openFileTabs[0]!.filePath).toBe('src/app.ts');
      expect(openFileTabs[0]!.fileName).toBe('app.ts');
      expect(openFileTabs[0]!.isChanged).toBe(false);
      expect(activeFileTabKey).toBe(fileTabKey('src/app.ts', 'code'));
    });

    it('openFileTab with isChanged creates a diff tab', () => {
      useUiStore.getState().openFileTab('src/index.ts', true);
      const { openFileTabs } = useUiStore.getState();
      expect(openFileTabs[0]!.tabType).toBe('diff');
    });

    it('openFileTab re-selects existing tab without duplicating', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().openFileTab('src/b.ts', false);
      useUiStore.getState().openFileTab('src/a.ts', false);
      expect(useUiStore.getState().openFileTabs.length).toBe(2);
      expect(useUiStore.getState().activeFileTabKey).toBe(
        fileTabKey('src/a.ts', 'code')
      );
    });

    it('closeFileTab removes tab and activates previous', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().openFileTab('src/b.ts', false);
      useUiStore.getState().closeFileTab('src/b.ts', 'code');
      const { openFileTabs, activeFileTabKey } = useUiStore.getState();
      expect(openFileTabs.length).toBe(1);
      expect(activeFileTabKey).toBe(fileTabKey('src/a.ts', 'code'));
    });

    it('closeFileTab with no remaining tabs clears activeFileTabKey', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().closeFileTab('src/a.ts', 'code');
      expect(useUiStore.getState().openFileTabs.length).toBe(0);
      expect(useUiStore.getState().activeFileTabKey).toBe(null);
    });

    it('closeAllFileTabs clears everything', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore.getState().openFileTab('src/b.ts', true);
      useUiStore.getState().closeAllFileTabs();
      expect(useUiStore.getState().openFileTabs.length).toBe(0);
      expect(useUiStore.getState().activeFileTabKey).toBe(null);
    });

    it('openHtmlTab creates an html-type tab', () => {
      useUiStore.getState().openHtmlTab('preview.html', 'tok-1');
      const { openFileTabs } = useUiStore.getState();
      expect(openFileTabs.length).toBe(1);
      expect(openFileTabs[0]!.tabType).toBe('html');
      expect(openFileTabs[0]!.token).toBe('tok-1');
    });

    it('refreshHtmlTab increments refreshVersion', () => {
      useUiStore.getState().openHtmlTab('preview.html', 'tok-1');
      useUiStore.getState().refreshHtmlTab('preview.html');
      const tab = useUiStore.getState().openFileTabs[0]!;
      expect(tab.refreshVersion).toBe(1);
      useUiStore.getState().refreshHtmlTab('preview.html');
      const tab2 = useUiStore.getState().openFileTabs[0]!;
      expect(tab2.refreshVersion).toBe(2);
    });
  });

  describe('diff view settings', () => {
    it('setFileDiffViewMode changes mode and persists', () => {
      useUiStore.getState().setFileDiffViewMode('side-by-side');
      expect(useUiStore.getState().fileDiffViewMode).toBe('side-by-side');
      expect(storage['claude-remote-diff-view-mode']).toBe('side-by-side');
    });

    it('setFileWordWrap changes wrap and persists', () => {
      useUiStore.getState().setFileWordWrap(true);
      expect(useUiStore.getState().fileWordWrap).toBe(true);
      expect(storage['claude-remote-word-wrap']).toBe('true');
    });
  });

  describe('workspace collapse', () => {
    it('toggleWorkspaceCollapse adds and removes', () => {
      useUiStore.getState().toggleWorkspaceCollapse('/repo/a');
      expect(useUiStore.getState().isWorkspaceCollapsed('/repo/a')).toBe(true);
      useUiStore.getState().toggleWorkspaceCollapse('/repo/a');
      expect(useUiStore.getState().isWorkspaceCollapsed('/repo/a')).toBe(false);
    });

    it('persists collapsed workspaces to localStorage', () => {
      useUiStore.getState().toggleWorkspaceCollapse('/repo/x');
      const stored = JSON.parse(storage['claude-remote-collapsed-workspaces']!);
      expect(stored).toEqual(['/repo/x']);
    });
  });

  describe('fileTabKey', () => {
    it('defaults to code type', () => {
      expect(fileTabKey('src/app.ts')).toBe('code::src/app.ts');
    });

    it('uses specified type', () => {
      expect(fileTabKey('src/app.ts', 'diff')).toBe('diff::src/app.ts');
      expect(fileTabKey('preview.html', 'html')).toBe('html::preview.html');
    });
  });
});
