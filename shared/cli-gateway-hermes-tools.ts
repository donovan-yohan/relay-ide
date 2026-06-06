import { execFile } from 'node:child_process';
import type {
  RelayCliGatewayCommand,
  RelayCliGatewayContractManifest,
  RelayCliGatewayEnvelope,
  RelayJsonSchema,
} from './cli-gateway-contract.js';
import { RELAY_CLI_GATEWAY_CONTRACT } from './cli-gateway-contract.js';

export const CLI_GATEWAY_HERMES_SMOKE_COMMANDS = [
  'nodes.list',
  'sessions.create',
  'files.read',
  'sessions.stream',
  'sessions.input',
  'sessions.detach',
] as const satisfies readonly RelayCliGatewayCommand[];

export type RelayHermesGatewaySmokeCommand = (typeof CLI_GATEWAY_HERMES_SMOKE_COMMANDS)[number];

export interface RelayHermesGatewayMcpDescriptor {
  name: string;
  description: string;
  inputSchema: RelayJsonSchema;
}

export interface RelayHermesGatewayFunctionDescriptor {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: RelayJsonSchema;
  };
}

export interface RelayHermesGatewayToolDefinition {
  name: string;
  description: string;
  parameters: RelayJsonSchema;
  mcp: RelayHermesGatewayMcpDescriptor;
  function: RelayHermesGatewayFunctionDescriptor;
  relay: {
    contract: RelayCliGatewayContractManifest['contract'];
    contractVersion: RelayCliGatewayContractManifest['contractVersion'];
    command: RelayCliGatewayCommand;
    cli: readonly string[];
    transport: string;
    requiresAuth: boolean;
    capabilityHints: readonly string[];
  };
}

export interface RelayHermesGatewayRunnerOptions {
  command?: string;
  commandArgsPrefix?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

type ResolvedRelayHermesGatewayRunnerOptions = Required<
  Pick<RelayHermesGatewayRunnerOptions, 'command' | 'timeoutMs'>
> &
  Omit<RelayHermesGatewayRunnerOptions, 'command' | 'timeoutMs'>;

export type RelayHermesGatewayToolResult = RelayCliGatewayEnvelope | RelayCliGatewayEnvelope[];

export function relayHermesGatewayToolName(command: RelayCliGatewayCommand): string {
  return `relay_gateway_${command.split('.').join('_')}`;
}

export function generateRelayHermesGatewayTools(
  manifest: RelayCliGatewayContractManifest = RELAY_CLI_GATEWAY_CONTRACT,
  commands: readonly RelayCliGatewayCommand[] = CLI_GATEWAY_HERMES_SMOKE_COMMANDS
): RelayHermesGatewayToolDefinition[] {
  return commands.map((command) => {
    const spec = manifest.commandSchemas.find((entry) => entry.name === command);
    if (!spec) throw new Error(`CLI gateway manifest is missing ${command}`);
    const name = relayHermesGatewayToolName(spec.name);
    const mcp: RelayHermesGatewayMcpDescriptor = {
      name,
      description: spec.summary,
      inputSchema: spec.inputSchema,
    };
    const functionDescriptor: RelayHermesGatewayFunctionDescriptor = {
      type: 'function',
      function: {
        name,
        description: spec.summary,
        parameters: spec.inputSchema,
      },
    };
    return {
      name,
      description: spec.summary,
      parameters: spec.inputSchema,
      mcp,
      function: functionDescriptor,
      relay: {
        contract: manifest.contract,
        contractVersion: manifest.contractVersion,
        command: spec.name,
        cli: spec.cli,
        transport: spec.transport,
        requiresAuth: spec.requiresAuth,
        capabilityHints: spec.capabilityHints,
      },
    };
  });
}

export function generateRelayHermesGatewayMcpDescriptors(
  manifest: RelayCliGatewayContractManifest = RELAY_CLI_GATEWAY_CONTRACT,
  commands: readonly RelayCliGatewayCommand[] = CLI_GATEWAY_HERMES_SMOKE_COMMANDS
): RelayHermesGatewayMcpDescriptor[] {
  return generateRelayHermesGatewayTools(manifest, commands).map((tool) => tool.mcp);
}

export function generateRelayHermesGatewayFunctionDescriptors(
  manifest: RelayCliGatewayContractManifest = RELAY_CLI_GATEWAY_CONTRACT,
  commands: readonly RelayCliGatewayCommand[] = CLI_GATEWAY_HERMES_SMOKE_COMMANDS
): RelayHermesGatewayFunctionDescriptor[] {
  return generateRelayHermesGatewayTools(manifest, commands).map((tool) => tool.function);
}

export class RelayHermesGatewayToolRunner {
  private readonly toolsByName: Map<string, RelayHermesGatewayToolDefinition>;
  private readonly options: ResolvedRelayHermesGatewayRunnerOptions;

  constructor(
    tools: readonly RelayHermesGatewayToolDefinition[],
    options: RelayHermesGatewayRunnerOptions = {}
  ) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    const resolved: ResolvedRelayHermesGatewayRunnerOptions = {
      command: options.command ?? 'relay-ide',
      commandArgsPrefix: options.commandArgsPrefix ?? [],
      timeoutMs: options.timeoutMs ?? 10_000,
    };
    if (options.cwd !== undefined) resolved.cwd = options.cwd;
    if (options.env !== undefined) resolved.env = options.env;
    this.options = resolved;
  }

  async callTool(
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<RelayHermesGatewayToolResult> {
    const tool = this.toolsByName.get(name);
    if (!tool) throw new Error(`unknown generated Relay Hermes gateway tool: ${name}`);
    const gatewayArgs = gatewayArgsForGeneratedTool(tool, input);
    return await execRelayGatewayTool(this.options, gatewayArgs);
  }
}

function gatewayArgsForGeneratedTool(
  tool: RelayHermesGatewayToolDefinition,
  input: Record<string, unknown>
): string[] {
  const cliArgs = tool.relay.cli.slice(1);
  if (tool.relay.command === 'sessions.create') {
    return replaceCliPlaceholder(cliArgs, '<json>', JSON.stringify(input));
  }
  if (tool.relay.command === 'files.read') {
    return appendOptionalFlags(replaceGatewayInputPlaceholders(cliArgs, input), input, [
      ['nodeId', '--node-id'],
      ['cwd', '--cwd'],
      ['maxBytes', '--max-bytes'],
      ['maxLines', '--max-lines'],
      ['confirmationToken', '--confirmation-token'],
    ]);
  }
  if (tool.relay.command === 'sessions.stream') {
    return appendOptionalFlags(replaceGatewayInputPlaceholders(cliArgs, input), input, [
      ['maxEvents', '--max-events'],
      ['maxBytes', '--max-bytes'],
      ['idleTimeoutMs', '--idle-timeout-ms'],
    ]);
  }
  if (tool.relay.command === 'sessions.kill') {
    return appendOptionalFlags(replaceGatewayInputPlaceholders(cliArgs, input), input, [
      ['confirmationToken', '--confirmation-token'],
    ]);
  }
  if (tool.relay.command === 'sessions.input') {
    return gatewaySessionInputArgs(input);
  }
  return replaceGatewayInputPlaceholders(cliArgs, input);
}

function gatewaySessionInputArgs(input: Record<string, unknown>): string[] {
  const id = requiredStringInput(input, ['id', 'sessionId'], '<session-id>');
  const args = ['v1', 'sessions', 'input', '--id', id];
  if (typeof input['data'] === 'string') {
    args.push('--data', input['data']);
  } else if (typeof input['dataBase64'] === 'string') {
    args.push('--data-base64', input['dataBase64']);
  } else if (input['stdin'] === true) {
    throw new Error('generated Relay Hermes gateway smoke runner does not support stdin input');
  } else {
    throw new Error('generated Relay Hermes gateway tool input must include data or dataBase64');
  }
  for (const [field, flag] of [
    ['waitFor', '--wait-for'],
    ['timeoutMs', '--timeout-ms'],
    ['maxBytes', '--max-bytes'],
  ] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`generated Relay CLI tool input ${field} must be a string or number`);
    }
    args.push(flag, String(value));
  }
  args.push('--json');
  return args;
}

function replaceGatewayInputPlaceholders(
  cliArgs: readonly string[],
  input: Record<string, unknown>
): string[] {
  return cliArgs.map((arg) => {
    if (arg === '<session-id>') return requiredStringInput(input, ['id', 'sessionId'], arg);
    if (arg === '<display-name>') return requiredStringInput(input, ['displayName'], arg);
    if (arg === '<path>') return requiredStringInput(input, ['path'], arg);
    if (arg === '<text>') return requiredStringInput(input, ['data'], arg);
    return arg;
  });
}

function replaceCliPlaceholder(
  cliArgs: readonly string[],
  placeholder: string,
  value: string
): string[] {
  return cliArgs.map((arg) => (arg === placeholder ? value : arg));
}

function requiredStringInput(
  input: Record<string, unknown>,
  keys: readonly string[],
  placeholder: string
): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`generated Relay CLI tool input must include ${keys.join(' or ')} for ${placeholder}`);
}

function appendOptionalFlags(
  cliArgs: string[],
  input: Record<string, unknown>,
  fields: readonly (readonly [string, string])[]
): string[] {
  const insertion = cliArgs.lastIndexOf('--json');
  const args = cliArgs.slice();
  const flags: string[] = [];
  for (const [field, flag] of fields) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`generated Relay CLI tool input ${field} must be a string or number`);
    }
    flags.push(flag, String(value));
  }
  if (insertion === -1 || flags.length === 0) return args.concat(flags);
  args.splice(insertion, 0, ...flags);
  return args;
}

async function execRelayGatewayTool(
  options: ResolvedRelayHermesGatewayRunnerOptions,
  gatewayArgs: readonly string[]
): Promise<RelayHermesGatewayToolResult> {
  const args = [...(options.commandArgsPrefix ?? []), ...gatewayArgs];
  const execOptions = {
    encoding: 'utf8' as const,
    env: { ...process.env, ...options.env },
    timeout: options.timeoutMs,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  return await new Promise<RelayHermesGatewayToolResult>((resolve, reject) => {
    execFile(options.command, args, execOptions, (error, stdout, stderr) => {
      try {
        resolve(parseGatewayStdout(stdout));
      } catch (parseError) {
        reject(error ?? parseError ?? new Error(stderr || 'Relay CLI gateway tool failed'));
      }
    });
  });
}

function parseGatewayStdout(stdout: string): RelayHermesGatewayToolResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('Relay CLI gateway tool produced no JSON output');
  try {
    return JSON.parse(trimmed) as RelayCliGatewayEnvelope;
  } catch {
    /* sessions.stream emits newline-delimited compact envelopes. */
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.length > 0);
  const parsed = lines.map((line) => JSON.parse(line) as RelayCliGatewayEnvelope);
  if (parsed.length === 1) {
    const first = parsed[0];
    if (!first) throw new Error('Relay CLI gateway tool produced no JSON output');
    return first;
  }
  return parsed;
}
