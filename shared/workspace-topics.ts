import type { NodeId } from './identity.js';
import type { WorkspaceId } from './workspace.js';
import type { ArtifactId, TaskRef, WorkContextId } from './work-context.js';

// Workspace topics (#1022): typed backend/shared foundation for the
// Discord-replacement topic/workspace ladder. Topics are organization and launch
// defaults, not transcript warehouses. They link to existing WorkContext,
// session, task, artifact, repo/worktree, and WorkspaceSurface identities by ref.
// Surface metadata stays in WorkspaceSurface records; topics only carry surface ids.

export const WORKSPACE_TOPIC_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_TOPICS_MAX_LIST_ENTRIES = 200;
export const WORKSPACE_TOPICS_SEARCH_DEFAULT_LIMIT = 20;
export const WORKSPACE_TOPICS_SEARCH_MAX_RESULTS = 50;
export const WORKSPACE_TOPICS_SEARCH_QUERY_MAX = 160;
export const WORKSPACE_TOPIC_TITLE_MAX = 160;
export const WORKSPACE_TOPIC_DESCRIPTION_MAX = 2000;
export const WORKSPACE_TOPIC_PROMPT_MAX = 4000;
export const WORKSPACE_TOPIC_REF_MAX = 256;
export const WORKSPACE_TOPIC_PATH_MAX = 4096;
export const WORKSPACE_TOPIC_MAX_REFS = 100;

export type WorkspaceTopicId = string;
export type WorkspaceTopicStatus = 'active' | 'archived';
export type WorkspaceTopicVisibility = 'default' | 'private' | 'shared';
export type WorkspaceTopicSource = 'persisted' | 'derived';
export type WorkspaceTopicPrivacyClass = 'public' | 'internal' | 'sensitive';
export type WorkspaceTopicRetentionClass =
  | 'ephemeral'
  | 'session'
  | 'project'
  | 'audit';
export type WorkspaceTopicRedactionStrategy =
  | 'none'
  | 'summary'
  | 'hash'
  | 'omitted';
export type WorkspaceTopicMutationKind = 'create' | 'update' | 'archive';

export const WORKSPACE_TOPIC_DEFAULT_PRECEDENCE = [
  'explicit-spawn-input',
  'session-override',
  'topic-defaults',
  'workspace-defaults',
  'repo-project-defaults',
  'agent-profile-defaults',
  'provider-runtime-defaults',
] as const;
export type WorkspaceTopicDefaultPrecedence =
  (typeof WORKSPACE_TOPIC_DEFAULT_PRECEDENCE)[number];

export interface WorkspaceTopicPrivacyMetadata {
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

export const WORKSPACE_TOPIC_CHANNEL_KINDS: readonly WorkspaceTopicChannelKind[] =
  ['repo', 'product-area', 'journal', 'ops', 'research', 'topic'] as const;

export function isWorkspaceTopicChannelKind(
  value: unknown
): value is WorkspaceTopicChannelKind {
  return (
    typeof value === 'string' &&
    (WORKSPACE_TOPIC_CHANNEL_KINDS as readonly string[]).includes(value)
  );
}

export interface WorkspaceTopicDisplay {
  title: string;
  description?: string;
  icon?: string;
  color?: string;
  /** Optional channel taxonomy (repo/product-area/journal/ops/research/topic). */
  kind?: WorkspaceTopicChannelKind;
}

export interface WorkspaceTopicGrouping {
  parentTopicId?: WorkspaceTopicId;
  order?: number;
}

export interface WorkspaceTopicPromptDefaults {
  starterPrompt?: string;
  systemPrompt?: string;
  instructions?: string;
  contextPacketIds?: string[];
}

export interface WorkspaceTopicRoutingDefaults {
  providerId?: string;
  agentId?: string;
  nodeId?: NodeId;
  repoPath?: string;
  worktreePath?: string;
  cwd?: string;
}

export interface WorkspaceTopicLinkedRefs {
  workContextIds?: WorkContextId[];
  sessionIds?: string[];
  taskRefs?: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>[];
  artifactIds?: ArtifactId[];
  /** WorkspaceSurface ids from shared/workspace-surfaces.ts. No duplicated surface fields. */
  workspaceSurfaceIds?: string[];
}

export interface WorkspaceTopicState {
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

export type WorkspaceTopicSearchMatchKind =
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

export interface WorkspaceTopicSearchAction {
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

export type WorkspaceTopicLaunchOverrides = Record<string, unknown>;

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

export interface WorkspaceTopicLaunchPreviewInput {
  create: WorkspaceTopicCreateInput;
  intent: WorkspaceTopicLaunchIntent;
  templateKind?: WorkspaceTopicTemplateKind;
  launchOverrides?: WorkspaceTopicLaunchOverrides;
}

export interface WorkspaceTopicLaunchPreview {
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
  const sideEffects = [
    'create WorkspaceTopic room',
    create.linkedRefs?.workContextIds?.length
      ? 'link existing WorkContext ref'
      : 'create WorkContext link for this room',
    input.intent === 'create-and-launch'
      ? 'launch provider-neutral session through sessions.create'
      : undefined,
    input.intent === 'create-and-launch'
      ? 'link created session back to WorkspaceTopic/WorkContext'
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return {
    intent: input.intent,
    templateKind: input.templateKind ?? 'agent-task',
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
const BUILTIN_PROVIDER_IDS = new Set([
  'claude',
  'codex',
  'opencode',
  'hermes',
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
  const workspaceId = readRequiredString(
    record['workspaceId'],
    'workspaceId',
    WORKSPACE_TOPIC_REF_MAX
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

export interface WorkspaceTopicDefaultsInput {
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

function readLaunchBoolean(
  overrides: WorkspaceTopicLaunchOverrides,
  key: string
): boolean | undefined {
  const value = overrides[key];
  return typeof value === 'boolean' ? value : undefined;
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

function topicPromptForSession(topic: WorkspaceTopic): string | undefined {
  const parts = [
    topic.promptDefaults.starterPrompt,
    topic.promptDefaults.instructions,
  ].filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0
  );
  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * Build the existing `sessions.create` body for a WorkspaceTopic launch.
 *
 * This deliberately projects Topic defaults into Relay's provider/session
 * primitives instead of creating a Hermes-only launch fork. In the v1 local
 * sessions API `cwd` is represented by `worktreePath`, so a topic-level cwd
 * that differs from repoPath becomes the session worktree/cwd field unless an
 * explicit worktreePath override is supplied.
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
  const explicitProvider = readLaunchString(overrides, 'agent');
  if (explicitProvider) explicitSpawnInput.providerId = explicitProvider;
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
  const agent = routing.providerId;
  if (agent) body['agent'] = agent;
  if (routing.nodeId) body['nodeId'] = routing.nodeId;
  for (const key of [
    'type',
    'mode',
    'terminalBackend',
    'branchName',
    'continuePolicy',
    'controlMode',
  ]) {
    const value = readLaunchString(overrides, key);
    if (value) body[key] = value;
  }
  const yolo = readLaunchBoolean(overrides, 'yolo');
  if (yolo !== undefined) body['yolo'] = yolo;
  for (const key of ['cols', 'rows']) {
    const value = readLaunchNumber(overrides, key);
    if (value !== undefined) body[key] = value;
  }
  const workContextId =
    readLaunchString(overrides, 'workContextId') ??
    input.topic.linkedRefs.workContextIds?.[0];
  if (workContextId) body['workContextId'] = workContextId;
  const initialPrompt =
    readLaunchString(overrides, 'initialPrompt') ??
    topicPromptForSession(input.topic);
  if (initialPrompt) body['initialPrompt'] = initialPrompt;
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

export function buildWorkspaceTopicRecord(input: {
  create: WorkspaceTopicCreateInput;
  now: string;
}): WorkspaceTopic {
  const id =
    input.create.id ??
    createWorkspaceTopicId(input.create.title, input.create.workspaceId);
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
