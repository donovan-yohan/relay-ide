import type { GlobalSessionId } from './identity.js';
import type { TaskRef, TaskRefKind, WorkContextId } from './work-context.js';

export const WORKFLOW_RUN_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_RUN_STATES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
  'unknown',
] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];
export const WORKFLOW_RUN_KINDS = [
  'provider-runtime',
  'relay-orchestration',
] as const;
export type WorkflowRunKind = (typeof WORKFLOW_RUN_KINDS)[number];

export interface WorkflowRunProgress {
  total?: number;
  completed?: number;
  failed?: number;
  blocked?: number;
}

export interface WorkflowRunNodeSummary {
  id: string;
  label?: string | undefined;
  state?: WorkflowRunState | undefined;
  progress?: WorkflowRunProgress | undefined;
}

export interface WorkflowRunJournalEntry {
  id?: string | undefined;
  type?: string | undefined;
  summary: string;
  occurredAt?: string | undefined;
}

export interface WorkflowRunLinks {
  sessionIds?: string[] | undefined;
  globalSessionIds?: GlobalSessionId[] | undefined;
  artifactIds?: string[] | undefined;
  inboxMessageIds?: string[] | undefined;
  handoffArtifactIds?: string[] | undefined;
  taskRefs?:
    | Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>[]
    | undefined;
}

export interface WorkflowRunSessionAttention {
  needsAttention?: boolean | undefined;
  reasons?: string[] | undefined;
  pendingInboxCount?: number | undefined;
}

export interface WorkflowRunSessionLink {
  role: string;
  sessionId?: string | undefined;
  globalSessionId?: GlobalSessionId | undefined;
  provider?: string | undefined;
  nodeId?: string | undefined;
  displayName?: string | undefined;
  cwd?: string | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | undefined;
  state?: WorkflowRunState | undefined;
  attention?: WorkflowRunSessionAttention | undefined;
  createdAt?: string | undefined;
}

export interface WorkflowRunOrchestration {
  planner?: WorkflowRunSessionLink | undefined;
  children?: WorkflowRunSessionLink[] | undefined;
}

export interface WorkflowRunProjection {
  schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
  id: string;
  runId: string;
  providerRuntime: string;
  runKind?: WorkflowRunKind | undefined;
  workContextId: WorkContextId;
  definition: {
    hash: string;
    version?: string | undefined;
    templateId?: string | undefined;
  };
  state: WorkflowRunState;
  progress?: WorkflowRunProgress | undefined;
  phases?: WorkflowRunNodeSummary[] | undefined;
  steps?: WorkflowRunNodeSummary[] | undefined;
  resultSummary?: string | undefined;
  errorSummary?: string | undefined;
  journal?: WorkflowRunJournalEntry[] | undefined;
  links?: WorkflowRunLinks | undefined;
  orchestration?: WorkflowRunOrchestration | undefined;
  createdAt: string;
  updatedAt: string;
  version: number;
  redaction: {
    rawPayloadStored: false;
    rawTranscriptStored: false;
    providerPrivateStateStored: false;
    truncated: boolean;
    omittedKeys: string[];
  };
}

export interface WorkflowRunPublishInput {
  id?: string | undefined;
  runId: string;
  providerRuntime: string;
  runKind?: WorkflowRunKind | undefined;
  workContextId: WorkContextId;
  definition: WorkflowRunProjection['definition'];
  state?: WorkflowRunState | undefined;
  progress?: WorkflowRunProgress | undefined;
  phases?: WorkflowRunNodeSummary[] | undefined;
  steps?: WorkflowRunNodeSummary[] | undefined;
  resultSummary?: string | undefined;
  errorSummary?: string | undefined;
  journal?: WorkflowRunJournalEntry[] | undefined;
  links?: WorkflowRunLinks | undefined;
  orchestration?: WorkflowRunOrchestration | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface WorkflowRunUpdateInput {
  expectedVersion?: number | undefined;
  state?: WorkflowRunState | undefined;
  progress?: WorkflowRunProgress | undefined;
  phases?: WorkflowRunNodeSummary[] | undefined;
  steps?: WorkflowRunNodeSummary[] | undefined;
  resultSummary?: string | undefined;
  errorSummary?: string | undefined;
  journal?: WorkflowRunJournalEntry[] | undefined;
  links?: WorkflowRunLinks | undefined;
  orchestration?: WorkflowRunOrchestration | undefined;
  updatedAt?: string | undefined;
}

export const WORKFLOW_RUN_SUMMARY_MAX_BYTES = 8 * 1024;
export const WORKFLOW_RUN_JOURNAL_SUMMARY_MAX_BYTES = 2 * 1024;
export const WORKFLOW_RUN_MAX_JOURNAL_ENTRIES = 100;
export const WORKFLOW_RUN_MAX_PHASES = 50;
export const WORKFLOW_RUN_MAX_STEPS = 200;
export const WORKFLOW_RUN_MAX_CHILD_SESSIONS = 50;
export const WORKFLOW_RUN_MAX_ATTENTION_REASONS = 20;

const SECRETISH_KEYS = new Set<string>([
  'rawcontent',
  'rawpayload',
  'rawtranscript',
  'terminaltranscript',
  'transcript',
  'prompt',
  'prompts',
  'messages',
  'secret',
  'secrets',
  'env',
  'token',
  'apikey',
  'api_key',
  'providerauth',
  'providerprivate',
  'providerprivatestate',
  'hermesprofilestate',
  'rawhermesprofilestate',
]);
const TASK_REF_KINDS = new Set<string>([
  'github-issue',
  'github-pr',
  'kanban-task',
  'jira-ticket',
  'linear-issue',
  'external',
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class WorkflowRunValidationError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkflowRunValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringField(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  return optionalString(input[key]);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = stringField(input, key);
  if (!value)
    throw new WorkflowRunValidationError(`${key} is required`, { field: key });
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseState(value: unknown): WorkflowRunState | undefined {
  if (typeof value !== 'string') return undefined;
  return (WORKFLOW_RUN_STATES as readonly string[]).includes(value)
    ? (value as WorkflowRunState)
    : undefined;
}

function parseRunKind(value: unknown): WorkflowRunKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new WorkflowRunValidationError(
      'runKind must be a known WorkflowRunKind',
      {
        field: 'runKind',
      }
    );
  }
  if ((WORKFLOW_RUN_KINDS as readonly string[]).includes(value))
    return value as WorkflowRunKind;
  throw new WorkflowRunValidationError(
    'runKind must be a known WorkflowRunKind',
    {
      field: 'runKind',
    }
  );
}

function truncateUtf8(
  value: string,
  maxBytes: number
): { value: string; truncated: boolean } {
  const encoded = textEncoder.encode(value);
  if (encoded.length <= maxBytes) return { value, truncated: false };
  return {
    value: textDecoder.decode(encoded.slice(0, maxBytes)).replace(/�+$/u, ''),
    truncated: true,
  };
}

function collectForbiddenKeys(
  value: unknown,
  path = '$',
  found: string[] = []
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectForbiddenKeys(item, `${path}[${index}]`, found)
    );
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (SECRETISH_KEYS.has(normalized)) {
      found.push(`${path}.${key}`);
      continue;
    }
    collectForbiddenKeys(child, `${path}.${key}`, found);
  }
  return found;
}

function parseDefinition(value: unknown): WorkflowRunProjection['definition'] {
  if (!isRecord(value)) {
    throw new WorkflowRunValidationError('definition is required', {
      field: 'definition',
    });
  }
  return {
    hash: requireString(value, 'hash'),
    ...(stringField(value, 'version')
      ? { version: stringField(value, 'version') }
      : {}),
    ...(stringField(value, 'templateId')
      ? { templateId: stringField(value, 'templateId') }
      : {}),
  };
}

function parseProgress(value: unknown): WorkflowRunProgress | undefined {
  if (!isRecord(value)) return undefined;
  const progress: WorkflowRunProgress = {};
  for (const key of ['total', 'completed', 'failed', 'blocked'] as const) {
    const parsed = optionalInteger(value[key]);
    if (parsed !== undefined) progress[key] = parsed;
  }
  return Object.keys(progress).length ? progress : undefined;
}

function parseNodeSummaries(
  value: unknown,
  limit: number,
  field: 'phases' | 'steps'
): { items?: WorkflowRunNodeSummary[]; truncated: boolean } {
  if (!Array.isArray(value)) return { truncated: false };
  const truncated = value.length > limit;
  const items: WorkflowRunNodeSummary[] = [];
  for (const entry of value.slice(0, limit)) {
    if (!isRecord(entry)) continue;
    const id = stringField(entry, 'id');
    if (!id) {
      throw new WorkflowRunValidationError(
        `${field} entries must include string id`,
        { field }
      );
    }
    const progress = parseProgress(entry['progress']);
    const state = parseState(entry['state']);
    const item: WorkflowRunNodeSummary = {
      id,
      ...(stringField(entry, 'label')
        ? { label: stringField(entry, 'label') }
        : {}),
      ...(state ? { state } : {}),
      ...(progress ? { progress } : {}),
    };
    items.push(item);
  }
  return items.length ? { items, truncated } : { truncated };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  return strings.length ? strings : undefined;
}

function parseAttention(value: unknown): {
  attention?: WorkflowRunSessionAttention;
  truncated: boolean;
} {
  if (!isRecord(value)) return { truncated: false };
  const attention: WorkflowRunSessionAttention = {};
  if (typeof value['needsAttention'] === 'boolean')
    attention.needsAttention = value['needsAttention'];
  const pendingInboxCount = optionalInteger(value['pendingInboxCount']);
  if (pendingInboxCount !== undefined)
    attention.pendingInboxCount = pendingInboxCount;
  const reasonsRaw = parseStringArray(value['reasons']);
  const truncated =
    (reasonsRaw?.length ?? 0) > WORKFLOW_RUN_MAX_ATTENTION_REASONS;
  const reasons = reasonsRaw?.slice(0, WORKFLOW_RUN_MAX_ATTENTION_REASONS);
  if (reasons?.length) attention.reasons = reasons;
  return Object.keys(attention).length
    ? { attention, truncated }
    : { truncated };
}

function parseSessionLink(
  value: unknown,
  field: string
): { link?: WorkflowRunSessionLink; truncated: boolean } {
  if (!isRecord(value)) return { truncated: false };
  const role = stringField(value, 'role');
  if (!role) {
    throw new WorkflowRunValidationError(
      `${field} session links must include string role`,
      {
        field,
      }
    );
  }
  const sessionId = stringField(value, 'sessionId');
  const globalSessionId = stringField(value, 'globalSessionId') as
    | GlobalSessionId
    | undefined;
  if (!sessionId && !globalSessionId) {
    throw new WorkflowRunValidationError(
      `${field} session links must include sessionId or globalSessionId`,
      { field }
    );
  }
  const state = parseState(value['state']);
  if (value['state'] !== undefined && !state) {
    throw new WorkflowRunValidationError(
      `${field} session link state must be known`,
      {
        field,
      }
    );
  }
  const attention = parseAttention(value['attention']);
  const link: WorkflowRunSessionLink = {
    role,
    ...(sessionId ? { sessionId } : {}),
    ...(globalSessionId ? { globalSessionId } : {}),
    ...(stringField(value, 'provider')
      ? { provider: stringField(value, 'provider') }
      : {}),
    ...(stringField(value, 'nodeId')
      ? { nodeId: stringField(value, 'nodeId') }
      : {}),
    ...(stringField(value, 'displayName')
      ? { displayName: stringField(value, 'displayName') }
      : {}),
    ...(stringField(value, 'cwd') ? { cwd: stringField(value, 'cwd') } : {}),
    ...(stringField(value, 'repoPath')
      ? { repoPath: stringField(value, 'repoPath') }
      : {}),
    ...(stringField(value, 'worktreePath')
      ? { worktreePath: stringField(value, 'worktreePath') }
      : {}),
    ...(state ? { state } : {}),
    ...(attention.attention ? { attention: attention.attention } : {}),
    ...(stringField(value, 'createdAt')
      ? { createdAt: stringField(value, 'createdAt') }
      : {}),
  };
  return { link, truncated: attention.truncated };
}

function parseOrchestration(value: unknown): {
  orchestration?: WorkflowRunOrchestration;
  truncated: boolean;
} {
  if (!isRecord(value)) return { truncated: false };
  const planner = parseSessionLink(value['planner'], 'orchestration.planner');
  let truncated = planner.truncated;
  const childrenRaw = value['children'];
  let children: WorkflowRunSessionLink[] | undefined;
  if (childrenRaw !== undefined) {
    if (!Array.isArray(childrenRaw)) {
      throw new WorkflowRunValidationError(
        'orchestration.children must be an array',
        {
          field: 'orchestration.children',
        }
      );
    }
    truncated =
      truncated || childrenRaw.length > WORKFLOW_RUN_MAX_CHILD_SESSIONS;
    children = [];
    for (const entry of childrenRaw.slice(0, WORKFLOW_RUN_MAX_CHILD_SESSIONS)) {
      const child = parseSessionLink(entry, 'orchestration.children');
      truncated = truncated || child.truncated;
      if (child.link) children.push(child.link);
    }
  }
  const orchestration: WorkflowRunOrchestration = {
    ...(planner.link ? { planner: planner.link } : {}),
    ...(children?.length ? { children } : {}),
  };
  return Object.keys(orchestration).length
    ? { orchestration, truncated }
    : { truncated };
}

function parseTaskRefs(
  value: unknown
): WorkflowRunLinks['taskRefs'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: NonNullable<WorkflowRunLinks['taskRefs']> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const kind = stringField(entry, 'kind');
    const id = stringField(entry, 'id');
    if (!kind || !id || !TASK_REF_KINDS.has(kind)) continue;
    const ref: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'> = {
      kind: kind as TaskRefKind,
      id,
    };
    const title = stringField(entry, 'title');
    const url = stringField(entry, 'url');
    const status = stringField(entry, 'status');
    if (title) ref.title = title;
    if (url) ref.url = url;
    if (status) ref.status = status;
    refs.push(ref);
  }
  return refs.length ? refs : undefined;
}

function parseLinks(value: unknown): WorkflowRunLinks | undefined {
  if (!isRecord(value)) return undefined;
  const links: WorkflowRunLinks = {};
  const fields = [
    ['sessionIds', parseStringArray(value['sessionIds'])],
    ['globalSessionIds', parseStringArray(value['globalSessionIds'])],
    ['artifactIds', parseStringArray(value['artifactIds'])],
    ['inboxMessageIds', parseStringArray(value['inboxMessageIds'])],
    ['handoffArtifactIds', parseStringArray(value['handoffArtifactIds'])],
  ] as const;
  for (const [key, values] of fields) {
    if (values?.length) links[key] = values;
  }
  const taskRefs = parseTaskRefs(value['taskRefs']);
  if (taskRefs?.length) links.taskRefs = taskRefs;
  return Object.keys(links).length ? links : undefined;
}

function parseJournal(value: unknown): {
  journal?: WorkflowRunJournalEntry[];
  truncated: boolean;
} {
  if (!Array.isArray(value)) return { truncated: false };
  let truncated = value.length > WORKFLOW_RUN_MAX_JOURNAL_ENTRIES;
  const journal: WorkflowRunJournalEntry[] = [];
  for (const entry of value.slice(0, WORKFLOW_RUN_MAX_JOURNAL_ENTRIES)) {
    if (!isRecord(entry)) continue;
    const summaryRaw = optionalString(entry['summary']);
    if (!summaryRaw) {
      throw new WorkflowRunValidationError(
        'journal entries must include string summary',
        {
          field: 'journal',
        }
      );
    }
    const summary = truncateUtf8(
      summaryRaw,
      WORKFLOW_RUN_JOURNAL_SUMMARY_MAX_BYTES
    );
    truncated = truncated || summary.truncated;
    journal.push({
      summary: summary.value,
      ...(stringField(entry, 'id') ? { id: stringField(entry, 'id') } : {}),
      ...(stringField(entry, 'type')
        ? { type: stringField(entry, 'type') }
        : {}),
      ...(stringField(entry, 'occurredAt')
        ? { occurredAt: stringField(entry, 'occurredAt') }
        : {}),
    });
  }
  return journal.length ? { journal, truncated } : { truncated };
}

function parseProjectionParts(input: Record<string, unknown>): {
  partial: Omit<WorkflowRunUpdateInput, 'expectedVersion'>;
  truncated: boolean;
  omittedKeys: string[];
} {
  const omittedKeys = collectForbiddenKeys(input);
  if (omittedKeys.length > 0) {
    throw new WorkflowRunValidationError(
      'workflow run payload contains forbidden raw/private fields',
      {
        omittedKeys,
      }
    );
  }
  let truncated = false;
  const resultSummary = optionalString(input['resultSummary'])
    ? truncateUtf8(
        input['resultSummary'] as string,
        WORKFLOW_RUN_SUMMARY_MAX_BYTES
      )
    : undefined;
  const errorSummary = optionalString(input['errorSummary'])
    ? truncateUtf8(
        input['errorSummary'] as string,
        WORKFLOW_RUN_SUMMARY_MAX_BYTES
      )
    : undefined;
  truncated =
    truncated || Boolean(resultSummary?.truncated || errorSummary?.truncated);
  const phases = parseNodeSummaries(
    input['phases'],
    WORKFLOW_RUN_MAX_PHASES,
    'phases'
  );
  const steps = parseNodeSummaries(
    input['steps'],
    WORKFLOW_RUN_MAX_STEPS,
    'steps'
  );
  const journal = parseJournal(input['journal']);
  truncated =
    truncated || phases.truncated || steps.truncated || journal.truncated;
  const state = parseState(input['state']);
  if (input['state'] !== undefined && !state) {
    throw new WorkflowRunValidationError(
      'state must be a known WorkflowRunState',
      { field: 'state' }
    );
  }
  const progress = parseProgress(input['progress']);
  const links = parseLinks(input['links']);
  const orchestration = parseOrchestration(input['orchestration']);
  truncated = truncated || orchestration.truncated;
  return {
    partial: {
      ...(state ? { state } : {}),
      ...(progress ? { progress } : {}),
      ...(phases.items ? { phases: phases.items } : {}),
      ...(steps.items ? { steps: steps.items } : {}),
      ...(resultSummary ? { resultSummary: resultSummary.value } : {}),
      ...(errorSummary ? { errorSummary: errorSummary.value } : {}),
      ...(journal.journal ? { journal: journal.journal } : {}),
      ...(links ? { links } : {}),
      ...(orchestration.orchestration
        ? { orchestration: orchestration.orchestration }
        : {}),
      ...(stringField(input, 'updatedAt')
        ? { updatedAt: stringField(input, 'updatedAt') }
        : {}),
    },
    truncated,
    omittedKeys,
  };
}

export function parseWorkflowRunPublishInput(
  value: unknown
): WorkflowRunPublishInput & {
  redaction: WorkflowRunProjection['redaction'];
} {
  if (!isRecord(value)) {
    throw new WorkflowRunValidationError(
      'workflow run publish payload must be an object'
    );
  }
  const parts = parseProjectionParts(value);
  const parsedRunKind = parseRunKind(value['runKind']);
  if (parts.partial.orchestration && parsedRunKind === 'provider-runtime') {
    throw new WorkflowRunValidationError(
      'runKind must be relay-orchestration when orchestration is present',
      { field: 'runKind' }
    );
  }
  const runKind = parts.partial.orchestration
    ? 'relay-orchestration'
    : parsedRunKind;
  return {
    runId: requireString(value, 'runId'),
    providerRuntime: requireString(value, 'providerRuntime'),
    ...(runKind ? { runKind } : {}),
    workContextId: requireString(value, 'workContextId'),
    definition: parseDefinition(value['definition']),
    ...(stringField(value, 'id') ? { id: stringField(value, 'id') } : {}),
    state: parts.partial.state ?? 'queued',
    ...(parts.partial.progress ? { progress: parts.partial.progress } : {}),
    ...(parts.partial.phases ? { phases: parts.partial.phases } : {}),
    ...(parts.partial.steps ? { steps: parts.partial.steps } : {}),
    ...(parts.partial.resultSummary
      ? { resultSummary: parts.partial.resultSummary }
      : {}),
    ...(parts.partial.errorSummary
      ? { errorSummary: parts.partial.errorSummary }
      : {}),
    ...(parts.partial.journal ? { journal: parts.partial.journal } : {}),
    ...(parts.partial.links ? { links: parts.partial.links } : {}),
    ...(parts.partial.orchestration
      ? { orchestration: parts.partial.orchestration }
      : {}),
    ...(stringField(value, 'createdAt')
      ? { createdAt: stringField(value, 'createdAt') }
      : {}),
    ...(parts.partial.updatedAt ? { updatedAt: parts.partial.updatedAt } : {}),
    redaction: {
      rawPayloadStored: false,
      rawTranscriptStored: false,
      providerPrivateStateStored: false,
      truncated: parts.truncated,
      omittedKeys: parts.omittedKeys,
    },
  };
}

export function parseWorkflowRunUpdateInput(
  value: unknown
): WorkflowRunUpdateInput & {
  redactionPatch: Pick<
    WorkflowRunProjection['redaction'],
    'truncated' | 'omittedKeys'
  >;
} {
  if (!isRecord(value)) {
    throw new WorkflowRunValidationError(
      'workflow run update payload must be an object'
    );
  }
  const parts = parseProjectionParts(value);
  const expectedVersion = optionalInteger(value['expectedVersion']);
  return {
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    ...parts.partial,
    redactionPatch: {
      truncated: parts.truncated,
      omittedKeys: parts.omittedKeys,
    },
  };
}

export function workflowRunSummaryPayload(
  run: WorkflowRunProjection
): Record<string, unknown> {
  const orchestrationSessions = [
    ...(run.orchestration?.planner ? [run.orchestration.planner] : []),
    ...(run.orchestration?.children ?? []),
  ];
  const childSessions = run.orchestration?.children ?? [];
  const plannerSessionId = run.orchestration?.planner?.sessionId;
  const plannerGlobalSessionId = run.orchestration?.planner?.globalSessionId;
  return {
    workflowRunId: run.id,
    runId: run.runId,
    providerRuntime: run.providerRuntime,
    ...(run.runKind ? { runKind: run.runKind } : {}),
    workContextId: run.workContextId,
    state: run.state,
    version: run.version,
    updatedAt: run.updatedAt,
    ...(plannerSessionId ? { plannerSessionId } : {}),
    ...(plannerGlobalSessionId ? { plannerGlobalSessionId } : {}),
    participantSessionIds: orchestrationSessions.flatMap((link) =>
      link.sessionId ? [link.sessionId] : []
    ),
    participantGlobalSessionIds: orchestrationSessions.flatMap((link) =>
      link.globalSessionId ? [link.globalSessionId] : []
    ),
    childSessionIds: childSessions.flatMap((link) =>
      link.sessionId ? [link.sessionId] : []
    ),
    childGlobalSessionIds: childSessions.flatMap((link) =>
      link.globalSessionId ? [link.globalSessionId] : []
    ),
    childCount: run.orchestration?.children?.length ?? 0,
    artifactIds: run.links?.artifactIds ?? [],
    inboxMessageIds: run.links?.inboxMessageIds ?? [],
    handoffArtifactIds: run.links?.handoffArtifactIds ?? [],
    taskRefs: run.links?.taskRefs ?? [],
  };
}
