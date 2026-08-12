/**
 * Local, stdio-only MCP facade for the deliberately small channel-client API.
 *
 * This is not a generic Relay gateway bridge. The command tuple is closed so a
 * desktop MCP host cannot turn an ambient Relay credential into shell, PTY, or
 * provider-runtime access. Credentials are read only by createRelayChannelClient
 * from process configuration; no MCP tool accepts connection settings or tokens.
 */
import {
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';

import {
  RELAY_CLI_GATEWAY_CONTRACT,
  RELAY_CLI_GATEWAY_CONTRACT_VERSION,
  RELAY_CLI_GATEWAY_MAJOR,
  type RelayCliGatewayCommand,
  type RelayCliGatewayCommandSpec,
  type RelayCliGatewayError,
  type RelayJsonSchema,
} from './cli-gateway-contract.js';
import {
  createRelayChannelClient,
  RelayChannelClientError,
  RelayChannelSubscriptionOverflowError,
  type RelayChannelClient,
} from './channel-client.js';
import {
  isChannelSubscriptionFilter,
  type ChannelSubscriptionFilter,
} from './channel-chat-protocol.js';
import { RELAY_COMMAND_MANIFEST } from './relay-command-manifest.js';

/** The complete and intentionally non-extensible Relay MCP command set. */
export const RELAY_MCP_CHANNEL_COMMANDS = [
  'channels.list',
  'channels.get',
  'channels.run.get',
  'channels.history',
  'channels.subscribe',
  'channels.threads.history',
  'channels.roster',
  'channels.post',
] as const satisfies readonly RelayCliGatewayCommand[];

export const RELAY_MCP_SUBSCRIBE_MAX_EVENTS = 100;
export const RELAY_MCP_SUBSCRIBE_MAX_IDLE_TIMEOUT_MS = 30_000;

type RelayMcpChannelCommand = (typeof RELAY_MCP_CHANNEL_COMMANDS)[number];
type JsonRecord = Record<string, unknown>;

// Keep this denylist aligned with the channel-client projection. The MCP
// facade repeats it deliberately: injected/test clients and future client
// regressions must not turn the facade into a provider-correlation escape.
const PRIVATE_PROVIDER_KEYS = new Set([
  'runtimeId',
  'turnId',
  'itemId',
  'providerItemId',
  'providerTurnId',
  'providerRuntimeId',
  'sessionId',
  'source',
  'sourceId',
  'sourceRuntimeId',
  'sourceTurnId',
  'sourceItemId',
]);
const PRIVATE_PROVIDER_NORMALIZED_KEYS = new Set(
  [...PRIVATE_PROVIDER_KEYS].map((key) => key.toLowerCase())
);
const SENSITIVE_ERROR_KEY =
  /(?:token|authorization|credential|secret|api[-_]?key|password)/i;
const PRIVATE_REDACTION_MIN_CHARS = 8;

export interface RelayMcpToolDefinition {
  command: RelayMcpChannelCommand;
  name: string;
  description: string;
  inputSchema: RelayJsonSchema;
  outputSchema: RelayJsonSchema;
}

export interface RelayMcpOkEnvelope {
  ok: true;
  contract: typeof RELAY_CLI_GATEWAY_MAJOR;
  contractVersion: typeof RELAY_CLI_GATEWAY_CONTRACT_VERSION;
  command: RelayMcpChannelCommand;
  data: JsonRecord;
}

export interface RelayMcpErrorEnvelope {
  ok: false;
  contract: typeof RELAY_CLI_GATEWAY_MAJOR;
  contractVersion: typeof RELAY_CLI_GATEWAY_CONTRACT_VERSION;
  command: RelayMcpChannelCommand;
  error: RelayCliGatewayError;
}

export type RelayMcpEnvelope = RelayMcpOkEnvelope | RelayMcpErrorEnvelope;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrivateProviderKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return (
    PRIVATE_PROVIDER_NORMALIZED_KEYS.has(normalized) ||
    /^(?:provider|source)?(?:runtime|turn|item|session)(?:id)?$/.test(
      normalized
    )
  );
}

function toolName(command: RelayMcpChannelCommand): string {
  return `relay_${command.replaceAll('.', '_')}`;
}

function commandSpec(
  command: RelayMcpChannelCommand
): RelayCliGatewayCommandSpec {
  const spec = RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.find(
    (candidate) => candidate.name === command
  );
  const manifestEntry = RELAY_COMMAND_MANIFEST.commands.find(
    (candidate) => candidate.name === command
  );
  if (
    !spec ||
    !manifestEntry ||
    manifestEntry.inputSchema !== spec.inputSchema ||
    manifestEntry.outputSchema !== spec.outputSchema
  ) {
    throw new Error(`Relay MCP command manifest drift for ${command}`);
  }
  return spec;
}

function copySchema(schema: RelayJsonSchema): RelayJsonSchema {
  return structuredClone(schema);
}

/**
 * The gateway allows long-lived subscriptions for native clients. MCP calls
 * must always name both bounds so an agent cannot accidentally hold stdio open.
 */
function boundedSubscribeInputSchema(schema: RelayJsonSchema): RelayJsonSchema {
  const result = copySchema(schema);
  const properties = result.properties ?? {};
  properties['maxEvents'] = {
    ...(properties['maxEvents'] ?? {}),
    minimum: 1,
    maximum: RELAY_MCP_SUBSCRIBE_MAX_EVENTS,
    description: `Required MCP bound; at most ${RELAY_MCP_SUBSCRIBE_MAX_EVENTS} event frames.`,
  };
  properties['idleTimeoutMs'] = {
    ...(properties['idleTimeoutMs'] ?? {}),
    minimum: 1,
    maximum: RELAY_MCP_SUBSCRIBE_MAX_IDLE_TIMEOUT_MS,
    description: `Required MCP quiet-stream deadline; at most ${RELAY_MCP_SUBSCRIBE_MAX_IDLE_TIMEOUT_MS} ms.`,
  };
  result.properties = properties;
  result.required = [
    ...new Set([...(result.required ?? []), 'maxEvents', 'idleTimeoutMs']),
  ];
  return result;
}

/**
 * Preserve the gateway envelope shape but state that returned values are the
 * public channel projection. The source schema remains mechanically sourced
 * from the stable contract, while the runtime sanitizer below removes every
 * provider-runtime locator before it reaches the MCP transport.
 */
function publicOutputSchema(spec: RelayCliGatewayCommandSpec): RelayJsonSchema {
  const schema = copySchema(spec.outputSchema);
  return {
    title: `${schema.title ?? spec.name}McpEnvelope`,
    description: `${schema.description ?? spec.summary} MCP returns a typed Relay success or error envelope after public-channel projection; provider runtimeId, turnId, and itemId are never returned.`,
    oneOf: [schema, copySchema(RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema)],
  };
}

/**
 * MCP is request/response, so its subscribe tool does not expose the gateway's
 * unbounded single-frame result. It returns the client's finite collection
 * instead. Keep the frame validator mechanically derived from the canonical
 * gateway schema so event variants cannot drift between the two surfaces.
 */
function boundedSubscribeOutputSchema(
  spec: RelayCliGatewayCommandSpec
): RelayJsonSchema {
  const successSchema = copySchema(spec.outputSchema);
  const canonicalFrameSchema = successSchema.properties?.['data'];
  if (!canonicalFrameSchema)
    throw new Error('channels.subscribe is missing its canonical frame schema');

  successSchema.title = 'ChannelsSubscribeCollectionOutput';
  successSchema.description =
    'A finite public-channel collection. frames use the canonical channels.subscribe frame schema and are bounded by the required MCP maxEvents input.';
  successSchema.properties = {
    ...successSchema.properties,
    data: {
      title: 'ChannelsSubscribeCollectionData',
      type: 'object',
      additionalProperties: false,
      properties: {
        frames: {
          type: 'array',
          items: copySchema(canonicalFrameSchema),
          description: `At most ${RELAY_MCP_SUBSCRIBE_MAX_EVENTS} event frames, plus any open or closed boundary frames.`,
        },
        // The client intentionally returns its reduced public state along with
        // frames, so an MCP host can resume from durableSeq without replaying
        // non-delivery state replacements as user-visible messages.
        state: { type: 'object', additionalProperties: true },
        durableSeq: { type: 'integer', minimum: 0 },
        stopReason: { type: 'string' },
      },
      required: ['frames', 'state', 'durableSeq', 'stopReason'],
    },
  };
  return {
    title: `${successSchema.title}McpEnvelope`,
    description:
      'MCP returns the bounded public channel collection or a typed Relay error. Provider runtimeId, turnId, and itemId are never returned.',
    oneOf: [
      successSchema,
      copySchema(RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema),
    ],
  };
}

function buildRelayMcpToolDefinitions(): readonly RelayMcpToolDefinition[] {
  return RELAY_MCP_CHANNEL_COMMANDS.map((command) => {
    const spec = commandSpec(command);
    return {
      command,
      name: toolName(command),
      description: `${spec.summary} Local stdio only; Relay credentials come exclusively from the process environment.`,
      inputSchema:
        command === 'channels.subscribe'
          ? boundedSubscribeInputSchema(spec.inputSchema)
          : copySchema(spec.inputSchema),
      outputSchema:
        command === 'channels.subscribe'
          ? boundedSubscribeOutputSchema(spec)
          : publicOutputSchema(spec),
    };
  });
}

// The contract and manifest are process-static. Build once so each tool call
// cannot allocate/clone eight schemas on its hot path.
const RELAY_MCP_TOOL_DEFINITIONS = buildRelayMcpToolDefinitions();

export function relayMcpToolDefinitions(): readonly RelayMcpToolDefinition[] {
  return RELAY_MCP_TOOL_DEFINITIONS;
}

function invalid(
  command: RelayMcpChannelCommand,
  message: string
): RelayMcpErrorEnvelope {
  return {
    ok: false,
    contract: RELAY_CLI_GATEWAY_MAJOR,
    contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
    command,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  };
}

function requireString(input: JsonRecord, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalString(input: JsonRecord, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalInteger(input: JsonRecord, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function assertOnlySchemaKeys(
  command: RelayMcpChannelCommand,
  input: JsonRecord,
  schema: RelayJsonSchema
): RelayMcpErrorEnvelope | undefined {
  if (schema.additionalProperties !== false) return undefined;
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  return unexpected
    ? invalid(command, `${unexpected} is not a supported input`)
    : undefined;
}

function privateProviderValues(value: unknown, values: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => privateProviderValues(entry, values));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      isPrivateProviderKey(key) &&
      typeof nested === 'string' &&
      nested.length >= PRIVATE_REDACTION_MIN_CHARS &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(nested)
    ) {
      values.add(nested);
    }
    privateProviderValues(nested, values);
  }
}

function redactProviderValues(
  value: string,
  values: ReadonlySet<string>
): string {
  let result = value;
  for (const privateValue of [...values].sort(
    (left, right) => right.length - left.length
  )) {
    result = result.replaceAll(privateValue, '[redacted]');
  }
  return result;
}

function publicValue(
  value: unknown,
  privateValues: ReadonlySet<string> = new Set()
): unknown {
  if (typeof value === 'string')
    return redactProviderValues(value, privateValues);
  if (Array.isArray(value))
    return value.map((entry) => publicValue(entry, privateValues));
  if (!isRecord(value)) return value;
  const result: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    // These fields name provider-private runtime entities. Omit them at every
    // depth, including unknown server error details and future event variants.
    if (isPrivateProviderKey(key) || SENSITIVE_ERROR_KEY.test(key)) continue;
    const projected = publicValue(nested, privateValues);
    if (
      key === 'agentDetail' &&
      isRecord(projected) &&
      Object.keys(projected).length === 0
    )
      continue;
    result[key] = projected;
  }
  return result;
}

function publicData(value: unknown): JsonRecord {
  const privateValues = new Set<string>();
  privateProviderValues(value, privateValues);
  const projected = publicValue(value, privateValues);
  return isRecord(projected) ? projected : { value: projected };
}

/**
 * A client can receive an untrusted error body from a remote Relay endpoint.
 * Never pass an unknown string through to MCP's canonical error schema: that
 * would make an otherwise typed facade fail output validation and discard the
 * useful error envelope. Unknown upstream spellings are safely categorized.
 */
function canonicalErrorCode(value: unknown): RelayCliGatewayError['code'] {
  const canonicalCodes =
    RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema.properties?.['error']
      ?.properties?.['code']?.enum ?? [];
  return typeof value === 'string' &&
    canonicalCodes.includes(value as RelayCliGatewayError['code'])
    ? (value as RelayCliGatewayError['code'])
    : 'UPSTREAM_ERROR';
}

function publicError(error: unknown): RelayCliGatewayError {
  if (error instanceof RelayChannelSubscriptionOverflowError) {
    return {
      code: 'UPSTREAM_ERROR',
      message: 'Relay subscription exceeded a local safety limit',
      retryable: false,
      details: publicData({
        limit: error.limit,
        maximum: error.maximum,
        observed: error.observed,
      }),
    };
  }
  if (error instanceof RelayChannelClientError) {
    const privateValues = new Set<string>();
    privateProviderValues(error.details, privateValues);
    return {
      code: canonicalErrorCode(error.code),
      message: redactProviderValues(error.message, privateValues),
      retryable: error.retryable ?? error.status >= 500,
      ...(error.details ? { details: publicData(error.details) } : {}),
    };
  }
  return {
    code: 'UPSTREAM_ERROR',
    message: 'Relay channel request failed',
    retryable: true,
  };
}

function errorEnvelope(
  command: RelayMcpChannelCommand,
  error: unknown
): RelayMcpErrorEnvelope {
  return {
    ok: false,
    contract: RELAY_CLI_GATEWAY_MAJOR,
    contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
    command,
    error: publicError(error),
  };
}

function success(
  command: RelayMcpChannelCommand,
  data: unknown
): RelayMcpOkEnvelope {
  return {
    ok: true,
    contract: RELAY_CLI_GATEWAY_MAJOR,
    contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
    command,
    data: publicData(data),
  };
}

function boundedSubscribeInput(input: JsonRecord):
  | {
      channelId: string;
      maxEvents: number;
      idleTimeoutMs: number;
      afterSeq?: number;
      filter?: ChannelSubscriptionFilter;
    }
  | RelayMcpErrorEnvelope {
  const channelId = requireString(input, 'channelId');
  const maxEvents = optionalInteger(input, 'maxEvents');
  const idleTimeoutMs = optionalInteger(input, 'idleTimeoutMs');
  if (!channelId)
    return invalid(
      'channels.subscribe',
      'channelId must be a non-empty string'
    );
  if (
    maxEvents === undefined ||
    maxEvents < 1 ||
    maxEvents > RELAY_MCP_SUBSCRIBE_MAX_EVENTS
  )
    return invalid(
      'channels.subscribe',
      `maxEvents must be an integer from 1 to ${RELAY_MCP_SUBSCRIBE_MAX_EVENTS}`
    );
  if (
    idleTimeoutMs === undefined ||
    idleTimeoutMs < 1 ||
    idleTimeoutMs > RELAY_MCP_SUBSCRIBE_MAX_IDLE_TIMEOUT_MS
  )
    return invalid(
      'channels.subscribe',
      `idleTimeoutMs must be an integer from 1 to ${RELAY_MCP_SUBSCRIBE_MAX_IDLE_TIMEOUT_MS}`
    );
  const afterSeq = optionalInteger(input, 'afterSeq');
  if (
    input['afterSeq'] !== undefined &&
    (afterSeq === undefined || afterSeq < 0)
  )
    return invalid(
      'channels.subscribe',
      'afterSeq must be a non-negative integer'
    );
  const filter = input['filter'];
  if (filter !== undefined && !isChannelSubscriptionFilter(filter))
    return invalid(
      'channels.subscribe',
      'filter must be a valid channel subscription predicate object'
    );
  return {
    channelId,
    maxEvents,
    idleTimeoutMs,
    ...(afterSeq === undefined ? {} : { afterSeq }),
    ...(filter === undefined ? {} : { filter }),
  };
}

type RelayMcpReadCommand = Exclude<
  RelayMcpChannelCommand,
  'channels.post' | 'channels.subscribe'
>;

function pageInput(
  command: RelayMcpReadCommand,
  input: JsonRecord
):
  | { channelId: string; limit?: number; beforeSeq?: number; afterSeq?: number }
  | RelayMcpErrorEnvelope {
  const channelId = requireString(input, 'channelId');
  if (!channelId)
    return invalid(command, 'channelId must be a non-empty string');
  const limit = optionalInteger(input, 'limit');
  const beforeSeq = optionalInteger(input, 'beforeSeq');
  const afterSeq = optionalInteger(input, 'afterSeq');
  if (beforeSeq !== undefined && afterSeq !== undefined)
    return invalid(command, 'beforeSeq and afterSeq cannot both be set');
  return {
    channelId,
    ...(limit === undefined ? {} : { limit }),
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(afterSeq === undefined ? {} : { afterSeq }),
  };
}

async function executeReadTool(
  command: RelayMcpReadCommand,
  input: JsonRecord,
  client: RelayChannelClient
): Promise<RelayMcpEnvelope> {
  switch (command) {
    case 'channels.list':
      return success(command, await client.list());
    case 'channels.get': {
      const channelId = requireString(input, 'channelId');
      return channelId
        ? success(command, await client.get({ channelId }))
        : invalid(command, 'channelId must be a non-empty string');
    }
    case 'channels.run.get': {
      const channelId = requireString(input, 'channelId');
      const runId = requireString(input, 'runId');
      if (!channelId || !runId)
        return invalid(
          command,
          'channelId and runId must be non-empty strings'
        );
      const threadId = optionalString(input, 'threadId');
      return success(
        command,
        await client.run.get({
          channelId,
          runId,
          ...(threadId === undefined ? {} : { threadId }),
        })
      );
    }
    case 'channels.history': {
      const page = pageInput(command, input);
      return 'ok' in page ? page : success(command, await client.history(page));
    }
    case 'channels.threads.history': {
      const page = pageInput(command, input);
      const threadId = requireString(input, 'threadId');
      if ('ok' in page) return page;
      if (!threadId)
        return invalid(
          command,
          'channelId and threadId must be non-empty strings'
        );
      return success(
        command,
        await client.threads.history({ ...page, threadId })
      );
    }
    case 'channels.roster': {
      const channelId = requireString(input, 'channelId');
      return channelId
        ? success(command, await client.roster({ channelId }))
        : invalid(command, 'channelId must be a non-empty string');
    }
  }
}

async function executePostTool(
  input: JsonRecord,
  client: RelayChannelClient
): Promise<RelayMcpEnvelope> {
  const command = 'channels.post' as const;
  const channelId = requireString(input, 'channelId');
  const text = requireString(input, 'text');
  if (!channelId || !text)
    return invalid(command, 'channelId and text must be non-empty strings');
  const format = input['format'];
  if (format !== undefined && format !== 'text' && format !== 'markdown')
    return invalid(command, 'format must be text or markdown');
  const parentMessageId = optionalString(input, 'parentMessageId');
  const threadId = input['threadId'];
  if (
    threadId !== undefined &&
    threadId !== null &&
    typeof threadId !== 'string'
  )
    return invalid(command, 'threadId must be a string or null');
  const clientMessageId = optionalString(input, 'clientMessageId');
  return success(
    command,
    await client.post({
      channelId,
      text,
      ...(format === undefined ? {} : { format }),
      ...(parentMessageId === undefined
        ? {}
        : { parentMessageId: parentMessageId as `chm:${string}` }),
      ...(threadId === undefined
        ? {}
        : { threadId: threadId as `chm:${string}` | null }),
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
    })
  );
}

async function executeSubscribeTool(
  input: JsonRecord,
  client: RelayChannelClient
): Promise<RelayMcpEnvelope> {
  const bounded = boundedSubscribeInput(input);
  if ('ok' in bounded) return bounded;
  return success(
    'channels.subscribe',
    await client.collect({
      // Forward only shared, validated predicate fields. Authoritative MCP
      // bounds and route identity are assigned afterwards, so a nested object
      // can never shadow them through object spread order.
      ...(bounded.filter ?? {}),
      channelId: bounded.channelId,
      maxEvents: bounded.maxEvents,
      idleTimeoutMs: bounded.idleTimeoutMs,
      ...(bounded.afterSeq === undefined ? {} : { afterSeq: bounded.afterSeq }),
    })
  );
}

/** Execute one of the eight allowed commands; never accepts credentials/configuration. */
export async function executeRelayMcpTool(
  command: RelayMcpChannelCommand,
  input: unknown,
  client: RelayChannelClient = createRelayChannelClient()
): Promise<RelayMcpEnvelope> {
  const definition = relayMcpToolDefinitions().find(
    (entry) => entry.command === command
  );
  // Do not reflect an unsupported command supplied through an unsafe cast into
  // the public envelope or MCP logs. The advertised tuple remains closed.
  if (!definition) return invalid('channels.list', 'tool is not supported');
  if (!isRecord(input)) return invalid(command, 'tool input must be an object');
  const unexpected = assertOnlySchemaKeys(
    command,
    input,
    definition.inputSchema
  );
  if (unexpected) return unexpected;
  try {
    if (command === 'channels.post')
      return await executePostTool(input, client);
    if (command === 'channels.subscribe')
      return await executeSubscribeTool(input, client);
    return await executeReadTool(command, input, client);
  } catch (error) {
    return errorEnvelope(command, error);
  }
}

/** Create the local stdio server. Callers intentionally cannot add Relay tools. */
export function createRelayMcpServer(
  client: RelayChannelClient = createRelayChannelClient()
): McpServer {
  const server = new McpServer({ name: 'relay-mcp', version: '0.1.1' });
  for (const definition of relayMcpToolDefinitions()) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: fromJsonSchema(
          definition.inputSchema as unknown as JsonSchemaType
        ),
        outputSchema: fromJsonSchema(
          definition.outputSchema as unknown as JsonSchemaType
        ),
      },
      async (input) => {
        const envelope = await executeRelayMcpTool(
          definition.command,
          input,
          client
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
          structuredContent: envelope,
          ...(envelope.ok ? {} : { isError: true }),
        };
      }
    );
  }
  return server;
}
