import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type { HubNodeStatus } from '../../../shared/relay-node-protocol.js';
import type { AgentState, SessionSummary } from './types.js';
import type { WorkspaceTab } from './workspace-layout.js';

export type SummaryIcon =
  | 'session-claude'
  | 'session-codex'
  | 'session-opencode'
  | 'session-hermes'
  | 'session-agent'
  | 'session-terminal'
  | 'file-tsx'
  | 'file-ts'
  | 'file-jsx'
  | 'file-js'
  | 'file-py'
  | 'file-rs'
  | 'file-go'
  | 'file-css'
  | 'file-html'
  | 'file-md'
  | 'file-json'
  | 'file-generic'
  | 'file-diff'
  | 'file-html-preview';

export type SummaryDot = 'live' | 'attention' | 'idle' | 'error' | null;

export interface SummaryPill {
  kind: 'dirty' | 'info' | 'warn' | 'success';
  label: string;
}

export interface NodeBadge {
  label: string;
  status: HubNodeStatus | 'unknown';
}

export interface WorkspaceTabSummary {
  icon: SummaryIcon;
  primary: string;
  meta?: string;
  pills: SummaryPill[];
  dot: SummaryDot;
  /**
   * Populated on session tabs that target a non-local execution node.
   * Drives the cross-node label + heartbeat indicator in the tab chrome.
   */
  nodeBadge?: NodeBadge;
  breadcrumb?: {
    segments: string[];
    repoLabel?: string;
    repoColor?: string;
  };
}

export interface SummaryNodeInfo {
  label: string;
  status: HubNodeStatus;
}

export interface SummaryContext {
  findSession?: (id: string) => SessionSummary | undefined;
  isFileChanged?: (filePath: string) => boolean;
  fileLineCount?: (filePath: string) => number | undefined;
  /**
   * Lookup for cross-node session tabs. Returns the node's display label
   * and current heartbeat status, or undefined when not yet known.
   */
  findNode?: (nodeId: string) => SummaryNodeInfo | undefined;
  repoLabel?: string;
  repoColor?: string;
}

const FILE_ICON_MAP: Record<string, SummaryIcon> = {
  tsx: 'file-tsx',
  ts: 'file-ts',
  jsx: 'file-jsx',
  js: 'file-js',
  py: 'file-py',
  rs: 'file-rs',
  go: 'file-go',
  css: 'file-css',
  scss: 'file-css',
  html: 'file-html',
  md: 'file-md',
  markdown: 'file-md',
  json: 'file-json',
};

export function summaryForTab(
  tab: WorkspaceTab,
  ctx: SummaryContext = {}
): WorkspaceTabSummary {
  if (tab.kind === 'session') return summaryForSessionTab(tab, ctx);
  return summaryForFileTab(tab, ctx);
}

function summaryForSessionTab(
  tab: Extract<WorkspaceTab, { kind: 'session' }>,
  ctx: SummaryContext
): WorkspaceTabSummary {
  const session = ctx.findSession?.(tab.sessionId);
  const isTerminal = tab.sessionType === 'terminal';
  const agent = session?.agent ?? '';
  const icon = sessionIconFor(tab.sessionType, agent);
  const primary =
    session?.displayName ||
    session?.branchName ||
    (isTerminal ? 'terminal' : 'session');
  const dot = sessionDot(session?.agentState, session?.idle);
  const meta = sessionMeta(session);
  const nodeBadge = nodeBadgeFor(tab.nodeId ?? session?.nodeId, ctx);
  return {
    icon,
    primary,
    pills: [],
    dot,
    ...(meta !== undefined ? { meta } : {}),
    ...(nodeBadge ? { nodeBadge } : {}),
  };
}

function nodeBadgeFor(
  nodeId: string | undefined,
  ctx: SummaryContext
): NodeBadge | undefined {
  if (!nodeId || nodeId === DEFAULT_LOCAL_NODE_ID) return undefined;
  const info = ctx.findNode?.(nodeId);
  if (!info) {
    return { label: nodeId, status: 'unknown' };
  }
  return { label: info.label, status: info.status };
}

function sessionIconFor(
  type: 'agent' | 'terminal',
  agent: string
): SummaryIcon {
  if (type === 'terminal') return 'session-terminal';
  const a = agent.toLowerCase();
  if (a.includes('claude')) return 'session-claude';
  if (a.includes('codex')) return 'session-codex';
  if (a.includes('opencode')) return 'session-opencode';
  if (a.includes('hermes')) return 'session-hermes';
  return 'session-agent';
}

function sessionDot(state?: AgentState, idle?: boolean): SummaryDot {
  if (state === 'error') return 'error';
  if (state === 'permission-prompt' || state === 'waiting-for-input') {
    return 'attention';
  }
  if (state === 'processing') return 'live';
  if (idle) return 'idle';
  return null;
}

function sessionMeta(session: SessionSummary | undefined): string | undefined {
  if (!session) return undefined;
  const parts: string[] = [];
  if (session.agent) parts.push(session.agent);
  if (session.cwd) {
    const last = session.cwd.split('/').filter(Boolean).pop();
    if (last) parts.push(last);
  }
  if (session.repoName && !parts.includes(session.repoName)) {
    parts.push(session.repoName);
  }
  if (session.agentState) parts.push(session.agentState);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function summaryForFileTab(
  tab: Extract<WorkspaceTab, { kind: 'file' }>,
  ctx: SummaryContext
): WorkspaceTabSummary {
  const segments = tab.filePath.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] ?? tab.filePath;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const icon = fileIconFor(ext, tab.tabType);
  const isChanged = ctx.isFileChanged?.(tab.filePath) ?? false;
  const lines = ctx.fileLineCount?.(tab.filePath);

  const pills: SummaryPill[] = [];
  if (isChanged) pills.push({ kind: 'dirty', label: 'unsaved' });
  if (tab.tabType === 'diff') pills.push({ kind: 'info', label: 'diff' });
  if (tab.tabType === 'html') pills.push({ kind: 'info', label: 'preview' });
  const langLabel = `${ext || 'file'}${lines !== undefined ? ` · ${lines} lines` : ''}`;
  pills.push({ kind: 'info', label: langLabel });

  return {
    icon,
    primary: fileName,
    pills,
    dot: null,
    breadcrumb: {
      segments,
      ...(ctx.repoLabel !== undefined ? { repoLabel: ctx.repoLabel } : {}),
      ...(ctx.repoColor !== undefined ? { repoColor: ctx.repoColor } : {}),
    },
  };
}

function fileIconFor(
  ext: string,
  tabType: 'code' | 'diff' | 'html'
): SummaryIcon {
  if (tabType === 'diff') return 'file-diff';
  if (tabType === 'html') return 'file-html-preview';
  return FILE_ICON_MAP[ext] ?? 'file-generic';
}
