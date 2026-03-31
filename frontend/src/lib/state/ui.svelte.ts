const SIDEBAR_WIDTH_KEY = 'claude-remote-sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'claude-remote-sidebar-collapsed';
const ACTIVE_WORKSPACE_KEY = 'claude-remote-active-workspace';
const ACTIVE_WORKSPACE_GROUP_KEY = 'claude-remote-active-workspace-group';
const TERMINAL_FONT_SIZE_KEY = 'claude-remote-terminal-font-size';
const RIGHT_SIDEBAR_WIDTH_KEY = 'claude-remote-right-sidebar-width';
const RIGHT_SIDEBAR_COLLAPSED_KEY = 'claude-remote-right-sidebar-collapsed';
const FILE_VIEWER_WIDTH_KEY = 'claude-remote-file-viewer-width';
export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 500;
export const COLLAPSED_SIDEBAR_WIDTH = 44;
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 28;
export const DEFAULT_RIGHT_SIDEBAR_WIDTH = 220;
export const MIN_RIGHT_SIDEBAR_WIDTH = 160;
export const MAX_RIGHT_SIDEBAR_WIDTH = 400;
export const COLLAPSED_RIGHT_SIDEBAR_WIDTH = 16;
export const DEFAULT_FILE_VIEWER_RATIO = 0.35; // 35% of available space

function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (val >= MIN_SIDEBAR_WIDTH && val <= MAX_SIDEBAR_WIDTH) return val;
    }
  } catch { /* localStorage unavailable */ }
  return DEFAULT_SIDEBAR_WIDTH;
}

function loadSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; }
  catch { return false; }
}

function loadActiveRepoPath(): string | null {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); }
  catch { return null; }
}

function loadTerminalFontSize(): number {
  try {
    const stored = localStorage.getItem(TERMINAL_FONT_SIZE_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (!Number.isNaN(val) && val >= MIN_TERMINAL_FONT_SIZE && val <= MAX_TERMINAL_FONT_SIZE) return val;
    }
  } catch { /* localStorage unavailable */ }
  return DEFAULT_TERMINAL_FONT_SIZE;
}

let sidebarOpen = $state(false);
let sidebarWidth = $state(loadSidebarWidth());
let sidebarCollapsed = $state(loadSidebarCollapsed());
let searchQuery = $state('');
let activeRepoPath = $state<string | null>(loadActiveRepoPath());
let activeWorkspaceId = $state<string | null>((() => {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_GROUP_KEY); }
  catch { return null; }
})());
let terminalFontSize = $state(loadTerminalFontSize());
let hasHardwareKeyboard = $state(false);
let fullPageDiff = $state<{
  workspacePath: string;
  file?: string | undefined;
  base?: string | undefined;
} | null>(null);

// ── Right sidebar & file viewer state ──
export type RightSidebarTab = 'changes' | 'all-files' | 'checks';

export interface OpenFileTab {
  filePath: string;
  fileName: string;
  isChanged: boolean; // true = show diff, false = show raw content
}

let fileDiffSource = $state<'working' | 'staged' | 'branch'>('working');
let fileDiffDefaultBranch = $state('main');

let rightSidebarVisible = $state(true);
let rightSidebarCollapsed = $state((() => {
  try { return localStorage.getItem(RIGHT_SIDEBAR_COLLAPSED_KEY) === 'true'; }
  catch { return false; }
})());
let rightSidebarWidth = $state((() => {
  try {
    const stored = localStorage.getItem(RIGHT_SIDEBAR_WIDTH_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (val >= MIN_RIGHT_SIDEBAR_WIDTH && val <= MAX_RIGHT_SIDEBAR_WIDTH) return val;
    }
  } catch { /* localStorage unavailable */ }
  return DEFAULT_RIGHT_SIDEBAR_WIDTH;
})());
let rightSidebarTab = $state<RightSidebarTab>('changes');
let openFileTabs = $state<OpenFileTab[]>([]);
let activeFileTabPath = $state<string | null>(null);
let fileViewerRatio = $state((() => {
  try {
    const stored = localStorage.getItem(FILE_VIEWER_WIDTH_KEY);
    if (stored) {
      const val = parseFloat(stored);
      if (val >= 0.15 && val <= 0.75) return val;
    }
  } catch { /* localStorage unavailable */ }
  return DEFAULT_FILE_VIEWER_RATIO;
})());
let sendToTargetSessionId = $state<string | null>(null);
let lastChangedFiles = $state<string[]>([]);

export function getUi() {
  return {
    get sidebarOpen() { return sidebarOpen; },
    set sidebarOpen(v: boolean) { sidebarOpen = v; },
    get sidebarWidth() { return sidebarWidth; },
    set sidebarWidth(v: number) { sidebarWidth = v; },
    get sidebarCollapsed() { return sidebarCollapsed; },
    set sidebarCollapsed(v: boolean) { sidebarCollapsed = v; },
    get searchQuery() { return searchQuery; },
    set searchQuery(v: string) { searchQuery = v; },
    get activeRepoPath() { return activeRepoPath; },
    set activeRepoPath(v: string | null) {
      activeRepoPath = v;
      try {
        if (v === null) localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
        else localStorage.setItem(ACTIVE_WORKSPACE_KEY, v);
      } catch { /* localStorage unavailable */ }
    },
    get activeWorkspaceId() { return activeWorkspaceId; },
    set activeWorkspaceId(id: string | null) {
      activeWorkspaceId = id;
      try {
        if (id === null) localStorage.removeItem(ACTIVE_WORKSPACE_GROUP_KEY);
        else localStorage.setItem(ACTIVE_WORKSPACE_GROUP_KEY, id);
      } catch { /* localStorage unavailable */ }
    },
    get terminalFontSize() { return terminalFontSize; },
    set terminalFontSize(v: number) { terminalFontSize = v; },
    get hasHardwareKeyboard() { return hasHardwareKeyboard; },
    set hasHardwareKeyboard(v: boolean) { hasHardwareKeyboard = v; },
    get fullPageDiff() { return fullPageDiff; },
    set fullPageDiff(v: typeof fullPageDiff) { fullPageDiff = v; },
    // Right sidebar & file viewer
    get fileDiffSource() { return fileDiffSource; },
    set fileDiffSource(v: 'working' | 'staged' | 'branch') { fileDiffSource = v; },
    get fileDiffDefaultBranch() { return fileDiffDefaultBranch; },
    set fileDiffDefaultBranch(v: string) { fileDiffDefaultBranch = v; },
    get rightSidebarVisible() { return rightSidebarVisible; },
    set rightSidebarVisible(v: boolean) { rightSidebarVisible = v; },
    get rightSidebarCollapsed() { return rightSidebarCollapsed; },
    set rightSidebarCollapsed(v: boolean) { rightSidebarCollapsed = v; },
    get rightSidebarWidth() { return rightSidebarWidth; },
    set rightSidebarWidth(v: number) { rightSidebarWidth = v; },
    get rightSidebarTab() { return rightSidebarTab; },
    set rightSidebarTab(v: RightSidebarTab) { rightSidebarTab = v; },
    get openFileTabs() { return openFileTabs; },
    set openFileTabs(v: OpenFileTab[]) { openFileTabs = v; },
    get activeFileTabPath() { return activeFileTabPath; },
    set activeFileTabPath(v: string | null) { activeFileTabPath = v; },
    get fileViewerRatio() { return fileViewerRatio; },
    set fileViewerRatio(v: number) { fileViewerRatio = v; },
    get sendToTargetSessionId() { return sendToTargetSessionId; },
    set sendToTargetSessionId(v: string | null) { sendToTargetSessionId = v; },
    get lastChangedFiles() { return lastChangedFiles; },
    set lastChangedFiles(v: string[]) { lastChangedFiles = v; },
  };
}

export function openSidebar(): void { sidebarOpen = true; }
export function closeSidebar(): void { sidebarOpen = false; }

// ── Right sidebar helpers ──
export function toggleRightSidebarCollapsed(): void {
  rightSidebarCollapsed = !rightSidebarCollapsed;
  try { localStorage.setItem(RIGHT_SIDEBAR_COLLAPSED_KEY, String(rightSidebarCollapsed)); }
  catch { /* localStorage unavailable */ }
}

export function saveRightSidebarWidth(): void {
  try { localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, String(rightSidebarWidth)); }
  catch { /* localStorage unavailable */ }
}

export function saveFileViewerRatio(): void {
  try { localStorage.setItem(FILE_VIEWER_WIDTH_KEY, String(fileViewerRatio)); }
  catch { /* localStorage unavailable */ }
}

export function openFileTab(filePath: string, isChanged: boolean): void {
  const fileName = filePath.split('/').pop() ?? filePath;
  const existing = openFileTabs.find(t => t.filePath === filePath);
  if (!existing) {
    openFileTabs = [...openFileTabs, { filePath, fileName, isChanged }];
  } else if (existing.isChanged !== isChanged) {
    // Update existing tab's mode if reopened from a different context (all-files vs changes)
    openFileTabs = openFileTabs.map(t => t.filePath === filePath ? { ...t, isChanged } : t);
  }
  activeFileTabPath = filePath;
}

export function closeFileTab(filePath: string): void {
  openFileTabs = openFileTabs.filter(t => t.filePath !== filePath);
  if (activeFileTabPath === filePath) {
    activeFileTabPath = openFileTabs.length > 0 ? openFileTabs[openFileTabs.length - 1]!.filePath : null;
  }
}

export function closeAllFileTabs(): void {
  openFileTabs = [];
  activeFileTabPath = null;
}
export function saveSidebarWidth(): void {
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); }
  catch { /* localStorage unavailable */ }
}
export function toggleSidebarCollapsed(): void {
  sidebarCollapsed = !sidebarCollapsed;
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed)); }
  catch { /* localStorage unavailable */ }
}
export function saveTerminalFontSize(): void {
  try { localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(terminalFontSize)); }
  catch { /* localStorage unavailable */ }
}

// ── Collapsible workspaces ──
const COLLAPSED_WORKSPACES_KEY = 'claude-remote-collapsed-workspaces';

function loadCollapsedWorkspaces(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_WORKSPACES_KEY);
    if (stored) return new Set(JSON.parse(stored) as string[]);
  } catch { /* localStorage unavailable */ }
  return new Set();
}

let collapsedWorkspaces = $state<Set<string>>(loadCollapsedWorkspaces());

function saveCollapsedWorkspaces(): void {
  try {
    localStorage.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify([...collapsedWorkspaces]));
  } catch { /* localStorage unavailable */ }
}

export function toggleWorkspaceCollapse(path: string): void {
  if (collapsedWorkspaces.has(path)) {
    collapsedWorkspaces.delete(path);
  } else {
    collapsedWorkspaces.add(path);
  }
  collapsedWorkspaces = new Set(collapsedWorkspaces); // trigger reactivity
  saveCollapsedWorkspaces();
}

export function isWorkspaceCollapsed(path: string): boolean {
  return collapsedWorkspaces.has(path);
}

// ── Time tick (30s interval for reactive time display) ──
let timeTick = $state(0);
setInterval(() => { timeTick++; }, 30_000);
export function getTimeTick(): number { return timeTick; }
