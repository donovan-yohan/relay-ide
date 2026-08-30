import type { NodeId } from './identity.js';
import type { WorkspaceId } from './workspace.js';
import { normalizeWorkspaceId } from './workspace.js';
import type { ArtifactId, TaskRef, WorkContextId } from './work-context.js';

// Workspace topics (#1022): typed backend/shared foundation for the
// Discord-replacement topic/workspace ladder. Topics are organization and launch
// defaults, not transcript warehouses. They link to existing WorkContext,
// session, task, artifact, repo/worktree, and WorkspaceSurface identities by ref.
// Surface metadata stays in WorkspaceSurface records; topics only carry surface ids.

const WORKSPACE_TOPIC_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_TOPICS_MAX_LIST_ENTRIES = 200;
export const WORKSPACE_TOPICS_SEARCH_DEFAULT_LIMIT = 20;
export const WORKSPACE_TOPICS_SEARCH_MAX_RESULTS = 50;
export const WORKSPACE_TOPICS_SEARCH_QUERY_MAX = 160;
const WORKSPACE_TOPIC_TITLE_MAX = 160;
const WORKSPACE_TOPIC_DESCRIPTION_MAX = 2000;
const WORKSPACE_TOPIC_PROMPT_MAX = 4000;
const WORKSPACE_TOPIC_REF_MAX = 256;
const WORKSPACE_TOPIC_PATH_MAX = 4096;
const WORKSPACE_TOPIC_MAX_REFS = 100;

export type WorkspaceTopicId = string;
type WorkspaceTopicStatus = 'active' | 'archived';
type WorkspaceTopicVisibility = 'default' | 'private' | 'shared';
type WorkspaceTopicSource = 'persisted' | 'derived';
type WorkspaceTopicPrivacyClass = 'public' | 'internal' | 'sensitive';
type WorkspaceTopicRetentionClass =
  | 'ephemeral'
  | 'session'
  | 'project'
  | 'audit';
type WorkspaceTopicRedactionStrategy = 'none' | 'summary' | 'hash' | 'omitted';
export type WorkspaceTopicMutationKind = 'create' | 'update' | 'archive';

interface WorkspaceTopicPrivacyMetadata {
  classification: WorkspaceTopicPrivacyClass;
  retention: WorkspaceTopicRetentionClass;
  redaction: WorkspaceTopicRedactionStrategy;
  rawDefaultsStored: false;
}

/**
 * Discord-style channel taxonomy for a topic — a semantic facet chosen by the
 * user, distinct from the routing-derived structural kind (repo/folder/thread).
 */
export type WorkspaceTopicChannelKind =
  | 'repo'
  | 'product-area'
  | 'journal'
  | 'ops'
  | 'research'
  | 'topic';

const WORKSPACE_TOPIC_CHANNEL_KINDS: readonly WorkspaceTopicChannelKind[] = [
  'repo',
  'product-area',
  'journal',
  'ops',
  'research',
  'topic',
] as const;

interface WorkspaceTopicDisplay {
  title: string;
  description?: string;
  icon?: string;
  color?: string;
  /** Optional channel taxonomy (repo/product-area/journal/ops/research/topic). */
  kind?: WorkspaceTopicChannelKind;
}

interface WorkspaceTopicGrouping {
  parentTopicId?: WorkspaceTopicId;
  order?: number;
}

interface WorkspaceTopicPromptDefaults {
  starterPrompt?: string;
  systemPrompt?: string;
  instructions?: string;
  contextPacketIds?: string[];
}

interface WorkspaceTopicRoutingDefaults {
  providerId?: string;
  agentId?: string;
  nodeId?: NodeId;
  repoPath?: string;
  worktreePath?: string;
  cwd?: string;
}

interface WorkspaceTopicLinkedRefs {
  workContextIds?: WorkContextId[];
  sessionIds?: string[];
  taskRefs?: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>[];
  artifactIds?: ArtifactId[];
  /** WorkspaceSurface ids from shared/workspace-surfaces.ts. No duplicated surface fields. */
  workspaceSurfaceIds?: string[];
  /**
   * Private channel agent runtimes the binder bound to this topic (#1287).
   * These are deliberately NOT Relay sessions — `ChannelAgentRuntime` is absent
   * from session lists — so they never resolve to a session row and MUST NOT be
   * written into `sessionIds`. They exist so a channel that has ever bound an
   * agent counts as explicitly linked and stops guessing its participants from
   * `routingDefaults` paths.
   */
  agentRuntimeIds?: string[];
}

interface WorkspaceTopicState {
  pinned: boolean;
  muted: boolean;
  archivedAt?: string;
}

export interface WorkspaceTopicMutationPolicy {
  kind: WorkspaceTopicMutationKind;
  sideEffectClass: 'write' | 'destructive';
  requiresConfirmation: boolean;
  controlRequirements: readonly 'confirmation-challenge'[];
  scopeKind: 'work-context';
  audit: {
    expectation: 'action-summary';
    storesRawPrompt: false;
    storesRawTranscript: false;
    storesRawPtyInput: false;
    storesRawProviderState: false;
  };
}

export interface WorkspaceTopic {
  schemaVersion: typeof WORKSPACE_TOPIC_SCHEMA_VERSION;
  id: WorkspaceTopicId;
  workspaceId: WorkspaceId;
  source: WorkspaceTopicSource;
  status: WorkspaceTopicStatus;
  visibility: WorkspaceTopicVisibility;
  display: WorkspaceTopicDisplay;
  grouping: WorkspaceTopicGrouping;
  promptDefaults: WorkspaceTopicPromptDefaults;
  routingDefaults: WorkspaceTopicRoutingDefaults;
  linkedRefs: WorkspaceTopicLinkedRefs;
  state: WorkspaceTopicState;
  privacy: WorkspaceTopicPrivacyMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTopicListResponse {
  topics: WorkspaceTopic[];
  truncated: boolean;
  derived: boolean;
}

type WorkspaceTopicSearchMatchKind =
  | 'topic'
  | 'workspace'
  | 'task'
  | 'repo'
  | 'worktree'
  | 'artifact'
  | 'surface'
  | 'agent'
  | 'session'
  | 'phrase';

export type WorkspaceTopicSearchFreshness = 'fresh' | 'stale' | 'unknown';

export interface WorkspaceTopicSearchMatch {
  kind: WorkspaceTopicSearchMatchKind;
  field: string;
  label: string;
  value: string;
}

interface WorkspaceTopicSearchAction {
  kind: 'open-topic';
  topicId: WorkspaceTopicId;
  primarySessionId?: string;
  disabledReason?: string;
}

export interface WorkspaceTopicSearchResult {
  topic: WorkspaceTopic;
  score: number;
  freshness: WorkspaceTopicSearchFreshness;
  matches: WorkspaceTopicSearchMatch[];
  action: WorkspaceTopicSearchAction;
}

export interface WorkspaceTopicSearchResponse {
  query: string;
  results: WorkspaceTopicSearchResult[];
  truncated: boolean;
  derived: boolean;
  unavailableReason?: string;
}

type WorkspaceTopicLaunchOverrides = Record<string, unknown>;

export interface WorkspaceTopicCreateInput {
  id?: WorkspaceTopicId;
  workspaceId: WorkspaceId;
  title: string;
  description?: string;
  channelKind?: WorkspaceTopicChannelKind;
  visibility?: WorkspaceTopicVisibility;
  grouping?: WorkspaceTopicGrouping;
  promptDefaults?: WorkspaceTopicPromptDefaults;
  routingDefaults?: WorkspaceTopicRoutingDefaults;
  linkedRefs?: WorkspaceTopicLinkedRefs;
  pinned?: boolean;
  muted?: boolean;
  privacy?: Partial<WorkspaceTopicPrivacyMetadata>;
}

export interface WorkspaceTopicUpdateInput {
  title?: string;
  description?: string | null;
  channelKind?: WorkspaceTopicChannelKind | null;
  visibility?: WorkspaceTopicVisibility;
  grouping?: WorkspaceTopicGrouping;
  promptDefaults?: WorkspaceTopicPromptDefaults;
  routingDefaults?: WorkspaceTopicRoutingDefaults;
  linkedRefs?: WorkspaceTopicLinkedRefs;
  pinned?: boolean;
  muted?: boolean;
  privacy?: Partial<WorkspaceTopicPrivacyMetadata>;
}

export type WorkspaceTopicLaunchIntent = 'create-only' | 'create-and-launch';
export type WorkspaceTopicTemplateKind =
  | 'agent-task'
  | 'terminal-task'
  | 'note';

interface WorkspaceTopicLaunchPreviewInput {
  create: WorkspaceTopicCreateInput;
  intent: WorkspaceTopicLaunchIntent;
  templateKind?: WorkspaceTopicTemplateKind;
  launchOverrides?: WorkspaceTopicLaunchOverrides;
}

interface WorkspaceTopicLaunchPreview {
  intent: WorkspaceTopicLaunchIntent;
  templateKind: WorkspaceTopicTemplateKind;
  title: string;
  workspaceId: WorkspaceId;
  providerLabel: string;
  modeLabel: string;
  nodeLabel: string;
  cwdLabel: string;
  promptSources: string[];
  taskRefs: string[];
  sideEffects: string[];
}

function launchOverrideString(
  overrides: WorkspaceTopicLaunchOverrides | undefined,
  key: string
): string | undefined {
  const value = overrides?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function taskRefLabel(
  ref: NonNullable<WorkspaceTopicLinkedRefs['taskRefs']>[number]
): string {
  return ref.title
    ? `${ref.kind}:${ref.id} · ${ref.title}`
    : `${ref.kind}:${ref.id}`;
}

function providerPreviewLabel(provider: string): string {
  return provider === 'hermes' ? 'hermes (mode explicit)' : provider;
}

export function buildWorkspaceTopicLaunchPreview(
  input: WorkspaceTopicLaunchPreviewInput
): WorkspaceTopicLaunchPreview {
  const create = input.create;
  const overrideProvider = launchOverrideString(input.launchOverrides, 'agent');
  const overrideNode = launchOverrideString(input.launchOverrides, 'nodeId');
  const overrideRepo = launchOverrideString(input.launchOverrides, 'repoPath');
  const overrideWorktree = launchOverrideString(
    input.launchOverrides,
    'worktreePath'
  );
  const overrideCwd = launchOverrideString(input.launchOverrides, 'cwd');
  const routing = resolveWorkspaceTopicRoutingDefaults({
    ...(create.routingDefaults
      ? { topicDefaults: create.routingDefaults }
      : {}),
    explicitSpawnInput: {
      ...(overrideProvider ? { providerId: overrideProvider } : {}),
      ...(overrideNode ? { nodeId: overrideNode } : {}),
      ...(overrideRepo ? { repoPath: overrideRepo } : {}),
      ...(overrideWorktree ? { worktreePath: overrideWorktree } : {}),
      ...(overrideCwd ? { cwd: overrideCwd } : {}),
    },
  });
  const provider = routing.providerId ?? 'default provider';
  const mode = launchOverrideString(input.launchOverrides, 'mode') ?? 'pty';
  const promptSources = [
    create.promptDefaults?.starterPrompt ? 'starter prompt' : undefined,
    create.promptDefaults?.instructions ? 'instructions' : undefined,
    create.promptDefaults?.contextPacketIds?.length
      ? `${create.promptDefaults.contextPacketIds.length} context packets`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const taskRefs = (create.linkedRefs?.taskRefs ?? []).map(taskRefLabel);
  const templateKind = input.templateKind ?? 'agent-task';
  const sideEffects = [
    'create WorkspaceTopic room',
    create.linkedRefs?.workContextIds?.length
      ? 'link existing WorkContext ref'
      : 'create WorkContext link for this room',
    input.intent === 'create-and-launch' && templateKind === 'agent-task'
      ? 'open provider DM channel and post the first message'
      : undefined,
    input.intent === 'create-and-launch' && templateKind === 'terminal-task'
      ? 'launch terminal through sessions.create'
      : undefined,
    input.intent === 'create-and-launch' && templateKind === 'terminal-task'
      ? 'link created terminal back to WorkspaceTopic/WorkContext'
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return {
    intent: input.intent,
    templateKind,
    title: create.title,
    workspaceId: create.workspaceId,
    providerLabel: providerPreviewLabel(provider),
    modeLabel: mode,
    nodeLabel: routing.nodeId ?? 'local/default node',
    cwdLabel:
      routing.worktreePath ?? routing.cwd ?? routing.repoPath ?? 'default cwd',
    promptSources: promptSources.length ? promptSources : ['none'],
    taskRefs: taskRefs.length ? taskRefs : ['none'],
    sideEffects,
  };
}

export interface WorkspaceTopicValidationOptions {
  knownRepoPaths?: readonly string[];
  knownWorktreePaths?: readonly string[];
  knownWorkspaceSurfaceIds?: readonly string[];
}

export class WorkspaceTopicValidationError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkspaceTopicValidationError';
  }
}

const TOPIC_ID_PATTERN = /^topic:[A-Za-z0-9._~%-]{1,160}$/;
const VISIBILITIES = new Set<string>(['default', 'private', 'shared']);
const CHANNEL_KINDS = new Set<string>(WORKSPACE_TOPIC_CHANNEL_KINDS);
const PRIVACY_CLASSES = new Set<string>(['public', 'internal', 'sensitive']);
const RETENTION_CLASSES = new Set<string>([
  'ephemeral',
  'session',
  'project',
  'audit',
]);
const REDACTION_STRATEGIES = new Set<string>([
  'none',
  'summary',
  'hash',
  'omitted',
]);
const TASK_REF_KINDS = new Set<string>([
  'github-issue',
  'github-pr',
  'kanban-task',
  'jira-ticket',
  'linear-issue',
  'external',
]);
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|api[_-]?key|credential|authorization|authheader)/i;
const SECRET_VALUE_PATTERN =
  /(bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|relay-sac-v1\.|BEGIN [A-Z ]*PRIVATE KEY)/i;
const CUSTOM_PROVIDER_PATTERN = /^custom:[A-Za-z0-9._-]{1,80}$/;
/**
 * Provider ids a topic's `routingDefaults.providerId` may name without the
 * `custom:` prefix. `terminal` is the non-agent routing lane, not an adapter.
 *
 * The declaration of record is `ProviderDescriptor.allowedAsTopicRoutingDefault`
 * (`server/protocol-adapters/index.ts`). This set has to be restated here because
 * `shared/` must not import from `server/` and the topic validator runs on both
 * sides; `test/provider-registry-drift.test.ts` binds the two in both directions,
 * so a registered provider missing here (its topic routing default REJECTED by
 * `assertProviderId`) or a name no adapter serves fails the drift suite.
 */
export const BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'opencode',
  'hermes',
  'prime-agent',
  'pi',
  'terminal',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  value: unknown,
  field: string,
  max: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new WorkspaceTopicValidationError(`${field} must be a string`, {
      field,
    });
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    throw new WorkspaceTopicValidationError(
      `${field} exceeds ${max} characters`,
      {
        field,
        max,
      }
    );
  }
  return trimmed;
}

function readRequiredString(
  value: unknown,
  field: string,
  max: number
): string {
  const parsed = readString(value, field, max);
  if (!parsed)
    throw new WorkspaceTopicValidationError(`${field} is required`, { field });
  return parsed;
}

function readBoolean(
  value: unknown,
  field: string,
  fallback: boolean
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new WorkspaceTopicValidationError(`${field} must be a boolean`, {
      field,
    });
  }
  return value;
}

function readFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkspaceTopicValidationError(
      `${field} must be a finite number`,
      { field }
    );
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: Set<string>,
  fallback: T
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new WorkspaceTopicValidationError(`${field} is invalid`, {
      field,
      allowed: Array.from(allowed),
    });
  }
  return value as T;
}

function readStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new WorkspaceTopicValidationError(`${field} must be an array`, {
      field,
    });
  }
  if (value.length > WORKSPACE_TOPIC_MAX_REFS) {
    throw new WorkspaceTopicValidationError(
      `${field} exceeds ${WORKSPACE_TOPIC_MAX_REFS} entries`,
      {
        field,
        max: WORKSPACE_TOPIC_MAX_REFS,
      }
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    const parsed = readRequiredString(entry, field, WORKSPACE_TOPIC_REF_MAX);
    if (!out.includes(parsed)) out.push(parsed);
  }
  return out.length ? out : undefined;
}

/**
 * Crockford base32 (no `i`/`l`/`o`/`u`), lowercased. A minted topic id is one
 * opaque token in this alphabet, well inside the `topic:` grammar.
 */
const TOPIC_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** 10 base32 chars hold a 48-bit millisecond timestamp (ULID layout). */
const TOPIC_ID_TIME_CHARS = 10;
/** 16 base32 chars = 80 bits of entropy per id (ULID layout). */
const TOPIC_ID_RANDOM_CHARS = 16;

type TopicIdRandomSource = { getRandomValues(array: Uint8Array): unknown };

function topicIdSymbol(value: number): string {
  return TOPIC_ID_ALPHABET[value % TOPIC_ID_ALPHABET.length] ?? '0';
}

function encodeTopicIdTime(nowMs: number): string {
  let value = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) : 0;
  let out = '';
  for (let index = 0; index < TOPIC_ID_TIME_CHARS; index += 1) {
    out = `${topicIdSymbol(value)}${out}`;
    value = Math.floor(value / TOPIC_ID_ALPHABET.length);
  }
  return out;
}

function encodeTopicIdRandom(): string {
  const bytes = new Uint8Array(TOPIC_ID_RANDOM_CHARS);
  // Structural lookup, not the ambient `Crypto` type: this module is bundled
  // into the browser AND imported by the hub, and the two lib sets declare
  // `globalThis.crypto` differently.
  const source = (globalThis as { crypto?: Partial<TopicIdRandomSource> })
    .crypto;
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  // 256 % 32 === 0, so folding a byte onto the alphabet is bias-free.
  return Array.from(bytes, (byte) => topicIdSymbol(byte)).join('');
}

/**
 * Mint an OPAQUE topic/channel id (#1287 slice 4).
 *
 * Channel identity is independent of the free-text title: two chats titled
 * "Fix bug #12" in one workspace are two channels, duplicate titles are legal,
 * and a rename is display-only (`channel_messages.channel_id` keys the
 * transcript — `docs/LEARNINGS.md` L-20260729-topic-id-title-slug).
 *
 * Shape is ULID-like — `topic:` + 10 chars of millisecond timestamp + 16 chars
 * of CSPRNG entropy — so ids sort by creation for debugging. NOTHING may parse
 * the suffix: workspace membership lives in the `workspace_id` column, never in
 * the id. Deterministic channels (DMs, WorkContext-derived rows) pass their own
 * id in explicitly and are unaffected.
 */
export function mintWorkspaceTopicId(
  nowMs: number = Date.now()
): WorkspaceTopicId {
  return `topic:${encodeTopicIdTime(nowMs)}${encodeTopicIdRandom()}`;
}

/**
 * Deterministic topic id derived from a STABLE key (never a free-text title).
 *
 * This is the id-minting path for channels that must resolve to the same row on
 * every recomputation — today only `deriveWorkspaceTopicsFromWorkContexts`,
 * which keys off the WorkContext id. Free-titled chats use
 * `mintWorkspaceTopicId`; DMs build their own id in `dm-channels.ts`.
 *
 * The slug charset deliberately excludes `~`, which reserves the `~` sub-
 * namespace for DM ids (see `frontend/src/lib/dm-channels.ts`).
 */
export function createWorkspaceTopicId(
  localId: string,
  namespace?: string
): WorkspaceTopicId {
  const slug = [namespace, localId]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('-')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  if (!slug)
    throw new WorkspaceTopicValidationError('topic id localId is required');
  return `topic:${encodeURIComponent(slug)}`;
}

export function isWorkspaceTopicId(value: unknown): value is WorkspaceTopicId {
  return typeof value === 'string' && TOPIC_ID_PATTERN.test(value);
}

export function assertWorkspaceTopicId(
  value: string,
  field = 'id'
): WorkspaceTopicId {
  if (!isWorkspaceTopicId(value)) {
    throw new WorkspaceTopicValidationError(
      `${field} is not a valid WorkspaceTopic id`,
      {
        field,
        expected: 'topic:<url-safe-id>',
      }
    );
  }
  return value;
}

/**
 * Reason code for a create blocked by an existing row on the SAME id (#1287).
 *
 * Since slice 4 mints opaque ids, the free-titled composer path cannot collide
 * at all. What remains is the deliberate-id residue: DM ids
 * (`dmChannelTopicId`), WorkContext-derived rows, and any explicit `id` posted
 * through the gateway or a raw `POST /workspace-topics`.
 */
export const WORKSPACE_TOPIC_ALREADY_EXISTS_REASON =
  'WORKSPACE_TOPIC_ALREADY_EXISTS';

/** `open` when the blocking channel is active, `restore` when it is archived. */
type WorkspaceTopicConflictRemedy = 'open' | 'restore';

/**
 * Self-explaining 409 body for that conflict.
 *
 * The blocker is frequently INVISIBLE to the caller: archived rows are filtered
 * out of the default list, and `list()` caps at
 * `WORKSPACE_TOPICS_MAX_LIST_ENTRIES` (200) while the store keeps 500 — so an
 * active row ranked 201+ by `updated_at` is missing from the list too. Naming
 * the row and its remedy is therefore the whole point: without it the caller
 * gets "already exists" about a channel it cannot find, and no way forward.
 *
 * A `type` alias, not an `interface`: this is carried as the `details` bag of a
 * gateway error (`Record<string, unknown>`), and only type aliases get the
 * implicit index signature that assignment needs.
 */
export type WorkspaceTopicConflictDetails = {
  reasonCode: typeof WORKSPACE_TOPIC_ALREADY_EXISTS_REASON;
  /** The requested id. Identical to `blockingTopicId` — this is a PK conflict. */
  id: WorkspaceTopicId;
  blockingTopicId: WorkspaceTopicId;
  blockingTopicStatus: WorkspaceTopicStatus;
  blockingTopicTitle: string;
  blockingWorkspaceId: WorkspaceId;
  remedy: WorkspaceTopicConflictRemedy;
};

/**
 * Build the conflict body from whatever the store could recover about the
 * blocker. `title` is optional on purpose: a row whose `record_json` failed to
 * parse still has id/workspace/status columns, and a conflict that names the id
 * beats one that names nothing.
 *
 * `blockingWorkspaceId` is normalized HERE, at the single point every producer
 * goes through, because `parseWorkspaceTopicConflictDetails` normalizes on the
 * way back in. Emitting the raw column instead would make the field round-trip
 * to a DIFFERENT value than the server holds for any row still carrying a
 * retired sentinel (`workspace:local` in → `ws:local` out), silently pointing a
 * caller that navigates or groups by it at the wrong lane.
 */
export function buildWorkspaceTopicConflictDetails(blocker: {
  id: WorkspaceTopicId;
  workspaceId: WorkspaceId;
  status: WorkspaceTopicStatus;
  title?: string | undefined;
}): WorkspaceTopicConflictDetails {
  return {
    reasonCode: WORKSPACE_TOPIC_ALREADY_EXISTS_REASON,
    id: blocker.id,
    blockingTopicId: blocker.id,
    blockingTopicStatus: blocker.status,
    blockingTopicTitle: blocker.title?.trim() || blocker.id,
    blockingWorkspaceId: normalizeWorkspaceId(blocker.workspaceId),
    remedy: blocker.status === 'archived' ? 'restore' : 'open',
  };
}

/** Operator-facing message for a conflict body. Names the blocker AND the way out. */
export function workspaceTopicConflictMessage(
  details: WorkspaceTopicConflictDetails
): string {
  const blocker = `channel id ${details.blockingTopicId} is already taken by the ${details.blockingTopicStatus} channel "${details.blockingTopicTitle}"`;
  return details.remedy === 'restore'
    ? `${blocker} — restore that channel instead of creating a new one`
    : `${blocker} — open that channel instead of creating a new one`;
}

/**
 * Read a conflict body back off the wire. Returns null for any other error
 * shape, so callers can branch on "this id is taken" without string-matching
 * messages.
 */
export function parseWorkspaceTopicConflictDetails(
  value: unknown
): WorkspaceTopicConflictDetails | null {
  const record = asRecord(value);
  if (record['reasonCode'] !== WORKSPACE_TOPIC_ALREADY_EXISTS_REASON)
    return null;
  const blockingTopicId = record['blockingTopicId'];
  const status = record['blockingTopicStatus'];
  const remedy = record['remedy'];
  if (!isWorkspaceTopicId(blockingTopicId)) return null;
  if (status !== 'active' && status !== 'archived') return null;
  if (remedy !== 'open' && remedy !== 'restore') return null;
  const title = record['blockingTopicTitle'];
  const workspaceId = record['blockingWorkspaceId'];
  return {
    reasonCode: WORKSPACE_TOPIC_ALREADY_EXISTS_REASON,
    id: isWorkspaceTopicId(record['id']) ? record['id'] : blockingTopicId,
    blockingTopicId,
    blockingTopicStatus: status,
    blockingTopicTitle:
      typeof title === 'string' && title.trim() ? title : blockingTopicId,
    blockingWorkspaceId: normalizeWorkspaceId(
      typeof workspaceId === 'string' ? workspaceId : null
    ),
    remedy,
  };
}

function assertNoSecretBearingDefaults(
  value: unknown,
  path = 'defaults'
): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERN.test(value)) {
      throw new WorkspaceTopicValidationError(
        'topic defaults must not contain raw secrets',
        {
          field: path,
          reasonCode: 'WORKSPACE_TOPIC_SECRET_DEFAULT_REJECTED',
        }
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretBearingDefaults(entry, `${path}[${index}]`)
    );
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new WorkspaceTopicValidationError(
        'topic defaults must not contain secret-bearing keys',
        {
          field: `${path}.${key}`,
          reasonCode: 'WORKSPACE_TOPIC_SECRET_DEFAULT_REJECTED',
        }
      );
    }
    assertNoSecretBearingDefaults(nested, `${path}.${key}`);
  }
}

function assertProviderId(providerId: string | undefined): void {
  if (!providerId) return;
  if (
    BUILTIN_PROVIDER_IDS.has(providerId) ||
    CUSTOM_PROVIDER_PATTERN.test(providerId)
  )
    return;
  throw new WorkspaceTopicValidationError(
    'routingDefaults.providerId is unsupported',
    {
      field: 'routingDefaults.providerId',
      providerId,
      allowed: [...Array.from(BUILTIN_PROVIDER_IDS), 'custom:<id>'],
    }
  );
}

function assertKnownPath(
  value: string | undefined,
  field: string,
  known: readonly string[] | undefined
): void {
  if (!value || !known || known.length === 0) return;
  const normalized = new Set(
    known.map((entry) => entry.trim()).filter(Boolean)
  );
  if (!normalized.has(value)) {
    throw new WorkspaceTopicValidationError(
      `${field} is not a known configured binding`,
      {
        field,
        reasonCode: 'WORKSPACE_TOPIC_STALE_BINDING',
        value,
      }
    );
  }
}

function assertKnownWorktreePath(
  value: string | undefined,
  options: WorkspaceTopicValidationOptions
): void {
  if (!value) return;
  if (options.knownWorktreePaths && options.knownWorktreePaths.length > 0) {
    assertKnownPath(
      value,
      'routingDefaults.worktreePath',
      options.knownWorktreePaths
    );
    return;
  }
  if (!options.knownRepoPaths || options.knownRepoPaths.length === 0) return;
  const normalizedRepos = options.knownRepoPaths.map((entry) =>
    entry.trim().replace(/\/+$/, '')
  );
  const normalizedValue = value.replace(/\/+$/, '');
  const isUnderKnownRepo = normalizedRepos.some(
    (repoPath) =>
      normalizedValue === repoPath || normalizedValue.startsWith(`${repoPath}/`)
  );
  if (!isUnderKnownRepo) {
    throw new WorkspaceTopicValidationError(
      'routingDefaults.worktreePath is not under a known configured repo binding',
      {
        field: 'routingDefaults.worktreePath',
        reasonCode: 'WORKSPACE_TOPIC_STALE_BINDING',
        value,
      }
    );
  }
}

function parsePromptDefaults(raw: unknown): WorkspaceTopicPromptDefaults {
  const record = asRecord(raw);
  assertNoSecretBearingDefaults(record, 'promptDefaults');
  const out: WorkspaceTopicPromptDefaults = {};
  const starterPrompt = readString(
    record['starterPrompt'],
    'promptDefaults.starterPrompt',
    WORKSPACE_TOPIC_PROMPT_MAX
  );
  if (starterPrompt) out.starterPrompt = starterPrompt;
  const systemPrompt = readString(
    record['systemPrompt'],
    'promptDefaults.systemPrompt',
    WORKSPACE_TOPIC_PROMPT_MAX
  );
  if (systemPrompt) out.systemPrompt = systemPrompt;
  const instructions = readString(
    record['instructions'],
    'promptDefaults.instructions',
    WORKSPACE_TOPIC_PROMPT_MAX
  );
  if (instructions) out.instructions = instructions;
  const contextPacketIds = readStringList(
    record['contextPacketIds'],
    'promptDefaults.contextPacketIds'
  );
  if (contextPacketIds) out.contextPacketIds = contextPacketIds;
  return out;
}

function parseRoutingDefaults(
  raw: unknown,
  options: WorkspaceTopicValidationOptions
): WorkspaceTopicRoutingDefaults {
  const record = asRecord(raw);
  assertNoSecretBearingDefaults(record, 'routingDefaults');
  const out: WorkspaceTopicRoutingDefaults = {};
  const providerId = readString(
    record['providerId'],
    'routingDefaults.providerId',
    WORKSPACE_TOPIC_REF_MAX
  );
  assertProviderId(providerId);
  if (providerId) out.providerId = providerId;
  const agentId = readString(
    record['agentId'],
    'routingDefaults.agentId',
    WORKSPACE_TOPIC_REF_MAX
  );
  if (agentId) out.agentId = agentId;
  const nodeId = readString(
    record['nodeId'],
    'routingDefaults.nodeId',
    WORKSPACE_TOPIC_REF_MAX
  );
  if (nodeId) out.nodeId = nodeId;
  const repoPath = readString(
    record['repoPath'],
    'routingDefaults.repoPath',
    WORKSPACE_TOPIC_PATH_MAX
  );
  assertKnownPath(repoPath, 'routingDefaults.repoPath', options.knownRepoPaths);
  if (repoPath) out.repoPath = repoPath;
  const worktreePath = readString(
    record['worktreePath'],
    'routingDefaults.worktreePath',
    WORKSPACE_TOPIC_PATH_MAX
  );
  assertKnownWorktreePath(worktreePath, options);
  if (worktreePath) out.worktreePath = worktreePath;
  const cwd = readString(
    record['cwd'],
    'routingDefaults.cwd',
    WORKSPACE_TOPIC_PATH_MAX
  );
  if (cwd) out.cwd = cwd;
  return out;
}

function parseTaskRefs(value: unknown): WorkspaceTopicLinkedRefs['taskRefs'] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new WorkspaceTopicValidationError(
      'linkedRefs.taskRefs must be an array',
      {
        field: 'linkedRefs.taskRefs',
      }
    );
  }
  if (value.length > WORKSPACE_TOPIC_MAX_REFS) {
    throw new WorkspaceTopicValidationError(
      'linkedRefs.taskRefs exceeds maximum entries',
      {
        field: 'linkedRefs.taskRefs',
        max: WORKSPACE_TOPIC_MAX_REFS,
      }
    );
  }
  const out: NonNullable<WorkspaceTopicLinkedRefs['taskRefs']> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const kind = readRequiredString(
      record['kind'],
      'linkedRefs.taskRefs.kind',
      WORKSPACE_TOPIC_REF_MAX
    );
    if (!TASK_REF_KINDS.has(kind)) {
      throw new WorkspaceTopicValidationError(
        'linkedRefs.taskRefs.kind is invalid',
        {
          field: 'linkedRefs.taskRefs.kind',
        }
      );
    }
    const id = readRequiredString(
      record['id'],
      'linkedRefs.taskRefs.id',
      WORKSPACE_TOPIC_REF_MAX
    );
    const ref: NonNullable<WorkspaceTopicLinkedRefs['taskRefs']>[number] = {
      kind: kind as TaskRef['kind'],
      id,
    };
    const title = readString(
      record['title'],
      'linkedRefs.taskRefs.title',
      WORKSPACE_TOPIC_TITLE_MAX
    );
    if (title) ref.title = title;
    const url = readString(record['url'], 'linkedRefs.taskRefs.url', 2048);
    if (url) ref.url = url;
    const status = readString(
      record['status'],
      'linkedRefs.taskRefs.status',
      WORKSPACE_TOPIC_REF_MAX
    );
    if (status) ref.status = status;
    out.push(ref);
  }
  return out.length ? out : undefined;
}

function parseLinkedRefs(
  raw: unknown,
  options: WorkspaceTopicValidationOptions
): WorkspaceTopicLinkedRefs {
  const record = asRecord(raw);
  const out: WorkspaceTopicLinkedRefs = {};
  const workContextIds = readStringList(
    record['workContextIds'],
    'linkedRefs.workContextIds'
  );
  if (workContextIds) out.workContextIds = workContextIds;
  const sessionIds = readStringList(
    record['sessionIds'],
    'linkedRefs.sessionIds'
  );
  if (sessionIds) out.sessionIds = sessionIds;
  const taskRefs = parseTaskRefs(record['taskRefs']);
  if (taskRefs) out.taskRefs = taskRefs;
  const artifactIds = readStringList(
    record['artifactIds'],
    'linkedRefs.artifactIds'
  );
  if (artifactIds) out.artifactIds = artifactIds;
  const agentRuntimeIds = readStringList(
    record['agentRuntimeIds'],
    'linkedRefs.agentRuntimeIds'
  );
  if (agentRuntimeIds) out.agentRuntimeIds = agentRuntimeIds;
  const workspaceSurfaceIds = readStringList(
    record['workspaceSurfaceIds'],
    'linkedRefs.workspaceSurfaceIds'
  );
  if (workspaceSurfaceIds) {
    if (
      options.knownWorkspaceSurfaceIds &&
      options.knownWorkspaceSurfaceIds.length > 0
    ) {
      const known = new Set(options.knownWorkspaceSurfaceIds);
      const missing = workspaceSurfaceIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw new WorkspaceTopicValidationError(
          'linkedRefs.workspaceSurfaceIds contains unknown WorkspaceSurface ids',
          {
            field: 'linkedRefs.workspaceSurfaceIds',
            reasonCode: 'WORKSPACE_TOPIC_UNKNOWN_SURFACE_REF',
            missing,
          }
        );
      }
    }
    out.workspaceSurfaceIds = workspaceSurfaceIds;
  }
  return out;
}

function parseGrouping(raw: unknown): WorkspaceTopicGrouping {
  const record = asRecord(raw);
  const out: WorkspaceTopicGrouping = {};
  const parentTopicId = readString(
    record['parentTopicId'],
    'grouping.parentTopicId',
    WORKSPACE_TOPIC_REF_MAX
  );
  if (parentTopicId)
    out.parentTopicId = assertWorkspaceTopicId(
      parentTopicId,
      'grouping.parentTopicId'
    );
  const order = readFiniteNumber(record['order'], 'grouping.order');
  if (order !== undefined) out.order = order;
  return out;
}

function parsePrivacy(raw: unknown): WorkspaceTopicPrivacyMetadata {
  const record = asRecord(raw);
  return {
    classification: readEnum<WorkspaceTopicPrivacyClass>(
      record['classification'],
      'privacy.classification',
      PRIVACY_CLASSES,
      'internal'
    ),
    retention: readEnum<WorkspaceTopicRetentionClass>(
      record['retention'],
      'privacy.retention',
      RETENTION_CLASSES,
      'project'
    ),
    redaction: readEnum<WorkspaceTopicRedactionStrategy>(
      record['redaction'],
      'privacy.redaction',
      REDACTION_STRATEGIES,
      'summary'
    ),
    rawDefaultsStored: false,
  };
}

function parsePrivacyPatch(
  raw: unknown
): Partial<WorkspaceTopicPrivacyMetadata> | undefined {
  const record = asRecord(raw);
  const patch: Partial<WorkspaceTopicPrivacyMetadata> = {};
  if (record['classification'] !== undefined) {
    patch.classification = readEnum<WorkspaceTopicPrivacyClass>(
      record['classification'],
      'privacy.classification',
      PRIVACY_CLASSES,
      'internal'
    );
  }
  if (record['retention'] !== undefined) {
    patch.retention = readEnum<WorkspaceTopicRetentionClass>(
      record['retention'],
      'privacy.retention',
      RETENTION_CLASSES,
      'project'
    );
  }
  if (record['redaction'] !== undefined) {
    patch.redaction = readEnum<WorkspaceTopicRedactionStrategy>(
      record['redaction'],
      'privacy.redaction',
      REDACTION_STRATEGIES,
      'summary'
    );
  }
  if (Object.keys(patch).length === 0) return undefined;
  patch.rawDefaultsStored = false;
  return patch;
}

export function parseWorkspaceTopicCreateInput(
  raw: unknown,
  options: WorkspaceTopicValidationOptions = {}
): WorkspaceTopicCreateInput {
  const record = asRecord(raw);
  // #1287 slice 2: the create boundary can no longer persist a workspace
  // pointer that `ia_workspaces` is structurally unable to match. The legacy
  // placeholders (`workspace:local`, `ws:derived`) and blanks resolve to the
  // hub-seeded local workspace; `ws:<localId>` ids and caller-chosen legacy
  // refs pass through (see `normalizeWorkspaceId`). Only the POINTER moves — an
  // explicit `id` in the body is still honored verbatim below, so a client
  // re-deriving an existing channel id keeps hitting the same row.
  const workspaceId = normalizeWorkspaceId(
    readRequiredString(
      record['workspaceId'],
      'workspaceId',
      WORKSPACE_TOPIC_REF_MAX
    )
  );
  const title = readRequiredString(
    record['title'],
    'title',
    WORKSPACE_TOPIC_TITLE_MAX
  );
  const out: WorkspaceTopicCreateInput = { workspaceId, title };
  const id = readString(record['id'], 'id', WORKSPACE_TOPIC_REF_MAX);
  if (id) out.id = assertWorkspaceTopicId(id);
  const description = readString(
    record['description'],
    'description',
    WORKSPACE_TOPIC_DESCRIPTION_MAX
  );
  if (description) out.description = description;
  if (record['channelKind'] !== undefined && record['channelKind'] !== null) {
    out.channelKind = readEnum<WorkspaceTopicChannelKind>(
      record['channelKind'],
      'channelKind',
      CHANNEL_KINDS,
      'topic'
    );
  }
  out.visibility = readEnum<WorkspaceTopicVisibility>(
    record['visibility'],
    'visibility',
    VISIBILITIES,
    'default'
  );
  out.grouping = parseGrouping(record['grouping']);
  out.promptDefaults = parsePromptDefaults(record['promptDefaults']);
  out.routingDefaults = parseRoutingDefaults(
    record['routingDefaults'],
    options
  );
  out.linkedRefs = parseLinkedRefs(record['linkedRefs'], options);
  out.pinned = readBoolean(record['pinned'], 'pinned', false);
  out.muted = readBoolean(record['muted'], 'muted', false);
  out.privacy = parsePrivacy(record['privacy']);
  return out;
}

export function parseWorkspaceTopicUpdateInput(
  raw: unknown,
  options: WorkspaceTopicValidationOptions = {}
): WorkspaceTopicUpdateInput {
  const record = asRecord(raw);
  const out: WorkspaceTopicUpdateInput = {};
  const title = readString(record['title'], 'title', WORKSPACE_TOPIC_TITLE_MAX);
  if (title) out.title = title;
  if (record['description'] === null) {
    out.description = null;
  } else {
    const description = readString(
      record['description'],
      'description',
      WORKSPACE_TOPIC_DESCRIPTION_MAX
    );
    if (description) out.description = description;
  }
  if (record['channelKind'] === null) {
    out.channelKind = null;
  } else if (record['channelKind'] !== undefined) {
    out.channelKind = readEnum<WorkspaceTopicChannelKind>(
      record['channelKind'],
      'channelKind',
      CHANNEL_KINDS,
      'topic'
    );
  }
  if (record['visibility'] !== undefined) {
    out.visibility = readEnum<WorkspaceTopicVisibility>(
      record['visibility'],
      'visibility',
      VISIBILITIES,
      'default'
    );
  }
  if (record['grouping'] !== undefined)
    out.grouping = parseGrouping(record['grouping']);
  if (record['promptDefaults'] !== undefined)
    out.promptDefaults = parsePromptDefaults(record['promptDefaults']);
  if (record['routingDefaults'] !== undefined)
    out.routingDefaults = parseRoutingDefaults(
      record['routingDefaults'],
      options
    );
  if (record['linkedRefs'] !== undefined)
    out.linkedRefs = parseLinkedRefs(record['linkedRefs'], options);
  if (record['pinned'] !== undefined)
    out.pinned = readBoolean(record['pinned'], 'pinned', false);
  if (record['muted'] !== undefined)
    out.muted = readBoolean(record['muted'], 'muted', false);
  if (record['privacy'] !== undefined) {
    const privacy = parsePrivacyPatch(record['privacy']);
    if (privacy) out.privacy = privacy;
  }
  if (Object.keys(out).length === 0) {
    throw new WorkspaceTopicValidationError(
      'workspace topic update has no changes',
      {
        reasonCode: 'WORKSPACE_TOPIC_EMPTY_UPDATE',
      }
    );
  }
  return out;
}

export const WORKSPACE_TOPIC_MUTATION_POLICIES: Record<
  WorkspaceTopicMutationKind,
  WorkspaceTopicMutationPolicy
> = {
  create: {
    kind: 'create',
    sideEffectClass: 'write',
    requiresConfirmation: false,
    controlRequirements: [],
    scopeKind: 'work-context',
    audit: {
      expectation: 'action-summary',
      storesRawPrompt: false,
      storesRawTranscript: false,
      storesRawPtyInput: false,
      storesRawProviderState: false,
    },
  },
  update: {
    kind: 'update',
    sideEffectClass: 'write',
    requiresConfirmation: false,
    controlRequirements: [],
    scopeKind: 'work-context',
    audit: {
      expectation: 'action-summary',
      storesRawPrompt: false,
      storesRawTranscript: false,
      storesRawPtyInput: false,
      storesRawProviderState: false,
    },
  },
  archive: {
    kind: 'archive',
    sideEffectClass: 'destructive',
    requiresConfirmation: true,
    controlRequirements: ['confirmation-challenge'],
    scopeKind: 'work-context',
    audit: {
      expectation: 'action-summary',
      storesRawPrompt: false,
      storesRawTranscript: false,
      storesRawPtyInput: false,
      storesRawProviderState: false,
    },
  },
};

interface WorkspaceTopicDefaultsInput {
  providerRuntimeDefaults?: WorkspaceTopicRoutingDefaults;
  agentProfileDefaults?: WorkspaceTopicRoutingDefaults;
  repoProjectDefaults?: WorkspaceTopicRoutingDefaults;
  workspaceDefaults?: WorkspaceTopicRoutingDefaults;
  topicDefaults?: WorkspaceTopicRoutingDefaults;
  sessionOverride?: WorkspaceTopicRoutingDefaults;
  explicitSpawnInput?: WorkspaceTopicRoutingDefaults;
}

export function resolveWorkspaceTopicRoutingDefaults(
  input: WorkspaceTopicDefaultsInput
): WorkspaceTopicRoutingDefaults {
  return {
    ...(input.providerRuntimeDefaults ?? {}),
    ...(input.agentProfileDefaults ?? {}),
    ...(input.repoProjectDefaults ?? {}),
    ...(input.workspaceDefaults ?? {}),
    ...(input.topicDefaults ?? {}),
    ...(input.sessionOverride ?? {}),
    ...(input.explicitSpawnInput ?? {}),
  };
}

/**
 * Active workspace context a topic establishes when it is selected in the UI.
 * `repoPath` prefers the topic's repo, then its worktree; a pure-thread topic
 * with neither yields `null` so the caller can leave the current repo context
 * untouched. The node is intentionally not part of this context — launches read
 * it from the topic's routing defaults.
 */
export function resolveTopicActiveContext(topic: WorkspaceTopic): {
  workspaceId: string;
  repoPath: string | null;
} {
  const routing = topic.routingDefaults;
  return {
    workspaceId: topic.workspaceId,
    repoPath: routing.repoPath ?? routing.worktreePath ?? null,
  };
}

function readLaunchString(
  overrides: WorkspaceTopicLaunchOverrides,
  key: string
): string | undefined {
  const value = overrides[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readLaunchNumber(
  overrides: WorkspaceTopicLaunchOverrides,
  key: string
): number | undefined {
  const value = overrides[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Build the existing `sessions.create` body for a WorkspaceTopic launch.
 *
 * Project Topic location defaults into the public terminal-session contract.
 * Agent/provider/prompt defaults belong to channel dispatch and are
 * intentionally absent here.
 */
export function buildWorkspaceTopicSessionCreateBody(input: {
  topic: WorkspaceTopic;
  overrides?: WorkspaceTopicLaunchOverrides;
}): Record<string, unknown> {
  const overrides = input.overrides ?? {};
  const explicitWorktreePath = Object.prototype.hasOwnProperty.call(
    overrides,
    'worktreePath'
  )
    ? overrides['worktreePath']
    : undefined;
  const explicitSpawnInput: WorkspaceTopicRoutingDefaults = {};
  const explicitNode = readLaunchString(overrides, 'nodeId');
  if (explicitNode) explicitSpawnInput.nodeId = explicitNode;
  const explicitRepoPath = readLaunchString(overrides, 'repoPath');
  if (explicitRepoPath) explicitSpawnInput.repoPath = explicitRepoPath;
  if (typeof explicitWorktreePath === 'string' && explicitWorktreePath.trim()) {
    explicitSpawnInput.worktreePath = explicitWorktreePath.trim();
  }
  const explicitCwd = readLaunchString(overrides, 'cwd');
  if (explicitCwd) explicitSpawnInput.cwd = explicitCwd;

  const routing = resolveWorkspaceTopicRoutingDefaults({
    topicDefaults: input.topic.routingDefaults,
    explicitSpawnInput,
  });
  const body: Record<string, unknown> = { workspaceTopicId: input.topic.id };
  const repoPath = routing.repoPath ?? routing.cwd;
  if (repoPath) body['repoPath'] = repoPath;
  if (explicitWorktreePath === null) {
    body['worktreePath'] = null;
  } else {
    const worktreePath =
      routing.worktreePath ??
      (routing.cwd && routing.cwd !== repoPath ? routing.cwd : undefined);
    if (worktreePath) body['worktreePath'] = worktreePath;
  }
  if (routing.nodeId) body['nodeId'] = routing.nodeId;
  for (const key of ['type', 'mode', 'terminalBackend', 'branchName']) {
    const value = readLaunchString(overrides, key);
    if (value) body[key] = value;
  }
  for (const key of ['cols', 'rows']) {
    const value = readLaunchNumber(overrides, key);
    if (value !== undefined) body[key] = value;
  }
  const workContextId =
    readLaunchString(overrides, 'workContextId') ??
    input.topic.linkedRefs.workContextIds?.[0];
  if (workContextId) body['workContextId'] = workContextId;
  return body;
}

export function workspaceTopicSessionLinkPatch(input: {
  topic: WorkspaceTopic;
  sessionId: string;
  workContextId?: string | undefined;
}): WorkspaceTopicUpdateInput | undefined {
  const linkedRefs: WorkspaceTopicLinkedRefs = { ...input.topic.linkedRefs };
  const sessionIds = Array.from(
    new Set([...(linkedRefs.sessionIds ?? []), input.sessionId])
  );
  linkedRefs.sessionIds = sessionIds;
  if (input.workContextId) {
    linkedRefs.workContextIds = Array.from(
      new Set([...(linkedRefs.workContextIds ?? []), input.workContextId])
    );
  }
  if (
    sessionIds.length === (input.topic.linkedRefs.sessionIds ?? []).length &&
    (!input.workContextId ||
      input.topic.linkedRefs.workContextIds?.includes(input.workContextId))
  ) {
    return undefined;
  }
  return { linkedRefs };
}

/**
 * Newest binder runtime links retained per topic. A channel rebinds a fresh
 * runtime on every cold start, so the list is trimmed FIFO — it is a "this
 * topic links explicitly" marker plus a short recency tail, never an audit log,
 * and it must never grow into `WORKSPACE_TOPIC_MAX_REFS` territory.
 */
export const WORKSPACE_TOPIC_MAX_AGENT_RUNTIME_REFS = 16;

/**
 * Patch that records a binder-owned channel agent runtime on its topic (#1287).
 * Returns `undefined` when the runtime is already linked so callers skip a
 * no-op store write (and the `updatedAt` churn it would cause).
 */
export function workspaceTopicAgentRuntimeLinkPatch(input: {
  topic: WorkspaceTopic;
  runtimeId: string;
}): WorkspaceTopicUpdateInput | undefined {
  const runtimeId = input.runtimeId.trim();
  if (!runtimeId) return undefined;
  const current = input.topic.linkedRefs.agentRuntimeIds ?? [];
  if (current.includes(runtimeId)) return undefined;
  return {
    linkedRefs: {
      ...input.topic.linkedRefs,
      agentRuntimeIds: [...current, runtimeId].slice(
        -WORKSPACE_TOPIC_MAX_AGENT_RUNTIME_REFS
      ),
    },
  };
}

/**
 * True when a topic states who its participants are instead of leaving them to
 * be inferred. Any linked session, WorkContext, or channel agent runtime counts:
 * navigation surfaces use this to decide whether the legacy cwd/repoPath
 * fallback is allowed to run at all (#1287).
 */
export function workspaceTopicHasExplicitParticipantLinks(
  topic: WorkspaceTopic
): boolean {
  const linked = topic.linkedRefs;
  return (
    (linked.sessionIds?.length ?? 0) > 0 ||
    (linked.workContextIds?.length ?? 0) > 0 ||
    (linked.agentRuntimeIds?.length ?? 0) > 0
  );
}

export function buildWorkspaceTopicRecord(input: {
  create: WorkspaceTopicCreateInput;
  now: string;
}): WorkspaceTopic {
  // #1287 slice 4: identity is opaque, never `slug(workspaceId + '-' + title)`.
  // An explicit id still wins verbatim, which is how DMs and other
  // deterministic channels keep resolving to the same row.
  const id = input.create.id ?? mintWorkspaceTopicId(Date.parse(input.now));
  return {
    schemaVersion: WORKSPACE_TOPIC_SCHEMA_VERSION,
    id,
    workspaceId: input.create.workspaceId,
    source: 'persisted',
    status: 'active',
    visibility: input.create.visibility ?? 'default',
    display: {
      title: input.create.title,
      ...(input.create.description
        ? { description: input.create.description }
        : {}),
      ...(input.create.channelKind ? { kind: input.create.channelKind } : {}),
    },
    grouping: input.create.grouping ?? {},
    promptDefaults: input.create.promptDefaults ?? {},
    routingDefaults: input.create.routingDefaults ?? {},
    linkedRefs: input.create.linkedRefs ?? {},
    state: {
      pinned: input.create.pinned ?? false,
      muted: input.create.muted ?? false,
    },
    privacy: parsePrivacy(input.create.privacy),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function applyWorkspaceTopicUpdate(input: {
  topic: WorkspaceTopic;
  patch: WorkspaceTopicUpdateInput;
  now: string;
}): WorkspaceTopic {
  const topic = input.topic;
  const patch = input.patch;
  const display: WorkspaceTopicDisplay = { ...topic.display };
  if (patch.title !== undefined) display.title = patch.title;
  if (patch.description === null) delete display.description;
  else if (patch.description !== undefined)
    display.description = patch.description;
  if (patch.channelKind === null) delete display.kind;
  else if (patch.channelKind !== undefined) display.kind = patch.channelKind;
  return {
    ...topic,
    display,
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
    ...(patch.grouping !== undefined ? { grouping: patch.grouping } : {}),
    ...(patch.promptDefaults !== undefined
      ? { promptDefaults: patch.promptDefaults }
      : {}),
    ...(patch.routingDefaults !== undefined
      ? { routingDefaults: patch.routingDefaults }
      : {}),
    ...(patch.linkedRefs !== undefined ? { linkedRefs: patch.linkedRefs } : {}),
    state: {
      ...topic.state,
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.muted !== undefined ? { muted: patch.muted } : {}),
    },
    ...(patch.privacy !== undefined
      ? {
          privacy: {
            ...topic.privacy,
            ...patch.privacy,
            rawDefaultsStored: false,
          },
        }
      : {}),
    updatedAt: input.now,
  };
}

export function archiveWorkspaceTopicRecord(
  topic: WorkspaceTopic,
  now: string
): WorkspaceTopic {
  return {
    ...topic,
    status: 'archived',
    state: { ...topic.state, archivedAt: now },
    updatedAt: now,
  };
}

/** Inverse of archive: reactivate a topic and clear its archivedAt marker. */
export function restoreWorkspaceTopicRecord(
  topic: WorkspaceTopic,
  now: string
): WorkspaceTopic {
  const state = { ...topic.state };
  delete state.archivedAt;
  return {
    ...topic,
    status: 'active',
    state,
    updatedAt: now,
  };
}
