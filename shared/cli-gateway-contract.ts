import { RELAY_NODE_LINK_PROTOCOL_VERSION } from './relay-node-protocol.js';
import {
  RELAY_SECURITY_POLICY_VERSION,
  type RelayCapabilityBit,
} from './security-policy.js';
import {
  CONTEXT_PACKET_KINDS,
  SESSION_INBOX_MESSAGE_STATES,
} from './context-packet.js';
import { SUPERVISOR_SEND_KEY_NAMES } from './supervisor-actions.js';

export const RELAY_CLI_GATEWAY_MAJOR = 'v1' as const;
export const RELAY_CLI_GATEWAY_CONTRACT_VERSION = '1.0' as const;

export type RelayCliGatewayCommand =
  | 'contract.list'
  | 'contract.schema'
  | 'nodes.manifest'
  | 'nodes.list'
  | 'nodes.pair.requests'
  | 'nodes.pair.approve'
  | 'nodes.pair.deny'
  | 'nodes.pair.editAccess'
  | 'nodes.rotateCredential'
  | 'nodes.revoke'
  | 'repos.add'
  | 'workspaces.launch'
  | 'worktrees.create'
  | 'worktrees.status'
  | 'worktrees.delete'
  | 'worktrees.archive'
  | 'sessions.list'
  | 'sessions.get'
  | 'sessions.create'
  | 'tickets.startWork'
  | 'branches.openSession'
  | 'sessions.renew'
  | 'sessions.attach'
  | 'sessions.detach'
  | 'sessions.kill'
  | 'sessions.rename'
  | 'sessions.stream'
  | 'sessions.wait'
  | 'sessions.screen'
  | 'sessions.input'
  | 'sessions.interventions'
  | 'files.list'
  | 'files.stat'
  | 'files.read'
  | 'files.write'
  | 'work-contexts.get'
  | 'work-contexts.resume'
  | 'work-context-messages.append'
  | 'work-context-messages.list'
  | 'work-context-messages.show'
  | 'work-context-messages.query'
  | 'work-context-messages.templates.list'
  | 'work-context-messages.templates.show'
  | 'work-context-messages.templates.render'
  | 'context.create'
  | 'context.get'
  | 'context.list'
  | 'context.pin'
  | 'context.unpin'
  | 'work-context-artifacts.publish'
  | 'work-context-artifacts.list'
  | 'work-context-artifacts.show'
  | 'work-context-artifacts.pin'
  | 'work-context-artifacts.unpin'
  | 'work-context-artifacts.export'
  | 'work-context-artifacts.doctor'
  | 'handoff-artifacts.attach'
  | 'handoff-artifacts.list'
  | 'handoff-artifacts.show'
  | 'handoff-artifacts.copy'
  | 'workflow-runs.publish'
  | 'workflow-runs.update'
  | 'workflow-runs.list'
  | 'workflow-runs.get'
  | 'automation-runs.register'
  | 'automation-runs.observe'
  | 'automation-runs.retire'
  | 'automation-runs.list'
  | 'automation-runs.get'
  | 'pr-overseer.register'
  | 'pr-overseer.observe'
  | 'pr-overseer.retire'
  | 'pr-overseer.list'
  | 'pr-overseer.get'
  | 'workspace-surfaces.list'
  | 'workspace-surfaces.publish'
  | 'workspace-topics.list'
  | 'workspace-topics.search'
  | 'workspace-topics.get'
  | 'workspace-topics.create'
  | 'workspace-topics.update'
  | 'workspace-topics.archive'
  | 'channels.post'
  | 'cockpit.list'
  | 'cockpit.get'
  | 'inbox.send'
  | 'inbox.list'
  | 'inbox.get'
  | 'inbox.ack'
  | 'inbox.resolve'
  | 'inbox.ignore'
  | 'handoffs.plan'
  | 'artifacts.read'
  | 'supervisor.snapshot'
  | 'supervisor.sessions'
  | 'supervisor.sendText'
  | 'supervisor.sendKey'
  | 'supervisor.submit'
  | 'events.subscribe'
  | 'settings.get'
  | 'settings.update'
  | 'webhooks.status'
  | 'webhooks.ping';

export type RelayCliGatewayErrorCode =
  | 'UNAUTHORIZED'
  | 'SERVER_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'INVALID_JSON'
  | 'UNSUPPORTED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'SESSION_CONFLICT'
  | 'CONFIRMATION_REQUIRED'
  | 'NODE_OFFLINE'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'SESSION_MISMATCH'
  | 'SESSION_NON_RENEWABLE'
  | 'CONTROL_STATE_STALE'
  | 'INTERVENTION_ACK_REQUIRED'
  | 'INTERVENTION_ACK_STALE'
  | 'CONTROL_STATE_UNKNOWN'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export interface RelayCliGatewayError {
  code: RelayCliGatewayErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface RelayCliGatewayOkEnvelope<T = unknown> {
  ok: true;
  contract: typeof RELAY_CLI_GATEWAY_MAJOR;
  contractVersion: typeof RELAY_CLI_GATEWAY_CONTRACT_VERSION;
  command: RelayCliGatewayCommand;
  data: T;
}

export interface RelayCliGatewayErrorEnvelope {
  ok: false;
  contract: typeof RELAY_CLI_GATEWAY_MAJOR;
  contractVersion: typeof RELAY_CLI_GATEWAY_CONTRACT_VERSION;
  command: RelayCliGatewayCommand;
  error: RelayCliGatewayError;
}

export type RelayCliGatewayEnvelope<T = unknown> =
  | RelayCliGatewayOkEnvelope<T>
  | RelayCliGatewayErrorEnvelope;

export interface RelayJsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | readonly string[];
  enum?: readonly string[];
  const?: unknown;
  properties?: Record<string, RelayJsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: RelayJsonSchema;
  anyOf?: readonly RelayJsonSchema[];
  oneOf?: readonly RelayJsonSchema[];
  format?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

export interface RelayCliGatewayCommandSpec {
  name: RelayCliGatewayCommand;
  cli: readonly string[];
  summary: string;
  stable: boolean;
  transport: 'local' | 'hub-http' | 'hub-http-or-node-rpc';
  requiresAuth: boolean;
  capabilityHints: readonly string[];
  inputSchema: RelayJsonSchema;
  outputSchema: RelayJsonSchema;
  errorCodes: readonly RelayCliGatewayErrorCode[];
  unsupported?: string;
}

export interface RelayCliGatewayContractManifest {
  schemaVersion: 1;
  contract: typeof RELAY_CLI_GATEWAY_MAJOR;
  contractVersion: typeof RELAY_CLI_GATEWAY_CONTRACT_VERSION;
  generatedFrom: 'shared/cli-gateway-contract.ts';
  protocolVersions: {
    nodeLink: typeof RELAY_NODE_LINK_PROTOCOL_VERSION;
    securityPolicy: typeof RELAY_SECURITY_POLICY_VERSION;
  };
  errorEnvelopeSchema: RelayJsonSchema;
  commandSchemas: readonly RelayCliGatewayCommandSpec[];
}

const stringSchema = { type: 'string' } as const;
const nullableStringSchema = { type: ['string', 'null'] } as const;
const booleanSchema = { type: 'boolean' } as const;

const workspaceSurfaceSchema: RelayJsonSchema = {
  title: 'WorkspaceSurface',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    kind: {
      type: 'string',
      enum: ['web', 'docs', 'preview', 'dashboard', 'logs', 'command'],
    },
    label: stringSchema,
    description: stringSchema,
    url: stringSchema,
    command: stringSchema,
    logRef: stringSchema,
    nodeId: stringSchema,
    workspaceId: stringSchema,
    rootId: stringSchema,
    repoPath: stringSchema,
    status: { type: 'string', enum: ['discovered', 'published', 'retired'] },
    health: {
      type: 'string',
      enum: ['unknown', 'reachable', 'unreachable', 'configured'],
    },
    provenance: {
      type: 'object',
      additionalProperties: true,
      properties: {
        source: {
          type: 'string',
          enum: [
            'configured',
            'package-script',
            'compose',
            'agent-published',
            'process-scan',
          ],
        },
        detail: stringSchema,
        actor: stringSchema,
        sessionId: stringSchema,
        workContextId: stringSchema,
      },
      required: ['source'],
    },
    openMode: {
      type: 'string',
      enum: ['direct', 'node-scoped', 'copy', 'unavailable'],
    },
    createdAt: stringSchema,
    updatedAt: stringSchema,
  },
  required: [
    'id',
    'kind',
    'label',
    'nodeId',
    'status',
    'health',
    'provenance',
    'openMode',
  ],
};

const workspaceSurfacesListOutputDataSchema: RelayJsonSchema = {
  title: 'WorkspaceSurfacesListData',
  type: 'object',
  additionalProperties: false,
  properties: {
    surfaces: { type: 'array', items: workspaceSurfaceSchema },
    truncated: booleanSchema,
  },
  required: ['surfaces', 'truncated'],
};

const workspaceSurfacesPublishInputSchema: RelayJsonSchema = {
  title: 'WorkspaceSurfacesPublishInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    kind: {
      type: 'string',
      enum: ['web', 'docs', 'preview', 'dashboard', 'logs', 'command'],
    },
    label: stringSchema,
    description: stringSchema,
    url: stringSchema,
    command: stringSchema,
    logRef: stringSchema,
    nodeId: stringSchema,
    workspaceId: stringSchema,
    rootId: stringSchema,
    repoPath: stringSchema,
    health: {
      type: 'string',
      enum: ['unknown', 'reachable', 'unreachable', 'configured'],
    },
    actor: stringSchema,
    sessionId: stringSchema,
    workContextId: stringSchema,
  },
  required: ['kind', 'label'],
  anyOf: [
    { required: ['url'] },
    { required: ['command'] },
    { required: ['logRef'] },
  ],
};

const workspaceSurfacesPublishOutputDataSchema: RelayJsonSchema = {
  title: 'WorkspaceSurfacesPublishData',
  type: 'object',
  additionalProperties: false,
  properties: {
    surface: workspaceSurfaceSchema,
  },
  required: ['surface'],
};

const workspaceTopicMutationPolicySchema: RelayJsonSchema = {
  title: 'WorkspaceTopicMutationPolicy',
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: { type: 'string', enum: ['create', 'update', 'archive'] },
    sideEffectClass: { type: 'string', enum: ['write', 'destructive'] },
    requiresConfirmation: booleanSchema,
    scopeKind: { const: 'work-context' },
  },
  required: ['kind', 'sideEffectClass', 'requiresConfirmation', 'scopeKind'],
};

const workspaceTopicSchema: RelayJsonSchema = {
  title: 'WorkspaceTopic',
  type: 'object',
  additionalProperties: true,
  properties: {
    schemaVersion: { const: 1 },
    id: stringSchema,
    workspaceId: stringSchema,
    source: { type: 'string', enum: ['persisted', 'derived'] },
    status: { type: 'string', enum: ['active', 'archived'] },
    visibility: { type: 'string', enum: ['default', 'private', 'shared'] },
    display: {
      type: 'object',
      additionalProperties: true,
      properties: {
        title: stringSchema,
        description: stringSchema,
      },
      required: ['title'],
    },
    grouping: { type: 'object', additionalProperties: true },
    promptDefaults: { type: 'object', additionalProperties: true },
    routingDefaults: { type: 'object', additionalProperties: true },
    linkedRefs: {
      type: 'object',
      additionalProperties: true,
      properties: {
        workContextIds: { type: 'array', items: stringSchema },
        sessionIds: { type: 'array', items: stringSchema },
        taskRefs: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        artifactIds: { type: 'array', items: stringSchema },
        workspaceSurfaceIds: { type: 'array', items: stringSchema },
        agentRuntimeIds: { type: 'array', items: stringSchema },
      },
    },
    state: { type: 'object', additionalProperties: true },
    privacy: { type: 'object', additionalProperties: true },
    createdAt: stringSchema,
    updatedAt: stringSchema,
  },
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'source',
    'status',
    'visibility',
    'display',
    'linkedRefs',
    'state',
    'privacy',
    'createdAt',
    'updatedAt',
  ],
};

const workspaceTopicsListOutputDataSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicsListData',
  type: 'object',
  additionalProperties: false,
  properties: {
    topics: { type: 'array', items: workspaceTopicSchema },
    truncated: booleanSchema,
    derived: booleanSchema,
  },
  required: ['topics', 'truncated', 'derived'],
};

const workspaceTopicSearchInputSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicsSearchInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    q: stringSchema,
    workspaceId: stringSchema,
    workContextId: stringSchema,
    workContextIds: { type: 'array', items: stringSchema },
    includeArchived: booleanSchema,
    limit: { type: 'number', minimum: 1, maximum: 50, default: 20 },
  },
  required: ['q'],
};

const workspaceTopicSearchMatchSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicSearchMatch',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: [
        'topic',
        'workspace',
        'task',
        'repo',
        'worktree',
        'artifact',
        'surface',
        'agent',
        'session',
        'phrase',
      ],
    },
    field: stringSchema,
    label: stringSchema,
    value: stringSchema,
  },
  required: ['kind', 'field', 'label', 'value'],
};

const workspaceTopicSearchResultSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicSearchResult',
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: workspaceTopicSchema,
    score: { type: 'number' },
    freshness: { type: 'string', enum: ['fresh', 'stale', 'unknown'] },
    matches: { type: 'array', items: workspaceTopicSearchMatchSchema },
    action: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'open-topic' },
        topicId: stringSchema,
        primarySessionId: stringSchema,
        disabledReason: stringSchema,
      },
      required: ['kind', 'topicId'],
    },
  },
  required: ['topic', 'score', 'freshness', 'matches', 'action'],
};

const workspaceTopicsSearchOutputDataSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicsSearchData',
  type: 'object',
  additionalProperties: false,
  properties: {
    query: stringSchema,
    results: { type: 'array', items: workspaceTopicSearchResultSchema },
    truncated: booleanSchema,
    derived: booleanSchema,
    unavailableReason: stringSchema,
  },
  required: ['query', 'results', 'truncated', 'derived'],
};

const workspaceTopicGetInputSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicsGetInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema },
  required: ['id'],
};

const workspaceTopicArchiveInputSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicsArchiveInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema, confirmationToken: stringSchema },
  required: ['id'],
};

const workspaceTopicWriteInputSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicWriteInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    workspaceId: stringSchema,
    title: stringSchema,
    description: stringSchema,
    visibility: { type: 'string', enum: ['default', 'private', 'shared'] },
    grouping: { type: 'object', additionalProperties: true },
    promptDefaults: { type: 'object', additionalProperties: true },
    routingDefaults: { type: 'object', additionalProperties: true },
    linkedRefs: { type: 'object', additionalProperties: true },
    pinned: booleanSchema,
    muted: booleanSchema,
    privacy: { type: 'object', additionalProperties: true },
  },
};

const workspaceTopicCreateInputSchema: RelayJsonSchema = {
  ...workspaceTopicWriteInputSchema,
  title: 'WorkspaceTopicsCreateInput',
  required: ['workspaceId', 'title'],
};

const workspaceTopicUpdateInputSchema: RelayJsonSchema = {
  ...workspaceTopicWriteInputSchema,
  title: 'WorkspaceTopicsUpdateInput',
};

const workspaceTopicOutputDataSchema: RelayJsonSchema = {
  title: 'WorkspaceTopicData',
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: workspaceTopicSchema,
    mutationPolicy: workspaceTopicMutationPolicySchema,
  },
  required: ['topic'],
};

const controlActorSchema: RelayJsonSchema = {
  title: 'ControlActor',
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: { type: 'string', enum: ['agent', 'human', 'system'] },
    id: stringSchema,
    displayName: stringSchema,
    nodeId: stringSchema,
    sessionId: stringSchema,
  },
  required: ['kind'],
};

const sessionPeerIdentitySchema: RelayJsonSchema = {
  title: 'SessionPeerIdentity',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'local-user' },
        id: stringSchema,
        displayName: stringSchema,
      },
      required: ['kind', 'id'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'relay-node' },
        nodeId: stringSchema,
        credentialId: stringSchema,
        displayName: stringSchema,
      },
      required: ['kind', 'nodeId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'unknown' },
        id: stringSchema,
        displayName: stringSchema,
      },
      required: ['kind'],
    },
  ],
};

const sessionEnvelopeSchema: RelayJsonSchema = {
  title: 'SessionEnvelope',
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: stringSchema,
    globalSessionId: stringSchema,
    nodeId: stringSchema,
    intent: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: stringSchema,
        description: stringSchema,
      },
      required: ['kind', 'description'],
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['local-compatibility', 'node-cwd', 'repo', 'worktree'],
        },
        nodeId: stringSchema,
        cwd: stringSchema,
        repoPath: stringSchema,
        worktreePath: nullableStringSchema,
      },
      required: ['kind', 'nodeId', 'cwd'],
    },
    issuedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    revocable: booleanSchema,
    peerIdentity: sessionPeerIdentitySchema,
    correlationId: stringSchema,
    auditId: stringSchema,
  },
  required: [
    'sessionId',
    'globalSessionId',
    'nodeId',
    'intent',
    'scope',
    'issuedAt',
    'expiresAt',
    'revocable',
    'peerIdentity',
  ],
};

const sessionDescriptorSchema: RelayJsonSchema = {
  title: 'RelaySessionDescriptor',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    spawnedBySessionId: stringSchema,
    type: { type: 'string', enum: ['terminal'] },
    mode: { type: 'string', enum: ['pty'] },
    activityState: {
      type: 'string',
      enum: [
        'initializing',
        'waiting-for-input',
        'processing',
        'permission-prompt',
        'error',
        'idle',
      ],
    },
    nodeId: stringSchema,
    globalSessionId: stringSchema,
    cwd: stringSchema,
    repoPath: stringSchema,
    worktreePath: nullableStringSchema,
    repoName: stringSchema,
    branchName: stringSchema,
    displayName: stringSchema,
    status: { type: 'string', enum: ['active', 'disconnected'] },
    controlMode: {
      type: 'string',
      enum: ['human-driven'],
    },
    activeActors: { type: 'array', items: controlActorSchema },
    lastInterventionAt: nullableStringSchema,
    lastInterventionBy: { oneOf: [controlActorSchema, { type: 'null' }] },
    lastInterventionEventId: nullableStringSchema,
    controlFreshness: { type: 'string', enum: ['fresh', 'stale', 'unknown'] },
    controlReason: stringSchema,
    sessionEnvelope: sessionEnvelopeSchema,
  },
  required: [
    'id',
    'type',
    'mode',
    'cwd',
    'displayName',
    'status',
    'activityState',
  ],
};

const fileRpcStatSchema: RelayJsonSchema = {
  title: 'FileRpcStat',
  type: 'object',
  additionalProperties: false,
  properties: {
    path: stringSchema,
    name: stringSchema,
    type: { type: 'string', enum: ['file', 'directory', 'symlink', 'other'] },
    size: { type: 'number', minimum: 0 },
    mtimeMs: { type: 'number' },
    mode: { type: 'number' },
  },
  required: ['path', 'name', 'type', 'size', 'mtimeMs', 'mode'],
};

const fileRpcBaseInputSchema: RelayJsonSchema = {
  title: 'FileRpcGatewayInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: stringSchema,
    sessionId: stringSchema,
    id: stringSchema,
    path: stringSchema,
    cwd: stringSchema,
    confirmationToken: stringSchema,
  },
  required: ['sessionId'],
};

const fileRpcListInputSchema: RelayJsonSchema = {
  ...fileRpcBaseInputSchema,
  title: 'FileRpcListGatewayInput',
  properties: {
    ...(fileRpcBaseInputSchema.properties ?? {}),
    maxEntries: { type: 'number', minimum: 1, maximum: 500 },
  },
};

const fileRpcStatInputSchema: RelayJsonSchema = {
  ...fileRpcBaseInputSchema,
  title: 'FileRpcStatGatewayInput',
};

const fileRpcReadInputSchema: RelayJsonSchema = {
  ...fileRpcBaseInputSchema,
  title: 'FileRpcReadGatewayInput',
  properties: {
    ...(fileRpcBaseInputSchema.properties ?? {}),
    maxBytes: { type: 'number', minimum: 1, maximum: 65536 },
    maxLines: { type: 'number', minimum: 1, maximum: 2000 },
  },
};

const fileRpcListOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: { const: 'list' },
    root: stringSchema,
    cwd: stringSchema,
    path: stringSchema,
    entries: { type: 'array', items: fileRpcStatSchema },
    truncated: booleanSchema,
    maxEntries: { type: 'number' },
  },
  required: [
    'operation',
    'root',
    'cwd',
    'path',
    'entries',
    'truncated',
    'maxEntries',
  ],
};

const fileRpcStatOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: { const: 'stat' },
    root: stringSchema,
    cwd: stringSchema,
    path: stringSchema,
    stat: fileRpcStatSchema,
  },
  required: ['operation', 'root', 'cwd', 'path', 'stat'],
};

const fileRpcReadOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: { const: 'read' },
    root: stringSchema,
    cwd: stringSchema,
    path: stringSchema,
    encoding: { const: 'utf8' },
    content: stringSchema,
    bytesRead: { type: 'number' },
    truncatedBytes: booleanSchema,
    truncatedLines: booleanSchema,
    maxBytes: { type: 'number' },
    maxLines: { type: 'number' },
  },
  required: [
    'operation',
    'root',
    'cwd',
    'path',
    'encoding',
    'content',
    'bytesRead',
    'truncatedBytes',
    'truncatedLines',
    'maxBytes',
  ],
};

const fileRpcWriteInputSchema: RelayJsonSchema = {
  ...fileRpcBaseInputSchema,
  title: 'FileRpcWriteGatewayInput',
  properties: {
    ...(fileRpcBaseInputSchema.properties ?? {}),
    mode: { type: 'string', enum: ['create', 'overwrite', 'append'] },
    contentBase64: stringSchema,
    expectedHash: stringSchema,
    permissions: { type: 'number', minimum: 0, maximum: 511 },
  },
  required: [
    ...(fileRpcBaseInputSchema.required ?? []),
    'mode',
    'contentBase64',
  ],
};

const fileRpcWriteOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: { const: 'write' },
    root: stringSchema,
    cwd: stringSchema,
    path: stringSchema,
    mode: { type: 'string', enum: ['create', 'overwrite', 'append'] },
    bytesWritten: { type: 'number' },
    newHash: stringSchema,
    newMtime: stringSchema,
    created: booleanSchema,
  },
  required: [
    'operation',
    'root',
    'cwd',
    'path',
    'mode',
    'bytesWritten',
    'newHash',
    'newMtime',
    'created',
  ],
};

const attachOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session: sessionDescriptorSchema,
    attach: {
      type: 'object',
      additionalProperties: false,
      properties: {
        streaming: booleanSchema,
        mode: { const: 'descriptor' },
        message: stringSchema,
      },
      required: ['streaming', 'mode', 'message'],
    },
  },
  required: ['session', 'attach'],
};

const detachOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    detached: booleanSchema,
    killed: booleanSchema,
    session: sessionDescriptorSchema,
    message: stringSchema,
  },
  required: ['detached', 'killed', 'session', 'message'],
};

const sessionKillOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: booleanSchema,
    killed: booleanSchema,
    id: stringSchema,
    sessionId: stringSchema,
    requestedId: stringSchema,
    nodeId: stringSchema,
    globalSessionId: stringSchema,
  },
  required: ['ok', 'killed', 'id', 'sessionId'],
};

const sessionRenameInputSchema: RelayJsonSchema = {
  title: 'SessionsRenameInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    displayName: stringSchema,
  },
  required: ['id', 'displayName'],
};

const sessionRenameOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    renamed: booleanSchema,
    id: stringSchema,
    sessionId: stringSchema,
    requestedId: stringSchema,
    nodeId: stringSchema,
    globalSessionId: stringSchema,
    displayName: stringSchema,
    session: sessionDescriptorSchema,
  },
  required: ['renamed', 'id', 'sessionId', 'displayName'],
};

const sessionStreamInputSchema: RelayJsonSchema = {
  title: 'SessionsStreamInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    mode: { type: 'string', enum: ['ndjson'], default: 'ndjson' },
    maxEvents: { type: 'number', minimum: 1, maximum: 10000 },
    maxBytes: { type: 'number', minimum: 1, maximum: 1048576 },
    idleTimeoutMs: { type: 'number', minimum: 1, maximum: 300000 },
  },
  required: ['id'],
};

const sessionStreamEventSchema: RelayJsonSchema = {
  title: 'SessionsStreamEvent',
  type: 'object',
  additionalProperties: false,
  properties: {
    event: { type: 'string', enum: ['data', 'closed'] },
    sessionId: stringSchema,
    nodeId: stringSchema,
    globalSessionId: stringSchema,
    encoding: { const: 'utf8' },
    data: stringSchema,
    bytes: { type: 'number', minimum: 0 },
    sequence: { type: 'number', minimum: 0 },
    closeCode: { type: 'number' },
    reason: stringSchema,
    frames: { type: 'number', minimum: 0 },
    bytesReceived: { type: 'number', minimum: 0 },
    truncated: booleanSchema,
    maxBytes: { type: 'number', minimum: 1 },
    backpressureClosed: booleanSchema,
  },
  required: ['event', 'sessionId'],
};

const sessionWaitCommonProperties = {
  id: stringSchema,
  outputText: stringSchema,
  idleMs: { type: 'number', minimum: 1, maximum: 300000 },
  screenText: stringSchema,
  timeoutMs: { type: 'number', minimum: 1, maximum: 300000 },
  maxBytes: { type: 'number', minimum: 1, maximum: 1048576 },
} satisfies Record<string, RelayJsonSchema>;

const sessionWaitInputSchema: RelayJsonSchema = {
  title: 'SessionsWaitInput',
  type: 'object',
  additionalProperties: false,
  properties: sessionWaitCommonProperties,
  required: ['id'],
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: stringSchema,
        outputText: stringSchema,
        timeoutMs: sessionWaitCommonProperties.timeoutMs,
        maxBytes: sessionWaitCommonProperties.maxBytes,
      },
      required: ['id', 'outputText'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: stringSchema,
        idleMs: sessionWaitCommonProperties.idleMs,
        timeoutMs: sessionWaitCommonProperties.timeoutMs,
        maxBytes: sessionWaitCommonProperties.maxBytes,
      },
      required: ['id', 'idleMs'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: stringSchema,
        screenText: stringSchema,
        timeoutMs: sessionWaitCommonProperties.timeoutMs,
        maxBytes: sessionWaitCommonProperties.maxBytes,
      },
      required: ['id', 'screenText'],
    },
  ],
};

const sessionWaitOutputSchema: RelayJsonSchema = {
  title: 'SessionsWaitOutput',
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { const: 'raw-output' },
    status: { type: 'string', enum: ['matched', 'idle'] },
    sessionId: stringSchema,
    nodeId: stringSchema,
    globalSessionId: stringSchema,
    predicate: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['output-text', 'idle-ms'] },
        value: { type: ['string', 'number'] },
      },
      required: ['kind', 'value'],
    },
    elapsedMs: { type: 'number', minimum: 0 },
    bytesObserved: { type: 'number', minimum: 0 },
    truncated: booleanSchema,
    timeoutMs: { type: 'number', minimum: 1 },
    maxBytes: { type: 'number', minimum: 1 },
  },
  required: [
    'model',
    'status',
    'sessionId',
    'predicate',
    'elapsedMs',
    'bytesObserved',
    'truncated',
    'timeoutMs',
    'maxBytes',
  ],
};

const sessionScreenInputSchema: RelayJsonSchema = {
  title: 'SessionsScreenInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    scrollback: booleanSchema,
    maxLines: { type: 'number', minimum: 1, maximum: 1000 },
  },
  required: ['id'],
};

const renderedTerminalLineSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    text: stringSchema,
  },
};

const sessionScreenOutputSchema: RelayJsonSchema = {
  title: 'SessionsScreenOutput',
  type: 'object',
  additionalProperties: false,
  properties: {
    session: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: stringSchema,
        requestedId: stringSchema,
        nodeId: stringSchema,
        globalSessionId: stringSchema,
        type: stringSchema,
        mode: stringSchema,
        status: stringSchema,
        displayName: stringSchema,
      },
      required: ['id', 'nodeId', 'globalSessionId', 'mode', 'status'],
    },
    backend: {
      type: 'object',
      additionalProperties: true,
      properties: {
        terminalBackend: { type: 'string', enum: ['relay-pty'] },
        modelBackend: { const: 'libghostty-vt' },
        runtime: { const: 'relay-pty/libghostty-vt' },
      },
      required: ['terminalBackend', 'modelBackend', 'runtime'],
    },
    geometry: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: { type: 'number', minimum: 1 },
        cols: { type: 'number', minimum: 1 },
      },
      required: ['rows', 'cols'],
    },
    capturedAt: stringSchema,
    freshness: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['fresh'] },
        lastActivityAt: stringSchema,
        modelGeneratedAt: stringSchema,
      },
      required: ['state', 'lastActivityAt', 'modelGeneratedAt'],
    },
    visible: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: stringSchema,
        rows: { type: 'array', items: renderedTerminalLineSchema },
      },
      required: ['text', 'rows'],
    },
    cursor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        row: { type: 'number', minimum: 0 },
        col: { type: 'number', minimum: 0 },
      },
      required: ['row', 'col'],
    },
    title: nullableStringSchema,
    modes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        altScreen: booleanSchema,
        applicationCursorKeys: { type: ['boolean', 'null'] },
        mouseTracking: { type: ['boolean', 'null'] },
        bracketedPaste: { type: ['boolean', 'null'] },
      },
      required: [
        'altScreen',
        'applicationCursorKeys',
        'mouseTracking',
        'bracketedPaste',
      ],
    },
    scrollback: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requested: booleanSchema,
        included: booleanSchema,
        rows: { type: 'array', items: renderedTerminalLineSchema },
        availableRows: { type: 'number', minimum: 0 },
        includedRows: { type: 'number', minimum: 0 },
        maxLines: { type: 'number', minimum: 1, maximum: 1000 },
        truncated: booleanSchema,
        omittedRows: { type: 'number', minimum: 0 },
        bytesDropped: { type: 'number', minimum: 0 },
        capacityBytes: { type: 'number', minimum: 1 },
      },
      required: [
        'requested',
        'included',
        'rows',
        'availableRows',
        'includedRows',
        'truncated',
        'omittedRows',
        'bytesDropped',
        'capacityBytes',
      ],
    },
    unsupported: { type: 'array', items: stringSchema },
  },
  required: [
    'session',
    'backend',
    'geometry',
    'capturedAt',
    'freshness',
    'visible',
    'cursor',
    'title',
    'modes',
    'scrollback',
    'unsupported',
  ],
};

const sessionInputCommonProperties = {
  id: stringSchema,
  waitFor: stringSchema,
  timeoutMs: { type: 'number', minimum: 1, maximum: 300000 },
  maxBytes: { type: 'number', minimum: 1, maximum: 1048576 },
} satisfies Record<string, RelayJsonSchema>;

const sessionInputInputSchema: RelayJsonSchema = {
  title: 'SessionsInputInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...sessionInputCommonProperties,
    data: stringSchema,
    dataBase64: stringSchema,
    stdin: booleanSchema,
  },
  required: ['id'],
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { ...sessionInputCommonProperties, data: stringSchema },
      required: ['id', 'data'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { ...sessionInputCommonProperties, dataBase64: stringSchema },
      required: ['id', 'dataBase64'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { ...sessionInputCommonProperties, stdin: { const: true } },
      required: ['id', 'stdin'],
    },
  ],
};

const sessionInputOutputSchema: RelayJsonSchema = {
  title: 'SessionsInputOutput',
  type: 'object',
  additionalProperties: false,
  properties: {
    sent: booleanSchema,
    sessionId: stringSchema,
    nodeId: stringSchema,
    globalSessionId: stringSchema,
    bytesSent: { type: 'number', minimum: 0 },
    output: stringSchema,
    matched: booleanSchema,
    waitFor: stringSchema,
    bytesReceived: { type: 'number', minimum: 0 },
    truncated: booleanSchema,
    maxBytes: { type: 'number', minimum: 1 },
  },
  required: [
    'sent',
    'sessionId',
    'bytesSent',
    'matched',
    'bytesReceived',
    'truncated',
  ],
};

/**
 * Typed environment shape for terminal session creation.
 *
 * Adapter-facing alternative to the legacy `repoPath` / `worktreePath` / flat
 * `nodeId` + `cwd` fields. Uses scoped IDs from `shared/identity.ts` and the
 * canonical `RepoIdentity` string ("github.com/{owner}/{name}" or
 * "{host}/{path}") emitted by `shared/repo-identity.ts`. Raw host/path pairs
 * are intentionally absent: free-form host strings are exactly what #626
 * forbids on the terminal session contract.
 *
 * Invariants (enforced in `shared/cli-gateway-runtime.ts`):
 *   - `nodeId` and `cwd` are required.
 *   - `benchId` requires either `repoIdentity` or `repoInstanceId` (a Bench is
 *     anchored to a RepoInstance per `docs/WORKBENCH_BOUNDARY.md`).
 *   - Mixing `environment` with any of `repoPath` / `worktreePath` / flat
 *     `cwd` / flat `nodeId` is rejected — callers pick one shape.
 */
const createSessionEnvironmentSchema: RelayJsonSchema = {
  title: 'CreateSessionEnvironment',
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: {
      type: 'string',
      description: 'Target Relay node id. From EnvironmentOption.node.nodeId.',
    },
    repoIdentity: {
      type: ['string', 'null'],
      description:
        'Canonical normalized repo identity (e.g. "github.com/owner/name"). ' +
        'Sourced from shared/repo-identity.ts; never a free-form host/path pair.',
    },
    repoInstanceId: {
      type: 'string',
      description:
        'Scoped RepoInstanceId for a node-local checkout (encodes nodeId + local path).',
    },
    benchId: {
      type: 'string',
      description:
        'Scoped WorktreeInstanceId for a Bench inside the RepoInstance. Requires repoIdentity or repoInstanceId.',
    },
    cwd: {
      type: 'string',
      description: 'Absolute cwd on the target node where the session starts.',
    },
  },
  required: ['nodeId', 'cwd'],
};

const createSessionInputSchema: RelayJsonSchema = {
  title: 'CreateSessionInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: {
      description:
        'DEPRECATED in v1.x — prefer `environment.nodeId`. Optional execution node; omit for the current local /sessions path. Removed in v2.',
      type: 'string',
    },
    environment: createSessionEnvironmentSchema,
    repoPath: {
      ...stringSchema,
      description:
        'DEPRECATED in v1.x — prefer `environment.cwd` (with repoIdentity/repoInstanceId for repo-bound launches). Removed in v2.',
    },
    worktreePath: {
      ...nullableStringSchema,
      description:
        'DEPRECATED in v1.x — prefer `environment.benchId` + `environment.cwd`. Removed in v2.',
    },
    cwd: {
      ...stringSchema,
      description:
        'DEPRECATED in v1.x — prefer `environment.cwd`. Removed in v2.',
    },
    type: { type: 'string', enum: ['terminal'], default: 'terminal' },
    mode: { type: 'string', enum: ['pty'] },
    cols: { type: 'number', minimum: 1, maximum: 500 },
    rows: { type: 'number', minimum: 1, maximum: 200 },
    branchName: stringSchema,
    displayName: {
      ...stringSchema,
      description:
        'Human-readable terminal label shown in session lists and the web UI; defaults to "Terminal N".',
    },
    spawnedBySessionId: {
      ...stringSchema,
      description:
        'Optional best-effort lineage id of the Relay session that spawned this session; parent existence is not validated.',
    },
    workContextId: stringSchema,
    workspaceTopicId: {
      ...stringSchema,
      description:
        'WorkspaceTopic id whose routing/prompt defaults seed this session create and whose linked session refs are updated after launch.',
    },
    sessionEnvelope: sessionEnvelopeSchema,
    ttlSeconds: { type: 'number', minimum: 1 },
    expiresAt: { type: 'string', format: 'date-time' },
    confirmationToken: stringSchema,
  },
};

const lifecycleEnvironmentSchema: RelayJsonSchema = {
  title: 'LifecycleEnvironment',
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: {
      type: 'string',
      description:
        'Target Relay node id. v1 local lifecycle writes are supported only for the local node; remote nodes fail closed as UNSUPPORTED/NODE_OFFLINE until routed node worktree mutation support exists.',
    },
    repoIdentity: {
      type: ['string', 'null'],
      description:
        'Canonical normalized repo identity for audit/discovery. Path resolution prefers repoInstanceId over this identity in v1 local commands.',
    },
    repoInstanceId: {
      type: 'string',
      description:
        'Scoped RepoInstanceId, usually createRepoInstanceId(nodeId, localPath). Used instead of browser active repo state.',
    },
    benchId: {
      type: 'string',
      description:
        'Scoped WorktreeInstanceId, usually createWorktreeInstanceId(nodeId, localPath). Used for worktree status/delete/archive compatibility with path input.',
    },
    cwd: {
      type: 'string',
      description:
        'Absolute cwd on the target node. Accepted for status/preflight compatibility when benchId is unavailable.',
    },
  },
};

const repoAddInputSchema: RelayJsonSchema = {
  title: 'ReposAddInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    path: stringSchema,
    requireGitRepo: booleanSchema,
  },
  required: ['path'],
};

const workspaceLaunchInputSchema: RelayJsonSchema = {
  title: 'WorkspaceLaunchInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: stringSchema,
    terminalBackend: { type: 'string', enum: ['relay-pty'] },
    cols: { type: 'number', minimum: 1, maximum: 500 },
    rows: { type: 'number', minimum: 1, maximum: 200 },
  },
  required: ['workspaceId'],
};

const worktreeCreateInputSchema: RelayJsonSchema = {
  title: 'WorktreeCreateInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    environment: lifecycleEnvironmentSchema,
    repoPath: {
      ...stringSchema,
      description:
        'Compatibility path for the local repo checkout. Prefer environment.repoInstanceId when available.',
    },
    branch: {
      ...stringSchema,
      description:
        'Existing branch to check out into a worktree. Omit to create the next Relay-generated branch/mountain worktree.',
    },
    confirmationToken: stringSchema,
  },
  anyOf: [
    { required: ['repoPath'] },
    {
      required: ['environment'],
      properties: {
        environment: {
          ...lifecycleEnvironmentSchema,
          required: ['repoInstanceId'],
        },
      },
    },
  ],
};

const worktreeStatusInputSchema: RelayJsonSchema = {
  title: 'WorktreeStatusInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    environment: lifecycleEnvironmentSchema,
    worktreePath: {
      ...stringSchema,
      description:
        'Compatibility local worktree path. Prefer environment.benchId when available.',
    },
  },
  anyOf: [
    { required: ['worktreePath'] },
    {
      required: ['environment'],
      properties: {
        environment: { ...lifecycleEnvironmentSchema, required: ['benchId'] },
      },
    },
    {
      required: ['environment'],
      properties: {
        environment: { ...lifecycleEnvironmentSchema, required: ['cwd'] },
      },
    },
  ],
};

const worktreeDeleteInputSchema: RelayJsonSchema = {
  title: 'WorktreeDeleteInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    environment: lifecycleEnvironmentSchema,
    repoPath: {
      ...stringSchema,
      description:
        'Compatibility local repo checkout path. Prefer environment.repoInstanceId when available.',
    },
    worktreePath: {
      ...stringSchema,
      description:
        'Compatibility local worktree path. Prefer environment.benchId when available.',
    },
    force: booleanSchema,
    confirmationToken: stringSchema,
  },
  anyOf: [
    { required: ['repoPath', 'worktreePath'] },
    {
      required: ['repoPath', 'environment'],
      properties: {
        environment: { ...lifecycleEnvironmentSchema, required: ['benchId'] },
      },
    },
    {
      required: ['repoPath', 'environment'],
      properties: {
        environment: { ...lifecycleEnvironmentSchema, required: ['cwd'] },
      },
    },
    {
      required: ['worktreePath', 'environment'],
      properties: {
        environment: {
          ...lifecycleEnvironmentSchema,
          required: ['repoInstanceId'],
        },
      },
    },
    {
      required: ['environment'],
      properties: {
        environment: {
          ...lifecycleEnvironmentSchema,
          required: ['repoInstanceId', 'benchId'],
        },
      },
    },
    {
      required: ['environment'],
      properties: {
        environment: {
          ...lifecycleEnvironmentSchema,
          required: ['repoInstanceId', 'cwd'],
        },
      },
    },
  ],
};

const repoDescriptorSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    path: stringSchema,
    name: stringSchema,
    isGitRepo: booleanSchema,
    kind: { type: 'string', enum: ['repo', 'directory'] },
    nodeId: stringSchema,
    repoIdentity: { type: ['string', 'null'] },
    repoInstanceId: stringSchema,
  },
};

const worktreeCreateOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branchName: stringSchema,
    mountainName: stringSchema,
    worktreePath: stringSchema,
    existing: booleanSchema,
  },
  required: ['branchName', 'worktreePath'],
};

const worktreeStatusOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    activeSessions: { type: 'array', items: stringSchema },
    hasUncommittedChanges: booleanSchema,
  },
  required: ['activeSessions', 'hasUncommittedChanges'],
};

const worktreeDeleteOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: booleanSchema,
    action: { type: 'string', enum: ['delete', 'archive'] },
    branchDeleted: booleanSchema,
    audit: {
      type: 'object',
      additionalProperties: true,
      properties: {
        repoPath: stringSchema,
        worktreePath: stringSchema,
        force: booleanSchema,
      },
    },
  },
  required: ['ok', 'action', 'branchDeleted'],
};

const renewSessionInputSchema: RelayJsonSchema = {
  title: 'RenewSessionInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    sessionId: stringSchema,
    nodeId: stringSchema,
    ttlSeconds: { type: 'number', minimum: 1 },
    expiresAt: { type: 'string', format: 'date-time' },
  },
  required: ['id'],
};

const ticketContextInputSchema: RelayJsonSchema = {
  title: 'TicketContextInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    source: stringSchema,
    id: stringSchema,
    title: stringSchema,
    url: stringSchema,
    description: stringSchema,
  },
  required: ['source', 'id'],
};

const repoWorkflowBindingInputSchema: RelayJsonSchema = {
  title: 'RepoWorkflowBindingInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: stringSchema,
    repoPath: stringSchema,
    workspaceId: stringSchema,
    repoIdentity: stringSchema,
    repoInstanceId: stringSchema,
  },
  required: ['repoPath'],
};

const branchWorkflowTargetInputSchema: RelayJsonSchema = {
  title: 'BranchWorkflowTargetInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: stringSchema,
    base: stringSchema,
    remote: stringSchema,
    url: stringSchema,
  },
  required: ['name'],
};

const prWorkflowTargetInputSchema: RelayJsonSchema = {
  title: 'PrWorkflowTargetInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'number', minimum: 1 },
    url: stringSchema,
    head: stringSchema,
    base: stringSchema,
    title: stringSchema,
  },
  anyOf: [{ required: ['number'] }, { required: ['head'] }],
};

const worktreeWorkflowPolicyInputSchema: RelayJsonSchema = {
  title: 'WorktreeWorkflowPolicyInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['reuse-existing', 'create-if-missing', 'reject-if-missing'],
      default: 'reuse-existing',
    },
    worktreePath: stringSchema,
    allowDirty: booleanSchema,
    allowConflicted: booleanSchema,
  },
};

const workflowSessionOptionsInputSchema: RelayJsonSchema = {
  title: 'WorkflowSessionOptionsInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['terminal'], default: 'terminal' },
    mode: { type: 'string', enum: ['pty'] },
    terminalBackend: { type: 'string', enum: ['relay-pty'] },
    cols: { type: 'number', minimum: 1, maximum: 500 },
    rows: { type: 'number', minimum: 1, maximum: 200 },
    workContextId: stringSchema,
  },
};

const promptHandoffPolicyInputSchema: RelayJsonSchema = {
  title: 'PromptHandoffPolicyInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['none', 'initial-prompt', 'unsupported'] },
    prompt: stringSchema,
    requireTypedDelivery: booleanSchema,
  },
};

const workflowCommandInputSchema: RelayJsonSchema = {
  title: 'WorkflowCommandInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    ticket: ticketContextInputSchema,
    repo: repoWorkflowBindingInputSchema,
    branch: branchWorkflowTargetInputSchema,
    pr: prWorkflowTargetInputSchema,
    worktree: worktreeWorkflowPolicyInputSchema,
    session: workflowSessionOptionsInputSchema,
    prompt: promptHandoffPolicyInputSchema,
    confirmationToken: stringSchema,
  },
  required: ['repo'],
  anyOf: [{ required: ['branch'] }, { required: ['pr'] }],
};

const ticketsStartWorkWorkflowInputSchema: RelayJsonSchema = {
  ...workflowCommandInputSchema,
  title: 'TicketsStartWorkInput',
  required: ['repo', 'ticket'],
};

const branchesOpenSessionWorkflowInputSchema: RelayJsonSchema = {
  ...workflowCommandInputSchema,
  title: 'BranchesOpenSessionInput',
};

const workflowCommandOutputSchema: RelayJsonSchema = {
  title: 'WorkflowCommandOutputData',
  type: 'object',
  additionalProperties: false,
  properties: {
    session: sessionDescriptorSchema,
    nodeId: stringSchema,
    repo: { type: 'object', additionalProperties: true },
    worktree: { type: 'object', additionalProperties: true },
    branch: { type: 'object', additionalProperties: true },
    pr: { type: 'object', additionalProperties: true },
    workContextId: stringSchema,
    created: { type: 'object', additionalProperties: true },
    reused: { type: 'object', additionalProperties: true },
    promptHandoff: { type: 'object', additionalProperties: true },
    controlHandoff: { type: 'object', additionalProperties: true },
  },
  required: [
    'session',
    'nodeId',
    'repo',
    'worktree',
    'branch',
    'created',
    'reused',
    'promptHandoff',
    'controlHandoff',
  ],
};

const workflowGatewayErrorCodes = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_ARGUMENT',
  'INVALID_JSON',
  'UNSUPPORTED',
  'NOT_FOUND',
  'SESSION_CONFLICT',
  'CONFIRMATION_REQUIRED',
  'NODE_OFFLINE',
  'SERVER_UNAVAILABLE',
  'UPSTREAM_ERROR',
] as const satisfies readonly RelayCliGatewayErrorCode[];

export const gatewayErrorSchema: RelayJsonSchema = {
  title: 'RelayCliGatewayErrorEnvelope',
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { const: false },
    contract: { const: RELAY_CLI_GATEWAY_MAJOR },
    contractVersion: { const: RELAY_CLI_GATEWAY_CONTRACT_VERSION },
    command: stringSchema,
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: {
          type: 'string',
          enum: [
            'UNAUTHORIZED',
            'SERVER_UNAVAILABLE',
            'INVALID_ARGUMENT',
            'INVALID_JSON',
            'UNSUPPORTED',
            'NOT_FOUND',
            'FORBIDDEN',
            'SESSION_CONFLICT',
            'CONFIRMATION_REQUIRED',
            'NODE_OFFLINE',
            'SESSION_EXPIRED',
            'SESSION_REVOKED',
            'SESSION_MISMATCH',
            'SESSION_NON_RENEWABLE',
            'CONTROL_STATE_STALE',
            'INTERVENTION_ACK_REQUIRED',
            'INTERVENTION_ACK_STALE',
            'CONTROL_STATE_UNKNOWN',
            'UPSTREAM_ERROR',
            'INTERNAL',
          ],
        },
        message: stringSchema,
        retryable: booleanSchema,
        details: { type: 'object', additionalProperties: true },
      },
      required: ['code', 'message', 'retryable'],
    },
  },
  required: ['ok', 'contract', 'contractVersion', 'command', 'error'],
};

export const EVENTS_SUBSCRIBE_TOPICS = [
  'sessions',
  'nodes',
  'audit',
  'context',
  'inbox',
  'attention',
  'work-context-artifacts',
  'handoff-artifacts',
  'workflow-runs',
  'automation-runs',
  'pr-overseer',
] as const;
export type EventsSubscribeTopic = (typeof EVENTS_SUBSCRIBE_TOPICS)[number];

export const EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES = {
  sessions: ['session:read'],
  nodes: ['session:read'],
  audit: ['session:read', 'tab:intervention:read'],
  context: ['context:read'],
  inbox: ['inbox:read'],
  // Attention/session-state is a derived projection of the session read model,
  // gated like session reads on `session:read`.
  attention: ['session:read'],
  'work-context-artifacts': ['context:read'],
  'handoff-artifacts': ['context:read'],
  'workflow-runs': ['context:read'],
  'automation-runs': ['context:read'],
  'pr-overseer': ['context:read'],
} as const satisfies Record<
  EventsSubscribeTopic,
  readonly RelayCapabilityBit[]
>;

const eventsSubscribeInputSchema: RelayJsonSchema = {
  title: 'EventsSubscribeInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: {
      type: 'string',
      enum: EVENTS_SUBSCRIBE_TOPICS,
      description:
        'Non-destructive event topic to subscribe to: sessions lifecycle/control, node link status, redacted audit envelopes, WorkContext workflow metadata, inbox message lifecycle, or derived attention/session-state transitions for active-agent steering.',
    },
    cursor: stringSchema,
    workContextId: stringSchema,
    sessionId: stringSchema,
    globalSessionId: stringSchema,
    repoPath: {
      ...stringSchema,
      description:
        'Exact repo checkout path filter. Only the `attention` topic carries repoPath, so other topics never match this filter.',
    },
    maxEvents: {
      type: 'number',
      minimum: 1,
      maximum: 10000,
      description:
        'Detach after N event frames (excluding open/closed envelopes).',
    },
    idleTimeoutMs: {
      type: 'number',
      minimum: 1,
      maximum: 300000,
      description: 'Detach after this many ms without an event frame.',
    },
  },
  required: ['topic'],
};

const workContextGetInputSchema: RelayJsonSchema = {
  title: 'WorkContextGetInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema },
  required: ['id'],
};

const workContextResumeInputSchema: RelayJsonSchema = {
  title: 'WorkContextResumeInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    currentHeadSha: stringSchema,
    publicSafe: booleanSchema,
    maxArtifacts: { type: 'integer', minimum: 1, maximum: 200 },
    maxAuditRefs: { type: 'integer', minimum: 1, maximum: 200 },
    maxChars: { type: 'integer', minimum: 4000, maximum: 200000 },
  },
  required: ['id'],
};

const workContextMessageEnvelopeSchema: RelayJsonSchema = {
  title: 'WorkContextMessageEnvelope',
  type: 'object',
  additionalProperties: true,
  properties: {
    schemaVersion: { type: 'number' },
    id: stringSchema,
    workContextId: stringSchema,
    kind: stringSchema,
    sender: { type: 'object', additionalProperties: true },
    audience: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    summary: stringSchema,
    refs: { type: 'object', additionalProperties: true },
    payloadSchema: stringSchema,
    payload: { type: 'object', additionalProperties: true },
    visibility: { type: 'string', enum: ['private', 'internal', 'public'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    redaction: { type: 'object', additionalProperties: true },
  },
  required: [
    'id',
    'workContextId',
    'kind',
    'sender',
    'summary',
    'payload',
    'createdAt',
  ],
};

const workContextMessageAppendInputSchema: RelayJsonSchema = {
  title: 'WorkContextMessageAppendInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    workContextId: stringSchema,
    kind: stringSchema,
    sender: { type: 'object', additionalProperties: true },
    audience: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    summary: stringSchema,
    refs: { type: 'object', additionalProperties: true },
    parentMessageId: stringSchema,
    replyToMessageId: stringSchema,
    payloadSchema: stringSchema,
    payload: { type: 'object', additionalProperties: true },
    template: stringSchema,
    repoPath: stringSchema,
    cwd: stringSchema,
    templateData: { type: 'object', additionalProperties: true },
    visibility: { type: 'string', enum: ['private', 'internal', 'public'] },
  },
  required: ['workContextId', 'summary'],
};

const workContextMessageQueryInputSchema: RelayJsonSchema = {
  title: 'WorkContextMessageQueryInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    workContextId: stringSchema,
    kind: stringSchema,
    senderId: stringSchema,
    audienceKind: stringSchema,
    audienceId: stringSchema,
    payloadSchema: stringSchema,
    threadId: stringSchema,
    parentMessageId: stringSchema,
    refKind: stringSchema,
    refValue: stringSchema,
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    filter: { type: 'object', additionalProperties: true },
  },
};

const workContextMessageTemplateSelectorSchema: RelayJsonSchema = {
  title: 'WorkContextMessageTemplateSelector',
  type: 'object',
  additionalProperties: false,
  properties: {
    repoPath: stringSchema,
    cwd: stringSchema,
    workContextId: stringSchema,
    includeInvalid: booleanSchema,
  },
};

const workContextMessageTemplateSchema: RelayJsonSchema = {
  title: 'WorkContextMessageTemplate',
  type: 'object',
  additionalProperties: true,
  properties: {
    schemaVersion: { const: 1 },
    id: stringSchema,
    stem: stringSchema,
    name: stringSchema,
    description: stringSchema,
    kind: stringSchema,
    payloadSchema: stringSchema,
    mediaType: stringSchema,
    encoding: {
      type: 'string',
      enum: ['json', 'markdown', 'text', 'artifact-ref'],
    },
    bodyGuide: { type: 'object', additionalProperties: true },
    example: { type: 'object', additionalProperties: true },
    fallback: { type: 'object', additionalProperties: true },
    tags: { type: 'array', items: stringSchema },
    sourcePath: stringSchema,
  },
  required: [
    'schemaVersion',
    'id',
    'stem',
    'name',
    'kind',
    'payloadSchema',
    'mediaType',
    'encoding',
    'sourcePath',
  ],
};

const workContextMessageTemplateDiagnosticSchema: RelayJsonSchema = {
  title: 'WorkContextMessageTemplateDiagnostic',
  type: 'object',
  additionalProperties: false,
  properties: {
    code: stringSchema,
    message: stringSchema,
    template: stringSchema,
    sourcePath: stringSchema,
  },
  required: ['code', 'message'],
};

const workContextMessageTemplateRenderInputSchema: RelayJsonSchema = {
  title: 'WorkContextMessageTemplateRenderInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    template: stringSchema,
    repoPath: stringSchema,
    cwd: stringSchema,
    workContextId: stringSchema,
    templateData: { type: 'object', additionalProperties: true },
    message: { type: 'object', additionalProperties: true },
  },
  required: ['template'],
};

// ---------------------------------------------------------------------------
// context.* / inbox.* (#765, ADR-019)
//
// Ref-only, hub-mediated SQLite-behind-gateway context packets + session inbox.
// Schemas are intentionally `additionalProperties: true` on the nested envelope
// objects so the #758 store can evolve the canonical `ContextPacket` /
// `SessionInboxMessage` blob shapes without a contract bump; the gateway verbs
// pin only the addressing/lifecycle fields they own. Delivery is PULL: only
// `inbox.list` / `inbox.get` flip `queued → delivered`.
// ---------------------------------------------------------------------------

const contextPacketEnvelopeSchema: RelayJsonSchema = {
  title: 'ContextPacket',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    kind: { type: 'string', enum: CONTEXT_PACKET_KINDS },
    note: stringSchema,
    createdBy: stringSchema,
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'kind', 'createdBy', 'createdAt'],
};

const inboxMessageEnvelopeSchema: RelayJsonSchema = {
  title: 'SessionInboxMessage',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    targetSessionId: stringSchema,
    targetWorkContextId: stringSchema,
    contextPacketIds: { type: 'array', items: stringSchema },
    text: stringSchema,
    state: { type: 'string', enum: SESSION_INBOX_MESSAGE_STATES },
    createdBy: stringSchema,
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'contextPacketIds', 'state', 'createdBy', 'createdAt'],
};

const contextCreateInputSchema: RelayJsonSchema = {
  title: 'ContextCreateInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: CONTEXT_PACKET_KINDS },
    anchor: { type: 'object', additionalProperties: true },
    fileRef: { type: 'object', additionalProperties: true },
    note: stringSchema,
    binding: { type: 'object', additionalProperties: true },
    createdBy: stringSchema,
  },
  required: ['kind'],
};

const contextGetInputSchema: RelayJsonSchema = {
  title: 'ContextGetInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema },
  required: ['id'],
};

const contextListInputSchema: RelayJsonSchema = {
  title: 'ContextListInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: stringSchema,
    workspaceId: stringSchema,
    workContextId: stringSchema,
    limit: { type: 'number', minimum: 1, maximum: 200 },
  },
};

const contextPinInputSchema: RelayJsonSchema = {
  title: 'ContextPinInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    workContextId: stringSchema,
    actorId: stringSchema,
    createdBy: stringSchema,
  },
  required: ['id', 'workContextId'],
};

const inboxSendInputSchema: RelayJsonSchema = {
  title: 'InboxSendInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    targetSessionId: stringSchema,
    targetWorkContextId: stringSchema,
    contextPacketIds: { type: 'array', items: stringSchema },
    text: stringSchema,
    createdBy: stringSchema,
  },
  anyOf: [
    { required: ['targetSessionId'] },
    { required: ['targetWorkContextId'] },
  ],
};

const inboxListInputSchema: RelayJsonSchema = {
  title: 'InboxListInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    targetSessionId: stringSchema,
    targetWorkContextId: stringSchema,
    state: { type: 'string', enum: SESSION_INBOX_MESSAGE_STATES },
    limit: { type: 'number', minimum: 1, maximum: 200 },
  },
  anyOf: [
    { required: ['targetSessionId'] },
    { required: ['targetWorkContextId'] },
  ],
};

const inboxGetInputSchema: RelayJsonSchema = {
  title: 'InboxGetInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema },
  required: ['id'],
};

const inboxTransitionInputSchema: RelayJsonSchema = {
  title: 'InboxTransitionInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema, actorId: stringSchema },
  required: ['id'],
};

const contextPacketDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { contextPacket: contextPacketEnvelopeSchema },
  required: ['contextPacket'],
};

const artifactRefEnvelopeSchema: RelayJsonSchema = {
  title: 'ArtifactRef',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    kind: stringSchema,
    title: stringSchema,
    uri: stringSchema,
    summary: stringSchema,
  },
  required: ['id', 'kind'],
};

const contextListDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contextPackets: { type: 'array', items: contextPacketEnvelopeSchema },
    pinnedArtifacts: { type: 'array', items: artifactRefEnvelopeSchema },
  },
  required: ['contextPackets'],
};

const contextPinDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workContext: { type: 'object', additionalProperties: true },
    contextPacket: contextPacketEnvelopeSchema,
    pinnedContextPackets: { type: 'array', items: contextPacketEnvelopeSchema },
    pinnedArtifacts: { type: 'array', items: artifactRefEnvelopeSchema },
    alreadyPinned: booleanSchema,
  },
  required: [
    'workContext',
    'contextPacket',
    'pinnedContextPackets',
    'pinnedArtifacts',
    'alreadyPinned',
  ],
};

const contextUnpinDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workContext: { type: 'object', additionalProperties: true },
    contextPacket: contextPacketEnvelopeSchema,
    removed: booleanSchema,
    lifecycle: { type: 'object', additionalProperties: true },
  },
  required: ['workContext', 'removed', 'lifecycle'],
};

const inboxMessageDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { message: inboxMessageEnvelopeSchema },
  required: ['message'],
};

const inboxListDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messages: { type: 'array', items: inboxMessageEnvelopeSchema },
  },
  required: ['messages'],
};

const contextInboxReadErrorCodes = [
  'UNAUTHORIZED',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'FORBIDDEN',
  'SERVER_UNAVAILABLE',
  'UPSTREAM_ERROR',
] as const satisfies readonly RelayCliGatewayErrorCode[];

const contextInboxWriteErrorCodes = [
  'UNAUTHORIZED',
  'INVALID_ARGUMENT',
  'INVALID_JSON',
  'NOT_FOUND',
  'FORBIDDEN',
  'SESSION_CONFLICT',
  'SERVER_UNAVAILABLE',
  'UPSTREAM_ERROR',
] as const satisfies readonly RelayCliGatewayErrorCode[];

const workContextArtifactReadErrorCodes = [
  'UNAUTHORIZED',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'FORBIDDEN',
  'SERVER_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'INTERNAL',
] as const satisfies readonly RelayCliGatewayErrorCode[];

const workContextArtifactWriteErrorCodes = [
  'UNAUTHORIZED',
  'INVALID_ARGUMENT',
  'INVALID_JSON',
  'NOT_FOUND',
  'FORBIDDEN',
  'SESSION_CONFLICT',
  'SERVER_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'INTERNAL',
] as const satisfies readonly RelayCliGatewayErrorCode[];

const handoffPlanInputSchema: RelayJsonSchema = {
  title: 'HandoffPlanInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    request: { type: 'object', additionalProperties: true },
    sourceRepoPath: stringSchema,
    approvedUntrackedPaths: { type: 'array', items: stringSchema },
    sourceBranchName: stringSchema,
  },
  required: ['request'],
};

const artifactReadInputSchema: RelayJsonSchema = {
  title: 'ArtifactReadInput',
  type: 'object',
  additionalProperties: false,
  properties: { ref: stringSchema },
  required: ['ref'],
};

const workContextArtifactTaskRefSchema: RelayJsonSchema = {
  title: 'WorkContextArtifactTaskRef',
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: stringSchema,
    id: stringSchema,
    title: stringSchema,
    url: stringSchema,
    status: stringSchema,
  },
  required: ['kind', 'id'],
};

const workContextArtifactPublishInputSchema: RelayJsonSchema = {
  title: 'WorkContextArtifactPublishInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    workContextId: stringSchema,
    projectId: stringSchema,
    taskRef: workContextArtifactTaskRefSchema,
    stage: {
      type: 'string',
      enum: ['implementation', 'qa', 'review', 'release'],
    },
    provenanceActorId: stringSchema,
    actorId: stringSchema,
    visibility: { type: 'string', enum: ['private', 'public'] },
    kind: stringSchema,
    title: stringSchema,
    summary: stringSchema,
    capturedAt: { type: 'string', format: 'date-time' },
    supersedesArtifactId: stringSchema,
    currentHeadSha: stringSchema,
    pin: booleanSchema,
    artifact: { type: 'object', additionalProperties: true },
  },
  required: ['workContextId', 'artifact'],
};

const workContextArtifactListInputSchema: RelayJsonSchema = {
  title: 'WorkContextArtifactListInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    workContextId: stringSchema,
    projectId: stringSchema,
    taskRef: workContextArtifactTaskRefSchema,
    stage: {
      type: 'string',
      enum: ['implementation', 'qa', 'review', 'release'],
    },
    includeSuperseded: booleanSchema,
    limit: { type: 'number', minimum: 1, maximum: 200 },
    currentHeadSha: stringSchema,
  },
  anyOf: [{ required: ['workContextId'] }, { required: ['taskRef'] }],
};

const workContextArtifactIdInputSchema: RelayJsonSchema = {
  title: 'WorkContextArtifactIdInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    currentHeadSha: stringSchema,
    public: booleanSchema,
    output: stringSchema,
  },
  required: ['id'],
};

const workContextArtifactPinInputSchema: RelayJsonSchema = {
  title: 'WorkContextArtifactPinInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    workContextId: stringSchema,
    actorId: stringSchema,
  },
  required: ['id', 'workContextId'],
};

const workContextArtifactDoctorInputSchema: RelayJsonSchema = {
  title: 'WorkContextArtifactDoctorInput',
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const supervisorSnapshotInputSchema: RelayJsonSchema = {
  title: 'SupervisorSnapshotInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    expectedControlMode: {
      type: 'string',
      enum: ['human-driven'],
      description:
        'Optional caller-observed control mode. When supplied, stale or mismatched control state is refused.',
    },
    latestSeenInterventionEventId: {
      ...stringSchema,
      description:
        'Optional caller-observed intervention event id. Must match the latest target intervention before typed supervisor actions continue.',
    },
  },
  required: ['id'],
};

const supervisorSessionsInputSchema: RelayJsonSchema = {
  title: 'SupervisorSessionsInput',
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const supervisorSendTextInputSchema: RelayJsonSchema = {
  title: 'SupervisorSendTextInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    targetIds: { type: 'array', items: stringSchema },
    text: stringSchema,
    actor: { type: 'object', additionalProperties: true },
  },
  required: ['text'],
  oneOf: [{ required: ['id'] }, { required: ['targetIds'] }],
};

const supervisorSendKeyInputSchema: RelayJsonSchema = {
  title: 'SupervisorSendKeyInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    targetIds: { type: 'array', items: stringSchema },
    key: { type: 'string', enum: SUPERVISOR_SEND_KEY_NAMES },
    actor: { type: 'object', additionalProperties: true },
  },
  required: ['key'],
  oneOf: [{ required: ['id'] }, { required: ['targetIds'] }],
};

const supervisorSubmitInputSchema: RelayJsonSchema = {
  title: 'SupervisorSubmitInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    targetIds: { type: 'array', items: stringSchema },
    text: {
      ...stringSchema,
      description:
        'Optional message body to type before submitting. May contain newlines (multi-line prompts) and tabs; control/escape sequences are rejected. The command appends the carriage return itself — callers must not include a trailing Enter. Requires the tab:intervention:send-text capability in addition to tab:intervention:submit.',
    },
    clearInput: {
      ...booleanSchema,
      description:
        'Clear the current input buffer (best-effort Ctrl-U) before typing/submitting.',
    },
    paste: {
      ...booleanSchema,
      description:
        'Wrap the text body in bracketed-paste markers so multi-line/long content is inserted as one paste instead of submitting line-by-line.',
    },
    dryRun: {
      ...booleanSchema,
      description:
        'Preview the planned submission (bytes/chars accepted, steps, eligibility) without writing to the PTY or emitting an audit intervention.',
    },
    actor: { type: 'object', additionalProperties: true },
  },
  oneOf: [{ required: ['id'] }, { required: ['targetIds'] }],
};

const handoffPlanOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'object', additionalProperties: true },
    dryRun: { type: 'object', additionalProperties: true },
    readOnly: { const: true },
  },
  required: ['plan', 'readOnly'],
};

const artifactReadOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifact: { type: 'object', additionalProperties: true },
  },
  required: ['artifact'],
};

const workContextArtifactRecordOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifact: { type: 'object', additionalProperties: true },
    pin: { type: 'object', additionalProperties: true },
    artifactRef: { type: 'object', additionalProperties: true },
    workContext: { type: 'object', additionalProperties: true },
    alreadyPinned: booleanSchema,
    removed: booleanSchema,
    lifecycle: { type: 'object', additionalProperties: true },
    export: { type: 'object', additionalProperties: true },
    diagnostics: { type: 'object', additionalProperties: true },
  },
};

const workContextArtifactListOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifacts: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
  required: ['artifacts'],
};

const supervisorSnapshotOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    snapshot: {
      type: 'object',
      additionalProperties: true,
      properties: {
        command: { const: 'supervisor.snapshot' },
        redaction: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rawPtyInputAvailable: { const: false },
            rawTranscriptAvailable: { const: false },
            rawPromptAvailable: { const: false },
            rawProviderStateAvailable: { const: false },
            auditStoresHashesOnly: { const: true },
          },
          required: [
            'rawPtyInputAvailable',
            'rawTranscriptAvailable',
            'rawPromptAvailable',
            'rawProviderStateAvailable',
            'auditStoresHashesOnly',
          ],
        },
      },
      required: ['command', 'redaction'],
    },
    audit: {
      type: 'object',
      additionalProperties: true,
      properties: {
        command: { const: 'supervisor.snapshot' },
        redaction: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rawPromptStored: { const: false },
            rawTranscriptStored: { const: false },
            rawPtyInputStored: { const: false },
            rawProviderStateStored: { const: false },
          },
          required: [
            'rawPromptStored',
            'rawTranscriptStored',
            'rawPtyInputStored',
            'rawProviderStateStored',
          ],
        },
      },
      required: ['command', 'redaction'],
    },
  },
  required: ['snapshot', 'audit'],
};

const supervisorSessionsOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { const: 'supervisor.sessions' },
    sessions: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    count: { type: 'number', minimum: 0 },
  },
  required: ['command', 'sessions', 'count'],
};

const supervisorActionOutputSchema = (
  command: 'supervisor.sendText' | 'supervisor.sendKey' | 'supervisor.submit'
): RelayJsonSchema => {
  const action =
    command === 'supervisor.submit'
      ? 'submit'
      : command === 'supervisor.sendKey'
        ? 'sendKey'
        : 'sendText';
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      command: { const: command },
      action: { const: action },
      results: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      counts: { type: 'object', additionalProperties: true },
      audit: { type: 'object', additionalProperties: true },
      redaction: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rawContentAvailable: { const: false },
          rawContentStored: { const: false },
          hashesOnly: { const: true },
        },
        required: ['rawContentAvailable', 'rawContentStored', 'hashesOnly'],
      },
    },
    required: ['command', 'action', 'results', 'counts', 'audit', 'redaction'],
  };
};

const gatewayHandoffErrorCodes = [
  'UNAUTHORIZED',
  'INVALID_ARGUMENT',
  'INVALID_JSON',
  'NOT_FOUND',
  'FORBIDDEN',
  'SESSION_CONFLICT',
  'NODE_OFFLINE',
  'SERVER_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'INTERNAL',
] as const satisfies readonly RelayCliGatewayErrorCode[];

const gatewaySupervisorErrorCodes = [
  'UNAUTHORIZED',
  'INVALID_ARGUMENT',
  'INVALID_JSON',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONTROL_STATE_STALE',
  'INTERVENTION_ACK_REQUIRED',
  'SERVER_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'INTERNAL',
] as const satisfies readonly RelayCliGatewayErrorCode[];

const eventsSubscribeFrameSchema: RelayJsonSchema = {
  title: 'EventsSubscribeFrame',
  type: 'object',
  additionalProperties: false,
  properties: {
    event: { type: 'string', enum: ['open', 'event', 'closed'] },
    topic: { type: 'string', enum: EVENTS_SUBSCRIBE_TOPICS },
    sequence: { type: 'number', minimum: 0 },
    occurredAt: { type: 'string', format: 'date-time' },
    cursor: { type: 'string' },
    replay: { type: 'boolean' },
    replayDropped: { type: 'boolean' },
    payload: { type: 'object', additionalProperties: true },
    frames: { type: 'number', minimum: 0 },
    closeCode: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['event', 'topic', 'sequence'],
};

const workflowRunProjectionSchema: RelayJsonSchema = {
  title: 'WorkflowRunProjection',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    runId: stringSchema,
    providerRuntime: stringSchema,
    workContextId: stringSchema,
    state: stringSchema,
    version: { type: 'number', minimum: 1 },
    redaction: { type: 'object', additionalProperties: true },
  },
  required: [
    'id',
    'runId',
    'providerRuntime',
    'workContextId',
    'state',
    'version',
    'redaction',
  ],
};

const workflowRunPublishInputSchema: RelayJsonSchema = {
  title: 'WorkflowRunPublishInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    runId: stringSchema,
    providerRuntime: stringSchema,
    workContextId: stringSchema,
    definition: { type: 'object', additionalProperties: true },
    state: stringSchema,
  },
  required: ['runId', 'providerRuntime', 'workContextId', 'definition'],
};

const workflowRunUpdateInputSchema: RelayJsonSchema = {
  title: 'WorkflowRunUpdateInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    expectedVersion: { type: 'number', minimum: 1 },
    state: stringSchema,
  },
};

const workflowRunListInputSchema: RelayJsonSchema = {
  title: 'WorkflowRunListInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    workContextId: stringSchema,
    state: stringSchema,
    providerRuntime: stringSchema,
    limit: { type: 'number', minimum: 1, maximum: 100 },
  },
  required: ['workContextId'],
};

const workflowRunGetInputSchema: RelayJsonSchema = {
  title: 'WorkflowRunGetInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema },
  required: ['id'],
};

const workflowRunOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { workflowRun: workflowRunProjectionSchema },
  required: ['workflowRun'],
};

const workflowRunListOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workflowRuns: { type: 'array', items: workflowRunProjectionSchema },
  },
  required: ['workflowRuns'],
};

const automationRunTargetSchema: RelayJsonSchema = {
  title: 'AutomationRunTarget',
  type: 'object',
  additionalProperties: true,
  properties: {
    sessionId: stringSchema,
    globalSessionId: stringSchema,
    label: stringSchema,
    lastKnownState: {
      type: 'string',
      enum: ['alive', 'gone', 'ended', 'unknown'],
    },
    lastCheckedAt: stringSchema,
  },
  required: ['lastKnownState'],
};

const automationRunRecordSchema: RelayJsonSchema = {
  title: 'AutomationRunRecord',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    name: stringSchema,
    kind: stringSchema,
    runId: stringSchema,
    owner: { type: 'object', additionalProperties: true },
    repoPath: stringSchema,
    workContextId: stringSchema,
    targets: { type: 'array', items: automationRunTargetSchema },
    status: stringSchema,
    staleReasons: { type: 'array', items: stringSchema },
    heartbeat: { type: 'object', additionalProperties: true },
    cleanup: { type: 'object', additionalProperties: true },
    version: { type: 'number', minimum: 1 },
    redaction: { type: 'object', additionalProperties: true },
  },
  required: [
    'id',
    'name',
    'kind',
    'owner',
    'targets',
    'status',
    'staleReasons',
    'heartbeat',
    'cleanup',
    'version',
    'redaction',
  ],
};

const automationRunRegisterInputSchema: RelayJsonSchema = {
  title: 'AutomationRunRegisterInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    name: stringSchema,
    kind: {
      type: 'string',
      enum: ['watchdog', 'cron', 'automation', 'oversight', 'manual'],
    },
    runId: stringSchema,
    owner: { type: 'object', additionalProperties: true },
    repoPath: stringSchema,
    workContextId: stringSchema,
    targets: { type: 'array', items: automationRunTargetSchema },
    links: { type: 'object', additionalProperties: true },
    expiresAt: stringSchema,
    ttlSeconds: { type: 'number', minimum: 30, maximum: 604800 },
    observationSummary: stringSchema,
  },
  required: ['name', 'kind', 'owner', 'targets'],
};

const automationRunObserveInputSchema: RelayJsonSchema = {
  title: 'AutomationRunObserveInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    summary: stringSchema,
    targets: { type: 'array', items: automationRunTargetSchema },
    ttlSeconds: { type: 'number', minimum: 30, maximum: 604800 },
    expiresAt: stringSchema,
  },
};

const automationRunRetireInputSchema: RelayJsonSchema = {
  title: 'AutomationRunRetireInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    reason: stringSchema,
    retiredBy: stringSchema,
  },
};

const automationRunListInputSchema: RelayJsonSchema = {
  title: 'AutomationRunListInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    workContextId: stringSchema,
    repoPath: stringSchema,
    status: {
      type: 'string',
      enum: ['active', 'stale', 'cleanup-needed', 'retired'],
    },
    kind: {
      type: 'string',
      enum: ['watchdog', 'cron', 'automation', 'oversight', 'manual'],
    },
    orchestrator: stringSchema,
    includeRetired: booleanSchema,
    limit: { type: 'number', minimum: 1, maximum: 100 },
  },
};

const automationRunGetInputSchema: RelayJsonSchema = {
  title: 'AutomationRunGetInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema },
  required: ['id'],
};

const automationRunOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { automationRun: automationRunRecordSchema },
  required: ['automationRun'],
};

const automationRunListOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    automationRuns: { type: 'array', items: automationRunRecordSchema },
  },
  required: ['automationRuns'],
};

// ─── PR / check / review overseer (#960) ───────────────────────────────────────

const prOverseerPrRefSchema: RelayJsonSchema = {
  title: 'PrOverseerPrRef',
  type: 'object',
  additionalProperties: false,
  properties: {
    ownerRepo: stringSchema,
    number: { type: 'number', minimum: 1 },
    url: stringSchema,
  },
  required: ['ownerRepo', 'number'],
};

const prOverseerIssueRefSchema: RelayJsonSchema = {
  title: 'PrOverseerIssueRef',
  type: 'object',
  additionalProperties: false,
  properties: {
    ownerRepo: stringSchema,
    number: { type: 'number', minimum: 1 },
    url: stringSchema,
  },
  required: ['number'],
};

const prOverseerSessionRefSchema: RelayJsonSchema = {
  title: 'PrOverseerSessionRef',
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: stringSchema,
    globalSessionId: stringSchema,
  },
};

const prOverseerRecordSchema: RelayJsonSchema = {
  title: 'PrOverseerRecord',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    name: stringSchema,
    owner: { type: 'object', additionalProperties: true },
    repoPath: stringSchema,
    workContextId: stringSchema,
    session: prOverseerSessionRefSchema,
    issue: prOverseerIssueRefSchema,
    pr: prOverseerPrRefSchema,
    expectedHeadSha: stringSchema,
    status: stringSchema,
    blockers: { type: 'array', items: stringSchema },
    requiredNextAction: { type: 'object', additionalProperties: true },
    handoff: { type: 'object', additionalProperties: true },
    staleHeadRisk: { type: 'object', additionalProperties: true },
    heartbeat: { type: 'object', additionalProperties: true },
    cleanup: { type: 'object', additionalProperties: true },
    version: { type: 'number', minimum: 1 },
    redaction: { type: 'object', additionalProperties: true },
  },
  required: [
    'id',
    'name',
    'owner',
    'pr',
    'status',
    'blockers',
    'requiredNextAction',
    'handoff',
    'staleHeadRisk',
    'heartbeat',
    'cleanup',
    'version',
    'redaction',
  ],
};

const prOverseerRegisterInputSchema: RelayJsonSchema = {
  title: 'PrOverseerRegisterInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    name: stringSchema,
    owner: { type: 'object', additionalProperties: true },
    repoPath: stringSchema,
    workContextId: stringSchema,
    session: prOverseerSessionRefSchema,
    issue: prOverseerIssueRefSchema,
    pr: prOverseerPrRefSchema,
    expectedHeadSha: stringSchema,
    links: { type: 'object', additionalProperties: true },
    ttlSeconds: { type: 'number', minimum: 30, maximum: 604800 },
    observationSummary: stringSchema,
  },
  required: ['name', 'owner', 'pr'],
};

const prOverseerObserveInputSchema: RelayJsonSchema = {
  title: 'PrOverseerObserveInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    summary: stringSchema,
    expectedHeadSha: stringSchema,
    ttlSeconds: { type: 'number', minimum: 30, maximum: 604800 },
  },
};

const prOverseerRetireInputSchema: RelayJsonSchema = {
  title: 'PrOverseerRetireInput',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: stringSchema,
    reason: stringSchema,
    retiredBy: stringSchema,
  },
};

const prOverseerListInputSchema: RelayJsonSchema = {
  title: 'PrOverseerListInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    workContextId: stringSchema,
    repoPath: stringSchema,
    ownerRepo: stringSchema,
    status: {
      type: 'string',
      enum: [
        'pending',
        'observing',
        'blocked',
        'ready',
        'merged',
        'closed',
        'stale',
        'retired',
      ],
    },
    orchestrator: stringSchema,
    includeRetired: booleanSchema,
    limit: { type: 'number', minimum: 1, maximum: 100 },
  },
};

const prOverseerGetInputSchema: RelayJsonSchema = {
  title: 'PrOverseerGetInput',
  type: 'object',
  additionalProperties: false,
  properties: { id: stringSchema, currentHeadSha: stringSchema },
  required: ['id'],
};

const prOverseerOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { prOverseer: prOverseerRecordSchema },
  required: ['prOverseer'],
};

const prOverseerListOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prOverseers: { type: 'array', items: prOverseerRecordSchema },
  },
  required: ['prOverseers'],
};

const cockpitListInputSchema: RelayJsonSchema = {
  title: 'CockpitListInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'number', minimum: 1, maximum: 200 },
  },
};

const cockpitGetInputSchema: RelayJsonSchema = {
  title: 'CockpitGetInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    workContextId: stringSchema,
  },
  required: ['workContextId'],
};

const cockpitCommandHintSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    label: stringSchema,
    command: stringSchema,
    enabled: booleanSchema,
    disabledReason: nullableStringSchema,
    safety: { type: 'string', enum: ['read', 'attach'] },
  },
  required: ['id', 'label', 'enabled', 'disabledReason', 'safety'],
};

const cockpitListOutputDataSchema: RelayJsonSchema = {
  title: 'CockpitListOutputData',
  type: 'object',
  additionalProperties: false,
  properties: {
    generatedAt: { type: 'string', format: 'date-time' },
    count: { type: 'number', minimum: 0 },
    readFirst: { const: true },
    next: {
      oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }],
    },
    items: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
  required: ['generatedAt', 'count', 'next', 'items', 'readFirst'],
};

const cockpitGetOutputDataSchema: RelayJsonSchema = {
  title: 'CockpitGetOutputData',
  type: 'object',
  additionalProperties: false,
  properties: {
    generatedAt: { type: 'string', format: 'date-time' },
    readFirst: { const: true },
    selector: {
      type: 'object',
      additionalProperties: false,
      properties: { workContextId: stringSchema },
      required: ['workContextId'],
    },
    item: { type: 'object', additionalProperties: true },
    actionHints: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attach: cockpitCommandHintSchema,
        status: { type: 'array', items: cockpitCommandHintSchema },
        evidence: { type: 'array', items: cockpitCommandHintSchema },
        inbox: { type: 'array', items: cockpitCommandHintSchema },
        liveControls: { type: 'array', items: cockpitCommandHintSchema },
      },
      required: ['attach', 'status', 'evidence', 'inbox', 'liveControls'],
    },
  },
  required: ['generatedAt', 'selector', 'item', 'actionHints', 'readFirst'],
};

const channelMessagePartSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'image' },
    id: stringSchema,
    mime: {
      type: 'string',
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    w: { type: 'number' },
    h: { type: 'number' },
    bytes: { type: 'number' },
    alt: stringSchema,
  },
  required: ['type', 'id', 'mime', 'w', 'h', 'bytes'],
};

const channelPostInputSchema: RelayJsonSchema = {
  title: 'ChannelsPostInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    channelId: stringSchema,
    text: stringSchema,
    format: { type: 'string', enum: ['markdown', 'text'] },
    parentMessageId: stringSchema,
    threadId: nullableStringSchema,
    clientMessageId: stringSchema,
    parts: { type: 'array', items: channelMessagePartSchema },
  },
  required: ['channelId', 'text'],
};

const channelPostOutputDataSchema: RelayJsonSchema = {
  title: 'ChannelsPostData',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'object', additionalProperties: true },
  },
  required: ['message'],
};

const okOutput = (title: string, data: RelayJsonSchema): RelayJsonSchema => ({
  title,
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { const: true },
    contract: { const: RELAY_CLI_GATEWAY_MAJOR },
    contractVersion: { const: RELAY_CLI_GATEWAY_CONTRACT_VERSION },
    command: stringSchema,
    data,
  },
  required: ['ok', 'contract', 'contractVersion', 'command', 'data'],
});

const cliGatewayRedactionSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rawConfigReturned: { const: false },
    secretsReturned: { const: false },
    tokenMaterialReturned: { const: false },
  },
  required: ['rawConfigReturned', 'secretsReturned', 'tokenMaterialReturned'],
};

const cliGatewayWebhookRedactionSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rawConfigReturned: { const: false },
    secretsReturned: { const: false },
    tokenMaterialReturned: { const: false },
    webhookSecretsReturned: { const: false },
    rawWebhookUrlsReturned: { const: false },
  },
  required: [
    'rawConfigReturned',
    'secretsReturned',
    'tokenMaterialReturned',
    'webhookSecretsReturned',
    'rawWebhookUrlsReturned',
  ],
};

const cliGatewaySafeSettingsSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    defaultAgent: stringSchema,
    defaultNotifications: booleanSchema,
    renamerTool: {
      type: 'string',
      enum: ['claude', 'codex', 'none', 'custom-script'],
    },
    updateChannel: { type: 'string', enum: ['stable', 'nightly'] },
  },
  required: [
    'defaultAgent',
    'defaultNotifications',
    'renamerTool',
    'updateChannel',
  ],
};

const settingsGetOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    settings: cliGatewaySafeSettingsSchema,
    redaction: cliGatewayRedactionSchema,
  },
  required: ['settings', 'redaction'],
};

const settingsUpdateInputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: {
      type: 'string',
      enum: [
        'defaultAgent',
        'defaultNotifications',
        'renamerTool',
        'updateChannel',
      ],
    },
    value: { type: ['string', 'boolean'] },
    confirmRiskyWrite: booleanSchema,
  },
  required: ['key', 'value'],
};

const settingsUpdateOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: settingsUpdateInputSchema.properties?.['key'] ?? stringSchema,
    value: { type: ['string', 'boolean'] },
    previousValue: { type: ['string', 'boolean'] },
    changed: booleanSchema,
    redaction: cliGatewayRedactionSchema,
  },
  required: ['key', 'value', 'previousValue', 'changed', 'redaction'],
};

const webhookStatusOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    configured: booleanSchema,
    smeeConnected: booleanSchema,
    lastEventAt: nullableStringSchema,
    autoProvision: booleanSchema,
    repoStatuses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoPath: stringSchema,
          webhookStatus: {
            type: 'string',
            enum: ['manual', 'live', 'limited', 'error'],
          },
          webhookEnabled: booleanSchema,
          webhookError: stringSchema,
          lastEventAt: nullableStringSchema,
        },
        required: [
          'repoPath',
          'webhookStatus',
          'webhookEnabled',
          'lastEventAt',
        ],
      },
    },
    redaction: cliGatewayWebhookRedactionSchema,
  },
  required: [
    'configured',
    'smeeConnected',
    'lastEventAt',
    'autoProvision',
    'repoStatuses',
    'redaction',
  ],
};

const webhookPingOutputDataSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: booleanSchema,
    configured: booleanSchema,
    smeeConnected: booleanSchema,
    lastEventAt: nullableStringSchema,
    message: stringSchema,
    redaction: cliGatewayWebhookRedactionSchema,
  },
  required: [
    'ok',
    'configured',
    'smeeConnected',
    'lastEventAt',
    'message',
    'redaction',
  ],
};

const commandSpecs: readonly RelayCliGatewayCommandSpec[] = [
  {
    name: 'contract.list',
    cli: ['relay-ide', 'v1', '--list', '--json'],
    summary: 'List versioned gateway commands and machine-readable schemas.',
    stable: true,
    transport: 'local',
    requiresAuth: false,
    capabilityHints: [],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput('ContractListOutput', {
      $id: 'RelayCliGatewayContractManifest',
      type: 'object',
    }),
    errorCodes: ['INVALID_ARGUMENT', 'INTERNAL'],
  },
  {
    name: 'contract.schema',
    cli: ['relay-ide', 'v1', 'schema', '--json'],
    summary: 'Emit the complete v1 CLI gateway contract manifest.',
    stable: true,
    transport: 'local',
    requiresAuth: false,
    capabilityHints: [],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput('ContractSchemaOutput', {
      $id: 'RelayCliGatewayContractManifest',
      type: 'object',
    }),
    errorCodes: ['INTERNAL'],
  },
  {
    name: 'nodes.manifest',
    cli: ['relay-ide', 'v1', 'nodes', 'manifest', '--json'],
    summary: 'Return this host local node capability manifest.',
    stable: true,
    transport: 'local',
    requiresAuth: false,
    capabilityHints: [],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput('NodesManifestOutput', {
      type: 'object',
      additionalProperties: true,
    }),
    errorCodes: ['INTERNAL'],
  },
  {
    name: 'nodes.list',
    cli: ['relay-ide', 'v1', 'nodes', 'list', '--json'],
    summary:
      'List hub-known local/remote relay nodes and summarized capabilities.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput('NodesListOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodes: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['nodes'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'nodes.pair.requests',
    cli: ['relay-ide', 'v1', 'nodes', 'pair', 'requests', '--json'],
    summary:
      'List hub pending node pairing requests without exposing credentials.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      title: 'NodesPairRequestsInput',
      type: 'object',
      additionalProperties: false,
      properties: {
        state: {
          type: 'string',
          enum: ['pending', 'approved', 'denied', 'expired'],
        },
        deviceCode: stringSchema,
        includeResolved: booleanSchema,
      },
    },
    outputSchema: okOutput('NodesPairRequestsOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        requests: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['requests'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'nodes.pair.approve',
    cli: [
      'relay-ide',
      'v1',
      'nodes',
      'pair',
      'approve',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Approve a pending node pairing request using the existing hub pairing flow.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:create:terminal'],
    inputSchema: {
      title: 'NodesPairApproveInput',
      type: 'object',
      additionalProperties: false,
      properties: {
        requestId: stringSchema,
        displayName: stringSchema,
        requestedProfile: stringSchema,
        requestedRoots: { type: 'array', items: stringSchema },
        confirmationToken: stringSchema,
      },
      required: ['requestId'],
    },
    outputSchema: okOutput('NodesPairApproveOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { request: { type: 'object', additionalProperties: true } },
      required: ['request'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'CONFIRMATION_REQUIRED',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'nodes.pair.deny',
    cli: [
      'relay-ide',
      'v1',
      'nodes',
      'pair',
      'deny',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Deny a pending node pairing request through the hub pairing flow.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      title: 'NodesPairDenyInput',
      type: 'object',
      additionalProperties: false,
      properties: { requestId: stringSchema, reason: stringSchema },
      required: ['requestId'],
    },
    outputSchema: okOutput('NodesPairDenyOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { request: { type: 'object', additionalProperties: true } },
      required: ['request'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'nodes.pair.editAccess',
    cli: [
      'relay-ide',
      'v1',
      'nodes',
      'pair',
      'edit-access',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Edit display name, trust profile, or approved roots for a pending pairing request.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      title: 'NodesPairEditAccessInput',
      type: 'object',
      additionalProperties: false,
      properties: {
        requestId: stringSchema,
        displayName: stringSchema,
        requestedProfile: stringSchema,
        requestedRoots: { type: 'array', items: stringSchema },
      },
      required: ['requestId'],
    },
    outputSchema: okOutput('NodesPairEditAccessOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { request: { type: 'object', additionalProperties: true } },
      required: ['request'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'nodes.rotateCredential',
    cli: [
      'relay-ide',
      'v1',
      'nodes',
      'rotate-credential',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Rotate a paired node credential without exposing credential material.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      title: 'NodesRotateCredentialInput',
      type: 'object',
      additionalProperties: false,
      properties: {
        nodeId: stringSchema,
        delivery: {
          type: 'string',
          enum: ['online', 'manual'],
          default: 'online',
        },
        confirmationToken: stringSchema,
      },
      required: ['nodeId'],
    },
    outputSchema: okOutput('NodesRotateCredentialOutput', {
      type: 'object',
      additionalProperties: true,
      properties: { node: { type: 'object', additionalProperties: true } },
      required: ['node'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'CONFIRMATION_REQUIRED',
      'NODE_OFFLINE',
      'SESSION_REVOKED',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'nodes.revoke',
    cli: [
      'relay-ide',
      'v1',
      'nodes',
      'revoke',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary: 'Revoke a paired node credential and block future reconnects.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      title: 'NodesRevokeInput',
      type: 'object',
      additionalProperties: false,
      properties: { nodeId: stringSchema, confirmationToken: stringSchema },
      required: ['nodeId'],
    },
    outputSchema: okOutput('NodesRevokeOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { node: { type: 'object', additionalProperties: true } },
      required: ['node'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'CONFIRMATION_REQUIRED',
      'SESSION_REVOKED',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'repos.add',
    cli: [
      'relay-ide',
      'v1',
      'repos',
      'add',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Add a local repo/workspace path to Relay without relying on browser active repo state.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['rpc:git:read', 'rpc:git:write'],
    inputSchema: repoAddInputSchema,
    outputSchema: okOutput('ReposAddOutput', repoDescriptorSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'workspaces.launch',
    cli: [
      'relay-ide',
      'v1',
      'workspaces',
      'launch',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Launch a relay-pty terminal for a configured workspace group using its typed workspace id.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:create:terminal'],
    inputSchema: workspaceLaunchInputSchema,
    outputSchema: okOutput('WorkspacesLaunchOutput', sessionDescriptorSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'NOT_FOUND',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'worktrees.create',
    cli: [
      'relay-ide',
      'v1',
      'worktrees',
      'create',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Create or reuse a local git worktree for a repo instance; remote node writes fail closed until node capability support exists.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['rpc:git:read', 'rpc:git:write'],
    inputSchema: worktreeCreateInputSchema,
    outputSchema: okOutput('WorktreesCreateOutput', worktreeCreateOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'UNSUPPORTED',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'worktrees.status',
    cli: [
      'relay-ide',
      'v1',
      'worktrees',
      'status',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Preflight a worktree before cleanup, returning active session ids and dirty-worktree state.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'rpc:git:read'],
    inputSchema: worktreeStatusInputSchema,
    outputSchema: okOutput('WorktreesStatusOutput', worktreeStatusOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'UNSUPPORTED',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'worktrees.delete',
    cli: [
      'relay-ide',
      'v1',
      'worktrees',
      'delete',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Delete a local git worktree and its branch after fail-closed dirty/session/main-worktree checks.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: [
      'session:read',
      'session:control:kill',
      'rpc:git:read',
      'rpc:git:write',
    ],
    inputSchema: worktreeDeleteInputSchema,
    outputSchema: okOutput('WorktreesDeleteOutput', worktreeDeleteOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'UNSUPPORTED',
      'NOT_FOUND',
      'FORBIDDEN',
      'SESSION_CONFLICT',
      'CONFIRMATION_REQUIRED',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'worktrees.archive',
    cli: [
      'relay-ide',
      'v1',
      'worktrees',
      'archive',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Archive/remove a local git worktree while preserving its branch, with the same fail-closed preflight checks as delete.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: [
      'session:read',
      'session:control:kill',
      'rpc:git:read',
      'rpc:git:write',
    ],
    inputSchema: worktreeDeleteInputSchema,
    outputSchema: okOutput(
      'WorktreesArchiveOutput',
      worktreeDeleteOutputSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'UNSUPPORTED',
      'NOT_FOUND',
      'FORBIDDEN',
      'SESSION_CONFLICT',
      'CONFIRMATION_REQUIRED',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.list',
    cli: ['relay-ide', 'v1', 'sessions', 'list', '--json'],
    summary:
      'List active local and routed sessions with identity and control summaries.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput('SessionsListOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessions: { type: 'array', items: sessionDescriptorSchema },
      },
      required: ['sessions'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.get',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'get',
      '--id',
      '<session-id>',
      '--json',
    ],
    summary: 'Inspect one session by node-local id or globalSessionId.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema },
      required: ['id'],
    },
    outputSchema: okOutput('SessionsGetOutput', sessionDescriptorSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.create',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'create',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Create a local or routed relay-pty terminal and return the created descriptor. Agent participants belong to channels and DMs.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:create:terminal'],
    inputSchema: createSessionInputSchema,
    outputSchema: okOutput('SessionsCreateOutput', sessionDescriptorSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'UNSUPPORTED',
      'SERVER_UNAVAILABLE',
      'CONFIRMATION_REQUIRED',
      'NODE_OFFLINE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'tickets.startWork',
    cli: [
      'relay-ide',
      'v1',
      'tickets',
      'start-work',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Start work from a typed ticket context by resolving repo/branch/worktree policy and creating a Relay terminal.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:create:terminal'],
    inputSchema: ticketsStartWorkWorkflowInputSchema,
    outputSchema: okOutput(
      'TicketsStartWorkOutput',
      workflowCommandOutputSchema
    ),
    errorCodes: workflowGatewayErrorCodes,
  },
  {
    name: 'branches.openSession',
    cli: [
      'relay-ide',
      'v1',
      'branches',
      'open-session',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Open a terminal for a branch or PR target with typed repo/worktree and control metadata.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:create:terminal'],
    inputSchema: branchesOpenSessionWorkflowInputSchema,
    outputSchema: okOutput(
      'BranchesOpenSessionOutput',
      workflowCommandOutputSchema
    ),
    errorCodes: workflowGatewayErrorCodes,
  },
  {
    name: 'sessions.renew',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'renew',
      '--id',
      '<session-id>',
      '--ttl-seconds',
      '<seconds>',
      '--json',
    ],
    summary:
      'Renew or extend a scoped session expiry without changing its intent, scope, or peer identity.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:attach'],
    inputSchema: renewSessionInputSchema,
    outputSchema: okOutput('SessionsRenewOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { session: { type: 'object', additionalProperties: true } },
      required: ['session'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'SESSION_EXPIRED',
      'SESSION_REVOKED',
      'SESSION_MISMATCH',
      'SESSION_NON_RENEWABLE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.attach',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'attach',
      '--id',
      '<session-id>',
      '--json',
    ],
    summary:
      'Resolve a local or routed session descriptor for adapter attach without starting a streaming adapter runtime.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'session:attach'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema },
      required: ['id'],
    },
    outputSchema: okOutput('SessionsAttachOutput', attachOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.detach',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'detach',
      '--id',
      '<session-id>',
      '--json',
    ],
    summary:
      'Detach adapter control from a session without killing the underlying remote process.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'session:attach'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema },
      required: ['id'],
    },
    outputSchema: okOutput('SessionsDetachOutput', detachOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.kill',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'kill',
      '--id',
      '<session-id>',
      '--json',
    ],
    summary:
      'Destroy a local or routed session and terminate its underlying process.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'session:control:kill'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema, confirmationToken: stringSchema },
      required: ['id'],
    },
    outputSchema: okOutput('SessionsKillOutput', sessionKillOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'CONFIRMATION_REQUIRED',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.rename',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'rename',
      '--id',
      '<session-id>',
      '--display-name',
      '<display-name>',
      '--json',
    ],
    summary:
      'Persistently rename a local or routed session display name without changing process lifecycle.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'session:control:rename'],
    inputSchema: sessionRenameInputSchema,
    outputSchema: okOutput('SessionsRenameOutput', sessionRenameOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.stream',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'stream',
      '--id',
      '<session-id>',
      '--mode',
      'ndjson',
      '--json',
    ],
    summary:
      'Attach to a PTY session and emit UTF-8 output frames as newline-delimited gateway envelopes.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'session:attach'],
    inputSchema: sessionStreamInputSchema,
    outputSchema: okOutput('SessionsStreamEvent', sessionStreamEventSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.wait',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'wait',
      '--id',
      '<session-id>',
      '--output-text',
      '<text>',
      '--timeout-ms',
      '30000',
      '--json',
    ],
    summary:
      'Attach to a PTY session and wait for raw UTF-8 output or bounded idle without mutating session lifecycle.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'session:attach'],
    inputSchema: sessionWaitInputSchema,
    outputSchema: okOutput('SessionsWaitOutput', sessionWaitOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'UNSUPPORTED',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.screen',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'screen',
      '--id',
      '<session-id-or-global-id>',
      '--json',
    ],
    summary:
      'Read a bounded rendered terminal screen snapshot for a local relay-pty session from the libghostty terminal model.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: sessionScreenInputSchema,
    outputSchema: okOutput('SessionsScreenOutput', sessionScreenOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'UNSUPPORTED',
      'SESSION_CONFLICT',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.input',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'input',
      '--id',
      '<session-id>',
      '--data',
      '<text>',
      '--json',
    ],
    summary:
      'Send one UTF-8 input chunk to a PTY session, optionally waiting for observable echoed output.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'session:attach'],
    inputSchema: sessionInputInputSchema,
    outputSchema: okOutput('SessionsInputOutput', sessionInputOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'sessions.interventions',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'interventions',
      '--id',
      '<session-id>',
      '--json',
    ],
    summary:
      'Read bounded, redacted intervention metadata for a local session.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'tab:intervention:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: stringSchema,
        limit: { type: 'number', minimum: 1, maximum: 200 },
      },
      required: ['id'],
    },
    outputSchema: okOutput('SessionsInterventionsOutput', {
      type: 'object',
      additionalProperties: true,
      properties: {
        rawPayloadAvailable: { const: false },
        transcriptExportAvailable: { const: false },
      },
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'files.list',
    cli: [
      'relay-ide',
      'v1',
      'files',
      'list',
      '--session-id',
      '<session-id>',
      '--path',
      '<path>',
      '--json',
    ],
    summary: 'List a directory through scoped read-only File RPC.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'rpc:fs:list'],
    inputSchema: fileRpcListInputSchema,
    outputSchema: okOutput('FilesListOutput', fileRpcListOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'CONFIRMATION_REQUIRED',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'files.stat',
    cli: [
      'relay-ide',
      'v1',
      'files',
      'stat',
      '--session-id',
      '<session-id>',
      '--path',
      '<path>',
      '--json',
    ],
    summary: 'Stat a path through scoped read-only File RPC.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'rpc:fs:read'],
    inputSchema: fileRpcStatInputSchema,
    outputSchema: okOutput('FilesStatOutput', fileRpcStatOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'CONFIRMATION_REQUIRED',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'files.read',
    cli: [
      'relay-ide',
      'v1',
      'files',
      'read',
      '--session-id',
      '<session-id>',
      '--path',
      '<path>',
      '--json',
    ],
    summary:
      'Read UTF-8 file content through scoped read-only File RPC with byte/line caps.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'rpc:fs:read'],
    inputSchema: fileRpcReadInputSchema,
    outputSchema: okOutput('FilesReadOutput', fileRpcReadOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'CONFIRMATION_REQUIRED',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'files.write',
    cli: [
      'relay-ide',
      'v1',
      'files',
      'write',
      '--session-id',
      '<session-id>',
      '--path',
      '<path>',
      '--mode',
      '<create|overwrite|append>',
      '--file',
      '<local-path|->',
      '--json',
    ],
    summary:
      'Write file content through scoped File RPC with atomic-rename semantics and capability gate.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:read', 'rpc:fs:write'],
    inputSchema: fileRpcWriteInputSchema,
    outputSchema: okOutput('FilesWriteOutput', fileRpcWriteOutputSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'NODE_OFFLINE',
      'SERVER_UNAVAILABLE',
      'CONFIRMATION_REQUIRED',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'work-contexts.get',
    cli: [
      'relay-ide',
      'v1',
      'work-contexts',
      'get',
      '--id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'Read one WorkContext by stable identity for handoff/self-service agents.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: workContextGetInputSchema,
    outputSchema: okOutput('WorkContextsGetOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        workContext: { type: 'object', additionalProperties: true },
      },
      required: ['workContext'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'work-contexts.resume',
    cli: [
      'relay-ide',
      'v1',
      'work-contexts',
      'resume',
      '--id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'Generate a bounded deterministic WorkContext resume packet without raw logs, transcripts, or LLM history summarization.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: workContextResumeInputSchema,
    outputSchema: okOutput('WorkContextsResumeOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        resume: { type: 'object', additionalProperties: true },
      },
      required: ['resume'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'work-context-messages.append',
    cli: [
      'relay-ide',
      'v1',
      'work-context-messages',
      'append',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Append a WorkContext-scoped message envelope with agent/repo-defined payload data.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: workContextMessageAppendInputSchema,
    outputSchema: okOutput('WorkContextMessagesAppendOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { message: workContextMessageEnvelopeSchema },
      required: ['message'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'INVALID_JSON',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
    ],
  },
  {
    name: 'work-context-messages.list',
    cli: [
      'relay-ide',
      'v1',
      'work-context-messages',
      'list',
      '--work-context-id',
      '<id>',
      '--json',
    ],
    summary:
      'List bounded WorkContext message envelopes by context/thread/ref filters.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextMessageQueryInputSchema,
    outputSchema: okOutput('WorkContextMessagesListOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        messages: { type: 'array', items: workContextMessageEnvelopeSchema },
      },
      required: ['messages'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
    ],
  },
  {
    name: 'work-context-messages.show',
    cli: [
      'relay-ide',
      'v1',
      'work-context-messages',
      'show',
      '--id',
      '<message-id>',
      '--json',
    ],
    summary:
      'Read one WorkContext message envelope by id after WorkContext scope checks.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: {
      title: 'WorkContextMessagesShowInput',
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema },
      required: ['id'],
    },
    outputSchema: okOutput('WorkContextMessagesShowOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { message: workContextMessageEnvelopeSchema },
      required: ['message'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
    ],
  },
  {
    name: 'work-context-messages.query',
    cli: [
      'relay-ide',
      'v1',
      'work-context-messages',
      'query',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Query WorkContext messages with repo/agent-owned payload schemas preserved as opaque data.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextMessageQueryInputSchema,
    outputSchema: okOutput('WorkContextMessagesQueryOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        messages: { type: 'array', items: workContextMessageEnvelopeSchema },
        filter: workContextMessageQueryInputSchema,
      },
      required: ['messages'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
    ],
  },
  {
    name: 'work-context-messages.templates.list',
    cli: [
      'relay-ide',
      'v1',
      'work-context-messages',
      'templates',
      'list',
      '--repo-path',
      '<path>',
      '--json',
    ],
    summary:
      'List repo-local WorkContext message templates from .relay/messages/*.json.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextMessageTemplateSelectorSchema,
    outputSchema: okOutput('WorkContextMessageTemplatesListOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoRoot: stringSchema,
        templateDir: stringSchema,
        templates: { type: 'array', items: workContextMessageTemplateSchema },
        diagnostics: {
          type: 'array',
          items: workContextMessageTemplateDiagnosticSchema,
        },
      },
      required: ['templates', 'diagnostics'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
    ],
  },
  {
    name: 'work-context-messages.templates.show',
    cli: [
      'relay-ide',
      'v1',
      'work-context-messages',
      'templates',
      'show',
      '--template',
      '<id-or-stem>',
      '--json',
    ],
    summary:
      'Show one repo-local WorkContext message template by id or filename stem.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: {
      ...workContextMessageTemplateSelectorSchema,
      required: ['template'],
      properties: {
        ...workContextMessageTemplateSelectorSchema.properties,
        template: stringSchema,
      },
    },
    outputSchema: okOutput('WorkContextMessageTemplatesShowOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        template: workContextMessageTemplateSchema,
        repoRoot: stringSchema,
        templateDir: stringSchema,
        diagnostics: {
          type: 'array',
          items: workContextMessageTemplateDiagnosticSchema,
        },
      },
      required: ['template', 'diagnostics'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
    ],
  },
  {
    name: 'work-context-messages.templates.render',
    cli: [
      'relay-ide',
      'v1',
      'work-context-messages',
      'templates',
      'render',
      '--template',
      '<id-or-stem>',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Render a repo-local message template into a WorkContext message append input.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextMessageTemplateRenderInputSchema,
    outputSchema: okOutput('WorkContextMessageTemplatesRenderOutput', {
      type: 'object',
      additionalProperties: false,
      properties: {
        template: workContextMessageTemplateSchema,
        messageInput: { type: 'object', additionalProperties: true },
        diagnostics: {
          type: 'array',
          items: workContextMessageTemplateDiagnosticSchema,
        },
      },
      required: ['template', 'messageInput', 'diagnostics'],
    }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
    ],
  },
  {
    name: 'context.create',
    cli: [
      'relay-ide',
      'v1',
      'context',
      'create',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Create a ref-only context packet (file-anchor/file-ref/note) in the hub store.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: contextCreateInputSchema,
    outputSchema: okOutput('ContextCreateOutput', contextPacketDataSchema),
    errorCodes: contextInboxWriteErrorCodes,
  },
  {
    name: 'context.get',
    cli: [
      'relay-ide',
      'v1',
      'context',
      'get',
      '--id',
      '<context-packet-id>',
      '--json',
    ],
    summary:
      'Read one context packet by stable id. Ref-only; never returns raw file bytes.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: contextGetInputSchema,
    outputSchema: okOutput('ContextGetOutput', contextPacketDataSchema),
    errorCodes: contextInboxReadErrorCodes,
  },
  {
    name: 'context.list',
    cli: ['relay-ide', 'v1', 'context', 'list', '--json'],
    summary:
      'List context packets, optionally filtered by node/workspace binding or WorkContext artifact pins.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: contextListInputSchema,
    outputSchema: okOutput('ContextListOutput', contextListDataSchema),
    errorCodes: contextInboxReadErrorCodes,
  },
  {
    name: 'context.pin',
    cli: [
      'relay-ide',
      'v1',
      'context',
      'pin',
      '--id',
      '<context-packet-id>',
      '--work-context-id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'Pin an existing context packet to a WorkContext by recording a WorkContext artifact ref; the packet store remains the source of truth.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: contextPinInputSchema,
    outputSchema: okOutput('ContextPinOutput', contextPinDataSchema),
    errorCodes: contextInboxWriteErrorCodes,
  },
  {
    name: 'context.unpin',
    cli: [
      'relay-ide',
      'v1',
      'context',
      'unpin',
      '--id',
      '<context-packet-id>',
      '--work-context-id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'Unpin a context packet from a WorkContext artifact ref without deleting the packet; orphan cleanup/GC semantics remain explicit.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: contextPinInputSchema,
    outputSchema: okOutput('ContextUnpinOutput', contextUnpinDataSchema),
    errorCodes: contextInboxWriteErrorCodes,
  },
  {
    name: 'work-context-artifacts.publish',
    cli: [
      'relay-ide',
      'v1',
      'work-context-artifacts',
      'publish',
      '--work-context-id',
      '<work-context-id>',
      '--artifact-file',
      '<pipeline-handoff-artifact.json>',
      '--json',
    ],
    summary:
      'Publish a sanitized PipelineHandoffArtifact into the WorkContext artifact store with bounded payload and stable metadata.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['artifact:write'],
    inputSchema: workContextArtifactPublishInputSchema,
    outputSchema: okOutput(
      'WorkContextArtifactPublishOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactWriteErrorCodes,
  },
  {
    name: 'work-context-artifacts.list',
    cli: [
      'relay-ide',
      'v1',
      'work-context-artifacts',
      'list',
      '--work-context-id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'List WorkContext artifact metadata by WorkContext or task ref without reading raw payload files.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextArtifactListInputSchema,
    outputSchema: okOutput(
      'WorkContextArtifactListOutput',
      workContextArtifactListOutputSchema
    ),
    errorCodes: workContextArtifactReadErrorCodes,
  },
  {
    name: 'work-context-artifacts.show',
    cli: [
      'relay-ide',
      'v1',
      'work-context-artifacts',
      'show',
      '--id',
      '<artifact-id>',
      '--json',
    ],
    summary:
      'Read one WorkContext artifact by id with integrity validation and optional stale-head metadata.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextArtifactIdInputSchema,
    outputSchema: okOutput(
      'WorkContextArtifactShowOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactReadErrorCodes,
  },
  {
    name: 'work-context-artifacts.pin',
    cli: [
      'relay-ide',
      'v1',
      'work-context-artifacts',
      'pin',
      '--id',
      '<artifact-id>',
      '--work-context-id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'Pin a stored WorkContext artifact ref into a WorkContext without copying raw payload bytes.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['artifact:write'],
    inputSchema: workContextArtifactPinInputSchema,
    outputSchema: okOutput(
      'WorkContextArtifactPinOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactWriteErrorCodes,
  },
  {
    name: 'work-context-artifacts.unpin',
    cli: [
      'relay-ide',
      'v1',
      'work-context-artifacts',
      'unpin',
      '--id',
      '<artifact-id>',
      '--work-context-id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'Unpin a WorkContext artifact ref from a WorkContext without deleting the stored artifact.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['artifact:write'],
    inputSchema: workContextArtifactPinInputSchema,
    outputSchema: okOutput(
      'WorkContextArtifactUnpinOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactWriteErrorCodes,
  },
  {
    name: 'work-context-artifacts.export',
    cli: [
      'relay-ide',
      'v1',
      'work-context-artifacts',
      'export',
      '--id',
      '<artifact-id>',
      '--output',
      '<path>',
      '--json',
    ],
    summary:
      'Export the bounded public summary form of a WorkContext artifact; raw payload export is intentionally unsupported.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextArtifactIdInputSchema,
    outputSchema: okOutput(
      'WorkContextArtifactExportOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactReadErrorCodes,
  },
  {
    name: 'work-context-artifacts.doctor',
    cli: ['relay-ide', 'v1', 'work-context-artifacts', 'doctor', '--json'],
    summary:
      'Inspect WorkContext artifact store health, storage paths, bounded payload sizes, and recent artifact manifest entries.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextArtifactDoctorInputSchema,
    outputSchema: okOutput(
      'WorkContextArtifactDoctorOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactReadErrorCodes,
  },
  {
    name: 'handoff-artifacts.attach',
    cli: [
      'relay-ide',
      'v1',
      'handoff-artifacts',
      'attach',
      '--work-context-id',
      '<work-context-id>',
      '--artifact-file',
      '<pipeline-handoff-artifact.json>',
      '--json',
    ],
    summary:
      'Attach a validated PipelineHandoffArtifact layer to a WorkContext/TaskRef/PR lane; superseding writes must append stages without changing prior layers.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['artifact:write'],
    inputSchema: workContextArtifactPublishInputSchema,
    outputSchema: okOutput(
      'HandoffArtifactAttachOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactWriteErrorCodes,
  },
  {
    name: 'handoff-artifacts.list',
    cli: [
      'relay-ide',
      'v1',
      'handoff-artifacts',
      'list',
      '--work-context-id',
      '<work-context-id>',
      '--json',
    ],
    summary:
      'List PipelineHandoffArtifact metadata by WorkContext or task ref without reading raw payload files.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextArtifactListInputSchema,
    outputSchema: okOutput(
      'HandoffArtifactListOutput',
      workContextArtifactListOutputSchema
    ),
    errorCodes: workContextArtifactReadErrorCodes,
  },
  {
    name: 'handoff-artifacts.show',
    cli: [
      'relay-ide',
      'v1',
      'handoff-artifacts',
      'show',
      '--id',
      '<artifact-id>',
      '--json',
    ],
    summary:
      'Read one PipelineHandoffArtifact by id with integrity validation and optional stale-head metadata.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextArtifactIdInputSchema,
    outputSchema: okOutput(
      'HandoffArtifactShowOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactReadErrorCodes,
  },
  {
    name: 'handoff-artifacts.copy',
    cli: [
      'relay-ide',
      'v1',
      'handoff-artifacts',
      'copy',
      '--id',
      '<artifact-id>',
      '--output',
      '<path>',
      '--json',
    ],
    summary:
      'Copy the bounded public-safe PipelineHandoffArtifact summary; raw payload export is intentionally unsupported.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workContextArtifactIdInputSchema,
    outputSchema: okOutput(
      'HandoffArtifactCopyOutput',
      workContextArtifactRecordOutputSchema
    ),
    errorCodes: workContextArtifactReadErrorCodes,
  },
  {
    name: 'inbox.send',
    cli: [
      'relay-ide',
      'v1',
      'inbox',
      'send',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Queue a session/WorkContext inbox message referencing context packets. Never pushes into sessions.input; delivery is PULL.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['inbox:write'],
    inputSchema: inboxSendInputSchema,
    outputSchema: okOutput('InboxSendOutput', inboxMessageDataSchema),
    errorCodes: contextInboxWriteErrorCodes,
  },
  {
    name: 'inbox.list',
    cli: [
      'relay-ide',
      'v1',
      'inbox',
      'list',
      '--target-session-id',
      '<global-session-id>',
      '--json',
    ],
    summary:
      'List inbox messages for a session/WorkContext. PULL delivery: queued messages flip to delivered as a side effect of being fetched.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['inbox:read'],
    inputSchema: inboxListInputSchema,
    outputSchema: okOutput('InboxListOutput', inboxListDataSchema),
    errorCodes: contextInboxReadErrorCodes,
  },
  {
    name: 'inbox.get',
    cli: [
      'relay-ide',
      'v1',
      'inbox',
      'get',
      '--id',
      '<inbox-message-id>',
      '--json',
    ],
    summary:
      'Read one inbox message by id. PULL delivery: a queued message flips to delivered as a side effect of being fetched.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['inbox:read'],
    inputSchema: inboxGetInputSchema,
    outputSchema: okOutput('InboxGetOutput', inboxMessageDataSchema),
    errorCodes: contextInboxReadErrorCodes,
  },
  {
    name: 'inbox.ack',
    cli: [
      'relay-ide',
      'v1',
      'inbox',
      'ack',
      '--id',
      '<inbox-message-id>',
      '--json',
    ],
    summary:
      'Acknowledge an inbox message (delivered → acknowledged). Idempotent; rejects transitions out of terminal states.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['inbox:write'],
    inputSchema: inboxTransitionInputSchema,
    outputSchema: okOutput('InboxAckOutput', inboxMessageDataSchema),
    errorCodes: contextInboxWriteErrorCodes,
  },
  {
    name: 'inbox.resolve',
    cli: [
      'relay-ide',
      'v1',
      'inbox',
      'resolve',
      '--id',
      '<inbox-message-id>',
      '--json',
    ],
    summary:
      'Resolve an inbox message (terminal). Rejects transitions out of an already-terminal state.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['inbox:write'],
    inputSchema: inboxTransitionInputSchema,
    outputSchema: okOutput('InboxResolveOutput', inboxMessageDataSchema),
    errorCodes: contextInboxWriteErrorCodes,
  },
  {
    name: 'inbox.ignore',
    cli: [
      'relay-ide',
      'v1',
      'inbox',
      'ignore',
      '--id',
      '<inbox-message-id>',
      '--json',
    ],
    summary:
      'Ignore an inbox message (terminal). Rejects transitions out of an already-terminal state.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['inbox:write'],
    inputSchema: inboxTransitionInputSchema,
    outputSchema: okOutput('InboxIgnoreOutput', inboxMessageDataSchema),
    errorCodes: contextInboxWriteErrorCodes,
  },
  {
    name: 'handoffs.plan',
    cli: [
      'relay-ide',
      'v1',
      'handoffs',
      'plan',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Dry-run a cold handoff plan. Read-only; never mutates source or destination.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'rpc:fs:read'],
    inputSchema: handoffPlanInputSchema,
    outputSchema: okOutput('HandoffsPlanOutput', handoffPlanOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'artifacts.read',
    cli: [
      'relay-ide',
      'v1',
      'artifacts',
      'read',
      '--ref',
      '<artifact-ref>',
      '--json',
    ],
    summary:
      'Read a bounded handoff artifact reference; raw logs/secrets/transcripts are unavailable.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: artifactReadInputSchema,
    outputSchema: okOutput('ArtifactsReadOutput', artifactReadOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'supervisor.snapshot',
    cli: [
      'relay-ide',
      'v1',
      'supervisor',
      'snapshot',
      '--id',
      '<session-id>',
      '--json',
    ],
    summary:
      'Read a typed supervisor snapshot for one session with control-mode preflight, intervention ack checks, and redacted audit metadata; never sends raw PTY input.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'tab:intervention:read'],
    inputSchema: supervisorSnapshotInputSchema,
    outputSchema: okOutput(
      'SupervisorSnapshotOutput',
      supervisorSnapshotOutputSchema
    ),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'supervisor.sessions',
    cli: ['relay-ide', 'v1', 'supervisor', 'sessions', '--json'],
    summary:
      'List sessions eligible for typed supervisor actions with per-action reasons.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'tab:intervention:read'],
    inputSchema: supervisorSessionsInputSchema,
    outputSchema: okOutput(
      'SupervisorSessionsOutput',
      supervisorSessionsOutputSchema
    ),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'supervisor.sendText',
    cli: [
      'relay-ide',
      'v1',
      'supervisor',
      'send-text',
      '--id',
      '<session-id>',
      '--text',
      '<text>',
      '--json',
    ],
    summary:
      'Send bounded literal text to one or more PTY sessions as a typed supervisor intervention.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:attach', 'tab:intervention:send-text'],
    inputSchema: supervisorSendTextInputSchema,
    outputSchema: okOutput(
      'SupervisorSendTextOutput',
      supervisorActionOutputSchema('supervisor.sendText')
    ),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'supervisor.sendKey',
    cli: [
      'relay-ide',
      'v1',
      'supervisor',
      'send-key',
      '--id',
      '<session-id>',
      '--key',
      '<key-name>',
      '--json',
    ],
    summary:
      'Send one canonical closed-enum key to one or more PTY sessions as a typed supervisor intervention.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:attach', 'tab:intervention:send-key'],
    inputSchema: supervisorSendKeyInputSchema,
    outputSchema: okOutput(
      'SupervisorSendKeyOutput',
      supervisorActionOutputSchema('supervisor.sendKey')
    ),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'supervisor.submit',
    cli: [
      'relay-ide',
      'v1',
      'supervisor',
      'submit',
      '--id',
      '<session-id>',
      '[--text',
      '<text>]',
      '[--clear-input]',
      '[--paste]',
      '[--dry-run]',
      '--json',
    ],
    summary:
      'Typed submit primitive for agent/TUI steering: optionally type a (multi-line) text body, optionally clear the input first, then submit with an owned carriage return — callers never send a second Enter. Returns structured submission evidence. Inline text additionally requires tab:intervention:send-text.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:attach', 'tab:intervention:submit'],
    inputSchema: supervisorSubmitInputSchema,
    outputSchema: okOutput(
      'SupervisorSubmitOutput',
      supervisorActionOutputSchema('supervisor.submit')
    ),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'workflow-runs.publish',
    cli: [
      'relay-ide',
      'v1',
      'workflow-runs',
      'publish',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Publish a bounded WorkContext-scoped workflow run evidence projection without raw transcripts or provider-private state.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: workflowRunPublishInputSchema,
    outputSchema: okOutput(
      'WorkflowRunPublishOutput',
      workflowRunOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'workflow-runs.update',
    cli: [
      'relay-ide',
      'v1',
      'workflow-runs',
      'update',
      '--id',
      '<id>',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Update a bounded WorkContext-scoped workflow run projection, optionally with an expected version guard.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: workflowRunUpdateInputSchema,
    outputSchema: okOutput(
      'WorkflowRunUpdateOutput',
      workflowRunOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'workflow-runs.list',
    cli: [
      'relay-ide',
      'v1',
      'workflow-runs',
      'list',
      '--work-context-id',
      '<id>',
      '--json',
    ],
    summary: 'List bounded workflow run evidence projections by WorkContext.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workflowRunListInputSchema,
    outputSchema: okOutput(
      'WorkflowRunListOutput',
      workflowRunListOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'workflow-runs.get',
    cli: ['relay-ide', 'v1', 'workflow-runs', 'get', '--id', '<id>', '--json'],
    summary: 'Get one bounded workflow run projection by Relay workflowRun id.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workflowRunGetInputSchema,
    outputSchema: okOutput('WorkflowRunGetOutput', workflowRunOutputDataSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'automation-runs.register',
    cli: [
      'relay-ide',
      'v1',
      'automation-runs',
      'register',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Register (or replace) a Relay-visible automation/watchdog run with its target session ids, owner/orchestrator, links, and heartbeat TTL so a cron/watcher is trackable and retirable instead of silent.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: automationRunRegisterInputSchema,
    outputSchema: okOutput(
      'AutomationRunRegisterOutput',
      automationRunOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'automation-runs.observe',
    cli: [
      'relay-ide',
      'v1',
      'automation-runs',
      'observe',
      '--id',
      '<id>',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Record a heartbeat/observation for an automation run, refreshing its TTL and re-probing target session liveness so a watcher that stops reporting goes stale instead of running silently forever.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: automationRunObserveInputSchema,
    outputSchema: okOutput(
      'AutomationRunObserveOutput',
      automationRunOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'automation-runs.retire',
    cli: [
      'relay-ide',
      'v1',
      'automation-runs',
      'retire',
      '--id',
      '<id>',
      '--json',
    ],
    summary:
      'Retire an automation run as the safe, idempotent cleanup path; retiring an already-retired run is a no-op.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: automationRunRetireInputSchema,
    outputSchema: okOutput(
      'AutomationRunRetireOutput',
      automationRunOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'automation-runs.list',
    cli: ['relay-ide', 'v1', 'automation-runs', 'list', '--json'],
    summary:
      'List automation/watchdog runs with derived status (active/stale/cleanup-needed/retired) and stale target-session reasons, filterable by WorkContext, repo, status, kind, or orchestrator.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: automationRunListInputSchema,
    outputSchema: okOutput(
      'AutomationRunListOutput',
      automationRunListOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'automation-runs.get',
    cli: [
      'relay-ide',
      'v1',
      'automation-runs',
      'get',
      '--id',
      '<id>',
      '--json',
    ],
    summary:
      'Get one automation/watchdog run by id with derived status and live target-session liveness.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: automationRunGetInputSchema,
    outputSchema: okOutput(
      'AutomationRunGetOutput',
      automationRunOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'pr-overseer.register',
    cli: [
      'relay-ide',
      'v1',
      'pr-overseer',
      'register',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Link a Relay terminal, issue, or WorkContext to the GitHub PR it is shipping so checks, reviews, mergeability, and issue closeout can be observed and surfaced as structured blockers plus a required next action.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: prOverseerRegisterInputSchema,
    outputSchema: okOutput(
      'PrOverseerRegisterOutput',
      prOverseerOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'pr-overseer.observe',
    cli: [
      'relay-ide',
      'v1',
      'pr-overseer',
      'observe',
      '--id',
      '<id>',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      "Observe the linked PR's current GitHub checks/reviews/mergeability/issue-closeout, store an exact-head evidence snapshot, refresh the heartbeat, and return the derived status, blockers, stale-head risk, required next action, and handoff readiness.",
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: prOverseerObserveInputSchema,
    outputSchema: okOutput(
      'PrOverseerObserveOutput',
      prOverseerOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'pr-overseer.retire',
    cli: ['relay-ide', 'v1', 'pr-overseer', 'retire', '--id', '<id>', '--json'],
    summary:
      'Retire a PR overseer as the safe, idempotent terminal path (PR merged / abandoned); retiring an already-retired overseer is a no-op.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: prOverseerRetireInputSchema,
    outputSchema: okOutput(
      'PrOverseerRetireOutput',
      prOverseerOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'pr-overseer.list',
    cli: ['relay-ide', 'v1', 'pr-overseer', 'list', '--json'],
    summary:
      'List PR overseers with derived status (pending/observing/blocked/ready/merged/closed/stale/retired) and blockers, filterable by WorkContext, repo, owner/repo, status, or orchestrator. Reads are GitHub-free (last stored evidence + read-time staleness).',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: prOverseerListInputSchema,
    outputSchema: okOutput(
      'PrOverseerListOutput',
      prOverseerListOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'pr-overseer.get',
    cli: ['relay-ide', 'v1', 'pr-overseer', 'get', '--id', '<id>', '--json'],
    summary:
      'Get one PR overseer by id with the last stored exact-head evidence and derived status/blockers/handoff. Pass --current-head-sha to assert the head you are about to QA/merge matches the evidence (stale-head safety).',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: prOverseerGetInputSchema,
    outputSchema: okOutput('PrOverseerGetOutput', prOverseerOutputDataSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'workspace-surfaces.list',
    cli: ['relay-ide', 'v1', 'workspace-surfaces', 'list', '--json'],
    summary:
      'List bounded workspace surfaces discovered from safe static workspace metadata and agent-published records.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rootId: stringSchema,
        workspaceId: stringSchema,
        repoPath: stringSchema,
      },
    },
    outputSchema: okOutput(
      'WorkspaceSurfacesListOutput',
      workspaceSurfacesListOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'workspace-surfaces.publish',
    cli: ['relay-ide', 'v1', 'workspace-surfaces', 'publish', '--json'],
    summary:
      'Publish or update bounded agent-authored workspace surface metadata for display in Relay.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: workspaceSurfacesPublishInputSchema,
    outputSchema: okOutput(
      'WorkspaceSurfacesPublishOutput',
      workspaceSurfacesPublishOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'workspace-topics.list',
    cli: ['relay-ide', 'v1', 'workspace-topics', 'list', '--json'],
    summary:
      'List bounded WorkspaceTopic rows, or derive starter topics from existing WorkContexts when no persisted topic metadata exists.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspaceId: stringSchema,
        includeArchived: booleanSchema,
      },
    },
    outputSchema: okOutput(
      'WorkspaceTopicsListOutput',
      workspaceTopicsListOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'workspace-topics.search',
    cli: [
      'relay-ide',
      'v1',
      'workspace-topics',
      'search',
      '--q',
      '<query>',
      '--json',
    ],
    summary:
      'Search bounded WorkspaceTopic history across topic metadata, linked tasks, artifacts, surfaces, repos, agents, and sessions without exposing raw transcripts.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workspaceTopicSearchInputSchema,
    outputSchema: okOutput(
      'WorkspaceTopicsSearchOutput',
      workspaceTopicsSearchOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'workspace-topics.get',
    cli: [
      'relay-ide',
      'v1',
      'workspace-topics',
      'get',
      '--id',
      '<id>',
      '--json',
    ],
    summary:
      'Get one WorkspaceTopic by id, including linked WorkContext/session/task/artifact/surface refs.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:read'],
    inputSchema: workspaceTopicGetInputSchema,
    outputSchema: okOutput(
      'WorkspaceTopicsGetOutput',
      workspaceTopicOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'workspace-topics.create',
    cli: [
      'relay-ide',
      'v1',
      'workspace-topics',
      'create',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Create bounded WorkspaceTopic metadata with prompt/routing defaults and refs to existing WorkspaceSurface ids.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: workspaceTopicCreateInputSchema,
    outputSchema: okOutput(
      'WorkspaceTopicsCreateOutput',
      workspaceTopicOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'workspace-topics.update',
    cli: [
      'relay-ide',
      'v1',
      'workspace-topics',
      'update',
      '--id',
      '<id>',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Patch WorkspaceTopic metadata/defaults without duplicating WorkspaceSurface fields or storing raw secrets.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: workspaceTopicUpdateInputSchema,
    outputSchema: okOutput(
      'WorkspaceTopicsUpdateOutput',
      workspaceTopicOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'workspace-topics.archive',
    cli: [
      'relay-ide',
      'v1',
      'workspace-topics',
      'archive',
      '--id',
      '<id>',
      '--json',
    ],
    summary:
      'Archive a WorkspaceTopic. This destructive topic mutation advertises the Command Center confirmation-challenge policy and supports confirmation-token replay.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: workspaceTopicArchiveInputSchema,
    outputSchema: okOutput(
      'WorkspaceTopicsArchiveOutput',
      workspaceTopicOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'CONFIRMATION_REQUIRED',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'INTERNAL',
    ],
  },
  {
    name: 'channels.post',
    cli: [
      'relay-ide',
      'v1',
      'channels',
      'post',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Post a human- or agent-attributed message to a product channel; sender and source are always derived by the server.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['context:write'],
    inputSchema: channelPostInputSchema,
    outputSchema: okOutput('ChannelsPostOutput', channelPostOutputDataSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'SESSION_CONFLICT',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'cockpit.list',
    cli: ['relay-ide', 'v1', 'cockpit', 'list', '--json'],
    summary:
      'Read-first terminal cockpit projection over Active Work: ordered WorkContext/session attention, node freshness, durability, control state, TaskRefs, artifacts, and safe action availability.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'context:read'],
    inputSchema: cockpitListInputSchema,
    outputSchema: okOutput('CockpitListOutput', cockpitListOutputDataSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'cockpit.get',
    cli: [
      'relay-ide',
      'v1',
      'cockpit',
      'get',
      '--work-context-id',
      '<id>',
      '--json',
    ],
    summary:
      'Read-first terminal cockpit detail for one active WorkContext/session, including bounded status/evidence and attach command hints with disabled reasons.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'context:read'],
    inputSchema: cockpitGetInputSchema,
    outputSchema: okOutput('CockpitGetOutput', cockpitGetOutputDataSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'events.subscribe',
    cli: [
      'relay-ide',
      'v1',
      'events',
      'subscribe',
      '--topic',
      '<topic>',
      '--json',
    ],
    summary:
      'Subscribe to a non-destructive hub event topic and emit newline-delimited gateway envelopes. Read-only.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    // Union of capabilities across all topics: legacy `sessions` and `nodes`
    // need `session:read`; `audit` additionally needs
    // `tab:intervention:read`; WorkContext metadata topics need
    // `context:read`; `inbox` needs `inbox:read`. Generators that surface
    // this verb should request the superset so a single tool definition covers
    // every topic.
    capabilityHints: [
      'session:read',
      'tab:intervention:read',
      'context:read',
      'inbox:read',
    ],
    inputSchema: eventsSubscribeInputSchema,
    outputSchema: okOutput('EventsSubscribeFrame', eventsSubscribeFrameSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'settings.get',
    cli: ['relay-ide', 'v1', 'settings', 'get', '--json'],
    summary:
      'Read the CLI gateway safe settings subset with explicit redaction metadata; raw config and secrets are never returned.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: [],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput('SettingsGetOutput', settingsGetOutputDataSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'settings.update',
    cli: [
      'relay-ide',
      'v1',
      'settings',
      'update',
      '--input-json',
      '<json>',
      '--json',
    ],
    summary:
      'Mutate one allowlisted safe setting; risky transitions require confirmRiskyWrite=true and never expose raw config or secrets.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: [],
    inputSchema: settingsUpdateInputSchema,
    outputSchema: okOutput(
      'SettingsUpdateOutput',
      settingsUpdateOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'CONFIRMATION_REQUIRED',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'webhooks.status',
    cli: ['relay-ide', 'v1', 'webhooks', 'status', '--json'],
    summary:
      'Read bounded webhook relay status with webhook secrets and raw URLs intentionally redacted.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: [],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput(
      'WebhooksStatusOutput',
      webhookStatusOutputDataSchema
    ),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
  {
    name: 'webhooks.ping',
    cli: ['relay-ide', 'v1', 'webhooks', 'ping', '--json'],
    summary:
      'Run a safe webhook relay configuration ping/status probe without returning webhook secrets or raw URLs.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: [],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: okOutput('WebhooksPingOutput', webhookPingOutputDataSchema),
    errorCodes: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'SERVER_UNAVAILABLE',
      'UPSTREAM_ERROR',
    ],
  },
];

export const RELAY_CLI_GATEWAY_CONTRACT: RelayCliGatewayContractManifest = {
  schemaVersion: 1,
  contract: RELAY_CLI_GATEWAY_MAJOR,
  contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
  generatedFrom: 'shared/cli-gateway-contract.ts',
  protocolVersions: {
    nodeLink: RELAY_NODE_LINK_PROTOCOL_VERSION,
    securityPolicy: RELAY_SECURITY_POLICY_VERSION,
  },
  errorEnvelopeSchema: gatewayErrorSchema,
  commandSchemas: commandSpecs,
};

export function gatewayOk<T>(
  command: RelayCliGatewayCommand,
  data: T
): RelayCliGatewayOkEnvelope<T> {
  return {
    ok: true,
    contract: RELAY_CLI_GATEWAY_MAJOR,
    contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
    command,
    data,
  };
}

export function gatewayError(
  command: RelayCliGatewayCommand,
  error: RelayCliGatewayError
): RelayCliGatewayErrorEnvelope {
  return {
    ok: false,
    contract: RELAY_CLI_GATEWAY_MAJOR,
    contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
    command,
    error,
  };
}

export function commandSpec(
  name: RelayCliGatewayCommand
): RelayCliGatewayCommandSpec {
  const spec = RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.find(
    (entry) => entry.name === name
  );
  if (!spec) throw new Error(`unknown CLI gateway command spec: ${name}`);
  return spec;
}

export function stableCommandNames(): RelayCliGatewayCommand[] {
  return RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.map((entry) => entry.name);
}
