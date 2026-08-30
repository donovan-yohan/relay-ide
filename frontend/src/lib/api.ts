import type { WorkbenchLayout } from '../../../shared/workbench-layout-types.js';
import type { AgentRole } from '../../../shared/agent-roster.js';
import type {
  AnchorRef,
  AnchorState,
  ArtifactPacketRef,
  ContextPacket,
  ContextPacketBinding,
  ContextPacketKind,
  ContextPacketId,
  SessionInboxMessage,
  SessionInboxMessageId,
} from '../../../shared/context-packet.js';
import type {
  FileRpcListRequest,
  FileRpcListResponse,
  FileRpcReadResponse,
  FileRpcStatResponse,
  FileRpcTailResponse,
  FileRpcWriteResponse,
} from '../../../shared/file-rpc.js';
import type {
  WorkspaceEvidenceErrorResponse,
  WorkspaceEvidenceListRequest,
  WorkspaceEvidenceListResponse,
  WorkspaceEvidencePreviewRequest,
  WorkspaceEvidencePreviewResponse,
  WorkspaceEvidenceReadRequest,
  WorkspaceEvidenceReadResponse,
  WorkspaceEvidenceRoot,
  WorkspaceEvidenceStatRequest,
  WorkspaceEvidenceStatResponse,
} from '../../../shared/workspace-evidence.js';
import type {
  WorkspaceSurface,
  WorkspaceSurfaceListResponse,
} from '../../../shared/workspace-surfaces.js';
import {
  parseWorkspaceTopicConflictDetails,
  type WorkspaceTopic,
  type WorkspaceTopicCreateInput,
  type WorkspaceTopicListResponse,
  type WorkspaceTopicSearchResponse,
  type WorkspaceTopicUpdateInput,
} from '../../../shared/workspace-topics.js';
import type {
  ChannelImagePart,
  ChannelMention,
  ChannelMessage,
  ChannelMessageId,
  ChannelMessagePart,
  ChannelMessageSearchResponse,
  ChannelMessageSearchResult,
  ChannelReadStateEntry,
  ChannelReadStateResponse,
  ChannelReadStateUpdateRequest,
  ChannelReadStateUpdateResponse,
} from '../../../shared/channel-chat-protocol.js';
import type { AgentSlashCommandV2 } from '../../../shared/agent-chat-protocol-v2.js';
import type {
  WorkflowRunProjection,
  WorkflowRunState,
} from '../../../shared/workflow-run.js';
import type {
  PipelineHandoffArtifact,
  PipelineHandoffStageName,
} from '../../../shared/pipeline-handoff-artifact.js';
import type { ViewArtifactPackage } from '../../../shared/agent-view-artifact.js';
import type {
  AgentProfile,
  AgentProfileRespondTo,
} from '../../../shared/agent-profile.js';
import type { TaskRef, WorkContext } from '../../../shared/work-context.js';
import type {
  PipelineHandoffArtifactEnvelope,
  PublicPipelineHandoffArtifactSummary,
} from './pipeline-handoff-timeline.js';
import type {
  SessionSummary,
  WorktreeInfo,
  Repo,
  DashboardData,
  CiStatus,
  PrInfo,
  PullRequest,
  ActivityEntry,
  WorkspaceSettings,
  OrgPrsResponse,
  GitHubIssuesResponse,
  BranchLinksResponse,
  JiraIssuesResponse,
  JiraStatus,
  FilterPreset,
  BranchInfo,
  Workspace,
  ChangedFilesResponse,
  FileDiffResponse,
  SessionTelemetry,
  AccountTelemetry,
  AnalyticsOverview,
  AnalyticsSessionsResponse,
  AnalyticsSessionDetail,
  AnalyticsTrend,
  AnalyticsToolBreakdown,
  AnalyticsRateLimitHistory,
  FrameworkInfo,
  BranchDivergenceSummary,
  AggregatedRepoInventoryResponse,
  WorkContextActiveGroup,
} from './types.js';
import type {
  HubNodeCredentialRotationSummary,
  HubNodeSummary,
} from '../../../shared/relay-node-protocol.js';
import type {
  NodePairingRequestSummary,
  NodePairingTrustProfile,
} from '../../../shared/node-pairing-requests.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  parseGlobalSessionId,
  type NodeId,
} from '../../../shared/identity.js';
import type { SessionLane } from '../../../shared/session-lane.js';
import type { InterventionRecord } from '../../../shared/control-state.js';
import type {
  CommandCenterExecutionConfirmationInput,
  CommandCenterExecutionResult,
} from '../../../shared/command-center-execution.js';
import type { CommandCenterAssistantResult } from './command-center-assistant.js';
import { registerConfirmationRetry } from './confirmation-retries.js';

export class ConflictError extends Error {
  sessionId: string;
  constructor(sessionId: string) {
    super('conflict');
    this.name = 'ConflictError';
    this.sessionId = sessionId;
  }
}

export class HttpError extends Error {
  status: number;
  code: string | undefined;
  retryable: boolean | undefined;
  details: Record<string, unknown> | undefined;
  workspaceEvidence: WorkspaceEvidenceErrorResponse | undefined;
  constructor(
    status: number,
    message = httpErrorMessage(status),
    code?: string | undefined,
    retryable?: boolean | undefined,
    details?: Record<string, unknown> | undefined,
    workspaceEvidence?: WorkspaceEvidenceErrorResponse | undefined
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.workspaceEvidence = workspaceEvidence;
  }
}

export interface CanonicalConfirmationParams {
  action: string;
  [key: string]: unknown;
}

export type ConfirmationDecision = 'approve' | 'deny' | 'deny_revoke';
export type ConfirmationChallengeStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired'
  | 'redeemed'
  | 'invalidated';

export interface ConfirmationChallenge {
  challengeId: string;
  status: ConfirmationChallengeStatus;
  nodeId: string;
  intent: { action: string; target?: string };
  requiredBits: string[];
  challengeBits: string[];
  sessionId?: string;
  canonicalParams: CanonicalConfirmationParams;
  canonicalParamsHash: string;
  requesterDisplayName?: string;
  approverDisplayName?: string;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  tokenExpiresAt?: string;
  failedRedemptions: number;
  maxFailedRedemptions: number;
  reasonCode: string;
  message: string;
}

export class ConfirmationRequiredError extends HttpError {
  challenge: ConfirmationChallenge;
  constructor(error: HttpError, challenge: ConfirmationChallenge) {
    super(
      error.status,
      error.message,
      error.code,
      error.retryable,
      error.details,
      error.workspaceEvidence
    );
    this.name = 'ConfirmationRequiredError';
    this.challenge = challenge;
  }
}

function httpErrorMessage(status: number, fallback?: string): string {
  if (status === 502) {
    return 'Relay backend is unavailable (HTTP 502). The server may be restarting; try again in a moment.';
  }
  if (status === 503 || status === 504) {
    return `Relay backend is unavailable (HTTP ${status}). Try again in a moment.`;
  }
  return fallback ?? `HTTP ${status}`;
}

const BROWSER_SESSION_AUTH_MESSAGE =
  'browser session required; enter the browser PIN for this web UI.';
const SCOPED_ACTOR_AUTH_MESSAGE =
  'scoped actor credential required; browser PIN auth only unlocks the web UI.';
const SCOPED_OR_BROWSER_AUTH_MESSAGE =
  'scoped actor credential or browser session required for this route.';
const NODE_CREDENTIAL_AUTH_MESSAGE =
  'node credential required; browser PIN sessions are not accepted by node routes.';
const PAIR_TOKEN_AUTH_MESSAGE =
  'pair token required; browser PIN sessions are not accepted by pairing routes.';
const CAPABILITY_DENIED_AUTH_MESSAGE =
  'capability denied; this actor or session is missing the required grant.';
const APPROVAL_REQUIRED_AUTH_MESSAGE =
  'approval required before this action can continue.';
const CREDENTIAL_REVOKED_AUTH_MESSAGE =
  'credential revoked; re-authorize the relevant actor or node.';
const CREDENTIAL_EXPIRED_AUTH_MESSAGE =
  'credential expired; re-authenticate the relevant actor or node.';

const AUTH_LANE_ERROR_MESSAGES: Record<string, string> = {
  'browser-auth-required': BROWSER_SESSION_AUTH_MESSAGE,
  'browser-session-required': BROWSER_SESSION_AUTH_MESSAGE,
  browser_auth_required: BROWSER_SESSION_AUTH_MESSAGE,
  browser_session_required: BROWSER_SESSION_AUTH_MESSAGE,
  BROWSER_SESSION_REQUIRED: BROWSER_SESSION_AUTH_MESSAGE,

  'actor-credential-required': SCOPED_ACTOR_AUTH_MESSAGE,
  'scoped-actor-credential-required': SCOPED_ACTOR_AUTH_MESSAGE,
  actor_credential_required: SCOPED_ACTOR_AUTH_MESSAGE,
  scoped_actor_credential_required: SCOPED_ACTOR_AUTH_MESSAGE,
  'scoped-session-or-browser-auth-required': SCOPED_OR_BROWSER_AUTH_MESSAGE,
  CLI_GATEWAY_OR_BROWSER_AUTH_REQUIRED: SCOPED_OR_BROWSER_AUTH_MESSAGE,
  SCOPED_SESSION_OR_BROWSER_AUTH_REQUIRED: SCOPED_OR_BROWSER_AUTH_MESSAGE,

  'node-credential-required': NODE_CREDENTIAL_AUTH_MESSAGE,
  node_credential_required: NODE_CREDENTIAL_AUTH_MESSAGE,
  NODE_CREDENTIAL_REQUIRED: NODE_CREDENTIAL_AUTH_MESSAGE,

  'pair-token-required': PAIR_TOKEN_AUTH_MESSAGE,
  pair_token_required: PAIR_TOKEN_AUTH_MESSAGE,
  PAIR_TOKEN_REQUIRED: PAIR_TOKEN_AUTH_MESSAGE,

  'capability-denied': CAPABILITY_DENIED_AUTH_MESSAGE,
  capability_denied: CAPABILITY_DENIED_AUTH_MESSAGE,
  CAPABILITY_DENIED: CAPABILITY_DENIED_AUTH_MESSAGE,

  'approval-required': APPROVAL_REQUIRED_AUTH_MESSAGE,
  approval_required: APPROVAL_REQUIRED_AUTH_MESSAGE,
  APPROVAL_REQUIRED: APPROVAL_REQUIRED_AUTH_MESSAGE,

  'credential-revoked': CREDENTIAL_REVOKED_AUTH_MESSAGE,
  credential_revoked: CREDENTIAL_REVOKED_AUTH_MESSAGE,
  CREDENTIAL_REVOKED: CREDENTIAL_REVOKED_AUTH_MESSAGE,

  'credential-expired': CREDENTIAL_EXPIRED_AUTH_MESSAGE,
  credential_expired: CREDENTIAL_EXPIRED_AUTH_MESSAGE,
  CREDENTIAL_EXPIRED: CREDENTIAL_EXPIRED_AUTH_MESSAGE,
};

export function authLaneErrorMessage(
  code: string | undefined,
  fallback: string
): string {
  if (!code) return fallback;
  const normalized = code.trim();
  return (
    AUTH_LANE_ERROR_MESSAGES[normalized] ??
    AUTH_LANE_ERROR_MESSAGES[normalized.toLowerCase()] ??
    AUTH_LANE_ERROR_MESSAGES[normalized.toLowerCase().replace(/_/g, '-')] ??
    fallback
  );
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasChildren: boolean;
  isDirectory?: boolean;
  size?: number;
}

export interface BrowseResponse {
  resolved: string;
  entries: BrowseEntry[];
  truncated: boolean;
  total: number;
}

/** Create one direct child directory for the local Add Project browser. */
export async function createWorkspaceFolder(
  parentPath: string,
  name: string
): Promise<BrowseEntry> {
  return json<BrowseEntry>(
    await fetch('/workspaces/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath, name }),
    })
  );
}

export async function resolveCommandCenterAssistantIntent(
  query: string
): Promise<CommandCenterAssistantResult> {
  return json<CommandCenterAssistantResult>(
    await fetch('/api/command-center/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
  );
}

export async function executeCommandCenterAssistantCommand(
  commandId: string,
  args: Record<string, unknown>,
  options: {
    confirmation?: CommandCenterExecutionConfirmationInput;
  } = {}
): Promise<CommandCenterExecutionResult> {
  return json<CommandCenterExecutionResult>(
    await fetch('/api/command-center/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, args, ...options }),
    })
  );
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await httpErrorFromResponse(res);
  return res.json() as Promise<T>;
}

const CONTEXT_INBOX_CAPABILITIES =
  'context:read,context:write,inbox:read,inbox:write';

function contextInboxHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-relay-capabilities': CONTEXT_INBOX_CAPABILITIES,
  };
}

export type DecoratedContextPacket = ContextPacket & {
  anchorState?: AnchorState;
};

export type DecoratedInboxMessage = SessionInboxMessage & {
  contextPackets?: DecoratedContextPacket[];
};

export interface CreateContextPacketRequest {
  kind: ContextPacketKind;
  anchor?: AnchorRef;
  /** Set for `artifact-ref` (#898): ref-only pointer to a WorkContext artifact. */
  artifactRef?: ArtifactPacketRef;
  note?: string;
  binding?: ContextPacketBinding;
  createdBy?: string;
}

export async function createContextPacket(
  input: CreateContextPacketRequest
): Promise<ContextPacket> {
  const data = await json<{ contextPacket: ContextPacket }>(
    await fetch('/context', {
      method: 'POST',
      headers: contextInboxHeaders(),
      body: JSON.stringify(input),
    })
  );
  return data.contextPacket;
}

export interface SendInboxMessageRequest {
  targetSessionId?: string;
  targetWorkContextId?: string;
  contextPacketIds: ContextPacketId[];
  text?: string;
  createdBy?: string;
}

export async function sendInboxMessage(
  input: SendInboxMessageRequest
): Promise<DecoratedInboxMessage> {
  const data = await json<{ message: DecoratedInboxMessage }>(
    await fetch('/inbox', {
      method: 'POST',
      headers: contextInboxHeaders(),
      body: JSON.stringify(input),
    })
  );
  return data.message;
}

export async function fetchInboxMessages(
  targetSessionId: string,
  limit = 10
): Promise<DecoratedInboxMessage[]> {
  const params = new URLSearchParams({ targetSessionId, limit: String(limit) });
  const data = await json<{ messages?: DecoratedInboxMessage[] }>(
    await fetch(`/inbox?${params.toString()}`, {
      headers: { 'x-relay-capabilities': CONTEXT_INBOX_CAPABILITIES },
    })
  );
  return Array.isArray(data.messages) ? data.messages : [];
}

export async function previewInboxMessages(
  targetSessionId: string,
  limit = 10
): Promise<DecoratedInboxMessage[]> {
  const params = new URLSearchParams({ targetSessionId, limit: String(limit) });
  const data = await json<{ messages?: DecoratedInboxMessage[] }>(
    await fetch(`/inbox/preview?${params.toString()}`, {
      headers: { 'x-relay-capabilities': CONTEXT_INBOX_CAPABILITIES },
    })
  );
  return Array.isArray(data.messages) ? data.messages : [];
}

export async function updateInboxMessageState(
  id: SessionInboxMessageId,
  action: 'ack' | 'resolve' | 'ignore'
): Promise<DecoratedInboxMessage> {
  const data = await json<{ message: DecoratedInboxMessage }>(
    await fetch(`/inbox/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: contextInboxHeaders(),
      body: JSON.stringify({ actorId: 'relay-web' }),
    })
  );
  return data.message;
}

async function jsonOrNull<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}

async function jsonEither<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
    );
  }
}

async function parseErrorBody(
  res: Response,
  fallback: string
): Promise<string> {
  return (await httpErrorFromResponse(res, fallback)).message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkspaceEvidenceErrorResponse(
  value: unknown
): value is WorkspaceEvidenceErrorResponse {
  if (!isRecord(value)) return false;
  const error = value['error'];
  return (
    typeof value['operation'] === 'string' &&
    isRecord(error) &&
    typeof error['state'] === 'string' &&
    typeof error['reason'] === 'string' &&
    typeof error['message'] === 'string'
  );
}

async function workspaceEvidenceErrorFromResponse(
  res: Response
): Promise<HttpError> {
  try {
    const data = (await res.json()) as unknown;
    if (isWorkspaceEvidenceErrorResponse(data)) {
      return new HttpError(
        res.status,
        data.error.message,
        data.error.reason,
        undefined,
        {
          state: data.error.state,
          reason: data.error.reason,
          ...(data.error.rootRef ? { rootRef: data.error.rootRef } : {}),
          ...(data.error.nodeId ? { nodeId: data.error.nodeId } : {}),
        },
        data
      );
    }
  } catch {
    // Fall through to a generic status-preserving error below.
  }
  return new HttpError(res.status, httpErrorMessage(res.status));
}

function isConfirmationChallenge(
  value: unknown
): value is ConfirmationChallenge {
  if (!isRecord(value)) return false;
  return (
    typeof value['challengeId'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['nodeId'] === 'string' &&
    isRecord(value['intent']) &&
    typeof value['canonicalParamsHash'] === 'string' &&
    isRecord(value['canonicalParams']) &&
    Array.isArray(value['requiredBits']) &&
    Array.isArray(value['challengeBits']) &&
    typeof value['expiresAt'] === 'string'
  );
}

function confirmationChallengeFromError(
  error: HttpError
): ConfirmationChallenge | undefined {
  const challenge = error.details?.['challenge'];
  return isConfirmationChallenge(challenge) ? challenge : undefined;
}

async function httpErrorFromResponse(
  res: Response,
  fallback?: string
): Promise<HttpError> {
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown };
    const structuredError = isRecord(data.error) ? data.error : null;
    const details = isRecord(structuredError?.['details'])
      ? structuredError['details']
      : typeof (data as { sessionId?: unknown }).sessionId === 'string'
        ? { sessionId: (data as { sessionId: string }).sessionId }
        : undefined;
    const code =
      typeof data.error === 'string'
        ? data.error
        : typeof structuredError?.['code'] === 'string'
          ? structuredError['code']
          : undefined;
    const retryable =
      typeof structuredError?.['retryable'] === 'boolean'
        ? structuredError['retryable']
        : undefined;
    const rawMessage =
      typeof data.message === 'string'
        ? data.message
        : typeof structuredError?.['message'] === 'string'
          ? structuredError['message']
          : typeof data.error === 'string'
            ? httpErrorMessage(res.status, data.error)
            : httpErrorMessage(res.status, fallback);
    const message = authLaneErrorMessage(code, rawMessage);
    return new HttpError(res.status, message, code, retryable, details);
  } catch {
    return new HttpError(res.status, httpErrorMessage(res.status, fallback));
  }
}

export async function authenticate(pin: string): Promise<void> {
  const res = await fetch('/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const message = await parseErrorBody(res, 'Authentication failed');
    throw new Error(message);
  }
}

export async function checkAuth(): Promise<boolean> {
  const res = await fetch('/sessions');
  return res.ok;
}

export async function checkAuthStatus(): Promise<{
  hasPIN: boolean;
}> {
  const data = await json<{ hasPIN?: boolean }>(await fetch('/auth/status'));
  return { hasPIN: data.hasPIN === true };
}

export async function fetchConfirmationChallenges(): Promise<
  ConfirmationChallenge[]
> {
  const data = await json<{ challenges?: unknown[] }>(
    await fetch('/hub/confirmations')
  );
  return Array.isArray(data.challenges)
    ? data.challenges.filter(isConfirmationChallenge)
    : [];
}

export async function fetchConfirmationChallenge(
  challengeId: string
): Promise<ConfirmationChallenge> {
  const data = await json<{ challenge?: unknown }>(
    await fetch('/hub/confirmations/' + encodeURIComponent(challengeId))
  );
  if (!isConfirmationChallenge(data.challenge)) {
    throw new Error('confirmation challenge response was malformed');
  }
  return data.challenge;
}

export async function approveConfirmationChallenge(
  challengeId: string,
  decision: ConfirmationDecision,
  approverSession?: string
): Promise<{ confirmationToken?: string; challenge: ConfirmationChallenge }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (approverSession?.trim())
    headers['x-auth-session'] = approverSession.trim();
  const res = await fetch(
    '/hub/confirmations/' + encodeURIComponent(challengeId) + '/approve',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision }),
    }
  );
  if (!res.ok)
    throw await httpErrorFromResponse(res, 'Failed to approve confirmation');
  const data = await jsonEither<{
    confirmationToken?: unknown;
    challenge?: unknown;
  }>(res);
  if (!isConfirmationChallenge(data.challenge)) {
    throw new Error('confirmation approval response was malformed');
  }
  return {
    ...(typeof data.confirmationToken === 'string'
      ? { confirmationToken: data.confirmationToken }
      : {}),
    challenge: data.challenge,
  };
}

export async function fetchConfirmationRequesterToken(
  challengeId: string
): Promise<{ confirmationToken: string; challenge: ConfirmationChallenge }> {
  const res = await fetch(
    '/hub/confirmations/' +
      encodeURIComponent(challengeId) +
      '/requester-token',
    { method: 'POST' }
  );
  if (!res.ok)
    throw await httpErrorFromResponse(
      res,
      'Failed to fetch confirmation token'
    );
  const data = await jsonEither<{
    confirmationToken?: unknown;
    challenge?: unknown;
  }>(res);
  if (
    typeof data.confirmationToken !== 'string' ||
    !isConfirmationChallenge(data.challenge)
  ) {
    throw new Error('confirmation requester-token response was malformed');
  }
  return {
    confirmationToken: data.confirmationToken,
    challenge: data.challenge,
  };
}

export async function setupPin(pin: string, confirm: string): Promise<void> {
  const res = await fetch('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, confirm }),
  });
  if (!res.ok) {
    const message = await parseErrorBody(res, 'Failed to set PIN');
    throw new Error(message);
  }
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  return json<SessionSummary[]>(await fetch('/sessions'));
}

export interface InterventionReadResponse {
  interventions: InterventionRecord[];
  count: number;
  limit: number;
  truncated: boolean;
  rawPayloadAvailable: false;
  transcriptExportAvailable: false;
  redaction: {
    payload: 'preview-only';
    metadataIncluded: true;
  };
}

export async function fetchSessionInterventions(
  sessionId: string,
  limit = 12
): Promise<InterventionReadResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  return json<InterventionReadResponse>(
    await fetch(
      `/sessions/${encodeURIComponent(sessionId)}/interventions?${query.toString()}`
    )
  );
}

function sendRoutedSessionInput(
  nodeId: NodeId | string,
  sessionId: string,
  data: string
): Promise<{ ok: true }> {
  return new Promise((resolve, reject) => {
    const parsed = parseGlobalSessionId(sessionId);
    const localSessionId = parsed?.localSessionId ?? sessionId;
    const path =
      '/nodes/' +
      encodeURIComponent(nodeId) +
      '/ws/sessions/' +
      encodeURIComponent(localSessionId);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(protocol + '//' + location.host + path);
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error('timed out opening routed session input socket'));
    }, 5_000);

    socket.onopen = () => {
      socket.send(data);
      window.setTimeout(() => socket.close(1000, 'small input sent'), 25);
      window.clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ ok: true });
      }
    };
    socket.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(new Error('failed to open routed session input socket'));
    };
    socket.onclose = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(new Error('routed session input socket closed before sending'));
    };
  });
}

export async function sendSessionInput(
  sessionId: string,
  data: string,
  nodeId?: NodeId | string
): Promise<{ ok: true }> {
  if (nodeId && nodeId !== DEFAULT_LOCAL_NODE_ID) {
    return sendRoutedSessionInput(nodeId, sessionId, data);
  }

  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse(res, 'Failed to send session input');
  }
  return jsonEither<{ ok: true }>(res);
}

export async function fetchHubNodes(): Promise<HubNodeSummary[]> {
  const data = await json<{ nodes?: HubNodeSummary[] }>(await fetch('/nodes'));
  return Array.isArray(data.nodes) ? data.nodes : [];
}

function isHubNodeSummary(value: unknown): value is HubNodeSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value['nodeId'] === 'string' &&
    typeof value['displayName'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['credentialState'] === 'string' &&
    isRecord(value['identity']) &&
    isRecord(value['credential']) &&
    isRecord(value['trust']) &&
    isRecord(value['connection']) &&
    isRecord(value['version']) &&
    isRecord(value['capabilities'])
  );
}

export async function revokeHubNode(nodeId: string): Promise<HubNodeSummary> {
  const res = await fetch(`/nodes/${encodeURIComponent(nodeId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw await httpErrorFromResponse(res, 'Failed to revoke node');
  const data = await jsonEither<{ node?: unknown }>(res);
  if (!isHubNodeSummary(data.node)) {
    throw new Error('node revoke response was malformed');
  }
  return data.node;
}

export interface FetchNodePairingRequestsOptions {
  state?: NodePairingRequestSummary['state'];
  deviceCode?: string;
  includeResolved?: boolean;
}

export interface NodePairingAccessEditRequest {
  displayName?: string;
  requestedProfile?: NodePairingTrustProfile;
  requestedRoots?: string[];
}

function nodePairingQuery(
  options: FetchNodePairingRequestsOptions = {}
): string {
  const params = new URLSearchParams();
  if (options.state) params.set('state', options.state);
  if (options.deviceCode?.trim())
    params.set('deviceCode', options.deviceCode.trim());
  if (options.includeResolved) params.set('includeResolved', 'true');
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function fetchNodePairingRequests(
  options: FetchNodePairingRequestsOptions = {}
): Promise<NodePairingRequestSummary[]> {
  const data = await json<{ requests?: NodePairingRequestSummary[] }>(
    await fetch(`/hub/pairing/requests${nodePairingQuery(options)}`)
  );
  return Array.isArray(data.requests) ? data.requests : [];
}

export async function fetchNodePairingRequest(
  requestId: string
): Promise<NodePairingRequestSummary> {
  const data = await json<{ request?: NodePairingRequestSummary }>(
    await fetch(`/hub/pairing/requests/${encodeURIComponent(requestId)}`)
  );
  if (!data.request) throw new Error('pairing request response was malformed');
  return data.request;
}

export async function editNodePairingRequestAccess(
  requestId: string,
  input: NodePairingAccessEditRequest
): Promise<NodePairingRequestSummary> {
  const res = await fetch(
    `/hub/pairing/requests/${encodeURIComponent(requestId)}/access`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok)
    throw await httpErrorFromResponse(res, 'Failed to edit pairing access');
  const data = await jsonEither<{ request?: NodePairingRequestSummary }>(res);
  if (!data.request) throw new Error('pairing access response was malformed');
  return data.request;
}

export async function approveNodePairingRequest(
  requestId: string,
  input: NodePairingAccessEditRequest = {}
): Promise<NodePairingRequestSummary> {
  const res = await fetch(
    `/hub/pairing/requests/${encodeURIComponent(requestId)}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok)
    throw await httpErrorFromResponse(res, 'Failed to approve pairing request');
  const data = await jsonEither<{ request?: NodePairingRequestSummary }>(res);
  if (!data.request) throw new Error('pairing approval response was malformed');
  return data.request;
}

export async function denyNodePairingRequest(
  requestId: string,
  reason?: string
): Promise<NodePairingRequestSummary> {
  const res = await fetch(
    `/hub/pairing/requests/${encodeURIComponent(requestId)}/deny`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
    }
  );
  if (!res.ok)
    throw await httpErrorFromResponse(res, 'Failed to deny pairing request');
  const data = await jsonEither<{ request?: NodePairingRequestSummary }>(res);
  if (!data.request) throw new Error('pairing denial response was malformed');
  return data.request;
}

export async function rotateHubNodeCredential(
  nodeId: string,
  delivery: 'online' | 'manual' = 'online'
): Promise<{
  node: HubNodeSummary;
  rotation?: HubNodeCredentialRotationSummary;
}> {
  const res = await fetch(
    `/hub/nodes/${encodeURIComponent(nodeId)}/credential-rotation`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery }),
    }
  );
  if (!res.ok)
    throw await httpErrorFromResponse(res, 'Failed to rotate node credential');
  const data = await jsonEither<{
    node: HubNodeSummary;
    rotation?: HubNodeCredentialRotationSummary;
  }>(res);
  if (!data.node || typeof data.node.nodeId !== 'string') {
    throw new Error('node rotation response was malformed');
  }
  return data;
}

export async function clearHubNodeRotationFailure(
  nodeId: string
): Promise<HubNodeSummary> {
  const res = await fetch(
    `/hub/nodes/${encodeURIComponent(nodeId)}/credential-rotation/clear-failure`,
    { method: 'POST' }
  );
  if (!res.ok)
    throw await httpErrorFromResponse(
      res,
      'Failed to clear node rotation failure'
    );
  const data = await jsonEither<{ node?: HubNodeSummary }>(res);
  if (!data.node) throw new Error('node rotation response was malformed');
  return data.node;
}

export async function fetchActiveWork(): Promise<WorkContextActiveGroup[]> {
  const data = await json<{ groups?: WorkContextActiveGroup[] }>(
    await fetch('/work-contexts/active')
  );
  return Array.isArray(data.groups) ? data.groups : [];
}

export interface FetchWorkflowRunsOptions {
  workContextId: string;
  state?: WorkflowRunState;
  providerRuntime?: string;
  limit?: number;
}

export async function fetchWorkflowRuns({
  workContextId,
  state,
  providerRuntime,
  limit = 5,
}: FetchWorkflowRunsOptions): Promise<WorkflowRunProjection[]> {
  const params = new URLSearchParams({ workContextId });
  if (state) params.set('state', state);
  if (providerRuntime) params.set('providerRuntime', providerRuntime);
  if (limit > 0) params.set('limit', String(limit));
  const data = await json<{ workflowRuns?: WorkflowRunProjection[] }>(
    await fetch(`/workflow-runs?${params.toString()}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return Array.isArray(data.workflowRuns) ? data.workflowRuns : [];
}

export interface FetchPipelineHandoffArtifactsOptions {
  workContextId?: string;
  taskRef?: Pick<TaskRef, 'kind' | 'id'>;
  stage?: PipelineHandoffStageName;
  currentHeadSha?: string;
  includeSuperseded?: boolean;
  includePayload?: boolean;
  limit?: number;
}

const HANDOFF_ARTIFACT_HEADERS: HeadersInit = {
  'x-relay-capabilities': 'context:read',
};

export async function fetchAgentViewArtifactPackage(
  artifactId: string
): Promise<ViewArtifactPackage> {
  const data = await json<{
    artifact?: { viewArtifact?: ViewArtifactPackage };
  }>(
    await fetch(
      `/work-context-artifacts/${encodeURIComponent(artifactId)}/view-package`,
      {
        headers: HANDOFF_ARTIFACT_HEADERS,
      }
    )
  );
  const pkg = data.artifact?.viewArtifact;
  if (!pkg) {
    throw new Error('view artifact package response was malformed');
  }
  return pkg;
}

export async function fetchPipelineHandoffArtifacts({
  workContextId,
  taskRef,
  stage,
  currentHeadSha,
  includeSuperseded,
  includePayload = false,
  limit = 8,
}: FetchPipelineHandoffArtifactsOptions): Promise<
  PipelineHandoffArtifactEnvelope[]
> {
  const params = new URLSearchParams();
  if (workContextId) params.set('workContextId', workContextId);
  if (taskRef) {
    params.set('taskRefKind', taskRef.kind);
    params.set('taskRefId', taskRef.id);
  }
  if (stage) params.set('stage', stage);
  if (currentHeadSha) params.set('currentHeadSha', currentHeadSha);
  if (includeSuperseded !== undefined) {
    params.set('includeSuperseded', String(includeSuperseded));
  }
  params.set('limit', String(limit));

  const data = await json<{ artifacts?: PipelineHandoffArtifactEnvelope[] }>(
    await fetch(`/pipeline-handoff-artifacts?${params.toString()}`, {
      headers: HANDOFF_ARTIFACT_HEADERS,
    })
  );
  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  if (!includePayload) return artifacts;
  return Promise.all(
    artifacts.map(async (artifact) => {
      if (artifact.payload) return artifact;
      try {
        return await fetchPipelineHandoffArtifact(
          artifact.metadata.id,
          currentHeadSha ? { currentHeadSha } : {}
        );
      } catch (err) {
        return {
          ...artifact,
          payloadError: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}

export async function fetchPipelineHandoffArtifact(
  artifactId: string,
  options: { currentHeadSha?: string } = {}
): Promise<PipelineHandoffArtifactEnvelope> {
  const params = new URLSearchParams();
  if (options.currentHeadSha)
    params.set('currentHeadSha', options.currentHeadSha);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const data = await json<{ artifact: PipelineHandoffArtifactEnvelope }>(
    await fetch(
      `/pipeline-handoff-artifacts/${encodeURIComponent(artifactId)}${suffix}`,
      {
        headers: HANDOFF_ARTIFACT_HEADERS,
      }
    )
  );
  return data.artifact;
}

/**
 * Hub-wide WorkContext artifact search (#1065) — metadata only (title/kind/
 * taskRef/workContextId), never body/payload content. Hard-capped at 20
 * results server-side regardless of the requested limit.
 */
export async function searchWorkContextArtifacts(
  q: string,
  options: { kind?: string; limit?: number } = {}
): Promise<PipelineHandoffArtifactEnvelope[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams();
  params.set('q', trimmed);
  if (options.kind) params.set('kind', options.kind);
  params.set('limit', String(options.limit ?? 8));
  const data = await json<{ artifacts?: PipelineHandoffArtifactEnvelope[] }>(
    await fetch(`/work-context-artifacts?${params.toString()}`, {
      headers: HANDOFF_ARTIFACT_HEADERS,
    })
  );
  return Array.isArray(data.artifacts) ? data.artifacts : [];
}

export interface CopyPipelineHandoffArtifactResult {
  artifact: {
    metadata: PublicPipelineHandoffArtifactSummary;
    payload?: PipelineHandoffArtifact;
  };
  copy: {
    mode: 'public-summary';
    rawPayloadAvailable: false;
    exportBytes: number;
    maxBytes: number;
  };
}

export async function copyPipelineHandoffArtifact(
  artifactId: string
): Promise<CopyPipelineHandoffArtifactResult> {
  return json<CopyPipelineHandoffArtifactResult>(
    await fetch(
      `/pipeline-handoff-artifacts/${encodeURIComponent(artifactId)}/copy`,
      {
        headers: HANDOFF_ARTIFACT_HEADERS,
      }
    )
  );
}

// ── #728 IA Workspace bar (consumes the #733 CRUD API) ──────────────────────
// The six-layer **Workspace** (a durable, user-authored grouping-of-Projects),
// distinct from the legacy `config.workspaces` repo grouping (`Workspace` in
// `types.ts`). Shape mirrors `shared/workspace.ts`: `projectIds` is an ordered
// membership list of ProjectIds, NOT embedded projects. Backed by the IA store
// (`ia.db`) and mounted at `/hub/ia/workspaces` — STRICTLY non-destructive of
// any legacy state. Endpoints: GET (list), POST (create), PATCH (partial
// rename/reorder/membership/defaults), POST archive/restore, DELETE hard-delete.
export interface IaWorkspace {
  id: string;
  name: string;
  status: 'active' | 'archived';
  order: number;
  projectIds: string[];
  pinned: boolean;
  color: string | null;
  icon: string | null;
  defaultRepoPath: string | null;
  defaultNodeId: string | null;
  defaultProvider: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IaWorkspacePatch {
  name?: string;
  status?: 'active' | 'archived';
  order?: number;
  projectIds?: string[];
  pinned?: boolean;
  color?: string | null;
  icon?: string | null;
  defaultRepoPath?: string | null;
  defaultNodeId?: string | null;
  defaultProvider?: string | null;
}

const IA_WORKSPACES_PATH = '/hub/ia/workspaces';

export async function fetchIaWorkspaces(): Promise<IaWorkspace[]> {
  const data = await json<{ workspaces?: IaWorkspace[] }>(
    await fetch(IA_WORKSPACES_PATH)
  );
  return Array.isArray(data.workspaces) ? data.workspaces : [];
}

export async function createIaWorkspace(input: {
  name: string;
  projectIds?: string[];
  order?: number;
  pinned?: boolean;
  color?: string | null;
  icon?: string | null;
  defaultRepoPath?: string | null;
  defaultNodeId?: string | null;
  defaultProvider?: string | null;
}): Promise<IaWorkspace> {
  const data = await json<{ workspace: IaWorkspace }>(
    await fetch(IA_WORKSPACES_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
  return data.workspace;
}

export async function updateIaWorkspace(
  id: string,
  patch: IaWorkspacePatch
): Promise<IaWorkspace> {
  const data = await json<{ workspace: IaWorkspace }>(
    await fetch(`${IA_WORKSPACES_PATH}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
  return data.workspace;
}

export async function archiveIaWorkspace(id: string): Promise<IaWorkspace> {
  const data = await json<{ workspace: IaWorkspace }>(
    await fetch(`${IA_WORKSPACES_PATH}/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    })
  );
  return data.workspace;
}

export async function deleteIaWorkspace(id: string): Promise<void> {
  const res = await fetch(`${IA_WORKSPACES_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  // 204 No Content on success; surface a structured error otherwise.
  if (!res.ok) {
    throw await httpErrorFromResponse(res, 'Failed to delete workspace');
  }
}

function normalizeTelemetryMapEntry(
  mapKey: string,
  raw: Record<string, unknown>
): SessionTelemetry {
  const parsed = parseGlobalSessionId(mapKey);
  const rawSessionId =
    typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  return {
    ...(raw as Omit<SessionTelemetry, 'sessionId'>),
    sessionId: rawSessionId ?? parsed?.localSessionId ?? mapKey,
    ...(typeof raw.localSessionId === 'string'
      ? {}
      : parsed
        ? { localSessionId: parsed.localSessionId }
        : {}),
    ...(typeof raw.nodeId === 'string'
      ? {}
      : parsed
        ? { nodeId: parsed.nodeId }
        : {}),
    ...(typeof raw.globalSessionId === 'string'
      ? {}
      : parsed
        ? { globalSessionId: mapKey }
        : {}),
  };
}

function normalizeTelemetrySessions(data: unknown): SessionTelemetry[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is SessionTelemetry =>
        !!item && typeof item === 'object' && 'sessionId' in item
    ) as SessionTelemetry[];
  }
  if (data && typeof data === 'object') {
    const value = data as { sessions?: unknown; data?: unknown } & Record<
      string,
      unknown
    >;
    if (Array.isArray(value.sessions))
      return normalizeTelemetrySessions(value.sessions);
    if (value.sessions && typeof value.sessions === 'object') {
      return Object.entries(value.sessions as Record<string, unknown>).flatMap(
        ([sessionId, raw]) => {
          if (!raw || typeof raw !== 'object') return [];
          return [
            normalizeTelemetryMapEntry(
              sessionId,
              raw as Record<string, unknown>
            ),
          ];
        }
      );
    }
    if (Array.isArray(value.data))
      return normalizeTelemetrySessions(value.data);
    if (value.data && typeof value.data === 'object')
      return normalizeTelemetrySessions(value.data);
    return Object.entries(value).flatMap(([sessionId, raw]) => {
      if (!raw || typeof raw !== 'object') return [];
      return [
        normalizeTelemetryMapEntry(sessionId, raw as Record<string, unknown>),
      ];
    });
  }
  return [];
}

function normalizeAccountTelemetry(data: unknown): AccountTelemetry | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as { data?: unknown; account?: unknown };
  const raw = value.data ?? value.account ?? data;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<AccountTelemetry>;
  if (typeof candidate.updatedAt !== 'string') return null;
  return {
    framework:
      typeof candidate.framework === 'string' ? candidate.framework : 'unknown',
    rateLimits: Array.isArray(candidate.rateLimits) ? candidate.rateLimits : [],
    planType:
      typeof candidate.planType === 'string' ? candidate.planType : undefined,
    updatedAt: candidate.updatedAt,
  };
}

export async function fetchSessionTelemetry(): Promise<SessionTelemetry[]> {
  const res = await fetch('/telemetry/sessions');
  const data = await jsonOrNull<unknown>(res);
  return normalizeTelemetrySessions(data);
}

export async function fetchAccountTelemetry(): Promise<Record<
  string,
  AccountTelemetry
> | null> {
  const res = await fetch('/telemetry/account');
  const data = await jsonOrNull<unknown>(res);
  if (!data || typeof data !== 'object') return null;

  const result: Record<string, AccountTelemetry> = {};
  for (const [framework, telemetry] of Object.entries(
    data as Record<string, unknown>
  )) {
    if (
      telemetry &&
      typeof telemetry === 'object' &&
      'framework' in telemetry
    ) {
      const normalized = normalizeAccountTelemetry(
        telemetry as Partial<AccountTelemetry>
      );
      if (normalized) result[framework] = normalized;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function fetchTelemetrySetupStatus(): Promise<{
  installed: boolean;
}> {
  const res = await fetch('/telemetry/setup-status');
  const data = await jsonOrNull<unknown>(res);
  if (!data || typeof data !== 'object') return { installed: false };
  const value = data as { installed?: unknown };
  return { installed: value.installed === true };
}

export async function fetchWorktrees(): Promise<WorktreeInfo[]> {
  return json<WorktreeInfo[]>(await fetch('/git/worktrees'));
}

export async function fetchWorkspaces(): Promise<Repo[]> {
  const data = await json<{ workspaces: Repo[] }>(await fetch('/workspaces'));
  return data.workspaces;
}

export async function fetchRepoInventory(): Promise<AggregatedRepoInventoryResponse> {
  return json<AggregatedRepoInventoryResponse>(
    await fetch('/hub/repo-inventory')
  );
}

export async function addWorkspace(path: string): Promise<void> {
  const res = await fetch('/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to add workspace'));
  }
}

export async function removeWorkspace(path: string): Promise<void> {
  const res = await fetch('/workspaces', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error('Failed to remove workspace');
}

export async function reorderWorkspaces(paths: string[]): Promise<Repo[]> {
  const data = await json<{ workspaces: Repo[] }>(
    await fetch('/workspaces/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
  );
  return data.workspaces;
}

export async function browseFsDirectory(
  dirPath?: string,
  options?: { prefix?: string; showHidden?: boolean; includeFiles?: boolean }
): Promise<BrowseResponse> {
  const params = new URLSearchParams();
  if (dirPath) params.set('path', dirPath);
  if (options?.prefix) params.set('prefix', options.prefix);
  if (options?.showHidden) params.set('showHidden', 'true');
  if (options?.includeFiles) params.set('includeFiles', 'true');
  return json<BrowseResponse>(
    await fetch('/workspaces/browse?' + params.toString())
  );
}

export interface BulkAddResult {
  added: Array<{
    path: string;
    name: string;
    isGitRepo: boolean;
    defaultBranch: string | null;
  }>;
  errors: Array<{ path: string; error: string }>;
  /**
   * #1287 slice 2: the `ia_workspaces` lane each path resolved to — for freshly
   * added paths AND for duplicate re-adds (`created: false`), so a re-add
   * reveals the existing lane instead of only reporting "Already exists".
   * Optional because an older hub (or a degraded IA store) omits it.
   */
  workspaces?: Array<{
    path: string;
    workspaceId: string;
    name: string;
    created: boolean;
    /** True when the lane exists but is ARCHIVED, and therefore is NOT returned
     *  by `GET /hub/ia/workspaces` — reporting it as ready would promise the
     *  user a lane that never appears. Optional: a hub predating the field
     *  omits it, which reads as "not archived", exactly as before. */
    archived?: boolean;
  }>;
}

export interface NodeFsListArgs {
  nodeId: string;
  sessionId: string;
  cwd: string;
  path?: string;
  maxEntries?: number;
}

export async function fetchNodeFsList(
  args: NodeFsListArgs
): Promise<FileRpcListResponse> {
  const url = `/hub/nodes/${encodeURIComponent(args.nodeId)}/sessions/${encodeURIComponent(args.sessionId)}/files/list`;
  const body: Omit<FileRpcListRequest, 'sessionId' | 'root'> & {
    cwd: string;
    path: string;
    maxEntries: number;
  } = {
    cwd: args.cwd,
    path: args.path ?? args.cwd,
    maxEntries: args.maxEntries ?? 100,
  };
  return json<FileRpcListResponse>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

export interface NodeFsReadArgs {
  nodeId: string;
  sessionId: string;
  path: string;
  maxBytes?: number;
  rangeStart?: number;
  encoding?: 'utf8' | 'base64';
}

export async function fetchNodeFsRead(
  args: NodeFsReadArgs
): Promise<FileRpcReadResponse> {
  const url = `/hub/nodes/${encodeURIComponent(args.nodeId)}/sessions/${encodeURIComponent(args.sessionId)}/files/read`;
  const body: Record<string, unknown> = { path: args.path };
  if (args.maxBytes !== undefined) body.maxBytes = args.maxBytes;
  if (args.rangeStart !== undefined) body.rangeStart = args.rangeStart;
  if (args.encoding !== undefined) body.encoding = args.encoding;
  return json<FileRpcReadResponse>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

export interface NodeFsTailArgs {
  nodeId: string;
  sessionId: string;
  path: string;
  maxBytes?: number;
  maxLines?: number;
  follow?: boolean;
  maxFollowChunkBytes?: number;
}

export async function fetchNodeFsTail(
  args: NodeFsTailArgs
): Promise<FileRpcTailResponse> {
  const url = `/hub/nodes/${encodeURIComponent(args.nodeId)}/sessions/${encodeURIComponent(args.sessionId)}/files/tail`;
  const body: Record<string, unknown> = { path: args.path };
  if (args.maxBytes !== undefined) body.maxBytes = args.maxBytes;
  if (args.maxLines !== undefined) body.maxLines = args.maxLines;
  if (args.follow !== undefined) body.follow = args.follow;
  if (args.maxFollowChunkBytes !== undefined) {
    body.maxFollowChunkBytes = args.maxFollowChunkBytes;
  }
  return json<FileRpcTailResponse>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

export interface NodeFsStatArgs {
  nodeId: string;
  sessionId: string;
  path: string;
}

export async function fetchNodeFsStat(
  args: NodeFsStatArgs
): Promise<FileRpcStatResponse> {
  const url = `/hub/nodes/${encodeURIComponent(args.nodeId)}/sessions/${encodeURIComponent(args.sessionId)}/files/stat`;
  const body: Record<string, unknown> = { path: args.path };
  return json<FileRpcStatResponse>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

export type WorkspaceEvidenceApiError = WorkspaceEvidenceErrorResponse;

const WORKSPACE_EVIDENCE_PATH = '/workspace-evidence';

async function postWorkspaceEvidence<T>(
  operation: 'list' | 'stat' | 'read' | 'preview',
  body: unknown
): Promise<T> {
  const res = await fetch(`${WORKSPACE_EVIDENCE_PATH}/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await workspaceEvidenceErrorFromResponse(res);
  return res.json() as Promise<T>;
}

export async function fetchWorkspaceEvidenceRoots(): Promise<
  WorkspaceEvidenceRoot[]
> {
  const data = await json<{ roots?: WorkspaceEvidenceRoot[] }>(
    await fetch(`${WORKSPACE_EVIDENCE_PATH}/roots`)
  );
  return Array.isArray(data.roots) ? data.roots : [];
}

export async function fetchWorkspaceEvidenceList(
  request: WorkspaceEvidenceListRequest
): Promise<WorkspaceEvidenceListResponse> {
  return postWorkspaceEvidence<WorkspaceEvidenceListResponse>('list', request);
}

export async function fetchWorkspaceEvidenceStat(
  request: WorkspaceEvidenceStatRequest
): Promise<WorkspaceEvidenceStatResponse> {
  return postWorkspaceEvidence<WorkspaceEvidenceStatResponse>('stat', request);
}

export async function fetchWorkspaceEvidenceRead(
  request: WorkspaceEvidenceReadRequest
): Promise<WorkspaceEvidenceReadResponse> {
  return postWorkspaceEvidence<WorkspaceEvidenceReadResponse>('read', request);
}

export async function fetchWorkspaceEvidencePreview(
  request: WorkspaceEvidencePreviewRequest
): Promise<WorkspaceEvidencePreviewResponse> {
  return postWorkspaceEvidence<WorkspaceEvidencePreviewResponse>(
    'preview',
    request
  );
}

export interface FetchWorkspaceSurfacesArgs {
  rootId?: string;
  workspaceId?: string;
  repoPath?: string;
}

export async function fetchWorkspaceSurfaces(
  args: FetchWorkspaceSurfacesArgs = {}
): Promise<WorkspaceSurface[]> {
  const params = new URLSearchParams();
  if (args.rootId) params.set('rootId', args.rootId);
  if (args.workspaceId) params.set('workspaceId', args.workspaceId);
  if (args.repoPath) params.set('repoPath', args.repoPath);
  const query = params.toString();
  const data = await json<WorkspaceSurfaceListResponse>(
    await fetch(`/workspace-surfaces${query ? `?${query}` : ''}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return Array.isArray(data.surfaces) ? data.surfaces : [];
}

export async function fetchWorkspaceTopics(
  args: { workspaceId?: string; includeArchived?: boolean } = {}
): Promise<WorkspaceTopicListResponse> {
  const params = new URLSearchParams();
  if (args.workspaceId) params.set('workspaceId', args.workspaceId);
  if (args.includeArchived) params.set('includeArchived', '1');
  const query = params.toString();
  const data = await json<WorkspaceTopicListResponse>(
    await fetch(`/workspace-topics${query ? `?${query}` : ''}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return {
    topics: Array.isArray(data.topics) ? data.topics : [],
    truncated: Boolean(data.truncated),
    derived: Boolean(data.derived),
  };
}

/** Reversibly archive a topic while preserving its history and bindings. */
export async function archiveWorkspaceTopic(
  id: string
): Promise<WorkspaceTopic> {
  const data = await json<{ topic: WorkspaceTopic }>(
    await fetch(`/workspace-topics/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      headers: { 'x-relay-capabilities': 'context:write' },
    })
  );
  return data.topic;
}

/** Reactivate an archived topic (clears its archivedAt marker). */
export async function restoreWorkspaceTopic(
  id: string
): Promise<WorkspaceTopic> {
  const data = await json<{ topic: WorkspaceTopic }>(
    await fetch(`/workspace-topics/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      headers: { 'x-relay-capabilities': 'context:write' },
    })
  );
  return data.topic;
}

/** Fetch a single workspace topic by id (GET /workspace-topics/:id). */
export async function fetchWorkspaceTopic(id: string): Promise<WorkspaceTopic> {
  const data = await json<{ topic: WorkspaceTopic }>(
    await fetch(`/workspace-topics/${encodeURIComponent(id)}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return data.topic;
}

/** Update one persisted channel/topic field group. */
export async function updateWorkspaceTopic(
  id: string,
  input: WorkspaceTopicUpdateInput
): Promise<WorkspaceTopic> {
  const data = await json<{ topic: WorkspaceTopic }>(
    await fetch(`/workspace-topics/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify(input),
    })
  );
  return data.topic;
}

/**
 * Create a bare workspace topic (POST /workspace-topics) with no attached
 * WorkContext — used by the DM-as-channel flow (#1166), which needs only the
 * topic/channel identity, not the full room + WorkContext of a session launch.
 */
export async function createWorkspaceTopic(
  input: WorkspaceTopicCreateInput
): Promise<WorkspaceTopic> {
  const data = await json<{ topic?: WorkspaceTopic }>(
    await fetch('/workspace-topics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify(input),
    })
  );
  if (!data.topic) throw new Error('workspace topic response missing topic');
  return data.topic;
}

// ── Channel chat (#1166, epic #1163) ────────────────────────────────────────
// REST client over the already-shipped channel core. Channel identity == topic
// id. All writes go through POST /channels/:id/messages; the socket
// (`useChannelChatSocket`) is read-only. Sender is always server-derived — never
// send a `sender` field.

export interface ChannelSummaryView {
  id: string;
  title: string;
  kind?: string;
  visibility: 'default' | 'private' | 'shared';
  archived: boolean;
  latestSeq: number;
  messageCount: number;
  lastMessage: {
    id: string;
    seq: number;
    preview: string;
    senderId: string;
    senderKind: 'human' | 'agent' | 'system';
    /**
     * Server-resolved sender label + vendor. `senderId` is a profile Actor id
     * (`agent-profile:<vendor>:default`), so these are the ONLY safe sources for
     * a display label — never strip segments off the id (#1234).
     */
    senderDisplayName?: string;
    providerId?: string;
    /** Mention refs for this row, computed over the full body server-side. */
    mentions?: ChannelMention[];
    status: string;
    createdAt: string;
  } | null;
  members: { kind: 'human' | 'agent'; id: string; joinedAt: string }[];
  /**
   * Newest-active threads in this channel, capped server-side (#1287 slice 5
   * item 18). Optional so a client talking to a hub from before the extension
   * simply renders no thread rows.
   */
  threads?: {
    rootMessageId: string;
    title?: string;
    replyCount: number;
    lastReplyAt: string;
    preview: string;
    rootSenderId: string;
    rootSenderKind: 'human' | 'agent' | 'system';
    rootSenderDisplayName?: string;
    providerId?: string;
  }[];
  /** Total live threads; `threads` is only the newest slice. */
  threadCount?: number;
}

export async function fetchChannel(
  channelId: string
): Promise<ChannelSummaryView> {
  const data = await json<{ channel: ChannelSummaryView }>(
    await fetch(`/channels/${encodeURIComponent(channelId)}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return data.channel;
}

/**
 * All channels (archived ones only when they hold messages) with per-channel
 * `latestSeq`. This is the only client-side source of head seqs on a cold load:
 * the `/ws/events` `channel-activity` broadcast reports just the channels that
 * move while that socket is open.
 *
 * The route lists topics unfiltered, so the payload is the newest 200 by
 * `updated_at` INCLUDING archived ones. The rail's own topic query takes a
 * separate 200-row window whose `includeArchived` follows the archive toggle, so
 * with enough recently-updated archived topics a rendered active row can fall
 * outside this window and get no seed until it moves.
 */
export async function fetchChannels(): Promise<ChannelSummaryView[]> {
  const data = await json<{ channels?: ChannelSummaryView[] }>(
    await fetch('/channels', {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return Array.isArray(data.channels) ? data.channels : [];
}

/**
 * The operator's durable last-read marks (#1308 slice 3).
 *
 * ONE call for every marked channel, deliberately: this runs on boot next to
 * the channel-list seed, and a per-channel fan-out would cost a phone a round
 * trip per row before the sidebar could render an honest unread dot.
 *
 * Rows are re-validated here rather than trusted, because they feed the unread
 * projection directly — a malformed row must degrade to "the hub has no
 * opinion", never to a mark at `NaN` that silently swallows a channel's dot.
 *
 * Single-operator device sync (#1231): the payload carries no reader identity
 * because there is only ever one reader. This is not a read receipt.
 */
export async function fetchChannelReadState(): Promise<
  ChannelReadStateEntry[]
> {
  const data = await json<ChannelReadStateResponse>(
    await fetch('/channels/read-state', {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  if (!Array.isArray(data.channels)) return [];
  return data.channels.filter(
    (row): row is ChannelReadStateEntry =>
      typeof row?.channelId === 'string' &&
      row.channelId.length > 0 &&
      typeof row.lastReadSeq === 'number' &&
      Number.isFinite(row.lastReadSeq)
  );
}

/**
 * Publish one channel's last-read mark (#1308 slice 3).
 *
 * `keepalive` is what makes a pagehide flush actually leave the device: a
 * normal fetch is cancelled the moment the document starts unloading, so
 * closing the tab would drop the mark the operator just earned. `sendBeacon`
 * is not an option even though it is the usual answer — it cannot carry the
 * `x-relay-capabilities` header this route requires.
 *
 * Safe to repeat and safe to race: the hub is monotonic-up and clamps to the
 * channel head, so a retry, a duplicate, or two devices reporting at once
 * converge on one durable value.
 *
 * Returns that durable value so the caller can close the loop. It may be BELOW
 * what was pushed (the hub clamps to the channel head) or ABOVE it (another
 * device marked further first); either way the client learns what the hub
 * actually holds instead of assuming its own mark landed. A body that is
 * missing or malformed degrades to `null` — "the hub has no opinion" — never to
 * a mark at `NaN`, because this feeds the unread projection.
 */
export async function putChannelReadState(
  channelId: string,
  lastReadSeq: number,
  options: { keepalive?: boolean } = {}
): Promise<ChannelReadStateEntry | null> {
  const body: ChannelReadStateUpdateRequest = { lastReadSeq };
  const res = await fetch(
    `/channels/${encodeURIComponent(channelId)}/read-state`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify(body),
      keepalive: options.keepalive === true,
    }
  );
  if (!res.ok) throw await httpErrorFromResponse(res);
  const parsed = (await res
    .json()
    .catch(() => null)) as ChannelReadStateUpdateResponse | null;
  const row = parsed?.readState;
  return typeof row?.channelId === 'string' &&
    row.channelId.length > 0 &&
    typeof row.lastReadSeq === 'number' &&
    Number.isFinite(row.lastReadSeq)
    ? row
    : null;
}

/**
 * Full-text message search (#1308 slice 2). Rides `channels.history` — the same
 * durable log, the same capability — so no gateway verb is added.
 *
 * `includeArchived` mirrors `searchWorkspaceTopics` so ONE operator control (the
 * show-older-chats toggle) governs both sidebar sections; the server resolves
 * archive state from the topic store and scopes the index query by it.
 *
 * Every field is re-validated here rather than trusted: this response is fed
 * straight into a click handler that navigates, so a malformed row must degrade
 * to "no hits", never to a jump at `undefined`.
 */
export async function searchChannelMessages(args: {
  q: string;
  includeArchived?: boolean;
  workspaceId?: string;
  channelId?: string;
  limit?: number;
}): Promise<ChannelMessageSearchResponse> {
  const params = new URLSearchParams();
  params.set('q', args.q);
  if (args.includeArchived) params.set('includeArchived', '1');
  if (args.workspaceId) params.set('workspaceId', args.workspaceId);
  if (args.channelId) params.set('channelId', args.channelId);
  if (args.limit) params.set('limit', String(args.limit));
  const data = await json<ChannelMessageSearchResponse>(
    await fetch(`/channels/search?${params.toString()}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  const results = Array.isArray(data.results)
    ? data.results.filter(
        (hit): hit is ChannelMessageSearchResult =>
          typeof hit?.messageId === 'string' &&
          typeof hit.channelId === 'string'
      )
    : [];
  return {
    query: typeof data.query === 'string' ? data.query : args.q,
    results,
    truncated: Boolean(data.truncated),
    ...(data.unavailableReason
      ? { unavailableReason: data.unavailableReason }
      : {}),
    ...(typeof data.scopeAlias === 'string' && data.scopeAlias.length > 0
      ? { scopeAlias: data.scopeAlias }
      : {}),
  };
}

export interface ChannelHistoryPage {
  messages: ChannelMessage[];
  hasMore: boolean;
  nextCursor?: { afterSeq?: number; beforeSeq?: number };
  /** Present on the root-inclusive thread route. */
  thread?: { rootMessageId: ChannelMessageId; title: string };
}

export interface ChannelThreadSummary {
  rootMessageId: string;
  title: string;
  replyCount: number;
  lastReplyAt: string;
  preview: string;
  rootSenderId: string;
  rootSenderKind: 'human' | 'agent' | 'system';
  rootSenderDisplayName?: string;
  providerId?: string;
}

export async function fetchChannelHistory(
  channelId: string,
  filter: {
    beforeSeq?: number;
    afterSeq?: number;
    limit?: number;
    threadId?: string;
  } = {}
): Promise<ChannelHistoryPage> {
  const params = new URLSearchParams();
  if (filter.beforeSeq !== undefined)
    params.set('beforeSeq', String(filter.beforeSeq));
  if (filter.afterSeq !== undefined)
    params.set('afterSeq', String(filter.afterSeq));
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  if (filter.threadId !== undefined) params.set('threadId', filter.threadId);
  const query = params.toString();
  const data = await json<ChannelHistoryPage>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/messages${query ? `?${query}` : ''}`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    )
  );
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    hasMore: Boolean(data.hasMore),
    ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
  };
}

/**
 * Fetch one root-inclusive thread page. This intentionally uses the dedicated
 * thread-history route rather than the unrelated `threadId` filter on channel
 * history: the server validates the root and preserves its cursor semantics.
 */
export async function fetchChannelThreadHistory(
  channelId: string,
  rootMessageId: ChannelMessageId,
  filter: {
    beforeSeq?: number;
    afterSeq?: number;
    limit?: number;
  } = {}
): Promise<ChannelHistoryPage> {
  const params = new URLSearchParams();
  if (filter.beforeSeq !== undefined)
    params.set('beforeSeq', String(filter.beforeSeq));
  if (filter.afterSeq !== undefined)
    params.set('afterSeq', String(filter.afterSeq));
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  const query = params.toString();
  const data = await json<ChannelHistoryPage>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootMessageId)}${query ? `?${query}` : ''}`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    )
  );
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    hasMore: Boolean(data.hasMore),
    ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
    ...(data.thread &&
    typeof data.thread.rootMessageId === 'string' &&
    typeof data.thread.title === 'string'
      ? {
          thread: {
            rootMessageId: data.thread.rootMessageId as ChannelMessageId,
            title: data.thread.title,
          },
        }
      : {}),
  };
}

export async function createChannelThread(
  channelId: string,
  title: string
): Promise<ChannelThreadSummary> {
  const data = await json<{ thread: ChannelThreadSummary }>(
    await fetch(`/channels/${encodeURIComponent(channelId)}/threads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify({ title }),
    })
  );
  return data.thread;
}

export async function renameChannelThread(
  channelId: string,
  rootMessageId: string,
  title: string
): Promise<ChannelThreadSummary> {
  const data = await json<{ thread: ChannelThreadSummary }>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootMessageId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({ title }),
      }
    )
  );
  return data.thread;
}

export async function postChannelMessage(
  channelId: string,
  input: {
    text: string;
    format?: 'markdown' | 'text';
    parts?: ChannelMessagePart[];
    threadId?: string;
    parentMessageId?: string;
    clientMessageId: string;
    /**
     * Explicit mid-turn steering. Omitted prefers a harness's native safe-boundary
     * steer and otherwise queues behind the live turn; `'interrupt'` cancels it.
     */
    steering?: 'interrupt';
  }
): Promise<ChannelMessage> {
  const data = await json<{ message: ChannelMessage }>(
    await fetch(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify(input),
    })
  );
  return data.message;
}

/**
 * Upload channel images into the durable attachment lane. The browser never
 * supplies attachment metadata: the server sniffs, sanitizes, measures, and
 * returns canonical sender-neutral image parts.
 */
export async function uploadChannelImages(
  channelId: string,
  files: readonly File[]
): Promise<ChannelImagePart[]> {
  const form = new FormData();
  for (const file of files) form.append('images', file, file.name || 'image');
  const data = await json<{ attachments: ChannelImagePart[] }>(
    await fetch(`/channels/${encodeURIComponent(channelId)}/attachments`, {
      method: 'POST',
      headers: { 'x-relay-capabilities': 'context:write' },
      body: form,
    })
  );
  return Array.isArray(data.attachments) ? data.attachments : [];
}

/**
 * Capability headers cannot be attached by a plain <img src>. Fetch the
 * authenticated binary explicitly, then let the caller render an object URL.
 */
export async function fetchChannelAttachmentBlob(
  channelId: string,
  attachmentId: string,
  signal?: AbortSignal
): Promise<Blob> {
  const response = await fetch(
    `/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      headers: { 'x-relay-capabilities': 'context:read' },
      ...(signal ? { signal } : {}),
    }
  );
  if (!response.ok) {
    throw await httpErrorFromResponse(response, 'image unavailable');
  }
  return response.blob();
}

// ── Channel agent roster + control (#1167, slice 4) ─────────────────────────
// The roster lists the frameworks that can be @-mentioned in a channel, with
// their live binding/status. Interrupt + approval are per-agent control writes.

/** Live agent status within a channel (profile-actor-id keyed). */
export type ChannelAgentStatus =
  | 'spawning'
  | 'thinking'
  | 'streaming'
  | 'waiting'
  | 'idle';

/** One row of the channel @-mention roster (GET /channels/:id/roster). */
export interface RosterEntry {
  /** Durable AgentProfile actor id — what a mention resolves to. */
  id: string;
  displayName: string;
  /** Provider/framework spawn selector for this profile. */
  providerId: string;
  isDefault: boolean;
  isBuiltIn: boolean;
  kind: 'framework';
  /** False when the framework cannot currently be routed to (see `reason`). */
  available: boolean;
  reason: string | null;
  /** Present for a bound runtime when its collaboration role is known. */
  role?: AgentRole;
  /** Present when a live runtime is bound to this agent in the channel. */
  binding: {
    runtimeId: string;
    status: ChannelAgentStatus;
    /**
     * Posts waiting to trigger this agent's NEXT turn (#1308 slice 4).
     * Optional so an older hub's roster still parses; absent means zero.
     */
    queuedCount?: number;
    /** Safe-boundary steer requests currently attached to the active turn. */
    steeringCount?: number;
    /** Whether the live harness accepts the default native steer action. */
    steerSupported?: boolean;
  } | null;
  /** Provider-aware control previews. An absent list means discovery is unavailable. */
  commands?: AgentSlashCommandV2[];
}

export async function fetchChannelRoster(
  channelId: string
): Promise<RosterEntry[]> {
  const data = await json<{ roster: RosterEntry[] }>(
    await fetch(`/channels/${encodeURIComponent(channelId)}/roster`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return Array.isArray(data.roster) ? data.roster : [];
}

/** Execute a channel agent control without creating or routing a channel message. */
export async function executeChannelAgentCommand(
  channelId: string,
  input: {
    profileId: string;
    command: string;
    args?: string;
    /** Required by the server for context-changing/destructive controls. */
    confirmed?: boolean;
    /** Canonical thread root; absent addresses the root-channel runtime only. */
    threadId?: string | null;
  }
): Promise<{ config?: Record<string, unknown> }> {
  const data = await json<{ config?: Record<string, unknown> }>(
    await fetch(`/channels/${encodeURIComponent(channelId)}/agent-commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify(input),
    })
  );
  return data;
}

/**
 * Explicitly apply saved channel instructions to one conversation by restarting
 * its idle runtimes. Busy turns are rejected by the server and keep their
 * existing provider prompt until the operator applies again after they finish.
 */
export async function restartChannelAgentRuntimes(
  channelId: string,
  threadId?: string | null
): Promise<{ restarted: number }> {
  return json<{ restarted: number }>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/agent-runtimes/restart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify(threadId ? { threadId } : {}),
      }
    )
  );
}

/**
 * Interrupt the given agent's active turn in a channel. Lets `HttpError`
 * propagate: callers ignore 404 (no live binding) / 409 (NO_ACTIVE_TURN, agent
 * idle) since both mean "nothing to interrupt".
 */
export async function interruptChannelAgent(
  channelId: string,
  agentId: string,
  threadId?: string | null
): Promise<void> {
  await json<{ ok: true }>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/agents/${encodeURIComponent(
        agentId
      )}/interrupt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify(threadId ? { threadId } : {}),
      }
    )
  );
}

/**
 * Rewrite the body of one of the operator's own channel messages (#1308 slice 1
 * item 3). The updated row arrives on every device through the socket
 * (`channel-message-edited-v1`), so callers use the response only to know the
 * write landed — there is no optimistic local apply, exactly as with posting.
 * `HttpError` propagates: 403 (not the operator's lane), 409 (not an editable
 * row / archived channel) and 404 are all operator-legible states.
 */
export async function editChannelMessage(
  channelId: string,
  messageId: string,
  text: string
): Promise<ChannelMessage> {
  const body = await json<{ message: ChannelMessage }>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
        messageId
      )}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({ text }),
      }
    )
  );
  return body.message;
}

/**
 * Delete one of the operator's own channel messages (#1308 slice 1 item 4).
 * Returns the TOMBSTONE — the row keeps its id and seq and loses its body — so
 * a caller can see the state it now holds; the same row also arrives on every
 * device through the socket (`channel-message-deleted-v1`), so nothing is
 * applied optimistically here. `HttpError` propagates: 403 (not the operator's
 * lane), 409 (not a deletable row / archived channel) and 404 are all
 * operator-legible states.
 */
export async function deleteChannelMessage(
  channelId: string,
  messageId: string
): Promise<ChannelMessage> {
  const body = await json<{ message: ChannelMessage }>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
        messageId
      )}`,
      {
        method: 'DELETE',
        headers: { 'x-relay-capabilities': 'context:write' },
      }
    )
  );
  return body.message;
}

/** What a retry actually re-ran (#1308 slice 1 item 2). */
export interface ChannelMessageRetryResult {
  messageId: string;
  /** The ORIGINAL trigger that was re-routed; never a newly posted row. */
  triggerMessageId: string;
  profileActorId: string;
}

/**
 * Re-route the original trigger of a failed/interrupted/truncated agent row to
 * the same profile. `HttpError` propagates so callers can distinguish 409
 * (`CHANNEL_AGENT_BUSY` — the storm brake) from a genuine failure.
 */
export async function retryChannelMessage(
  channelId: string,
  messageId: string
): Promise<ChannelMessageRetryResult> {
  const body = await json<{ ok: true; retry: ChannelMessageRetryResult }>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
        messageId
      )}/retry`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({}),
      }
    )
  );
  return body.retry;
}

/** Persistent orchestrator binding created by the operator lane. */
export interface ChannelOrchestratorDesignation {
  ok: true;
  orchestrator: {
    runtimeId: string | null;
    status: ChannelAgentStatus;
    framework: string;
  };
}

/**
 * Designate (or resume) the persistent orchestrator for a product channel.
 * This route is cookie-authenticated: it keeps the standard operator channel
 * capability header but intentionally has no actor-token path.
 */
export async function designateChannelOrchestrator(
  channelId: string,
  framework = 'claude'
): Promise<ChannelOrchestratorDesignation> {
  const params = new URLSearchParams({ framework });
  return json<ChannelOrchestratorDesignation>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/orchestrator?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({}),
      }
    )
  );
}

/**
 * Respond to a channel agent's pending approval request. `decision` is an
 * `AgentApprovalDecisionV2` (accept/decline/cancel) — kept `unknown` here so the
 * caller owns the exact shape.
 */
export async function respondChannelApproval(
  channelId: string,
  agentId: string,
  requestId: string,
  decision: unknown,
  threadId?: string | null
): Promise<void> {
  await json<{ ok: true }>(
    await fetch(
      `/channels/${encodeURIComponent(channelId)}/agents/${encodeURIComponent(
        agentId
      )}/approvals`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({
          requestId,
          decision,
          ...(threadId ? { threadId } : {}),
        }),
      }
    )
  );
}

export interface WorkContextCreateBody {
  title?: string;
  source?: string;
  anchors?: WorkContext['anchors'];
  tasks?: TaskRef[];
  privacy?: WorkContext['privacy'];
}

export interface WorkspaceTopicRoomCreateInput {
  topic: WorkspaceTopicCreateInput;
  workContext?: WorkContextCreateBody;
  taskRef?: TaskRef;
}

export interface WorkspaceTopicRoomCreateResult {
  topic: WorkspaceTopic;
  workContext: WorkContext;
}

export interface WorkspaceTopicLaunchFailure {
  stage: 'work-context' | 'topic' | 'session';
  code?: string;
  message: string;
  retryable: boolean;
  status?: number;
}

export type WorkspaceTopicRoomLaunchResult =
  | {
      status: 'created';
      topic: WorkspaceTopic;
      workContext: WorkContext;
    }
  | {
      status: 'launched';
      topic: WorkspaceTopic;
      workContext: WorkContext;
      session: SessionSummary;
    }
  | {
      status: 'launch_failed';
      topic: WorkspaceTopic;
      workContext: WorkContext;
      failure: WorkspaceTopicLaunchFailure;
    };

export type WorkspaceTopicRoomSessionLaunchResult = Extract<
  WorkspaceTopicRoomLaunchResult,
  { status: 'launched' | 'launch_failed' }
>;

function launchFailure(
  stage: WorkspaceTopicLaunchFailure['stage'],
  err: unknown
): WorkspaceTopicLaunchFailure {
  if (err instanceof HttpError) {
    return {
      stage,
      message: err.message,
      retryable: err.retryable ?? stage === 'session',
      status: err.status,
      ...(err.code ? { code: err.code } : {}),
    };
  }
  return {
    stage,
    message: err instanceof Error ? err.message : String(err),
    retryable: stage === 'session',
  };
}

export async function createWorkContextForTopicRoom(
  input: WorkspaceTopicRoomCreateInput
): Promise<WorkContext> {
  const taskRef = input.taskRef ?? input.workContext?.tasks?.[0];
  const nodeId = input.topic.routingDefaults?.nodeId;
  const body = {
    title: input.workContext?.title ?? input.topic.title,
    source: input.workContext?.source ?? 'workspace-topic-room',
    anchors: input.workContext?.anchors ?? {
      project: { workspaceId: input.topic.workspaceId },
      ...(nodeId
        ? {
            node: {
              nodeId,
              kind: nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
            },
          }
        : {}),
      repo: {
        ...(input.topic.routingDefaults?.repoPath
          ? { localPath: input.topic.routingDefaults.repoPath }
          : {}),
      },
      worktree: {
        ...(input.topic.routingDefaults?.worktreePath
          ? { localPath: input.topic.routingDefaults.worktreePath }
          : {}),
      },
    },
    tasks: input.workContext?.tasks,
    privacy: input.workContext?.privacy,
    ...(taskRef ? { taskRef } : {}),
  };
  const path = taskRef ? '/work-contexts/from-task-ref' : '/work-contexts';
  const data = await json<{ workContext?: WorkContext }>(
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  if (!data.workContext)
    throw new Error('work context response missing workContext');
  return data.workContext;
}

export async function createWorkspaceTopicRoom(
  input: WorkspaceTopicRoomCreateInput
): Promise<WorkspaceTopicRoomCreateResult> {
  let workContext: WorkContext;
  try {
    workContext = await createWorkContextForTopicRoom(input);
  } catch (err) {
    throw launchFailure('work-context', err);
  }
  const linkedRefs = {
    ...(input.topic.linkedRefs ?? {}),
    workContextIds: Array.from(
      new Set([
        ...(input.topic.linkedRefs?.workContextIds ?? []),
        workContext.id,
      ])
    ),
    ...(input.taskRef
      ? {
          taskRefs: Array.from(
            new Map(
              [...(input.topic.linkedRefs?.taskRefs ?? []), input.taskRef].map(
                (ref) => [`${ref.kind}:${ref.id}`, ref]
              )
            ).values()
          ),
        }
      : {}),
  };
  try {
    const data = await json<{ topic?: WorkspaceTopic }>(
      await fetch('/workspace-topics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({ ...input.topic, linkedRefs }),
      })
    );
    if (!data.topic) throw new Error('workspace topic response missing topic');
    return { topic: data.topic, workContext };
  } catch (err) {
    // #1287 slice 4: the composer owns the channel id and reuses it across
    // retries, so a 409 here means THIS attempt already committed — a create
    // that timed out after the write, or a double submit. Adopt the row we
    // ourselves made instead of forking a second channel (the reason the id is
    // client-owned at all). An ARCHIVED blocker is not adoptable: the operator
    // archived it deliberately, and the conflict message already names restore
    // as the remedy, so that one still surfaces.
    const conflict =
      err instanceof HttpError && err.status === 409
        ? parseWorkspaceTopicConflictDetails(err.details)
        : null;
    if (conflict?.remedy === 'open') {
      try {
        return {
          topic: await fetchWorkspaceTopic(conflict.blockingTopicId),
          workContext,
        };
      } catch {
        throw launchFailure('topic', err);
      }
    }
    throw launchFailure('topic', err);
  }
}

export async function createWorkspaceTopicRoomAndMaybeLaunch(input: {
  room: WorkspaceTopicRoomCreateInput;
  launch?: Omit<CreateSessionBody, 'workspaceTopicId' | 'workContextId'>;
}): Promise<WorkspaceTopicRoomLaunchResult> {
  const room = await createWorkspaceTopicRoom(input.room);
  if (!input.launch) return { status: 'created', ...room };
  return launchWorkspaceTopicRoom({ room, launch: input.launch });
}

export async function launchWorkspaceTopicRoom(input: {
  room: WorkspaceTopicRoomCreateResult;
  launch: Omit<CreateSessionBody, 'workspaceTopicId' | 'workContextId'>;
}): Promise<WorkspaceTopicRoomSessionLaunchResult> {
  try {
    const nodeId =
      input.launch.nodeId ?? input.room.topic.routingDefaults?.nodeId;
    const session = await createSession({
      ...input.launch,
      ...(nodeId ? { nodeId } : {}),
      workspaceTopicId: input.room.topic.id,
      workContextId: input.room.workContext.id,
    });
    return { status: 'launched', ...input.room, session };
  } catch (err) {
    return {
      status: 'launch_failed',
      ...input.room,
      failure: launchFailure('session', err),
    };
  }
}

export async function searchWorkspaceTopics(args: {
  q: string;
  workspaceId?: string;
  workContextId?: string;
  workContextIds?: string[];
  includeArchived?: boolean;
  limit?: number;
}): Promise<WorkspaceTopicSearchResponse> {
  const params = new URLSearchParams();
  params.set('q', args.q);
  if (args.workspaceId) params.set('workspaceId', args.workspaceId);
  if (args.workContextId) params.set('workContextId', args.workContextId);
  if (args.workContextIds?.length)
    params.set('workContextIds', args.workContextIds.join(','));
  if (args.includeArchived) params.set('includeArchived', '1');
  if (args.limit) params.set('limit', String(args.limit));
  const data = await json<WorkspaceTopicSearchResponse>(
    await fetch(`/workspace-topics/search?${params.toString()}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    })
  );
  return {
    query: typeof data.query === 'string' ? data.query : args.q,
    results: Array.isArray(data.results) ? data.results : [],
    truncated: Boolean(data.truncated),
    derived: Boolean(data.derived),
    ...(typeof data.unavailableReason === 'string'
      ? { unavailableReason: data.unavailableReason }
      : {}),
  };
}

export interface NodeFsWriteArgs {
  nodeId: string;
  sessionId: string;
  path: string;
  mode: 'create' | 'overwrite' | 'append';
  /** UTF-8 content; encoded to base64 by this helper. */
  content: string;
  /** sha256 hex of current on-disk content; required by server for overwrite. */
  expectedHash?: string;
}

export async function fetchNodeFsWrite(
  args: NodeFsWriteArgs
): Promise<FileRpcWriteResponse> {
  const url = `/hub/nodes/${encodeURIComponent(args.nodeId)}/sessions/${encodeURIComponent(args.sessionId)}/files/write`;
  // btoa requires latin1; encode UTF-8 → bytes → base64 safely.
  const bytes = new TextEncoder().encode(args.content);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const contentBase64 = btoa(binary);
  const body: Record<string, unknown> = {
    path: args.path,
    mode: args.mode,
    contentBase64,
  };
  if (args.expectedHash) body.expectedHash = args.expectedHash;
  return json<FileRpcWriteResponse>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

export async function addWorkspacesBulk(
  paths: string[]
): Promise<BulkAddResult> {
  return json<BulkAddResult>(
    await fetch('/workspaces/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
  );
}

export async function fetchDashboard(repoPath: string): Promise<DashboardData> {
  interface RawDashboard {
    pullRequests: { prs: PullRequest[]; error?: string };
    branches: string[];
    activity: ActivityEntry[];
  }
  try {
    const raw = await json<RawDashboard>(
      await fetch('/workspaces/dashboard?path=' + encodeURIComponent(repoPath))
    );
    return {
      prs: raw.pullRequests?.prs ?? [],
      activity: raw.activity ?? [],
      isGitRepo: true,
      defaultBranch: null,
      hasGhCli: !raw.pullRequests?.error,
    };
  } catch (err) {
    // The /workspaces/dashboard handler responds to a non-git directory with
    // `{ error: 'not_git_repo', code: 'NOT_GIT' }`. httpErrorFromResponse
    // derives HttpError.code from the string `error` field (taking precedence
    // over the structured `code`), so the parsed code is 'not_git_repo' — not
    // 'NOT_GIT'. Match both so the non-git path (and the evidence-tab default
    // it drives) fires regardless of which field the error parser surfaces.
    if (
      err instanceof HttpError &&
      (err.code === 'not_git_repo' || err.code === 'NOT_GIT')
    ) {
      return {
        isGitRepo: false,
        prs: [],
        activity: [],
        hasGhCli: false,
        defaultBranch: null,
      };
    }
    throw err;
  }
}

export async function fetchCiStatusOrNull(
  repoPath: string,
  branch: string
): Promise<CiStatus | null> {
  const res = await fetch(
    '/gh/ci-status?path=' +
      encodeURIComponent(repoPath) +
      '&branch=' +
      encodeURIComponent(branch)
  );
  return jsonOrNull<CiStatus>(res);
}

export async function fetchPrForBranchOrNull(
  repoPath: string,
  branch: string
): Promise<PrInfo | null> {
  const res = await fetch(
    '/gh/pr?path=' +
      encodeURIComponent(repoPath) +
      '&branch=' +
      encodeURIComponent(branch)
  );
  const data = await jsonOrNull<{ pr: PrInfo | null }>(res);
  return data?.pr ?? null;
}

export async function fetchCurrentBranch(
  repoPath: string
): Promise<string | null> {
  const data = await json<{ branch: string | null }>(
    await fetch(
      '/workspaces/current-branch?path=' + encodeURIComponent(repoPath)
    )
  );
  return data.branch;
}

export async function autocompletePath(prefix: string): Promise<string[]> {
  const data = await json<{ suggestions: string[] }>(
    await fetch('/workspaces/autocomplete?prefix=' + encodeURIComponent(prefix))
  );
  return data.suggestions;
}

export async function createWorktree(
  repoPath: string,
  branch?: string
): Promise<{
  branchName: string;
  mountainName: string;
  worktreePath: string | null;
}> {
  const res = await fetch(
    '/workspaces/worktree?path=' + encodeURIComponent(repoPath),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch }),
    }
  );
  // Throw the typed HttpError (status/code/details preserved) so the shared
  // worktrees.create action bridge can normalize gateway error codes; existing
  // callers that read `error.message` stay backward-compatible since HttpError
  // extends Error with the same message string.
  if (!res.ok) {
    throw await httpErrorFromResponse(res, 'Failed to create worktree');
  }
  return jsonEither<{
    branchName: string;
    mountainName: string;
    worktreePath: string | null;
  }>(res);
}

export async function switchBranch(
  repoPath: string,
  branch: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(
    '/workspaces/branch?path=' + encodeURIComponent(repoPath),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch }),
    }
  );
  return jsonEither<{ success: boolean; error?: string }>(res);
}

export async function fetchBranches(
  repoPath: string,
  options: { refresh?: boolean } = {}
): Promise<BranchInfo[]> {
  const params = new URLSearchParams({ repo: repoPath });
  if (options.refresh) params.set('refresh', '1');
  return json<BranchInfo[]>(await fetch('/git/branches?' + params.toString()));
}

export interface EnrichBranchesResult {
  results: Record<string, { pr: PrInfo | null; stale: boolean }>;
}

/** How long one batched enrichment may run before the client gives up.
 *  Server-side `gh`/`git` subprocesses are bounded at 5-10 s each and run
 *  concurrently, so anything past this is a wedged connection, not slow work. */
const ENRICH_BRANCHES_TIMEOUT_MS = 30_000;

/**
 * Throws on a non-2xx response or a timeout so the caller can leave its
 * freshness metadata unstamped and retry, rather than treating an error as
 * "this repo has no pull requests".
 */
export async function enrichBranches(
  branches: Array<{ repoPath: string; branchName: string }>
): Promise<EnrichBranchesResult> {
  const res = await fetch('/gh/enrich-branches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branches }),
    signal: AbortSignal.timeout(ENRICH_BRANCHES_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`enrich-branches failed: HTTP ${res.status}`);
  }
  return jsonEither<EnrichBranchesResult>(res);
}

export interface CreateSessionBody {
  nodeId?: NodeId | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | null | undefined;
  cwd?: string | undefined;
  type?: 'terminal' | undefined;
  mode?: 'pty' | undefined;
  branchName?: string | undefined;
  terminalBackend?: 'relay-pty' | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  needsBranchRename?: boolean | undefined;
  newWorktree?: boolean | undefined;
  branchRenamePrompt?: string | undefined;
  sessionLane?: SessionLane | undefined;
  workContextId?: string | undefined;
  workspaceTopicId?: string | undefined;
  /** #740: Bench-inherited env overrides applied additively to the PTY env.
   *  Reserved keys (`PATH`, `RELAY_*`) are refused by the backend. */
  envOverrides?: Record<string, string> | undefined;
}

function sessionCreatePath(nodeId?: NodeId | undefined): string {
  return nodeId && nodeId !== DEFAULT_LOCAL_NODE_ID
    ? '/hub/nodes/' + encodeURIComponent(nodeId) + '/sessions'
    : '/sessions';
}

async function postSessionCreate(
  sessionPath: string,
  sessionBody: Omit<CreateSessionBody, 'nodeId'>,
  confirmationToken?: string
): Promise<Response> {
  return fetch(sessionPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...sessionBody,
      ...(confirmationToken ? { confirmationToken } : {}),
    }),
  });
}

async function parseSessionCreateResponse(
  res: Response,
  retryContext?: {
    sessionPath: string;
    sessionBody: Omit<CreateSessionBody, 'nodeId'>;
  }
): Promise<SessionSummary> {
  if (res.ok) return jsonEither<SessionSummary>(res);

  const error = await httpErrorFromResponse(res);
  const challenge = confirmationChallengeFromError(error);
  if (error.code === 'CONFIRMATION_REQUIRED' && challenge) {
    if (retryContext) {
      registerConfirmationRetry({
        challenge,
        label: challenge.intent.action,
        paramsHash: challenge.canonicalParamsHash,
        retry: async (confirmationToken) =>
          parseSessionCreateResponse(
            await postSessionCreate(
              retryContext.sessionPath,
              retryContext.sessionBody,
              confirmationToken
            )
          ),
      });
    }
    throw new ConfirmationRequiredError(error, challenge);
  }

  if (res.status === 409) {
    const sessionId =
      typeof error.details?.['sessionId'] === 'string'
        ? error.details['sessionId']
        : '';
    throw new ConflictError(sessionId);
  }

  throw error;
}

export async function createSession(
  body: CreateSessionBody
): Promise<SessionSummary> {
  const { nodeId, ...sessionBody } = body;
  const sessionPath = sessionCreatePath(nodeId);
  const session = await parseSessionCreateResponse(
    await postSessionCreate(sessionPath, sessionBody),
    {
      sessionPath,
      sessionBody,
    }
  );
  if (typeof window !== 'undefined' && session.workContextId) {
    window.dispatchEvent(
      new CustomEvent('relay-active-work-changed', {
        detail: { workContextId: session.workContextId, sessionId: session.id },
      })
    );
  }
  return session;
}

export async function killSession(
  id: string,
  nodeId?: NodeId | string
): Promise<void> {
  const sessionPath =
    nodeId && nodeId !== DEFAULT_LOCAL_NODE_ID
      ? `/hub/nodes/${encodeURIComponent(nodeId)}/sessions/${encodeURIComponent(id)}`
      : `/sessions/${encodeURIComponent(id)}`;
  const res = await fetch(sessionPath, { method: 'DELETE' });
  if (res.ok) return;

  const error = await httpErrorFromResponse(res, 'Failed to close session');
  const challenge = confirmationChallengeFromError(error);
  if (error.code === 'CONFIRMATION_REQUIRED' && challenge) {
    registerConfirmationRetry({
      challenge,
      label: challenge.intent.action,
      paramsHash: challenge.canonicalParamsHash,
      retry: async (confirmationToken) => {
        const retryRes = await fetch(sessionPath, {
          method: 'DELETE',
          headers: { 'x-confirmation-token': confirmationToken },
        });
        if (!retryRes.ok)
          throw await httpErrorFromResponse(
            retryRes,
            'Failed to close session'
          );
      },
    });
    throw new ConfirmationRequiredError(error, challenge);
  }
  throw error;
}

export async function renameSession(
  id: string,
  displayName: string,
  nodeId?: NodeId | string
): Promise<SessionSummary> {
  const sessionPath =
    nodeId && nodeId !== DEFAULT_LOCAL_NODE_ID
      ? `/hub/nodes/${encodeURIComponent(nodeId)}/sessions/${encodeURIComponent(id)}`
      : `/sessions/${encodeURIComponent(id)}`;
  const res = await fetch(sessionPath, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  // The local PATCH 404 body is `{error:'Session not found'}` (non-envelope);
  // httpErrorFromResponse normalizes both that and routed RelayError envelopes.
  if (!res.ok)
    throw await httpErrorFromResponse(res, 'Failed to rename session');
  return jsonEither<SessionSummary>(res);
}

export async function fetchWorktreeStatus(
  worktreePath: string
): Promise<{ activeSessions: string[]; hasUncommittedChanges: boolean }> {
  const res = await fetch(
    '/worktrees/status?path=' + encodeURIComponent(worktreePath)
  );
  if (!res.ok) {
    throw new Error(
      await parseErrorBody(res, 'Failed to fetch worktree status')
    );
  }
  return jsonEither<{
    activeSessions: string[];
    hasUncommittedChanges: boolean;
  }>(res);
}

export async function deleteWorktree(
  worktreePath: string,
  repoPath: string,
  force?: boolean,
  // The DELETE /worktrees route treats `deleteBranch !== false` as true, so an
  // omitted flag deletes the branch. Archive (branch-PRESERVING) MUST pass
  // `false` explicitly; delete (branch-DELETING) leaves it undefined.
  deleteBranch?: boolean
): Promise<void> {
  const res = await fetch('/worktrees', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      worktreePath,
      repoPath,
      force,
      ...(deleteBranch !== undefined ? { deleteBranch } : {}),
    }),
  });
  // The DELETE /worktrees route is force-only — it never emits the
  // CONFIRMATION_REQUIRED challenge envelope (the 409 bodies are plain-string
  // `{ error: 'active_sessions' | 'uncommitted_changes' }`), so there is no
  // confirmation-retry registration here. The blocking conditions surface as
  // a typed HttpError whose `code` carries the plain-string reason; callers
  // re-issue with force after the DeleteWorktreeDialog status-check confirms.
  if (!res.ok) {
    throw await httpErrorFromResponse(res, 'Failed to delete worktree');
  }
}

export async function uploadImage(
  sessionId: string,
  data: string,
  mimeType: string
): Promise<{
  path: string;
  clipboardSet: boolean;
  inserted?: boolean;
  mode?: 'clipboard' | 'path' | 'attachment';
}> {
  return json<{
    path: string;
    clipboardSet: boolean;
    inserted?: boolean;
    mode?: 'clipboard' | 'path' | 'attachment';
  }>(
    await fetch('/sessions/' + encodeURIComponent(sessionId) + '/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, mimeType }),
    })
  );
}

export async function checkVersion(): Promise<{
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  channel: string;
}> {
  return json<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    channel: string;
  }>(await fetch('/version'));
}

export async function triggerUpdate(): Promise<{
  ok: boolean;
  restarting?: boolean;
  /** Absent unless the server ran but could not confirm a version change. */
  verified?: boolean;
  version?: string | null;
  /** Which supervisor the server bet on restarting it (`none` when it stays up). */
  supervision?: string;
  /** Boot id of the process answering this request — the one going away. */
  bootId?: string;
  error?: string;
}> {
  // json() throws an HttpError carrying the server's `error` string, so the
  // caller can show why the update failed instead of a generic message.
  return json<{
    ok: boolean;
    restarting?: boolean;
    version?: string | null;
    supervision?: string;
    bootId?: string;
    error?: string;
    verified?: boolean;
  }>(await fetch('/update', { method: 'POST' }));
}

/** Neutral copy for an install that ran without changing the install root. */
export const UPDATE_NO_CHANGE_TEXT = 'No version change detected.';

/**
 * Failure text for an update attempt. Only an HttpError carries the server's
 * explanation; a transport failure can also mean the server exited mid-request
 * after a successful install, so those stay generic.
 */
export function updateFailureText(err: unknown): string {
  const detail = err instanceof HttpError ? err.message.trim() : '';
  return detail
    ? `Update failed: ${detail}`
    : 'Update failed. Please try again.';
}

export async function fetchUpdateChannel(): Promise<'stable' | 'nightly'> {
  const data = await json<{ channel: 'stable' | 'nightly' }>(
    await fetch('/update-channel')
  );
  return data.channel;
}

export async function setUpdateChannel(
  channel: 'stable' | 'nightly'
): Promise<void> {
  const res = await fetch('/update-channel', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  });
  if (!res.ok) throw new Error('Failed to update channel');
}

export async function fetchDefaultAgent(): Promise<string> {
  const data = await json<{ defaultAgent: string }>(
    await fetch('/config/defaultAgent')
  );
  return data.defaultAgent;
}

export async function setDefaultAgent(agent: string): Promise<void> {
  const res = await fetch('/config/defaultAgent', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultAgent: agent }),
  });
  if (!res.ok) throw new Error('Failed to update default agent');
}

async function fetchConfigBool(key: string): Promise<boolean> {
  const data = await json<Record<string, boolean>>(
    await fetch(`/config/${key}`)
  );
  return data[key]!;
}

async function setConfigBool(key: string, value: boolean): Promise<void> {
  const res = await fetch(`/config/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, `Failed to update ${key}`));
  }
}

export const fetchDefaultNotifications = () =>
  fetchConfigBool('defaultNotifications');
export const setDefaultNotifications = (v: boolean) =>
  setConfigBool('defaultNotifications', v);

export type RenamerTool = 'claude' | 'codex' | 'none' | 'custom-script';

export interface RenamerToolConfig {
  renamerTool: RenamerTool;
  renamerCustomScript?: string;
}

export async function fetchRenamerTool(): Promise<RenamerToolConfig> {
  const data = await json<RenamerToolConfig>(
    await fetch('/config/renamerTool')
  );
  return data;
}

export async function setRenamerTool(
  renamerTool: RenamerTool,
  renamerCustomScript?: string
): Promise<void> {
  const body: Record<string, string> = { renamerTool };
  if (renamerTool === 'custom-script' && renamerCustomScript) {
    body['renamerCustomScript'] = renamerCustomScript;
  }
  const res = await fetch('/config/renamerTool', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to update renamer tool');
}

export async function fetchVapidKey(): Promise<string | null> {
  try {
    const data = await json<{ vapidPublicKey: string }>(
      await fetch('/push/vapid-key')
    );
    return data.vapidPublicKey;
  } catch {
    return null;
  }
}

export async function pushSubscribe(
  subscription: PushSubscriptionJSON,
  sessionIds: string[]
): Promise<void> {
  const res = await fetch('/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, sessionIds }),
  });
  if (!res.ok) throw new Error('Push subscribe failed');
}

export async function pushUnsubscribe(endpoint: string): Promise<void> {
  await fetch('/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}

export async function fetchWorkspaceSettings(
  repoPath: string
): Promise<WorkspaceSettings> {
  return json<WorkspaceSettings>(
    await fetch('/workspaces/settings?path=' + encodeURIComponent(repoPath))
  );
}

export interface MergedWorkspaceSettings {
  settings: WorkspaceSettings;
  overridden: string[];
}

export async function fetchMergedWorkspaceSettings(
  repoPath: string
): Promise<MergedWorkspaceSettings> {
  return json<MergedWorkspaceSettings>(
    await fetch(
      '/workspaces/settings/merged?path=' + encodeURIComponent(repoPath)
    )
  );
}

export async function updateWorkspaceSettings(
  repoPath: string,
  settings: WorkspaceSettings
): Promise<void> {
  const res = await fetch(
    '/workspaces/settings?path=' + encodeURIComponent(repoPath),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }
  );
  if (!res.ok) {
    throw new Error(
      await parseErrorBody(res, 'Failed to update workspace settings')
    );
  }
}

export async function fetchOrgPrs(): Promise<OrgPrsResponse> {
  const res = await fetch('/org-dashboard/prs');
  return json<OrgPrsResponse>(res);
}

export async function fetchGithubIssues(): Promise<GitHubIssuesResponse> {
  const res = await fetch('/integration-github/issues');
  return json<GitHubIssuesResponse>(res);
}

export async function fetchBranchLinks(): Promise<BranchLinksResponse> {
  const res = await fetch('/branch-linker/links');
  return json<BranchLinksResponse>(res);
}

export async function fetchJiraIssues(): Promise<JiraIssuesResponse> {
  const res = await fetch('/integration-jira/issues');
  return json<JiraIssuesResponse>(res);
}

export async function fetchJiraStatuses(
  projectKey: string
): Promise<JiraStatus[]> {
  const data = await json<{ statuses: JiraStatus[] }>(
    await fetch(
      '/integration-jira/statuses?projectKey=' + encodeURIComponent(projectKey)
    )
  );
  return data.statuses;
}

export async function fetchAnalyticsSize(): Promise<{ bytes: number }> {
  return json<{ bytes: number }>(await fetch('/analytics/size'));
}

export async function clearAnalytics(): Promise<void> {
  const res = await fetch('/analytics/events', { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to clear analytics');
}

export async function fetchPresets(): Promise<FilterPreset[]> {
  const res = await fetch('/presets', { credentials: 'include' });
  return json<FilterPreset[]>(res);
}

export async function savePreset(preset: {
  name: string;
  filters: FilterPreset['filters'];
  sort: FilterPreset['sort'];
}): Promise<void> {
  const res = await fetch('/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(preset),
  });
  if (!res.ok) throw new Error('Failed to save preset');
}

export async function deletePreset(name: string): Promise<void> {
  const res = await fetch(`/presets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to delete preset');
}

export async function fetchGitHubStatus(): Promise<{
  connected: boolean;
  username: string | null;
  deviceFlowStatus?: 'polling' | 'denied' | 'expired';
}> {
  return json<{
    connected: boolean;
    username: string | null;
    deviceFlowStatus?: 'polling' | 'denied' | 'expired';
  }>(await fetch('/auth/github/status', { credentials: 'include' }));
}

export async function initiateGitHubDevice(): Promise<{
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}> {
  return json<{ userCode: string; verificationUri: string; expiresIn: number }>(
    await fetch('/auth/github', { credentials: 'include' })
  );
}

export async function disconnectGitHub(): Promise<void> {
  const res = await fetch('/auth/github/disconnect', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to disconnect GitHub');
}

// ── Webhook management ────────────────────────────────────────────────────────

export interface WebhookStatus {
  configured: boolean;
  smeeConnected: boolean;
  lastEventAt: string | null;
  autoProvision: boolean;
  secretPreview: string | null;
}

export interface BackfillResult {
  total: number;
  success: number;
  failed: number;
  results: Array<{
    path: string;
    ownerRepo: string | null;
    ok: boolean;
    error?: string;
  }>;
}

export async function fetchWebhookStatus(): Promise<WebhookStatus> {
  return json<WebhookStatus>(
    await fetch('/webhooks/manage/status', { credentials: 'include' })
  );
}

export async function setupWebhooks(): Promise<{
  ok: boolean;
  smeeUrl?: string;
  error?: string;
}> {
  return json<{ ok: boolean; smeeUrl?: string; error?: string }>(
    await fetch('/webhooks/manage/setup', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function removeWebhookSetup(): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/setup', {
      method: 'DELETE',
      credentials: 'include',
    })
  );
}

export async function reloadWebhooks(): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/reload', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function pingWebhook(): Promise<{ ok: boolean; error?: string }> {
  return json<{ ok: boolean; error?: string }>(
    await fetch('/webhooks/manage/ping', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function createRepoWebhook(
  repoPath: string
): Promise<{ ok: boolean; webhookId?: number; error?: string }> {
  return json<{ ok: boolean; webhookId?: number; error?: string }>(
    await fetch('/webhooks/manage/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repoPath }),
    })
  );
}

export async function removeRepoWebhook(
  repoPath: string
): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/repos/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repoPath }),
    })
  );
}

export async function backfillWebhooks(): Promise<BackfillResult> {
  return json<BackfillResult>(
    await fetch('/webhooks/manage/backfill', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function updateConfigAutoProvision(
  autoProvision: boolean
): Promise<void> {
  const res = await fetch('/config/autoProvision', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ autoProvision }),
  });
  if (!res.ok) throw new Error('Failed to update auto-provision setting');
}

// ── Workspace groups ──────────────────────────────────────────────────────────

function normalizeWorkspaceGroup(value: Workspace, index: number): Workspace {
  const raw = value as Workspace & { repos?: unknown; order?: unknown };
  return {
    ...value,
    repos: Array.isArray(raw.repos)
      ? raw.repos.filter((repo): repo is string => typeof repo === 'string')
      : [],
    order: typeof raw.order === 'number' ? raw.order : index,
  };
}

export async function fetchWorkspaceGroups(): Promise<Workspace[]> {
  const data = await json<Workspace[]>(await fetch('/workspace-groups'));
  return Array.isArray(data)
    ? data.map((workspace, index) => normalizeWorkspaceGroup(workspace, index))
    : [];
}

export async function createWorkspaceGroup(data: {
  name: string;
  repos: string[];
  themeColor?: string;
}): Promise<Workspace> {
  const res = await fetch('/workspace-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(await parseErrorBody(res, 'Failed to create workspace'));
  return jsonEither<Workspace>(res);
}

export async function updateWorkspaceGroup(
  id: string,
  data: Partial<Workspace>
): Promise<Workspace> {
  const res = await fetch(`/workspace-groups/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(await parseErrorBody(res, 'Failed to update workspace'));
  return jsonEither<Workspace>(res);
}

export async function deleteWorkspaceGroup(id: string): Promise<void> {
  const res = await fetch(`/workspace-groups/${id}`, { method: 'DELETE' });
  if (!res.ok)
    throw new Error(await parseErrorBody(res, 'Failed to delete workspace'));
}

export async function launchWorkspaceSession(
  workspaceId: string,
  opts?: {
    terminalBackend?: 'relay-pty';
    cols?: number;
    rows?: number;
  }
): Promise<
  SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }
> {
  const res = await fetch(`/workspace-groups/${workspaceId}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  // Throw the typed HttpError so workspaces.launch can normalize gateway codes
  // (NOT_FOUND for a missing workspace id, etc.); message stays identical for
  // existing string-reading callers.
  if (!res.ok)
    throw await httpErrorFromResponse(
      res,
      'Failed to launch workspace session'
    );
  return jsonEither<
    SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }
  >(res);
}

export interface FilesListResponse {
  files: string[];
  truncated: boolean;
  total: number;
  error?: string;
}

/** Swallows HTTP errors and returns empty list with an `error` field. */
export async function fetchFilesList(
  repoPath: string
): Promise<FilesListResponse> {
  const params = new URLSearchParams({ path: repoPath });
  const res = await fetch('/workspaces/files-list?' + params.toString());
  if (!res.ok) {
    return {
      files: [],
      truncated: false,
      total: 0,
      error: `HTTP ${res.status}`,
    };
  }
  return jsonEither<FilesListResponse>(res);
}

/** Swallows HTTP errors and returns an empty ChangedFilesResponse with an `error` field. */
export async function fetchChangedFiles(
  repoPath: string,
  base?: string
): Promise<ChangedFilesResponse> {
  const params = new URLSearchParams({ path: repoPath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/changed-files?' + params.toString());
  if (!res.ok) {
    return {
      files: [],
      aggregate: { additions: 0, deletions: 0, fileCount: 0 },
      error: `HTTP ${res.status}`,
    };
  }
  return jsonEither<ChangedFilesResponse>(res);
}

function isBranchDivergenceSummary(
  value: unknown
): value is BranchDivergenceSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BranchDivergenceSummary>;
  return (
    typeof candidate.repoPath === 'string' &&
    typeof candidate.aheadCount === 'number' &&
    typeof candidate.behindCount === 'number' &&
    Boolean(candidate.lineDelta) &&
    Boolean(candidate.dirty) &&
    Boolean(candidate.commits) &&
    typeof candidate.state === 'string' &&
    Array.isArray(candidate.baseCandidates) &&
    Array.isArray(candidate.warnings) &&
    typeof candidate.generatedAt === 'string'
  );
}

function emptyDivergenceSummary(
  repoPath: string,
  error: string
): BranchDivergenceSummary {
  return {
    repoPath,
    currentBranch: null,
    headSha: null,
    selectedBase: null,
    baseCandidates: [],
    aheadCount: 0,
    behindCount: 0,
    lineDelta: { additions: 0, deletions: 0, fileCount: 0 },
    dirty: {
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      files: [],
      truncated: false,
    },
    commits: { ahead: [], behind: [] },
    state: 'missing_base',
    error,
    warnings: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function fetchDivergence(
  repoPath: string,
  base?: string
): Promise<BranchDivergenceSummary> {
  const params = new URLSearchParams({ path: repoPath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/divergence?' + params.toString());
  if (!res.ok) {
    try {
      const parsed = await jsonEither<unknown>(res);
      if (isBranchDivergenceSummary(parsed)) return parsed;
    } catch {
      // Fall through to the generic transport fallback below.
    }
    return emptyDivergenceSummary(repoPath, `HTTP ${res.status}`);
  }
  return jsonEither<BranchDivergenceSummary>(res);
}

/** Swallows HTTP errors and returns `{ diff: '', error }` on failure. */
export async function fetchFileDiff(
  repoPath: string,
  filePath: string,
  base?: string
): Promise<FileDiffResponse> {
  const params = new URLSearchParams({ path: repoPath, file: filePath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/file-diff?' + params.toString());
  if (!res.ok) {
    return { diff: '', error: `HTTP ${res.status}` };
  }
  return jsonEither<FileDiffResponse>(res);
}

/** Swallows HTTP errors and returns `{ content: '', error }` on failure. */
export async function fetchFileContent(
  repoPath: string,
  filePath: string
): Promise<import('./types.js').FileContentResponse> {
  const params = new URLSearchParams({ path: repoPath, file: filePath });
  const res = await fetch('/workspaces/file-content?' + params.toString());
  if (!res.ok) {
    return { content: '', error: `HTTP ${res.status}` };
  }
  return jsonEither<import('./types.js').FileContentResponse>(res);
}

export interface SaveFileContentResult {
  mtimeMs: number;
  sizeBytes: number;
}

/** Thrown when the on-disk mtime no longer matches the caller's baseline (412). */
export class FileContentConflictError extends Error {
  mtimeMs: number;
  sizeBytes: number;
  contentHash: string;
  constructor(conflict: {
    mtimeMs: number;
    sizeBytes: number;
    contentHash: string;
  }) {
    super('file modified on disk');
    this.name = 'FileContentConflictError';
    this.mtimeMs = conflict.mtimeMs;
    this.sizeBytes = conflict.sizeBytes;
    this.contentHash = conflict.contentHash;
  }
}

/** Thrown when the proposed content exceeds the server write cap (413). */
export class FileContentOversizeError extends Error {
  sizeBytes: number;
  maxBytes: number;
  constructor(sizeBytes: number, maxBytes: number) {
    super('file too large to save');
    this.name = 'FileContentOversizeError';
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Save UTF-8 file content via `PUT /workspaces/file-content`. Pass
 * `expectedMtimeMs` for optimistic concurrency — omit it to force an overwrite
 * ("keep mine"). Throws `FileContentConflictError` on 412 and
 * `FileContentOversizeError` on 413; other failures throw `HttpError`.
 */
export async function saveFileContent(
  repoPath: string,
  filePath: string,
  content: string,
  expectedMtimeMs?: number
): Promise<SaveFileContentResult> {
  const params = new URLSearchParams({ path: repoPath, file: filePath });
  const res = await fetch('/workspaces/file-content?' + params.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      expectedMtimeMs !== undefined ? { content, expectedMtimeMs } : { content }
    ),
  });
  if (res.status === 412) {
    const data = await jsonEither<{
      mtimeMs?: number;
      sizeBytes?: number;
      contentHash?: string;
    }>(res);
    throw new FileContentConflictError({
      mtimeMs: data.mtimeMs ?? 0,
      sizeBytes: data.sizeBytes ?? 0,
      contentHash: data.contentHash ?? '',
    });
  }
  if (res.status === 413) {
    const data = await jsonEither<{ sizeBytes?: number; maxBytes?: number }>(
      res
    );
    throw new FileContentOversizeError(data.sizeBytes ?? 0, data.maxBytes ?? 0);
  }
  if (!res.ok) {
    throw await httpErrorFromResponse(res, 'Failed to save file');
  }
  return jsonEither<SaveFileContentResult>(res);
}

/** Swallows HTTP errors and returns `'main'` on failure or when the branch is empty. */
export async function fetchDefaultBranch(repoPath: string): Promise<string> {
  const params = new URLSearchParams({ path: repoPath });
  try {
    const data = await jsonOrNull<{ branch: string }>(
      await fetch('/workspaces/default-branch?' + params.toString())
    );
    return data?.branch || 'main';
  } catch {
    return 'main';
  }
}

// ── Session Analytics API ──

export async function fetchAnalyticsOverview(
  days = 7,
  repo?: string
): Promise<AnalyticsOverview> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  return json<AnalyticsOverview>(
    await fetch(`/api/analytics/overview?${params}`)
  );
}

export async function fetchAnalyticsSessions(opts?: {
  offset?: number;
  limit?: number;
  repo?: string;
  agent?: string;
  sort?: string;
}): Promise<AnalyticsSessionsResponse> {
  const params = new URLSearchParams();
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.repo) params.set('repo', opts.repo);
  if (opts?.agent) params.set('agent', opts.agent);
  if (opts?.sort) params.set('sort', opts.sort);
  return json<AnalyticsSessionsResponse>(
    await fetch(`/api/analytics/sessions?${params}`)
  );
}

export async function fetchAnalyticsSessionDetail(
  id: string
): Promise<AnalyticsSessionDetail> {
  return json<AnalyticsSessionDetail>(
    await fetch(`/api/analytics/sessions/${encodeURIComponent(id)}`)
  );
}

export async function fetchAnalyticsTrends(
  days = 30,
  repo?: string
): Promise<{ days: AnalyticsTrend[] }> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  return json<{ days: AnalyticsTrend[] }>(
    await fetch(`/api/analytics/trends?${params}`)
  );
}

export async function fetchAnalyticsTools(
  days = 7,
  repo?: string,
  session?: string
): Promise<AnalyticsToolBreakdown> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  if (session) params.set('session', session);
  return json<AnalyticsToolBreakdown>(
    await fetch(`/api/analytics/tools?${params}`)
  );
}

export async function fetchAnalyticsRateLimits(
  hours = 24
): Promise<AnalyticsRateLimitHistory> {
  return json<AnalyticsRateLimitHistory>(
    await fetch(`/api/analytics/rate-limits?hours=${hours}`)
  );
}

export async function fetchFrameworks(): Promise<FrameworkInfo[]> {
  const data = await json<{ frameworks: FrameworkInfo[] }>(
    await fetch('/api/frameworks')
  );
  return data.frameworks;
}

// ── Agent profiles ──────────────────────────────────────────────────────────

/**
 * The editable, vendor-neutral overlay fields for an AgentProfile. Framework
 * facts remain in `/api/frameworks`, keyed by `providerId`.
 */
export interface AgentProfileWriteInput {
  providerId: string;
  displayName?: string;
  systemPrompt?: string | null;
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
  envVars?: Record<string, string> | null;
  /**
   * Hermes multiplex profile binding (#1453). `null` CLEARS the binding; the
   * empty string is a deliberate 400 at the router, so an emptied field must
   * serialize as `null` and never as `''`.
   */
  hermesProfile?: string | null;
  namePool?: string[] | null;
  respondTo?: AgentProfileRespondTo;
  respondToAllowlist?: string[] | null;
}

const AGENT_PROFILES_PATH = '/agent-profiles';

export async function fetchAgentProfiles(): Promise<AgentProfile[]> {
  const data = await json<{ profiles?: AgentProfile[] }>(
    await fetch(AGENT_PROFILES_PATH)
  );
  return Array.isArray(data.profiles) ? data.profiles : [];
}

export async function createAgentProfile(
  input: AgentProfileWriteInput
): Promise<AgentProfile> {
  const data = await json<{ profile: AgentProfile }>(
    await fetch(AGENT_PROFILES_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
  return data.profile;
}

export async function updateAgentProfile(
  id: string,
  input: AgentProfileWriteInput
): Promise<AgentProfile> {
  const data = await json<{ profile: AgentProfile }>(
    await fetch(`${AGENT_PROFILES_PATH}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
  return data.profile;
}

export async function deleteAgentProfile(id: string): Promise<void> {
  const response = await fetch(
    `${AGENT_PROFILES_PATH}/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    }
  );
  if (!response.ok) throw await httpErrorFromResponse(response);
}

export async function setDefaultAgentProfile(
  id: string
): Promise<AgentProfile> {
  const data = await json<{ profile: AgentProfile }>(
    await fetch(`${AGENT_PROFILES_PATH}/${encodeURIComponent(id)}/default`, {
      method: 'POST',
    })
  );
  return data.profile;
}

// ── Workspace branch operations ───────────────────────────────────────────────

export async function renameBranch(
  path: string,
  newName: string
): Promise<{
  success?: boolean;
  oldName?: string;
  newName?: string;
  error?: string;
}> {
  const res = await fetch(
    '/workspaces/rename-branch?path=' + encodeURIComponent(path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName }),
    }
  );
  return jsonEither<{
    success?: boolean;
    oldName?: string;
    newName?: string;
    error?: string;
  }>(res);
}

export async function pushBranch(
  path: string,
  branch: string,
  deleteOldBranch: string
): Promise<{ success?: boolean; error?: string }> {
  const res = await fetch(
    '/workspaces/push-branch?path=' + encodeURIComponent(path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, deleteOldBranch }),
    }
  );
  return jsonEither<{ success?: boolean; error?: string }>(res);
}

export async function setPrBase(
  path: string,
  prNumber: number,
  baseBranch: string
): Promise<{ success?: boolean; error?: string }> {
  const res = await fetch(
    '/workspaces/pr-base?path=' + encodeURIComponent(path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber, baseBranch }),
    }
  );
  return jsonEither<{ success?: boolean; error?: string }>(res);
}

export async function fetchWorkspaceBranches(
  path: string
): Promise<BranchInfo[]> {
  return json<BranchInfo[]>(
    await fetch('/branches?path=' + encodeURIComponent(path))
  );
}

// ── Security audit log ────────────────────────────────────────────────────────

export interface SecurityAuditEntryRow {
  eventId: string;
  timestamp: string;
  sequence: number;
  schemaVersion: number;
  eventType: string;
  decision: string;
  reasonCode: string;
  peer: {
    kind: string;
    nodeId?: string;
    displayName?: string;
    principalHash?: string;
  };
  node: { nodeId?: string; trustTier?: string };
  sessionId?: string;
  intent: { action: string; target?: string };
  scopeHash: string;
  paramsHash: string;
  requiredBits: string[];
  grantedBits: string[];
  deniedBits: string[];
  aclRef?: string;
  policyVersion?: string;
  correlationId: string;
  prevHash: string | null;
  entryHash: string;
}

export interface SecurityAuditEntriesResponse {
  entries: SecurityAuditEntryRow[];
  nextBeforeSequence: number | null;
  head: { latestSequence: number; latestHash: string | null };
}

export interface SecurityAuditVerifyResponse {
  ok: boolean;
  entriesVerified: number;
  lastHash: string | null;
  break?: {
    sequence: number;
    eventId?: string;
    reason: string;
    expected?: string | number | null;
    actual?: string | number | null;
  };
}

export async function fetchSecurityAuditEntries(params?: {
  beforeSequence?: number | null;
  limit?: number;
}): Promise<SecurityAuditEntriesResponse> {
  const qs = new URLSearchParams();
  if (params?.beforeSequence != null)
    qs.set('beforeSequence', String(params.beforeSequence));
  if (params?.limit) qs.set('limit', String(params.limit));
  return json<SecurityAuditEntriesResponse>(
    await fetch(`/hub/audit/entries${qs.toString() ? '?' + qs.toString() : ''}`)
  );
}

export async function fetchSecurityAuditVerify(options?: {
  force?: boolean;
}): Promise<SecurityAuditVerifyResponse> {
  const query = options?.force ? '?force=1' : '';
  return json<SecurityAuditVerifyResponse>(
    await fetch(`/hub/audit/verify${query}`)
  );
}

// ---------------------------------------------------------------------------
// Workbench layout API (slice 3 of epic #612)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom block proposals — slice 4, #622
// ---------------------------------------------------------------------------

import type {
  CustomBlockProposal,
  CustomBlockProposalInput,
} from '../../../shared/workbench-custom-blocks.js';

/**
 * Fetch the list of custom block proposals, optionally filtered by status.
 */
export async function fetchCustomBlockProposals(
  status?: 'pending' | 'approved' | 'rejected' | 'revoked'
): Promise<CustomBlockProposal[]> {
  const url = status
    ? `/workbench/custom-blocks/proposals?status=${status}`
    : '/workbench/custom-blocks/proposals';
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to fetch custom block proposals')
    );
  return json<CustomBlockProposal[]>(res);
}

/**
 * Fetch a single custom block proposal by id, regardless of status.
 * Used by CustomBlock to look up pending/revoked proposals that would be missed
 * by the approved-only list query.
 */
export async function fetchCustomBlockProposalById(
  proposalId: string
): Promise<CustomBlockProposal> {
  const res = await fetch(
    `/workbench/custom-blocks/proposals/${encodeURIComponent(proposalId)}`
  );
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to fetch custom block proposal')
    );
  return json<CustomBlockProposal>(res);
}

/**
 * Submit a new custom block proposal (agent-facing).
 * Returns the created proposal with server-generated proposalId.
 */
export async function submitCustomBlockProposal(
  input: CustomBlockProposalInput
): Promise<CustomBlockProposal> {
  const res = await fetch('/workbench/custom-blocks/proposals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to submit custom block proposal')
    );
  return json<CustomBlockProposal>(res);
}

/**
 * Approve a pending custom block proposal (user-facing).
 */
export async function approveCustomBlockProposal(
  proposalId: string
): Promise<CustomBlockProposal> {
  const res = await fetch(
    `/workbench/custom-blocks/proposals/${proposalId}/approve`,
    { method: 'POST' }
  );
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to approve custom block proposal')
    );
  return json<CustomBlockProposal>(res);
}

/**
 * Reject a pending custom block proposal (user-facing).
 */
export async function rejectCustomBlockProposal(
  proposalId: string
): Promise<CustomBlockProposal> {
  const res = await fetch(
    `/workbench/custom-blocks/proposals/${proposalId}/reject`,
    { method: 'POST' }
  );
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to reject custom block proposal')
    );
  return json<CustomBlockProposal>(res);
}

/**
 * Revoke a previously-approved custom block proposal (user-facing).
 * Affected mounted blocks will render a "revoked" card.
 */
export async function revokeCustomBlockProposal(
  proposalId: string
): Promise<CustomBlockProposal> {
  const res = await fetch(
    `/workbench/custom-blocks/proposals/${proposalId}/revoke`,
    { method: 'POST' }
  );
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to revoke custom block proposal')
    );
  return json<CustomBlockProposal>(res);
}

/**
 * Fetch the persisted workbench layout for a workspace.
 * Returns `null` if no layout has been saved yet (server responds 204).
 */
export async function fetchWorkbenchLayout(
  workspaceId: string
): Promise<WorkbenchLayout | null> {
  const res = await fetch(
    `/workspace-groups/${encodeURIComponent(workspaceId)}/workbench-layout`
  );
  if (res.status === 204) return null;
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to fetch workbench layout')
    );
  return json<WorkbenchLayout>(res);
}

/**
 * Persist a workbench layout for a workspace.
 * Returns the layout as stored by the server.
 */
export async function putWorkbenchLayout(
  workspaceId: string,
  layout: WorkbenchLayout
): Promise<WorkbenchLayout> {
  const res = await fetch(
    `/workspace-groups/${encodeURIComponent(workspaceId)}/workbench-layout`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    }
  );
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to save workbench layout')
    );
  return jsonEither<WorkbenchLayout>(res);
}
