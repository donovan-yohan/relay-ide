import type { WorkflowRunSessionLink } from './workflow-run.js';

export interface OrchestrationLaunchLaneInput {
  role: string;
  provider?: string | undefined;
  agent?: string | undefined;
  nodeId?: string | undefined;
  type?: 'agent' | 'terminal' | undefined;
  mode?: 'pty' | 'web' | undefined;
  cwd?: string | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | undefined;
  initialPrompt?: string | undefined;
  inboxMessage?: string | undefined;
  controlMode?: string | undefined;
  yolo?: boolean | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
}

export interface OrchestrationLaunchInput {
  id?: string | undefined;
  runId?: string | undefined;
  workContextId: string;
  providerRuntime?: string | undefined;
  definition?:
    | {
        hash: string;
        version?: string | undefined;
        templateId?: string | undefined;
      }
    | undefined;
  planner?: WorkflowRunSessionLink | undefined;
  lanes: OrchestrationLaunchLaneInput[];
}

export interface OrchestrationLaunchLaneResult {
  role: string;
  provider: string;
  launched: boolean;
  sessionId?: string | undefined;
  globalSessionId?: string | undefined;
  nodeId?: string | undefined;
  inboxMessageId?: string | undefined;
  failureStage?: 'session-create' | 'message-delivery' | undefined;
  error?: string | undefined;
}

export interface OrchestrationLaunchResult {
  workflowRunId: string;
  runId: string;
  workContextId: string;
  planner?: WorkflowRunSessionLink | undefined;
  children: WorkflowRunSessionLink[];
  lanes: OrchestrationLaunchLaneResult[];
  partialFailure: boolean;
  workflowRun: Record<string, unknown>;
  next: {
    workflowRunCommand: string;
    eventsCommand: string;
  };
}

export interface OrchestrationLaunchDeps {
  now?: () => Date;
  newRunId?: () => string;
  publishWorkflowRun(input: Record<string, unknown>): Promise<unknown>;
  updateWorkflowRun(
    workflowRunId: string,
    input: Record<string, unknown>
  ): Promise<unknown>;
  createSession(input: Record<string, unknown>): Promise<unknown>;
  sendInboxMessage(input: Record<string, unknown>): Promise<unknown>;
}

export class OrchestrationLaunchValidationError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'OrchestrationLaunchValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown orchestration launch error';
}

function responseRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const nested = value[key];
  return isRecord(nested) ? nested : value;
}

function workflowRunFromResponse(value: unknown): Record<string, unknown> {
  return responseRecord(value, 'workflowRun');
}

function sessionFromResponse(value: unknown): Record<string, unknown> {
  return responseRecord(value, 'session');
}

function messageFromResponse(value: unknown): Record<string, unknown> {
  return responseRecord(value, 'message');
}

function requireString(value: unknown, field: string): string {
  const parsed = stringValue(value);
  if (!parsed)
    throw new OrchestrationLaunchValidationError(`${field} is required`, {
      field,
    });
  return parsed;
}

function normalizeInput(value: unknown): OrchestrationLaunchInput {
  if (!isRecord(value)) {
    throw new OrchestrationLaunchValidationError(
      'orchestration launch input must be an object'
    );
  }
  const workContextId = requireString(value['workContextId'], 'workContextId');
  const lanesRaw = value['lanes'];
  if (!Array.isArray(lanesRaw) || lanesRaw.length === 0) {
    throw new OrchestrationLaunchValidationError(
      'lanes must include at least one worker lane',
      { field: 'lanes' }
    );
  }
  const lanes = lanesRaw.map((laneRaw, index) => {
    if (!isRecord(laneRaw)) {
      throw new OrchestrationLaunchValidationError(
        'lanes entries must be objects',
        { field: `lanes[${index}]` }
      );
    }
    const role = requireString(laneRaw['role'], `lanes[${index}].role`);
    const provider = stringValue(laneRaw['provider']);
    const agent = stringValue(laneRaw['agent']);
    const laneType: OrchestrationLaunchLaneInput['type'] =
      laneRaw['type'] === 'terminal' || laneRaw['type'] === 'agent'
        ? (laneRaw['type'] as 'terminal' | 'agent')
        : undefined;
    const laneMode: OrchestrationLaunchLaneInput['mode'] =
      laneRaw['mode'] === 'pty' || laneRaw['mode'] === 'web'
        ? (laneRaw['mode'] as 'pty' | 'web')
        : undefined;
    if (!provider && !agent) {
      throw new OrchestrationLaunchValidationError(
        'lanes entries must include provider or agent',
        { field: `lanes[${index}].provider` }
      );
    }
    return {
      role,
      ...(provider ? { provider } : {}),
      ...(agent ? { agent } : {}),
      ...(stringValue(laneRaw['nodeId'])
        ? { nodeId: stringValue(laneRaw['nodeId']) }
        : {}),
      ...(laneType ? { type: laneType } : {}),
      ...(laneMode ? { mode: laneMode } : {}),
      ...(stringValue(laneRaw['cwd'])
        ? { cwd: stringValue(laneRaw['cwd']) }
        : {}),
      ...(stringValue(laneRaw['repoPath'])
        ? { repoPath: stringValue(laneRaw['repoPath']) }
        : {}),
      ...(stringValue(laneRaw['worktreePath'])
        ? { worktreePath: stringValue(laneRaw['worktreePath']) }
        : {}),
      ...(stringValue(laneRaw['initialPrompt'])
        ? { initialPrompt: stringValue(laneRaw['initialPrompt']) }
        : {}),
      ...(stringValue(laneRaw['inboxMessage'])
        ? { inboxMessage: stringValue(laneRaw['inboxMessage']) }
        : {}),
      ...(stringValue(laneRaw['controlMode'])
        ? { controlMode: stringValue(laneRaw['controlMode']) }
        : {}),
      ...(boolValue(laneRaw['yolo']) !== undefined
        ? { yolo: boolValue(laneRaw['yolo']) }
        : {}),
      ...(numberValue(laneRaw['cols']) !== undefined
        ? { cols: numberValue(laneRaw['cols']) }
        : {}),
      ...(numberValue(laneRaw['rows']) !== undefined
        ? { rows: numberValue(laneRaw['rows']) }
        : {}),
    };
  });

  return {
    workContextId,
    lanes,
    ...(stringValue(value['id']) ? { id: stringValue(value['id']) } : {}),
    ...(stringValue(value['runId'])
      ? { runId: stringValue(value['runId']) }
      : {}),
    ...(stringValue(value['providerRuntime'])
      ? { providerRuntime: stringValue(value['providerRuntime']) }
      : {}),
    ...(isRecord(value['definition'])
      ? {
          definition: {
            hash: requireString(value['definition']['hash'], 'definition.hash'),
            ...(stringValue(value['definition']['version'])
              ? { version: stringValue(value['definition']['version']) }
              : {}),
            ...(stringValue(value['definition']['templateId'])
              ? { templateId: stringValue(value['definition']['templateId']) }
              : {}),
          },
        }
      : {}),
    ...(isRecord(value['planner'])
      ? { planner: value['planner'] as unknown as WorkflowRunSessionLink }
      : {}),
  };
}

function laneSessionBody(
  lane: OrchestrationLaunchLaneInput,
  workContextId: string
): Record<string, unknown> {
  const provider = lane.provider ?? lane.agent;
  const body: Record<string, unknown> = {
    workContextId,
    type: lane.type ?? 'agent',
    ...(provider ? { agent: provider } : {}),
    ...(lane.mode ? { mode: lane.mode } : {}),
    ...(lane.nodeId ? { nodeId: lane.nodeId } : {}),
    ...(lane.cwd ? { cwd: lane.cwd } : {}),
    ...(lane.repoPath ? { repoPath: lane.repoPath } : {}),
    ...(lane.worktreePath ? { worktreePath: lane.worktreePath } : {}),
    ...(lane.initialPrompt ? { initialPrompt: lane.initialPrompt } : {}),
    ...(lane.controlMode ? { controlMode: lane.controlMode } : {}),
    ...(lane.yolo !== undefined ? { yolo: lane.yolo } : {}),
    ...(lane.cols !== undefined ? { cols: lane.cols } : {}),
    ...(lane.rows !== undefined ? { rows: lane.rows } : {}),
  };
  return body;
}

function linkFromSession(
  lane: OrchestrationLaunchLaneInput,
  session: Record<string, unknown>,
  createdAt: string,
  failedMessage: boolean
): WorkflowRunSessionLink {
  const provider = lane.provider ?? lane.agent ?? 'unknown';
  const sessionId =
    stringValue(session['id']) ?? stringValue(session['sessionId']);
  const globalSessionId = stringValue(session['globalSessionId']);
  const nodeId =
    stringValue(session['nodeId']) ??
    stringValue(session['node']) ??
    lane.nodeId;
  return {
    role: lane.role,
    provider,
    ...(sessionId ? { sessionId } : {}),
    ...(globalSessionId ? { globalSessionId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(stringValue(session['displayName'])
      ? { displayName: stringValue(session['displayName']) }
      : {}),
    ...(stringValue(session['cwd'])
      ? { cwd: stringValue(session['cwd']) }
      : {}),
    ...(stringValue(session['repoPath'])
      ? { repoPath: stringValue(session['repoPath']) }
      : lane.repoPath
        ? { repoPath: lane.repoPath }
        : {}),
    ...(stringValue(session['worktreePath'])
      ? { worktreePath: stringValue(session['worktreePath']) }
      : lane.worktreePath
        ? { worktreePath: lane.worktreePath }
        : {}),
    state: failedMessage ? 'waiting' : 'running',
    ...(failedMessage
      ? {
          attention: {
            needsAttention: true,
            reasons: ['message-delivery-failed'],
          },
        }
      : {}),
    createdAt,
  };
}

function requireWorkflowRunId(workflowRun: Record<string, unknown>): string {
  return requireString(workflowRun['id'], 'workflowRun.id');
}

export async function launchOrchestrationRun(
  rawInput: unknown,
  deps: OrchestrationLaunchDeps
): Promise<OrchestrationLaunchResult> {
  const input = normalizeInput(rawInput);
  const now = deps.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const runId =
    input.runId ??
    deps.newRunId?.() ??
    `relay-orchestration:${createdAt.replace(/[:.]/g, '-')}`;
  const definition = input.definition ?? {
    hash: 'relay-orchestration-launch:v0',
    templateId: 'relay/orchestration-launch-v0',
  };
  const published = workflowRunFromResponse(
    await deps.publishWorkflowRun({
      ...(input.id ? { id: input.id } : {}),
      runId,
      providerRuntime: input.providerRuntime ?? 'relay-orchestration',
      runKind: 'relay-orchestration',
      workContextId: input.workContextId,
      definition,
      state: 'running',
      ...(input.planner ? { orchestration: { planner: input.planner } } : {}),
    })
  );
  const workflowRunId = requireWorkflowRunId(published);
  const expectedVersion = numberValue(published['version']);
  const children: WorkflowRunSessionLink[] = [];
  const lanes: OrchestrationLaunchLaneResult[] = [];

  for (const lane of input.lanes) {
    const provider = lane.provider ?? lane.agent ?? 'unknown';
    try {
      const session = sessionFromResponse(
        await deps.createSession(laneSessionBody(lane, input.workContextId))
      );
      let inboxMessageId: string | undefined;
      let failedMessage: string | undefined;
      if (lane.inboxMessage) {
        try {
          const message = messageFromResponse(
            await deps.sendInboxMessage({
              targetSessionId:
                stringValue(session['id']) ?? stringValue(session['sessionId']),
              text: lane.inboxMessage,
              createdBy: 'orchestration-runs.launch',
            })
          );
          inboxMessageId = stringValue(message['id']);
        } catch (error) {
          failedMessage = errorMessage(error);
        }
      }
      const link = linkFromSession(
        lane,
        session,
        createdAt,
        Boolean(failedMessage)
      );
      children.push(link);
      lanes.push({
        role: lane.role,
        provider,
        launched: true,
        ...(link.sessionId ? { sessionId: link.sessionId } : {}),
        ...(link.globalSessionId
          ? { globalSessionId: link.globalSessionId }
          : {}),
        ...(link.nodeId ? { nodeId: link.nodeId } : {}),
        ...(inboxMessageId ? { inboxMessageId } : {}),
        ...(failedMessage
          ? {
              failureStage: 'message-delivery',
              error: failedMessage,
            }
          : {}),
      });
    } catch (error) {
      lanes.push({
        role: lane.role,
        provider,
        launched: false,
        failureStage: 'session-create',
        error: errorMessage(error),
      });
    }
  }

  const partialFailure = lanes.some((lane) => lane.failureStage);
  const updated = workflowRunFromResponse(
    await deps.updateWorkflowRun(workflowRunId, {
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      state: partialFailure ? 'waiting' : 'running',
      ...(partialFailure
        ? {
            errorSummary:
              'one or more orchestration launch lanes need attention',
          }
        : {}),
      orchestration: {
        ...(input.planner ? { planner: input.planner } : {}),
        ...(children.length ? { children } : {}),
      },
    })
  );

  return {
    workflowRunId,
    runId,
    workContextId: input.workContextId,
    ...(input.planner ? { planner: input.planner } : {}),
    children,
    lanes,
    partialFailure,
    workflowRun: updated,
    next: {
      workflowRunCommand: `relay-ide v1 workflow-runs get --id ${workflowRunId} --json`,
      eventsCommand: `relay-ide v1 events subscribe --topic workflow-runs --work-context-id ${input.workContextId} --json`,
    },
  };
}
