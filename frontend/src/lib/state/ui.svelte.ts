const SIDEBAR_WIDTH_KEY = 'claude-remote-sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'claude-remote-sidebar-collapsed';
const ACTIVE_WORKSPACE_KEY = 'claude-remote-active-workspace';
const TERMINAL_FONT_SIZE_KEY = 'claude-remote-terminal-font-size';
export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 500;
export const COLLAPSED_SIDEBAR_WIDTH = 44;
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 28;

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
let terminalFontSize = $state(loadTerminalFontSize());
let fullPageDiff = $state<{
  workspacePath: string;
  file?: string | undefined;
  base?: string | undefined;
} | null>(null);

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
    get terminalFontSize() { return terminalFontSize; },
    set terminalFontSize(v: number) { terminalFontSize = v; },
    get fullPageDiff() { return fullPageDiff; },
    set fullPageDiff(v: typeof fullPageDiff) { fullPageDiff = v; },
  };
}

export function openSidebar(): void { sidebarOpen = true; }
export function closeSidebar(): void { sidebarOpen = false; }
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
