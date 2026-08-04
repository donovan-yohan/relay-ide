import { describe, it, beforeEach, expect, vi } from 'vitest';

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
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_UTILITY_RAIL_WIDTH,
  MIN_UTILITY_RAIL_WIDTH,
  MAX_UTILITY_RAIL_WIDTH,
  MAX_TOPIC_RAIL_FOLDS,
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
    codeTabDirty: {},
    codeTabPendingContent: {},
    sendToTargetSessionId: null,
    lastChangedFiles: [],
    collapsedWorkspaces: new Set(),
    topicRailExpansion: {},
    collapsedTopicGroups: new Set(),
    advancedMode: false,
    orgDashboardTab: 'prs',
  });
}

function withMockWindowConfirm(
  value: boolean,
  run: (confirmSpy: ReturnType<typeof vi.fn>) => void
) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const confirmSpy = vi.fn(() => value);
  Object.defineProperty(globalThis, 'window', {
    value: { confirm: confirmSpy },
    configurable: true,
  });
  try {
    run(confirmSpy);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
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
      expect(
        useUiStore.getState().getUtilityRailState('/repo/b')
      ).toMatchObject({
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

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        selectedRailTab: 'review',
        review: {
          activeFilePath: 'src/a2.ts',
          diffSource: 'branch',
          defaultBranch: 'develop',
          currentHunkIndex: 2,
        },
      });
      expect(
        useUiStore.getState().getUtilityRailState('/repo/b')
      ).toMatchObject({
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
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
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
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
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

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a').review
      ).toMatchObject({
        activeFilePath: 'src/changed.ts',
        diffSource: 'branch',
        defaultBranch: 'develop',
        currentHunkIndex: 3,
      });
    });

    it('tracks utility terminal membership, order, and selected id per workspace', () => {
      useUiStore.getState().addUtilityTerminal('/repo/a', 'term-1');
      useUiStore.getState().addUtilityTerminal('/repo/a', 'term-2');
      useUiStore.getState().addUtilityTerminal('/repo/a', 'term-1');
      useUiStore.getState().addUtilityTerminal('/repo/b', 'term-b');

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        selectedRailTab: 'terminal',
        utilityTerminalIds: ['term-1', 'term-2'],
        selectedUtilityTerminalId: 'term-1',
      });
      expect(
        useUiStore.getState().getUtilityRailState('/repo/b')
      ).toMatchObject({
        utilityTerminalIds: ['term-b'],
        selectedUtilityTerminalId: 'term-b',
      });
      expect(storage['relay-utility-rail::/repo/a']).toContain(
        '"utilityTerminalIds":["term-1","term-2"]'
      );
    });

    it('selects, removes, promotes, and reconciles utility terminals without leaking stale ids', () => {
      useUiStore.getState().addUtilityTerminal('/repo/a', 'term-1');
      useUiStore.getState().addUtilityTerminal('/repo/a', 'term-2');
      useUiStore.getState().selectUtilityTerminal('/repo/a', 'term-2');

      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
          .selectedUtilityTerminalId
      ).toBe('term-2');

      useUiStore.getState().removeUtilityTerminal('/repo/a', 'term-2');
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        utilityTerminalIds: ['term-1'],
        selectedUtilityTerminalId: 'term-1',
      });

      useUiStore.getState().addUtilityTerminal('/repo/a', 'term-3');
      useUiStore.getState().promoteUtilityTerminal('/repo/a', 'term-1');
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        utilityTerminalIds: ['term-3'],
        selectedUtilityTerminalId: 'term-3',
      });

      useUiStore
        .getState()
        .reconcileUtilityTerminals('/repo/a', new Set(['term-9']));
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).not.toHaveProperty('utilityTerminalIds');
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).not.toHaveProperty('selectedUtilityTerminalId');
    });

    it('reconciles stale persisted utility terminal ids after hydration', () => {
      storage['relay-utility-rail::/repo/a'] = JSON.stringify({
        visible: true,
        selectedRailTab: 'terminal',
        width: DEFAULT_UTILITY_RAIL_WIDTH,
        utilityTerminalIds: ['stale-1', 'live-1', 'stale-2'],
        selectedUtilityTerminalId: 'stale-1',
      });

      useUiStore.getState().hydrateUtilityRailState('/repo/a');
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        utilityTerminalIds: ['stale-1', 'live-1', 'stale-2'],
        selectedUtilityTerminalId: 'stale-1',
      });

      useUiStore
        .getState()
        .reconcileUtilityTerminals('/repo/a', new Set(['live-1']));
      expect(
        useUiStore.getState().getUtilityRailState('/repo/a')
      ).toMatchObject({
        utilityTerminalIds: ['live-1'],
        selectedUtilityTerminalId: 'live-1',
      });
      expect(storage['relay-utility-rail::/repo/a']).toContain(
        '"utilityTerminalIds":["live-1"]'
      );
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
      useUiStore
        .getState()
        .setCodeTabDirty('src/a.ts', 'code', true, 'unsaved a');
      useUiStore.getState().closeAllFileTabs();
      expect(useUiStore.getState().openFileTabs.length).toBe(0);
      expect(useUiStore.getState().activeFileTabKey).toBe(null);
      expect(useUiStore.getState().codeTabDirty).toEqual({});
      expect(useUiStore.getState().codeTabPendingContent).toEqual({});
    });

    it('setCodeTabDirty stores and clears editor dirty state and pending text by tab key', () => {
      useUiStore.getState().openFileTab('src/a.ts', false);
      useUiStore
        .getState()
        .setCodeTabDirty('src/a.ts', 'code', true, 'unsaved text');
      expect(useUiStore.getState().codeTabDirty).toEqual({
        [fileTabKey('src/a.ts', 'code')]: true,
      });
      expect(useUiStore.getState().codeTabPendingContent).toEqual({
        [fileTabKey('src/a.ts', 'code')]: 'unsaved text',
      });

      useUiStore
        .getState()
        .setCodeTabDirty('src/a.ts', 'code', true, 'unsaved text v2');
      expect(
        useUiStore.getState().codeTabPendingContent[
          fileTabKey('src/a.ts', 'code')
        ]
      ).toBe('unsaved text v2');

      useUiStore.getState().setCodeTabDirty('src/a.ts', 'code', false);
      expect(useUiStore.getState().codeTabDirty).toEqual({});
      expect(useUiStore.getState().codeTabPendingContent).toEqual({});
    });

    it('keeps pending editor text in the store for dirty tab remount hydration', () => {
      useUiStore.getState().openFileTab('src/remount.ts', false);
      useUiStore
        .getState()
        .setCodeTabDirty(
          'src/remount.ts',
          'code',
          true,
          'disk text\nunsaved edit\n'
        );

      const key = fileTabKey('src/remount.ts', 'code');
      const remountedBridgeState = useUiStore.getState();

      expect(remountedBridgeState.codeTabDirty[key]).toBe(true);
      expect(remountedBridgeState.codeTabPendingContent[key]).toBe(
        'disk text\nunsaved edit\n'
      );
    });

    it('closeFileTab confirms before discarding dirty editor changes', () => {
      withMockWindowConfirm(false, (confirmSpy) => {
        useUiStore.getState().openFileTab('src/a.ts', false);
        useUiStore
          .getState()
          .setCodeTabDirty('src/a.ts', 'code', true, 'unsaved text');
        useUiStore.getState().closeFileTab('src/a.ts', 'code');
        expect(confirmSpy).toHaveBeenCalledWith(
          'discard unsaved changes to this file?'
        );
        expect(useUiStore.getState().openFileTabs.length).toBe(1);
        expect(useUiStore.getState().codeTabDirty).toEqual({
          [fileTabKey('src/a.ts', 'code')]: true,
        });
        expect(useUiStore.getState().codeTabPendingContent).toEqual({
          [fileTabKey('src/a.ts', 'code')]: 'unsaved text',
        });
      });
    });

    it('closeFileTab clears dirty editor state when discard is confirmed', () => {
      withMockWindowConfirm(true, () => {
        useUiStore.getState().openFileTab('src/a.ts', false);
        useUiStore
          .getState()
          .setCodeTabDirty('src/a.ts', 'code', true, 'unsaved text');
        useUiStore.getState().closeFileTab('src/a.ts', 'code');
        expect(useUiStore.getState().openFileTabs.length).toBe(0);
        expect(useUiStore.getState().codeTabDirty).toEqual({});
        expect(useUiStore.getState().codeTabPendingContent).toEqual({});
      });
    });

    it('closeAllFileTabs confirms before discarding dirty editor changes', () => {
      withMockWindowConfirm(false, (confirmSpy) => {
        useUiStore.getState().openFileTab('src/a.ts', false);
        useUiStore.getState().openFileTab('src/b.ts', false);
        useUiStore
          .getState()
          .setCodeTabDirty('src/a.ts', 'code', true, 'unsaved text');
        useUiStore.getState().closeAllFileTabs();
        expect(confirmSpy).toHaveBeenCalledWith(
          'discard unsaved changes to all open files?'
        );
        expect(useUiStore.getState().openFileTabs.length).toBe(2);
        expect(useUiStore.getState().codeTabDirty).toEqual({
          [fileTabKey('src/a.ts', 'code')]: true,
        });
        expect(useUiStore.getState().codeTabPendingContent).toEqual({
          [fileTabKey('src/a.ts', 'code')]: 'unsaved text',
        });
      });
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

  describe('chat rail fold state (#1287 slice 5)', () => {
    it('records only topics the operator actually toggled', () => {
      useUiStore.getState().setTopicRailExpanded('topic:a', false);
      useUiStore.getState().setTopicRailExpanded('topic:b', true);

      expect(useUiStore.getState().topicRailExpansion).toEqual({
        'topic:a': false,
        'topic:b': true,
      });
      expect(
        JSON.parse(storage['claude-remote-topic-rail-expansion']!)
      ).toEqual({ 'topic:a': false, 'topic:b': true });
    });

    it('leaves state identity alone when the value is unchanged', () => {
      useUiStore.getState().setTopicRailExpanded('topic:a', false);
      const before = useUiStore.getState().topicRailExpansion;
      useUiStore.getState().setTopicRailExpanded('topic:a', false);

      // Re-writing the same fold must not churn the record: the rail derives a
      // memoized Set from it, and a fresh object would re-render every row.
      expect(useUiStore.getState().topicRailExpansion).toBe(before);
    });

    it('caps the remembered folds and evicts the least recently touched', () => {
      for (let i = 0; i < MAX_TOPIC_RAIL_FOLDS + 5; i++) {
        useUiStore.getState().setTopicRailExpanded(`topic:${i}`, false);
      }
      // Re-touch the oldest survivor so it is no longer the eviction candidate.
      useUiStore.getState().setTopicRailExpanded('topic:5', true);
      useUiStore.getState().setTopicRailExpanded('topic:overflow', false);

      const expansion = useUiStore.getState().topicRailExpansion;
      expect(Object.keys(expansion)).toHaveLength(MAX_TOPIC_RAIL_FOLDS);
      expect(expansion['topic:0']).toBeUndefined();
      expect(expansion['topic:5']).toBe(true);
      expect(expansion['topic:overflow']).toBe(false);
    });

    it('persists mobile workspace-group collapse to localStorage', () => {
      useUiStore.getState().toggleTopicGroupCollapsed('ws:a');
      expect(useUiStore.getState().collapsedTopicGroups.has('ws:a')).toBe(true);
      expect(
        JSON.parse(storage['claude-remote-collapsed-topic-groups']!)
      ).toEqual(['ws:a']);

      useUiStore.getState().toggleTopicGroupCollapsed('ws:a');
      expect(useUiStore.getState().collapsedTopicGroups.has('ws:a')).toBe(false);
      expect(
        JSON.parse(storage['claude-remote-collapsed-topic-groups']!)
      ).toEqual([]);
    });

    it('rehydrates both folds from localStorage on a fresh load', async () => {
      // A reload is a fresh module graph, so prove the boot read rather than
      // the in-memory state a previous test left behind.
      storage['claude-remote-topic-rail-expansion'] = JSON.stringify({
        'topic:a': false,
        'topic:b': true,
        'topic:junk': 'yes',
      });
      storage['claude-remote-collapsed-topic-groups'] = JSON.stringify([
        'ws:a',
        7,
      ]);
      vi.resetModules();

      const { useUiStore: reloaded } = await import(
        '../../frontend/src/lib/stores/ui.js'
      );

      expect(reloaded.getState().topicRailExpansion).toEqual({
        'topic:a': false,
        'topic:b': true,
      });
      expect(Array.from(reloaded.getState().collapsedTopicGroups)).toEqual([
        'ws:a',
      ]);
    });

    it('survives corrupt persisted fold payloads', async () => {
      storage['claude-remote-topic-rail-expansion'] = '["not","a","map"]';
      storage['claude-remote-collapsed-topic-groups'] = '{oops';
      vi.resetModules();

      const { useUiStore: reloaded } = await import(
        '../../frontend/src/lib/stores/ui.js'
      );

      expect(reloaded.getState().topicRailExpansion).toEqual({});
      expect(reloaded.getState().collapsedTopicGroups.size).toBe(0);
    });
  });

  describe('advanced mode (#1058)', () => {
    it('setAdvancedMode(true) persists the flag and preserves the current tab', () => {
      useUiStore.getState().setOrgDashboardTab('tickets');
      useUiStore.getState().setAdvancedMode(true);

      expect(useUiStore.getState().advancedMode).toBe(true);
      expect(useUiStore.getState().orgDashboardTab).toBe('tickets');
      expect(storage['relay-advanced-mode']).toBe('1');
    });

    it('setAdvancedMode(false) rewrites a substrate tab back to prs', () => {
      useUiStore.getState().setAdvancedMode(true);
      useUiStore.getState().setOrgDashboardTab('active-work');

      useUiStore.getState().setAdvancedMode(false);

      expect(useUiStore.getState().advancedMode).toBe(false);
      expect(useUiStore.getState().orgDashboardTab).toBe('prs');
      expect(storage['relay-advanced-mode']).toBe(undefined);
    });

    it('setAdvancedMode(false) rewrites the other substrate tab (nodes) back to prs too', () => {
      useUiStore.getState().setAdvancedMode(true);
      useUiStore.getState().setOrgDashboardTab('nodes');

      useUiStore.getState().setAdvancedMode(false);

      expect(useUiStore.getState().orgDashboardTab).toBe('prs');
    });

    it('setAdvancedMode(false) leaves non-substrate tabs untouched', () => {
      useUiStore.getState().setAdvancedMode(true);
      useUiStore.getState().setOrgDashboardTab('audit');

      useUiStore.getState().setAdvancedMode(false);

      expect(useUiStore.getState().orgDashboardTab).toBe('audit');
    });

    it('toggleAdvancedMode flips the persisted flag', () => {
      expect(useUiStore.getState().advancedMode).toBe(false);
      useUiStore.getState().toggleAdvancedMode();
      expect(useUiStore.getState().advancedMode).toBe(true);
      expect(storage['relay-advanced-mode']).toBe('1');
      useUiStore.getState().toggleAdvancedMode();
      expect(useUiStore.getState().advancedMode).toBe(false);
      expect(storage['relay-advanced-mode']).toBe(undefined);
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
