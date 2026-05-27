import { RELAY_NODE_LINK_PROTOCOL_VERSION } from './relay-node-protocol.js';
import { RELAY_SECURITY_POLICY_VERSION } from './security-policy.js';

export const RELAY_CLI_GATEWAY_MAJOR = 'v1' as const;
export const RELAY_CLI_GATEWAY_CONTRACT_VERSION = '1.0' as const;

export type RelayCliGatewayCommand =
  | 'contract.list'
  | 'contract.schema'
  | 'nodes.manifest'
  | 'nodes.list'
  | 'sessions.list'
  | 'sessions.get'
  | 'sessions.create'
  | 'sessions.renew'
  | 'sessions.attach'
  | 'sessions.detach'
  | 'sessions.stream'
  | 'sessions.input'
  | 'sessions.interventions'
  | 'sessions.handBack'
  | 'files.list'
  | 'files.stat'
  | 'files.read'
  | 'files.write'
  | 'work-contexts.get'
  | 'handoffs.plan'
  | 'handoffs.create'
  | 'handoffs.status'
  | 'handoffs.cancel'
  | 'handoffs.resume'
  | 'handoffs.launch'
  | 'artifacts.read'
  | 'supervisor.snapshot'
  | 'supervisor.sessions'
  | 'supervisor.sendText'
  | 'supervisor.submit'
  | 'events.subscribe';

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
        kind: { type: 'string', enum: ['local-compatibility', 'node-cwd', 'repo', 'worktree'] },
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
    type: { type: 'string', enum: ['agent', 'terminal'] },
    agent: stringSchema,
    mode: { type: 'string', enum: ['pty', 'web'] },
    nodeId: stringSchema,
    globalSessionId: stringSchema,
    cwd: stringSchema,
    repoPath: stringSchema,
    worktreePath: nullableStringSchema,
    repoName: stringSchema,
    branchName: stringSchema,
    displayName: stringSchema,
    status: { type: 'string', enum: ['active', 'disconnected'] },
    controlMode: { type: 'string', enum: ['agent-driven', 'human-driven', 'co-driven'] },
    activeActors: { type: 'array', items: controlActorSchema },
    activeWorker: controlActorSchema,
    lastInterventionAt: nullableStringSchema,
    lastInterventionBy: { oneOf: [controlActorSchema, { type: 'null' }] },
    lastInterventionEventId: nullableStringSchema,
    controlFreshness: { type: 'string', enum: ['fresh', 'stale', 'unknown'] },
    controlReason: stringSchema,
    sessionEnvelope: sessionEnvelopeSchema,
  },
  required: ['id', 'type', 'agent', 'mode', 'cwd', 'displayName', 'status'],
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
  required: ['operation', 'root', 'cwd', 'path', 'entries', 'truncated', 'maxEntries'],
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
  required: [...(fileRpcBaseInputSchema.required ?? []), 'mode', 'contentBase64'],
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
  required: ['operation', 'root', 'cwd', 'path', 'mode', 'bytesWritten', 'newHash', 'newMtime', 'created'],
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
  required: ['sent', 'sessionId', 'bytesSent', 'matched', 'bytesReceived', 'truncated'],
};

/**
 * Typed environment shape for agent task creation (#626, epic #615).
 *
 * Adapter-facing alternative to the legacy `repoPath` / `worktreePath` / flat
 * `nodeId` + `cwd` fields. Uses scoped IDs from `shared/identity.ts` and the
 * canonical `RepoIdentity` string ("github.com/{owner}/{name}" or
 * "{host}/{path}") emitted by `shared/repo-identity.ts`. Raw host/path pairs
 * are intentionally absent: free-form host strings are exactly what #626
 * forbids on the agent task contract.
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
    type: { type: 'string', enum: ['agent', 'terminal'], default: 'agent' },
    mode: { type: 'string', enum: ['pty', 'web'] },
    agent: stringSchema,
    yolo: booleanSchema,
    cols: { type: 'number', minimum: 1, maximum: 500 },
    rows: { type: 'number', minimum: 1, maximum: 200 },
    branchName: stringSchema,
    initialPrompt: stringSchema,
    continuePolicy: { type: 'string', enum: ['always', 'never'] },
    workContextId: stringSchema,
    controlMode: {
      type: 'string',
      enum: ['agent-driven', 'human-driven'],
      description:
        'Only routed node session creation currently policy-checks controlMode. Local create rejects agent-driven as unsupported until hub policy support lands.',
    },
    sessionEnvelope: sessionEnvelopeSchema,
    ttlSeconds: { type: 'number', minimum: 1 },
    expiresAt: { type: 'string', format: 'date-time' },
    confirmationToken: stringSchema,
  },
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

const gatewayErrorSchema: RelayJsonSchema = {
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

export const EVENTS_SUBSCRIBE_TOPICS = ['sessions', 'nodes', 'audit'] as const;
export type EventsSubscribeTopic = (typeof EVENTS_SUBSCRIBE_TOPICS)[number];

const eventsSubscribeInputSchema: RelayJsonSchema = {
  title: 'EventsSubscribeInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: {
      type: 'string',
      enum: EVENTS_SUBSCRIBE_TOPICS,
      description:
        'Non-destructive event topic to subscribe to: sessions lifecycle/control, node link status, or redacted audit envelopes.',
    },
    maxEvents: {
      type: 'number',
      minimum: 1,
      maximum: 10000,
      description: 'Detach after N event frames (excluding open/closed envelopes).',
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

const handoffCreateInputSchema: RelayJsonSchema = {
  title: 'HandoffCreateInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: stringSchema,
    plan: { type: 'object', additionalProperties: true },
    confirmedGrants: { type: 'array', items: { type: 'object', additionalProperties: true } },
    sourceRepoPath: stringSchema,
    destinationRepoPath: stringSchema,
    approvedUntrackedPaths: { type: 'array', items: stringSchema },
    actorId: stringSchema,
  },
  required: ['confirmedGrants', 'sourceRepoPath', 'destinationRepoPath'],
  anyOf: [{ required: ['planId'] }, { required: ['plan'] }],
};

const handoffRunIdInputSchema: RelayJsonSchema = {
  title: 'HandoffRunIdInput',
  type: 'object',
  additionalProperties: false,
  properties: { runId: stringSchema, actorId: stringSchema },
  required: ['runId'],
};

const artifactReadInputSchema: RelayJsonSchema = {
  title: 'ArtifactReadInput',
  type: 'object',
  additionalProperties: false,
  properties: { ref: stringSchema },
  required: ['ref'],
};

const supervisorSnapshotInputSchema: RelayJsonSchema = {
  title: 'SupervisorSnapshotInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    expectedControlMode: {
      type: 'string',
      enum: ['agent-driven', 'human-driven', 'co-driven'],
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

const supervisorSubmitInputSchema: RelayJsonSchema = {
  title: 'SupervisorSubmitInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    targetIds: { type: 'array', items: stringSchema },
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

const handoffCreateOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run: { type: 'object', additionalProperties: true },
    artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['run', 'artifacts'],
};

const handoffStatusOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run: { type: 'object', additionalProperties: true },
    progress: { type: 'object', additionalProperties: true },
    redaction: { type: 'object', additionalProperties: true },
  },
  required: ['run', 'progress', 'redaction'],
};

const handoffResumeOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run: { type: 'object', additionalProperties: true },
    resume: { type: 'object', additionalProperties: true },
  },
  required: ['run', 'resume'],
};

const artifactReadOutputSchema: RelayJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifact: { type: 'object', additionalProperties: true },
  },
  required: ['artifact'],
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
    sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    count: { type: 'number', minimum: 0 },
  },
  required: ['command', 'sessions', 'count'],
};

const supervisorActionOutputSchema = (
  command: 'supervisor.sendText' | 'supervisor.submit'
): RelayJsonSchema => {
  const action = command === 'supervisor.submit' ? 'submit' : 'sendText';
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      command: { const: command },
      action: { const: action },
      results: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
    payload: { type: 'object', additionalProperties: true },
    frames: { type: 'number', minimum: 0 },
    closeCode: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['event', 'topic', 'sequence'],
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

const commandSpecs: readonly RelayCliGatewayCommandSpec[] = [
  {
    name: 'contract.list',
    cli: ['relay-ide', 'v1', '--list', '--json'],
    summary: 'List versioned gateway commands and machine-readable schemas.',
    stable: true,
    transport: 'local',
    requiresAuth: false,
    capabilityHints: [],
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: okOutput('ContractListOutput', { $id: 'RelayCliGatewayContractManifest', type: 'object' }),
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
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: okOutput('ContractSchemaOutput', { $id: 'RelayCliGatewayContractManifest', type: 'object' }),
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
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: okOutput('NodesManifestOutput', { type: 'object', additionalProperties: true }),
    errorCodes: ['INTERNAL'],
  },
  {
    name: 'nodes.list',
    cli: ['relay-ide', 'v1', 'nodes', 'list', '--json'],
    summary: 'List hub-known local/remote relay nodes and summarized capabilities.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: okOutput('NodesListOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { nodes: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      required: ['nodes'],
    }),
    errorCodes: ['UNAUTHORIZED', 'INVALID_ARGUMENT', 'SERVER_UNAVAILABLE', 'UPSTREAM_ERROR'],
  },
  {
    name: 'sessions.list',
    cli: ['relay-ide', 'v1', 'sessions', 'list', '--json'],
    summary: 'List active local and routed sessions with identity and control summaries.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: okOutput('SessionsListOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { sessions: { type: 'array', items: sessionDescriptorSchema } },
      required: ['sessions'],
    }),
    errorCodes: ['UNAUTHORIZED', 'INVALID_ARGUMENT', 'SERVER_UNAVAILABLE', 'UPSTREAM_ERROR'],
  },
  {
    name: 'sessions.get',
    cli: ['relay-ide', 'v1', 'sessions', 'get', '--id', '<session-id>', '--json'],
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
    cli: ['relay-ide', 'v1', 'sessions', 'create', '--input-json', '<json>', '--json'],
    summary: 'Create a local or routed node session and return the created descriptor.',
    stable: true,
    transport: 'hub-http-or-node-rpc',
    requiresAuth: true,
    capabilityHints: ['session:create:terminal', 'session:create:agent', 'tab:mode:set-agent'],
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
    name: 'sessions.renew',
    cli: ['relay-ide', 'v1', 'sessions', 'renew', '--id', '<session-id>', '--ttl-seconds', '<seconds>', '--json'],
    summary: 'Renew or extend a scoped session expiry without changing its intent, scope, or peer identity.',
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
    cli: ['relay-ide', 'v1', 'sessions', 'attach', '--id', '<session-id>', '--json'],
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
    cli: ['relay-ide', 'v1', 'sessions', 'detach', '--id', '<session-id>', '--json'],
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
    cli: ['relay-ide', 'v1', 'sessions', 'interventions', '--id', '<session-id>', '--json'],
    summary: 'Read bounded, redacted intervention metadata for a local session.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'tab:intervention:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema, limit: { type: 'number', minimum: 1, maximum: 200 } },
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
    name: 'sessions.handBack',
    cli: [
      'relay-ide',
      'v1',
      'sessions',
      'hand-back',
      '--id',
      '<session-id>',
      '--latest-seen-intervention-event-id',
      '<event-id>',
      '--json',
    ],
    summary: 'Acknowledge latest human intervention before restoring agent-driven control.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:attach', 'tab:mode:set-agent'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema, latestSeenInterventionEventId: stringSchema },
      required: ['id', 'latestSeenInterventionEventId'],
    },
    outputSchema: okOutput('SessionsHandBackOutput', { type: 'object', additionalProperties: true }),
    errorCodes: [
      'UNAUTHORIZED',
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'FORBIDDEN',
      'SESSION_CONFLICT',
      'CONTROL_STATE_STALE',
      'INTERVENTION_ACK_REQUIRED',
      'INTERVENTION_ACK_STALE',
      'CONTROL_STATE_UNKNOWN',
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
    summary: 'Read UTF-8 file content through scoped read-only File RPC with byte/line caps.',
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
    summary: 'Write file content through scoped File RPC with atomic-rename semantics and capability gate.',
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
    cli: ['relay-ide', 'v1', 'work-contexts', 'get', '--id', '<work-context-id>', '--json'],
    summary: 'Read one WorkContext by stable identity for handoff/self-service agents.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: workContextGetInputSchema,
    outputSchema: okOutput('WorkContextsGetOutput', {
      type: 'object',
      additionalProperties: false,
      properties: { workContext: { type: 'object', additionalProperties: true } },
      required: ['workContext'],
    }),
    errorCodes: ['UNAUTHORIZED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'SERVER_UNAVAILABLE', 'UPSTREAM_ERROR'],
  },
  {
    name: 'handoffs.plan',
    cli: ['relay-ide', 'v1', 'handoffs', 'plan', '--input-json', '<json>', '--json'],
    summary: 'Dry-run a cold handoff plan. Read-only; never mutates source or destination.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'rpc:fs:read'],
    inputSchema: handoffPlanInputSchema,
    outputSchema: okOutput('HandoffsPlanOutput', handoffPlanOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'handoffs.create',
    cli: ['relay-ide', 'v1', 'handoffs', 'create', '--input-json', '<json>', '--json'],
    summary: 'Execute a confirmed cold handoff through the transfer/apply engine; refuses fake success.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['rpc:fs:read', 'rpc:fs:write', 'session:create:agent', 'session:create:terminal', 'pty:exec:arbitrary'],
    inputSchema: handoffCreateInputSchema,
    outputSchema: okOutput('HandoffsCreateOutput', handoffCreateOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'handoffs.status',
    cli: ['relay-ide', 'v1', 'handoffs', 'status', '--run-id', '<run-id>', '--json'],
    summary: 'Read bounded/redacted HandoffRun state and progress.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: handoffRunIdInputSchema,
    outputSchema: okOutput('HandoffsStatusOutput', handoffStatusOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'handoffs.cancel',
    cli: ['relay-ide', 'v1', 'handoffs', 'cancel', '--run-id', '<run-id>', '--json'],
    summary: 'Cancel a non-terminal handoff run without applying additional mutations.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: handoffRunIdInputSchema,
    outputSchema: okOutput('HandoffsCancelOutput', handoffStatusOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'handoffs.resume',
    cli: ['relay-ide', 'v1', 'handoffs', 'resume', '--run-id', '<run-id>', '--json'],
    summary: 'Read cold handoff resume bundle refs without raw transcript/provider-auth export.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read'],
    inputSchema: handoffRunIdInputSchema,
    outputSchema: okOutput('HandoffsResumeOutput', handoffResumeOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'handoffs.launch',
    cli: ['relay-ide', 'v1', 'handoffs', 'launch', '--run-id', '<run-id>', '--json'],
    summary: 'Retry hub-side destination session launch for an applied cold handoff after a typed launch failure.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    // Static gateway manifests cannot know whether the stored retry target is
    // agent or terminal; advertise the superset for tool generators while the
    // hub route enforces the stored plan's runtime-specific create capability.
    capabilityHints: ['session:read', 'session:create:agent', 'session:create:terminal', 'pty:exec:arbitrary'],
    inputSchema: handoffRunIdInputSchema,
    outputSchema: okOutput('HandoffsLaunchOutput', handoffCreateOutputSchema),
    errorCodes: gatewayHandoffErrorCodes,
  },
  {
    name: 'artifacts.read',
    cli: ['relay-ide', 'v1', 'artifacts', 'read', '--ref', '<artifact-ref>', '--json'],
    summary: 'Read a bounded handoff artifact reference; raw logs/secrets/transcripts are unavailable.',
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
    cli: ['relay-ide', 'v1', 'supervisor', 'snapshot', '--id', '<session-id>', '--json'],
    summary:
      'Read a typed supervisor snapshot for one session with control-mode preflight, intervention ack checks, and redacted audit metadata; never sends raw PTY input.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'tab:intervention:read'],
    inputSchema: supervisorSnapshotInputSchema,
    outputSchema: okOutput('SupervisorSnapshotOutput', supervisorSnapshotOutputSchema),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'supervisor.sessions',
    cli: ['relay-ide', 'v1', 'supervisor', 'sessions', '--json'],
    summary: 'List sessions eligible for typed supervisor actions with per-action reasons.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:read', 'tab:intervention:read'],
    inputSchema: supervisorSessionsInputSchema,
    outputSchema: okOutput('SupervisorSessionsOutput', supervisorSessionsOutputSchema),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'supervisor.sendText',
    cli: ['relay-ide', 'v1', 'supervisor', 'send-text', '--id', '<session-id>', '--text', '<text>', '--json'],
    summary: 'Send bounded literal text to one or more PTY sessions as a typed supervisor intervention.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:attach', 'tab:intervention:send-text'],
    inputSchema: supervisorSendTextInputSchema,
    outputSchema: okOutput('SupervisorSendTextOutput', supervisorActionOutputSchema('supervisor.sendText')),
    errorCodes: gatewaySupervisorErrorCodes,
  },
  {
    name: 'supervisor.submit',
    cli: ['relay-ide', 'v1', 'supervisor', 'submit', '--id', '<session-id>', '--json'],
    summary: 'Submit Enter to one or more PTY sessions as a typed supervisor intervention.',
    stable: true,
    transport: 'hub-http',
    requiresAuth: true,
    capabilityHints: ['session:attach', 'tab:intervention:submit'],
    inputSchema: supervisorSubmitInputSchema,
    outputSchema: okOutput('SupervisorSubmitOutput', supervisorActionOutputSchema('supervisor.submit')),
    errorCodes: gatewaySupervisorErrorCodes,
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
    // Union of capabilities across all topics: `sessions` and `nodes` need
    // `session:read`; `audit` additionally needs `tab:intervention:read`
    // (enforced by the hub router on the `audit` topic). Generators that
    // surface this verb should request the superset so a single tool
    // definition covers every topic.
    capabilityHints: ['session:read', 'tab:intervention:read'],
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

export function commandSpec(name: RelayCliGatewayCommand): RelayCliGatewayCommandSpec {
  const spec = RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown CLI gateway command spec: ${name}`);
  return spec;
}

export function stableCommandNames(): RelayCliGatewayCommand[] {
  return RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.map((entry) => entry.name);
}
