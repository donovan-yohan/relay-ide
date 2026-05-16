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
  | 'sessions.attach'
  | 'sessions.detach'
  | 'sessions.stream'
  | 'sessions.input'
  | 'sessions.interventions'
  | 'sessions.handBack'
  | 'files.list'
  | 'files.stat'
  | 'files.read';

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

const sessionInputInputSchema: RelayJsonSchema = {
  title: 'SessionsInputInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: stringSchema,
    data: stringSchema,
    dataBase64: stringSchema,
    stdin: booleanSchema,
    waitFor: stringSchema,
    timeoutMs: { type: 'number', minimum: 1, maximum: 300000 },
    maxBytes: { type: 'number', minimum: 1, maximum: 1048576 },
  },
  required: ['id'],
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

const createSessionInputSchema: RelayJsonSchema = {
  title: 'CreateSessionInput',
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: {
      description: 'Optional execution node. Omit for current local /sessions path.',
      type: 'string',
    },
    repoPath: stringSchema,
    worktreePath: nullableStringSchema,
    cwd: stringSchema,
    type: { type: 'string', enum: ['agent', 'terminal'], default: 'agent' },
    mode: { type: 'string', enum: ['pty', 'web'] },
    agent: stringSchema,
    yolo: booleanSchema,
    cols: { type: 'number', minimum: 1, maximum: 500 },
    rows: { type: 'number', minimum: 1, maximum: 200 },
    branchName: stringSchema,
    initialPrompt: stringSchema,
    continuePolicy: { type: 'string', enum: ['always', 'never'] },
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
