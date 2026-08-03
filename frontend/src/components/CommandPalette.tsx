import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Repo,
  SessionSummary,
  PullRequest,
  OrgPrsResponse,
  GitHubIssue,
  GitHubIssuesResponse,
  JiraIssue,
  JiraIssuesResponse,
  WorkContextActiveGroup,
} from '../lib/types.js';
import { derivePrDotStatus } from '../lib/pr-status.js';
import StatusDot from './StatusDot.js';
import { getAction, getAllActions } from '../lib/actions/registry.js';
import { formatShortcut } from '../lib/actions/shortcuts.js';
import type { ActionContext, Action } from '../lib/actions/types.js';
import { isMobileDevice, isMac } from '../lib/utils.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import { buildSessionPaletteResults } from '../lib/command-palette-session-results.js';
import {
  buildTopicPaletteResults,
  recentTopicPaletteResults,
} from '../lib/command-palette-topic-results.js';
import {
  artifactKindIcon,
  fetchArtifactPaletteResults,
  type ArtifactPaletteResult,
} from '../lib/command-palette-artifact-results.js';
import {
  buildMessagePaletteResults,
  MESSAGE_PALETTE_LIMIT,
  type MessagePaletteResult,
} from '../lib/command-palette-message-results.js';
import type { PipelineHandoffArtifactEnvelope } from '../lib/pipeline-handoff-timeline.js';
import {
  CHANNEL_SEARCH_MIN_QUERY_CHARS,
  type ChannelMessageSearchResult,
} from '../../../shared/channel-chat-protocol.js';
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import { openChannelMessageSelection } from '../lib/topic-selection.js';
import {
  executeCommandCenterAssistantCommand,
  fetchWorkspaceTopics,
  resolveCommandCenterAssistantIntent,
  searchChannelMessages,
} from '../lib/api.js';
import {
  commandCenterAssistantCopy,
  commandCenterExecutionCopy,
  commandCenterSuggestionLabels,
  decideOpenUiAction,
  type CommandCenterAssistantResult,
} from '../lib/command-center-assistant.js';
import type {
  CommandCenterExecutionConfirmationInput,
  CommandCenterExecutionResult,
} from '../../../shared/command-center-execution.js';
import './CommandPalette.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  'all',
  'sessions',
  'topics',
  'workspaces',
  'artifacts',
  'prs',
  'settings',
] as const;
type Tab = (typeof TABS)[number];

/** Stable identity so the topic-derived memos/effects do not refire per render. */
const EMPTY_TOPICS: WorkspaceTopic[] = [];

const SEC_GENERAL = 'section-general';
const SEC_INTEGRATIONS = 'section-integrations';
const SEC_NODES = 'section-nodes';
const SEC_ADVANCED = 'section-advanced';
const SEC_ABOUT = 'section-about';

const SETTINGS_ENTRIES = [
  {
    id: 'setting-agent',
    label: 'Default Coding Agent',
    description: 'Which AI agent to use',
    section: SEC_GENERAL,
  },
  {
    id: 'setting-notifications',
    label: 'Notifications',
    description: 'Push notifications for sessions',
    section: SEC_GENERAL,
  },
  {
    id: 'setting-github',
    label: 'GitHub Connection',
    description: 'Connect GitHub account for PRs and CI',
    section: SEC_INTEGRATIONS,
  },
  {
    id: 'setting-webhooks',
    label: 'Webhooks',
    description: 'Real-time CI and PR updates',
    section: SEC_INTEGRATIONS,
  },
  {
    id: 'setting-jira',
    label: 'Jira',
    description: 'See Jira tickets in the sidebar',
    section: SEC_INTEGRATIONS,
  },
  {
    id: 'setting-nodes',
    label: 'Nodes',
    description: 'Pair, rename, or revoke Relay nodes',
    section: SEC_NODES,
  },
  {
    id: 'setting-devtools',
    label: 'Developer Tools',
    description: 'Mobile debug panel',
    section: SEC_ADVANCED,
  },
  {
    id: 'setting-analytics',
    label: 'Analytics',
    description: 'Local usage data',
    section: SEC_ADVANCED,
  },
  {
    id: 'setting-version',
    label: 'Version',
    description: 'Check for updates',
    section: SEC_ABOUT,
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type SettingEntry = (typeof SETTINGS_ENTRIES)[number];

type PaletteResult =
  | {
      type: 'workspace';
      id: string;
      label: string;
      sublabel?: string;
      data: Repo;
    }
  | {
      type: 'session';
      id: string;
      label: string;
      sublabel?: string;
      data: SessionSummary;
    }
  | {
      type: 'topic';
      id: string;
      label: string;
      sublabel?: string;
      data: WorkspaceTopic;
    }
  | {
      type: 'artifact';
      id: string;
      label: string;
      sublabel?: string;
      data: PipelineHandoffArtifactEnvelope;
    }
  | {
      type: 'message';
      id: string;
      label: string;
      sublabel?: string;
      data: ChannelMessageSearchResult;
    }
  | {
      type: 'pr' | 'attention';
      id: string;
      label: string;
      sublabel?: string;
      data: PullRequest;
    }
  | {
      type: 'ticket';
      id: string;
      label: string;
      sublabel?: string;
      data: GitHubIssue | JiraIssue;
    }
  | {
      type: 'command';
      id: string;
      label: string;
      sublabel?: string;
      data: Action;
      /** Non-empty when the action is visible but cannot be invoked in the current context. */
      disabledReason?: string;
    }
  | {
      type: 'setting';
      id: string;
      label: string;
      sublabel?: string;
      data: SettingEntry;
    };

interface ResultGroup {
  label: string;
  items: PaletteResult[];
}

export interface CommandPaletteProps {
  open: boolean;
  workspaces: Repo[];
  sessions: SessionSummary[];
  actionContext: ActionContext;
  onClose: () => void;
  onSelectWorkspace: (path: string) => void;
  onSelectSession: (id: string) => void;
  onSelectTopic?: (topic: WorkspaceTopic) => void;
  onSelectPr: (pr: PullRequest) => void;
  onOpenSettings?: (sectionId: string) => void;
  resolveAssistantIntent?: (
    query: string
  ) => Promise<CommandCenterAssistantResult>;
  executeAssistantCommand?: (
    commandId: string,
    args: Record<string, unknown>,
    options?: {
      confirmation?: CommandCenterExecutionConfirmationInput;
    }
  ) => Promise<CommandCenterExecutionResult>;
}

type AssistantExecutionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: CommandCenterExecutionResult }
  | { status: 'error'; message: string };

type AssistantState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'result'; query: string; result: CommandCenterAssistantResult }
  | { status: 'error'; query: string; message: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function categoryIcon(type: PaletteResult['type']): string {
  switch (type) {
    case 'workspace':
      return '■';
    case 'session':
      return '▸';
    case 'topic':
      return '◇';
    case 'message':
      return '"';
    case 'artifact':
      return '▤';
    case 'pr':
    case 'attention':
      return '●';
    case 'ticket':
      return '#';
    case 'command':
      return '>';
    case 'setting':
      return '*';
    default:
      return '';
  }
}

/**
 * `message` (#1308 slice 2 item 3) deliberately claims no tab of its own, the
 * same disposition `ticket` has: it shows in `all` and nowhere else. A `topics`
 * tab that also listed message rows would stop being a filter for topics, and a
 * ninth tab would cost every operator a longer Tab cycle to buy a filter for a
 * category that is already capped at five rows.
 */
function matchesTab(type: PaletteResult['type'], activeTab: Tab): boolean {
  if (activeTab === 'all') return true;
  if (activeTab === 'sessions') return type === 'session' || type === 'command';
  if (activeTab === 'topics') return type === 'topic';
  if (activeTab === 'workspaces') return type === 'workspace';
  if (activeTab === 'artifacts') return type === 'artifact';
  if (activeTab === 'prs') return type === 'pr' || type === 'attention';
  if (activeTab === 'settings') return type === 'setting' || type === 'command';
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves the workspace path to open for an artifact result (#1065). There
 * is no direct deep-link into the evidence tab yet (see PR notes) — this is
 * the cheapest existing open path: the WorkContext's worktree/repo path, so
 * `onSelectWorkspace` can navigate there and the user opens the evidence tab
 * manually.
 */
function repoPathForWorkContext(
  activeWork: WorkContextActiveGroup[],
  workContextId: string
): string | undefined {
  const group = activeWork.find((g) => g.context?.id === workContextId);
  return (
    group?.context?.anchors.worktree?.localPath ??
    group?.context?.anchors.repo?.localPath
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useCachedData(open: boolean) {
  const queryClient = useQueryClient();
  // Snapshot cache on each render (deps include `open` to re-read when palette opens)
  const cachedPrs = useMemo<PullRequest[]>(
    () => queryClient.getQueryData<OrgPrsResponse>(['org-prs'])?.prs ?? [],
    [queryClient, open]
  );
  const cachedGithubIssues = useMemo<GitHubIssue[]>(
    () =>
      queryClient.getQueryData<GitHubIssuesResponse>(['github-issues'])
        ?.issues ?? [],
    [queryClient, open]
  );
  const cachedJiraIssues = useMemo<JiraIssue[]>(
    () =>
      queryClient.getQueryData<JiraIssuesResponse>(['jira-issues'])?.issues ??
      [],
    [queryClient, open]
  );
  // #1287: the sidebar shell is the only other producer of this cache entry and
  // it never mounts while the sidebar is collapsed, so a collapsed-sidebar user
  // would otherwise have no topics in the palette at all. Observe the canonical
  // key itself (shared with the sidebar) rather than snapshotting it: staying an
  // active observer while open is what lets topic create/restore invalidations,
  // which default to `refetchType: 'active'`, refresh a palette-only corpus.
  const topicsQuery = useQuery({
    queryKey: ['workspace-topics'],
    queryFn: () => fetchWorkspaceTopics(),
    enabled: open,
    staleTime: 30_000,
  });
  const cachedTopics = topicsQuery.data?.topics ?? EMPTY_TOPICS;
  const cachedActiveWork = useMemo<WorkContextActiveGroup[]>(
    () =>
      queryClient.getQueryData<WorkContextActiveGroup[]>(['active-work']) ?? [],
    [queryClient, open]
  );
  return {
    cachedPrs,
    cachedGithubIssues,
    cachedJiraIssues,
    cachedTopics,
    cachedActiveWork,
  };
}

/**
 * Converts an Action into a PaletteResult command entry.
 * Actions with `disabledReason` that return a non-empty string are included
 * as disabled items so the user knows why the command is unavailable.
 */
function actionToPaletteCommand(
  a: Action,
  ctx: ActionContext
): Extract<PaletteResult, { type: 'command' }> {
  const reason = a.disabledReason?.(ctx);
  return {
    type: 'command',
    id: `cmd-${a.id}`,
    label: a.label,
    sublabel: reason ?? a.description ?? '',
    data: a,
    ...(reason ? { disabledReason: reason } : {}),
  };
}

function buildResults(
  q: string,
  workspaces: Repo[],
  sessions: SessionSummary[],
  cachedPrs: PullRequest[],
  cachedGithubIssues: GitHubIssue[],
  cachedJiraIssues: JiraIssue[],
  cachedTopics: WorkspaceTopic[],
  registryCommands: Action[],
  /** Actions that have a disabledReason but failed `when` — shown greyed-out. */
  degradedCommands: { action: Action; reason: string }[],
  needsAttention: PullRequest[],
  activeTab: Tab,
  actionContext: ActionContext,
  /** Hub-wide artifact search results (#1065) — already fetched+filtered server-side for `q`. */
  artifactResults: ArtifactPaletteResult[],
  /** Hub-wide message search hits (#1308 slice 2) — ranked and capped server-side for `q`. */
  messageResults: MessagePaletteResult[]
): PaletteResult[] {
  const items: PaletteResult[] = [];
  if (!q) {
    for (const pr of needsAttention)
      items.push({
        type: 'attention',
        id: `attn-${pr.number}`,
        label: `#${pr.number} ${pr.title}`,
        sublabel: pr.repoName ?? '',
        data: pr,
      });
    for (const ws of workspaces.slice(0, 5))
      items.push({
        type: 'workspace',
        id: `ws-${ws.path}`,
        label: ws.name,
        sublabel: ws.path,
        data: ws,
      });
    for (const topic of recentTopicPaletteResults(cachedTopics, 5))
      items.push(topic);
    for (const a of registryCommands)
      items.push(actionToPaletteCommand(a, actionContext));
    for (const { action, reason } of degradedCommands.filter(
      (entry) => entry.action.category !== 'gateway'
    ))
      items.push({
        type: 'command',
        id: `cmd-${action.id}`,
        label: action.label,
        sublabel: reason,
        data: action,
        disabledReason: reason,
      });
    return items.filter((r) => matchesTab(r.type, activeTab));
  }
  for (const ws of workspaces
    .filter((w) => w.name.toLowerCase().includes(q))
    .slice(0, 5))
    items.push({
      type: 'workspace',
      id: `ws-${ws.path}`,
      label: ws.name,
      sublabel: ws.path,
      data: ws,
    });
  for (const result of buildSessionPaletteResults(
    q,
    sessions,
    5,
    cachedTopics
  )) {
    items.push(result);
  }
  for (const topic of buildTopicPaletteResults(q, cachedTopics, 5)) {
    items.push(topic);
  }
  // Directly after `topics`, the other half of the same question: `topics`
  // answers "which chat was that?", `messages` answers "where was that said?".
  // They are never merged into one ranked list — a bm25 body score and a
  // substring title match share no unit (the sidebar's two sections, #1308
  // slice 2 item 2, split for the same reason).
  for (const result of messageResults) {
    items.push(result);
  }
  for (const result of artifactResults) {
    items.push(result);
  }
  for (const pr of cachedPrs
    .filter(
      (pr) =>
        pr.title.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        pr.headRefName.toLowerCase().includes(q)
    )
    .slice(0, 5)) {
    items.push({
      type: 'pr',
      id: `pr-${pr.number}`,
      label: `#${pr.number} ${pr.title}`,
      sublabel: pr.repoName ?? pr.headRefName,
      data: pr,
    });
  }
  for (const issue of cachedGithubIssues
    .filter(
      (i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q)
    )
    .slice(0, 3)) {
    items.push({
      type: 'ticket',
      id: `gh-${issue.number}`,
      label: `#${issue.number} ${issue.title}`,
      sublabel: issue.repoName,
      data: issue,
    });
  }
  for (const issue of cachedJiraIssues
    .filter(
      (i) =>
        i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q)
    )
    .slice(0, 3)) {
    items.push({
      type: 'ticket',
      id: `jira-${issue.key}`,
      label: `${issue.key} ${issue.title}`,
      sublabel: issue.status,
      data: issue,
    });
  }
  for (const a of registryCommands.filter(
    (a) =>
      a.label.toLowerCase().includes(q) ||
      a.description?.toLowerCase().includes(q) ||
      a.aliases?.some((alias) => alias.toLowerCase().includes(q))
  )) {
    items.push(actionToPaletteCommand(a, actionContext));
  }
  for (const { action, reason } of degradedCommands.filter(
    (entry) =>
      entry.action.label.toLowerCase().includes(q) ||
      entry.action.description?.toLowerCase().includes(q) ||
      entry.action.aliases?.some((alias) => alias.toLowerCase().includes(q)) ||
      entry.reason.toLowerCase().includes(q)
  )) {
    items.push({
      type: 'command',
      id: `cmd-${action.id}`,
      label: action.label,
      sublabel: reason,
      data: action,
      disabledReason: reason,
    });
  }
  for (const s of SETTINGS_ENTRIES.filter(
    (s) =>
      s.label.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
  ))
    items.push({
      type: 'setting',
      id: s.id,
      label: s.label,
      sublabel: s.description,
      data: s,
    });
  return items.filter((r) => matchesTab(r.type, activeTab));
}

function useGroupedResults(
  results: PaletteResult[],
  query: string
): ResultGroup[] {
  return useMemo(() => {
    const q = query.toLowerCase().trim();
    const typeOrder: Array<{ type: PaletteResult['type']; label: string }> = q
      ? [
          { type: 'workspace', label: 'workspaces' },
          { type: 'session', label: 'sessions' },
          { type: 'topic', label: 'topics' },
          { type: 'message', label: 'messages' },
          { type: 'artifact', label: 'artifacts' },
          { type: 'pr', label: 'pull requests' },
          { type: 'ticket', label: 'tickets' },
          { type: 'command', label: 'commands' },
          { type: 'setting', label: 'settings' },
        ]
      : [
          { type: 'attention', label: 'needs attention' },
          { type: 'workspace', label: 'workspaces' },
          { type: 'topic', label: 'topics' },
          { type: 'command', label: 'commands' },
        ];
    return typeOrder.flatMap(({ type, label }) => {
      const items = results.filter((r) => r.type === type);
      return items.length > 0 ? [{ label, items }] : [];
    });
  }, [results, query]);
}

/**
 * Hub-wide artifact search (#1065): fetches once `debouncedQuery` settles
 * (the palette already debounces the raw query 150ms before this hook sees
 * it, so no further debouncing is needed here). A monotonically increasing
 * request id guards against a slow earlier request clobbering a faster
 * later one.
 */
function useArtifactPaletteResults(
  debouncedQuery: string,
  cachedTopics: WorkspaceTopic[],
  open: boolean
): ArtifactPaletteResult[] {
  const [results, setResults] = useState<ArtifactPaletteResult[]>([]);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!open || !q) {
      setResults([]);
      return;
    }
    const requestId = ++requestIdRef.current;
    let cancelled = false;
    void fetchArtifactPaletteResults(q, cachedTopics, 5)
      .then((next) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setResults(next);
      })
      .catch(() => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, cachedTopics, open]);

  return results;
}

/**
 * Hub-wide message search for the palette (#1308 slice 2 item 3).
 *
 * The palette runs its OWN query rather than reading the sidebar's message-search
 * cache — the #1287/#1289 lesson that `useCachedData` already learned for
 * topics: `TopicSidebarShell` is the only other producer of that cache entry and
 * it never mounts while the sidebar is collapsed, so a cache-only palette would
 * show an empty `messages` category forever for exactly the operators who reach
 * for a palette instead of a rail.
 *
 * The key is namespaced `palette` instead of reusing the sidebar's
 * `['channel-message-search', q, scope, archive]`. That key does not mention its
 * own page size, so sharing it would let whichever surface asked first fix the
 * other's row count — the palette's 5-row answer would become the sidebar's
 * 20-row section, silently claiming it was not truncated.
 *
 * `enabled` carries `open` because the palette unmounts nothing when it closes
 * (`usePaletteState` only resets `query` on the way back IN), so without it a
 * closed palette would keep refetching the last query the operator typed. It
 * also carries CHANNEL_SEARCH_MIN_QUERY_CHARS: the palette is a keystroke
 * surface over the same FTS5 index as the sidebar, and a one-character prefix
 * query ranks essentially the whole corpus inside a synchronous sqlite call on
 * the hub's event loop. The server refuses that shape too; this keeps the
 * palette from asking. Other categories keep answering from the first
 * character — they are in-memory filters, not index reads.
 */
function useMessagePaletteResults(
  debouncedQuery: string,
  open: boolean
): MessagePaletteResult[] {
  const trimmed = debouncedQuery.trim();
  const enabled = open && trimmed.length >= CHANNEL_SEARCH_MIN_QUERY_CHARS;
  const { data } = useQuery({
    queryKey: ['channel-message-search', 'palette', trimmed],
    queryFn: () =>
      searchChannelMessages({ q: trimmed, limit: MESSAGE_PALETTE_LIMIT }),
    enabled,
    staleTime: 10_000,
  });
  return useMemo(
    // Gate on `enabled`, not just on `data`: a disabled query keeps serving its
    // last result, which would flash the previous query's hits over an empty
    // input on the next open.
    () => (enabled ? buildMessagePaletteResults(data?.results ?? []) : []),
    [enabled, data]
  );
}

// ── usePaletteState hook ───────────────────────────────────────────────────────

function usePaletteState(
  open: boolean,
  inputRef: React.RefObject<HTMLInputElement | null>
) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartYRef = useRef(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebouncedQuery('');
      setFocusedIndex(0);
      setActiveTab('all');
      setDragOffset(0);
      setDragging(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, inputRef]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  return {
    query,
    setQuery,
    debouncedQuery,
    focusedIndex,
    setFocusedIndex,
    activeTab,
    setActiveTab,
    dragOffset,
    setDragOffset,
    dragging,
    setDragging,
    dragStartYRef,
  };
}

// ── usePaletteHandlers hook ────────────────────────────────────────────────────

function usePaletteHandlers(
  flatItems: PaletteResult[],
  focusedIndex: number,
  activeTab: Tab,
  setFocusedIndex: (v: number | ((p: number) => number)) => void,
  setActiveTab: (t: Tab) => void,
  dragging: boolean,
  dragOffset: number,
  setDragging: (v: boolean) => void,
  setDragOffset: (v: number) => void,
  dragStartYRef: React.RefObject<number>,
  resultsRef: React.RefObject<HTMLDivElement | null>,
  actionContext: ActionContext,
  onClose: () => void,
  onSelectWorkspace: (path: string) => void,
  onSelectSession: (id: string) => void,
  onSelectTopic: ((topic: WorkspaceTopic) => void) | undefined,
  onSelectPr: (pr: PullRequest) => void,
  cachedActiveWork: WorkContextActiveGroup[],
  /** Corpus a message hit's channel is resolved against for workspace/repo context. */
  cachedTopics: WorkspaceTopic[],
  onOpenSettings?: (sectionId: string) => void
) {
  const scrollFocusedIntoView = useCallback(() => {
    requestAnimationFrame(() => {
      document
        .querySelector('.palette-item.focused')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  const selectItem = useCallback(
    async (item: PaletteResult) => {
      if (item.type === 'command') {
        // Degraded commands are visible but not invocable — do nothing on select.
        if ('disabledReason' in item && item.disabledReason) return;
        try {
          await (item.data as Action).handler(actionContext);
        } finally {
          onClose();
        }
        return;
      }
      onClose();
      if (item.type === 'workspace')
        onSelectWorkspace((item.data as Repo).path);
      else if (item.type === 'session')
        onSelectSession(scopedSessionKey(item.data as SessionSummary));
      else if (item.type === 'topic')
        onSelectTopic?.(item.data as WorkspaceTopic);
      else if (item.type === 'message') {
        // #1308 slice 2 item 3: identical disposition to the sidebar's message
        // hit — open the channel, then hand `ChannelView` the anchor it already
        // knows how to resolve (slice 1's bounded history walk, jump highlight,
        // and reply → thread-panel mapping). Shared gate, not an `onSelect*`
        // prop, because both entry points must open a hit the same way and a
        // per-caller prop is exactly how that drifts.
        const hit = item.data as ChannelMessageSearchResult;
        openChannelMessageSelection({
          channelId: hit.channelId,
          messageId: hit.messageId,
          // The hit's channel is often absent from the palette's topic corpus
          // (a message can match in a chat whose title does not); the gate opens
          // it by id anyway and uses a resolved topic for context only.
          topic: cachedTopics.find((topic) => topic.id === hit.channelId),
        });
      } else if (item.type === 'artifact') {
        // #1065: no direct deep-link into the evidence artifacts tab exists
        // yet (see PR notes) — copy the artifact reference and navigate to
        // the owning workspace as the cheapest existing open path so the
        // user can open the evidence tab manually.
        const envelope = item.data as PipelineHandoffArtifactEnvelope;
        const uri = `relay://work-context-artifacts/${encodeURIComponent(envelope.metadata.id)}`;
        if (globalThis.navigator?.clipboard?.writeText) {
          void globalThis.navigator.clipboard.writeText(uri);
        }
        const repoPath = repoPathForWorkContext(
          cachedActiveWork,
          envelope.metadata.workContextId
        );
        if (repoPath) onSelectWorkspace(repoPath);
      } else if (item.type === 'attention' || item.type === 'pr')
        onSelectPr(item.data as PullRequest);
      else if (item.type === 'setting')
        onOpenSettings?.((item.data as SettingEntry).section);
    },
    [
      actionContext,
      onClose,
      onSelectWorkspace,
      onSelectSession,
      onSelectTopic,
      onSelectPr,
      cachedActiveWork,
      cachedTopics,
      onOpenSettings,
    ]
  );

  const handleKeydown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (flatItems.length === 0) return;
        setFocusedIndex((p) => Math.min(p + 1, flatItems.length - 1));
        scrollFocusedIntoView();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (flatItems.length === 0) return;
        setFocusedIndex((p) => Math.max(p - 1, 0));
        scrollFocusedIntoView();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = flatItems[focusedIndex];
        if (item) void selectItem(item);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const idx = TABS.indexOf(activeTab);
        setActiveTab(
          e.shiftKey
            ? TABS[(idx - 1 + TABS.length) % TABS.length]!
            : TABS[(idx + 1) % TABS.length]!
        );
        setFocusedIndex(0);
      }
    },
    [
      onClose,
      flatItems,
      focusedIndex,
      scrollFocusedIntoView,
      selectItem,
      activeTab,
      setActiveTab,
      setFocusedIndex,
    ]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('palette-overlay'))
        onClose();
    },
    [onClose]
  );

  const handleDragStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobileDevice) return;
      const target = e.target as HTMLElement;
      const isHandle =
        target.classList.contains('drag-handle') ||
        target.classList.contains('drag-bar');
      if (!isHandle && resultsRef.current && resultsRef.current.scrollTop > 0)
        return;
      dragStartYRef.current = e.touches[0]!.clientY;
      setDragging(true);
    },
    [dragStartYRef, resultsRef, setDragging]
  );

  const handleDragMove = useCallback(
    (e: React.TouchEvent) => {
      if (!dragging) return;
      const delta = e.touches[0]!.clientY - dragStartYRef.current;
      if (delta > 0) setDragOffset(delta);
    },
    [dragging, dragStartYRef, setDragOffset]
  );

  const handleDragEnd = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    if (dragOffset > 100) onClose();
    setDragOffset(0);
  }, [dragging, dragOffset, onClose, setDragging, setDragOffset]);

  return {
    handleKeydown,
    handleBackdropClick,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    selectItem,
  };
}

interface CommandCenterAssistantPanelProps {
  state: AssistantState;
  copy: ReturnType<typeof commandCenterAssistantCopy> | undefined;
  isOpenUi: boolean;
  isExecuteCommand: boolean;
  openUiDecision: ReturnType<typeof decideOpenUiAction> | undefined;
  execution: AssistantExecutionState;
  suggestions: string[];
  onOpenUi: () => void;
  onExecuteCommand: () => void;
}

function CommandCenterAssistantPanel({
  state,
  copy,
  isOpenUi,
  isExecuteCommand,
  openUiDecision,
  execution,
  suggestions,
  onOpenUi,
  onExecuteCommand,
}: CommandCenterAssistantPanelProps) {
  if (state.status === 'idle') return null;
  return (
    <div className="palette-assistant-panel" role="status">
      <div className="assistant-kicker">assistant shell</div>
      {state.status === 'loading' && (
        <div className="assistant-copy">
          resolving &quot;{state.query}&quot;...
        </div>
      )}
      {state.status === 'error' && (
        <div className="assistant-copy assistant-copy-error">
          resolver request failed: {state.message}
        </div>
      )}
      {copy && (
        <>
          <div
            className={['assistant-title', `assistant-title-${copy.tone}`].join(
              ' '
            )}
          >
            {copy.title}
          </div>
          <div className="assistant-copy">{copy.detail}</div>
          {isOpenUi && (
            <div className="assistant-actions">
              {openUiDecision?.canOpen ? (
                <button
                  type="button"
                  className="palette-assistant-action"
                  onClick={onOpenUi}
                >
                  {copy.cta ?? 'open ui'}
                </button>
              ) : (
                <span className="assistant-blocked">
                  {openUiDecision?.reason ?? 'ui target unavailable'}
                </span>
              )}
            </div>
          )}
          {isExecuteCommand && (
            <div className="assistant-actions">
              <button
                type="button"
                className="palette-assistant-action"
                disabled={execution.status === 'loading'}
                onClick={onExecuteCommand}
              >
                {execution.status === 'loading'
                  ? 'running read-only command...'
                  : (copy.cta ?? 'run command')}
              </button>
            </div>
          )}
          {execution.status === 'error' && (
            <div className="assistant-copy assistant-copy-error">
              command request failed: {execution.message}
            </div>
          )}
          {execution.status === 'done' && (
            <CommandCenterExecutionSummary result={execution.result} />
          )}
          {suggestions.length > 0 && (
            <div className="assistant-suggestions">
              suggestions: {suggestions.join(' · ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CommandCenterExecutionSummary({
  result,
}: {
  result: CommandCenterExecutionResult;
}) {
  const copy = commandCenterExecutionCopy(result);
  return (
    <>
      <div
        className={['assistant-title', `assistant-title-${copy.tone}`].join(
          ' '
        )}
      >
        {copy.title}
      </div>
      <div className="assistant-copy">{copy.detail}</div>
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function CommandPalette({
  open,
  workspaces,
  sessions,
  actionContext,
  onClose,
  onSelectWorkspace,
  onSelectSession,
  onSelectTopic,
  onSelectPr,
  onOpenSettings,
  resolveAssistantIntent = resolveCommandCenterAssistantIntent,
  executeAssistantCommand = executeCommandCenterAssistantCommand,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [assistantState, setAssistantState] = useState<AssistantState>({
    status: 'idle',
  });
  const [assistantExecution, setAssistantExecution] =
    useState<AssistantExecutionState>({ status: 'idle' });
  const assistantOpenRef = useRef(open);
  const assistantRequestIdRef = useRef(0);
  const assistantExecutionRequestIdRef = useRef(0);

  const {
    query,
    setQuery,
    debouncedQuery,
    focusedIndex,
    setFocusedIndex,
    activeTab,
    setActiveTab,
    dragOffset,
    setDragOffset,
    dragging,
    setDragging,
    dragStartYRef,
  } = usePaletteState(open, inputRef);
  const {
    cachedPrs,
    cachedGithubIssues,
    cachedJiraIssues,
    cachedTopics,
    cachedActiveWork,
  } = useCachedData(open);
  // Commands that pass `when` — active and invocable.
  const registryCommands = useMemo(
    () => getAllActions().filter((a) => !a.when || a.when(actionContext)),
    [actionContext]
  );
  // Commands that fail `when` but have a `disabledReason` — shown greyed-out
  // in the palette so users know the feature exists and why it's unavailable.
  const degradedCommands = useMemo(
    () =>
      getAllActions()
        .filter((a) => a.when && !a.when(actionContext) && !!a.disabledReason)
        .map((a) => ({
          action: a,
          reason: a.disabledReason!(actionContext) ?? 'unavailable',
        }))
        .filter(({ reason }) => reason.length > 0),
    [actionContext]
  );
  const needsAttention = useMemo(
    () =>
      cachedPrs
        .filter(
          (pr) =>
            pr.state === 'OPEN' &&
            (pr.reviewDecision === 'CHANGES_REQUESTED' ||
              pr.role === 'reviewer')
        )
        .slice(0, 5),
    [cachedPrs]
  );
  const artifactResults = useArtifactPaletteResults(
    debouncedQuery,
    cachedTopics,
    open
  );
  const messageResults = useMessagePaletteResults(debouncedQuery, open);

  const results = useMemo(
    () =>
      buildResults(
        debouncedQuery.toLowerCase().trim(),
        workspaces,
        sessions,
        cachedPrs,
        cachedGithubIssues,
        cachedJiraIssues,
        cachedTopics,
        registryCommands,
        degradedCommands,
        needsAttention,
        activeTab,
        actionContext,
        artifactResults,
        messageResults
      ),
    [
      debouncedQuery,
      workspaces,
      sessions,
      cachedPrs,
      cachedGithubIssues,
      cachedJiraIssues,
      cachedTopics,
      registryCommands,
      degradedCommands,
      needsAttention,
      activeTab,
      actionContext,
      artifactResults,
      messageResults,
    ]
  );
  const groupedResults = useGroupedResults(results, debouncedQuery);
  const flatItems = useMemo(
    () => groupedResults.flatMap((g) => g.items),
    [groupedResults]
  );

  useEffect(() => {
    if (focusedIndex >= flatItems.length)
      setFocusedIndex(Math.max(0, flatItems.length - 1));
  }, [flatItems.length, focusedIndex, setFocusedIndex]);

  const {
    handleKeydown,
    handleBackdropClick,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    selectItem,
  } = usePaletteHandlers(
    flatItems,
    focusedIndex,
    activeTab,
    setFocusedIndex,
    setActiveTab,
    dragging,
    dragOffset,
    setDragging,
    setDragOffset,
    dragStartYRef,
    resultsRef,
    actionContext,
    onClose,
    onSelectWorkspace,
    onSelectSession,
    onSelectTopic,
    onSelectPr,
    cachedActiveWork,
    cachedTopics,
    onOpenSettings
  );

  const runAssistant = useCallback(async () => {
    const assistantQuery = query.trim();
    if (!assistantQuery || assistantState.status === 'loading') return;
    const requestId = assistantRequestIdRef.current + 1;
    assistantRequestIdRef.current = requestId;
    setAssistantExecution({ status: 'idle' });
    setAssistantState({ status: 'loading', query: assistantQuery });
    try {
      const result = await resolveAssistantIntent(assistantQuery);
      if (
        !assistantOpenRef.current ||
        assistantRequestIdRef.current !== requestId
      )
        return;
      setAssistantState({ status: 'result', query: assistantQuery, result });
    } catch (error) {
      if (
        !assistantOpenRef.current ||
        assistantRequestIdRef.current !== requestId
      )
        return;
      setAssistantState({
        status: 'error',
        query: assistantQuery,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [assistantState.status, query, resolveAssistantIntent]);

  const openAssistantUi = useCallback(async () => {
    if (assistantState.status !== 'result') return;
    const resolution = assistantState.result.resolution;
    if (resolution.kind !== 'open_ui') return;
    const action = getAction(resolution.ui.actionId as Action['id']);
    const decision = decideOpenUiAction(action, actionContext);
    if (!decision.canOpen || !action) return;
    await action.handler(actionContext);
    onClose();
  }, [actionContext, assistantState, onClose]);

  const runAssistantCommand = useCallback(async () => {
    if (assistantState.status !== 'result') return;
    const resolution = assistantState.result.resolution;
    if (resolution.kind !== 'execute_command') return;
    const requestId = assistantRequestIdRef.current;
    const executionRequestId = assistantExecutionRequestIdRef.current + 1;
    assistantExecutionRequestIdRef.current = executionRequestId;
    setAssistantExecution({ status: 'loading' });
    try {
      const result = await executeAssistantCommand(
        resolution.intent.commandId,
        isPlainRecord(resolution.intent.args) ? resolution.intent.args : {}
      );
      if (
        !assistantOpenRef.current ||
        assistantRequestIdRef.current !== requestId ||
        assistantExecutionRequestIdRef.current !== executionRequestId
      )
        return;
      setAssistantExecution({ status: 'done', result });
    } catch (error) {
      if (
        !assistantOpenRef.current ||
        assistantRequestIdRef.current !== requestId ||
        assistantExecutionRequestIdRef.current !== executionRequestId
      )
        return;
      setAssistantExecution({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [assistantState, executeAssistantCommand]);

  useEffect(() => {
    assistantOpenRef.current = open;
    if (!open) {
      assistantRequestIdRef.current += 1;
      assistantExecutionRequestIdRef.current += 1;
      setAssistantState({ status: 'idle' });
      setAssistantExecution({ status: 'idle' });
    }
    return () => {
      assistantOpenRef.current = false;
      assistantRequestIdRef.current += 1;
      assistantExecutionRequestIdRef.current += 1;
    };
  }, [open]);

  if (!open) return null;
  const paletteStyle =
    isMobileDevice && dragOffset > 0
      ? { transform: `translateY(${dragOffset}px)` }
      : undefined;
  const assistantResolution =
    assistantState.status === 'result'
      ? assistantState.result.resolution
      : undefined;
  const assistantCopy = assistantResolution
    ? commandCenterAssistantCopy(assistantResolution, {
        mobile: isMobileDevice,
      })
    : undefined;
  const openUiAction =
    assistantResolution?.kind === 'open_ui'
      ? getAction(assistantResolution.ui.actionId as Action['id'])
      : undefined;
  const openUiDecision =
    assistantResolution?.kind === 'open_ui'
      ? decideOpenUiAction(openUiAction, actionContext)
      : undefined;
  const assistantSuggestions = assistantResolution
    ? commandCenterSuggestionLabels(assistantResolution)
    : [];

  return (
    <div
      className={['palette-overlay', isMobileDevice ? 'mobile' : '']
        .filter(Boolean)
        .join(' ')}
      onClick={handleBackdropClick}
    >
      <div
        className={['palette', isMobileDevice ? 'mobile' : '']
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label="Command palette"
        style={paletteStyle}
        onTouchStart={isMobileDevice ? handleDragStart : undefined}
        onTouchMove={isMobileDevice ? handleDragMove : undefined}
        onTouchEnd={isMobileDevice ? handleDragEnd : undefined}
        onTouchCancel={isMobileDevice ? handleDragEnd : undefined}
      >
        {isMobileDevice && (
          <div className="drag-handle">
            <span className="drag-bar" />
          </div>
        )}
        <div className="palette-input-row">
          <span className="palette-prompt">&gt;</span>
          <input
            ref={inputRef}
            className="palette-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                query.trim() &&
                (e.metaKey || e.ctrlKey || e.shiftKey || flatItems.length === 0)
              ) {
                e.preventDefault();
                void runAssistant();
                return;
              }
              handleKeydown(e);
            }}
            placeholder="search or ask natural language..."
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={flatItems.length > 0}
            aria-controls="palette-results"
            aria-activedescendant={
              flatItems[focusedIndex]
                ? `palette-item-${flatItems[focusedIndex]!.id}`
                : undefined
            }
          />
          <button
            type="button"
            className="palette-assistant-button"
            disabled={!query.trim() || assistantState.status === 'loading'}
            onClick={() => void runAssistant()}
          >
            {assistantState.status === 'loading' ? 'asking' : 'ask'}
          </button>
        </div>
        <CommandCenterAssistantPanel
          state={assistantState}
          copy={assistantCopy}
          isOpenUi={assistantResolution?.kind === 'open_ui'}
          isExecuteCommand={assistantResolution?.kind === 'execute_command'}
          openUiDecision={openUiDecision}
          execution={assistantExecution}
          suggestions={assistantSuggestions}
          onOpenUi={() => void openAssistantUi()}
          onExecuteCommand={() => void runAssistantCommand()}
        />
        <div className="palette-tabs" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={['palette-tab', activeTab === tab ? 'active' : '']
                .filter(Boolean)
                .join(' ')}
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => {
                setActiveTab(tab);
                setFocusedIndex(0);
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        {(() => {
          const flatIndexMap = new Map(
            flatItems.map((item, i) => [item.id, i])
          );
          if (flatItems.length === 0 && debouncedQuery.trim()) {
            return (
              <div className="palette-results" ref={resultsRef} role="listbox">
                <div className="palette-empty">
                  no results for &quot;{debouncedQuery}&quot;
                </div>
              </div>
            );
          }
          return (
            <div
              className="palette-results"
              id="palette-results"
              role="listbox"
              ref={resultsRef}
            >
              {groupedResults.map((group) => (
                <div key={group.label} role="presentation">
                  <div className="palette-category" role="presentation">
                    {group.label}
                    {group.label === 'needs attention' && (
                      <span className="category-count">
                        ({group.items.length})
                      </span>
                    )}
                  </div>
                  {group.items.map((item) => {
                    const globalIndex = flatIndexMap.get(item.id) ?? -1;
                    const isFocused = globalIndex === focusedIndex;
                    const isDisabled =
                      item.type === 'command' &&
                      'disabledReason' in item &&
                      !!item.disabledReason;
                    const disabledReason =
                      item.type === 'command' && 'disabledReason' in item
                        ? item.disabledReason
                        : undefined;
                    return (
                      <div
                        key={item.id}
                        id={`palette-item-${item.id}`}
                        className={[
                          'palette-item',
                          isFocused ? 'focused' : '',
                          isDisabled ? 'disabled' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        role="option"
                        tabIndex={-1}
                        aria-selected={isFocused}
                        aria-disabled={isDisabled}
                        title={isDisabled ? disabledReason : undefined}
                        onClick={() => void selectItem(item)}
                        onMouseEnter={() => setFocusedIndex(globalIndex)}
                      >
                        <span
                          className={['item-cursor', isFocused ? 'visible' : '']
                            .filter(Boolean)
                            .join(' ')}
                        >
                          &gt;
                        </span>
                        {item.type === 'attention' || item.type === 'pr' ? (
                          <StatusDot
                            status={derivePrDotStatus(item.data as PullRequest)}
                            size={7}
                          />
                        ) : item.type === 'command' &&
                          (item.data as Action).icon ? (
                          <span className="item-icon">
                            {(item.data as Action).icon}
                          </span>
                        ) : item.type === 'artifact' ? (
                          <span className="item-icon">
                            {artifactKindIcon(
                              (item.data as PipelineHandoffArtifactEnvelope)
                                .metadata.kind
                            )}
                          </span>
                        ) : (
                          <span className="item-icon">
                            {categoryIcon(item.type)}
                          </span>
                        )}
                        <span className="item-label">{item.label}</span>
                        {item.sublabel && (
                          <span className="item-sublabel">{item.sublabel}</span>
                        )}
                        {!isMobileDevice &&
                          item.type === 'command' &&
                          (item.data as Action).shortcut && (
                            <kbd className="item-shortcut">
                              {formatShortcut(
                                (item.data as Action).shortcut!.key,
                                isMac
                              )}
                            </kbd>
                          )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })()}
        {!isMobileDevice && (
          <div className="palette-footer">
            <span className="hint">↑↓ navigate</span>
            <span className="hint">tab category</span>
            <span className="hint">↵ select</span>
            <span className="hint">esc close</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default CommandPalette;
