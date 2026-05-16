import { execFile } from 'node:child_process';
import type {
  RelayCliGatewayCommand,
  RelayCliGatewayContractManifest,
  RelayCliGatewayEnvelope,
  RelayJsonSchema,
} from './cli-gateway-contract.js';
import { RELAY_CLI_GATEWAY_CONTRACT } from './cli-gateway-contract.js';

export const CLI_GATEWAY_CLAUDE_SMOKE_COMMANDS = [
  'nodes.list',
  'sessions.create',
  'files.read',
  'sessions.detach',
] as const satisfies readonly RelayCliGatewayCommand[];

export type RelayClaudeGatewaySmokeCommand = (typeof CLI_GATEWAY_CLAUDE_SMOKE_COMMANDS)[number];

export interface RelayClaudeGatewayToolDefinition {
  name: string;
  description: string;
  input_schema: RelayJsonSchema;
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

export interface RelayClaudeGatewayRunnerOptions {
  command?: string;
  commandArgsPrefix?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

type ResolvedRelayClaudeGatewayRunnerOptions = Required<
  Pick<RelayClaudeGatewayRunnerOptions, 'command' | 'timeoutMs'>
> &
  Omit<RelayClaudeGatewayRunnerOptions, 'command' | 'timeoutMs'>;

export function relayClaudeGatewayToolName(command: RelayCliGatewayCommand): string {
  return `relay_${command.split('.').join('_')}`;
}

export function generateRelayClaudeGatewayTools(
  manifest: RelayCliGatewayContractManifest = RELAY_CLI_GATEWAY_CONTRACT,
  commands: readonly RelayCliGatewayCommand[] = CLI_GATEWAY_CLAUDE_SMOKE_COMMANDS
): RelayClaudeGatewayToolDefinition[] {
  return commands.map((command) => {
    const spec = manifest.commandSchemas.find((entry) => entry.name === command);
    if (!spec) throw new Error(`CLI gateway manifest is missing ${command}`);
    return {
      name: relayClaudeGatewayToolName(spec.name),
      description: spec.summary,
      input_schema: spec.inputSchema,
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

export class RelayClaudeGatewayToolRunner {
  private readonly toolsByName: Map<string, RelayClaudeGatewayToolDefinition>;
  private readonly options: ResolvedRelayClaudeGatewayRunnerOptions;

  constructor(
    tools: readonly RelayClaudeGatewayToolDefinition[],
    options: RelayClaudeGatewayRunnerOptions = {}
  ) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    const resolved: ResolvedRelayClaudeGatewayRunnerOptions = {
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
  ): Promise<RelayCliGatewayEnvelope> {
    const tool = this.toolsByName.get(name);
    if (!tool) throw new Error(`unknown generated Relay Claude gateway tool: ${name}`);
    const gatewayArgs = gatewayArgsForGeneratedTool(tool, input);
    return await execRelayGatewayTool(this.options, gatewayArgs);
  }
}

function gatewayArgsForGeneratedTool(
  tool: RelayClaudeGatewayToolDefinition,
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
  return replaceGatewayInputPlaceholders(cliArgs, input);
}

function replaceGatewayInputPlaceholders(
  cliArgs: readonly string[],
  input: Record<string, unknown>
): string[] {
  return cliArgs.map((arg) => {
    if (arg === '<session-id>') return requiredStringInput(input, ['id', 'sessionId'], arg);
    if (arg === '<path>') return requiredStringInput(input, ['path'], arg);
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
  options: ResolvedRelayClaudeGatewayRunnerOptions,
  gatewayArgs: readonly string[]
): Promise<RelayCliGatewayEnvelope> {
  const args = [...(options.commandArgsPrefix ?? []), ...gatewayArgs];
  const execOptions = {
    encoding: 'utf8' as const,
    env: { ...process.env, ...options.env },
    timeout: options.timeoutMs,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  return await new Promise<RelayCliGatewayEnvelope>((resolve, reject) => {
    execFile(options.command, args, execOptions, (error, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout) as RelayCliGatewayEnvelope);
      } catch (parseError) {
        reject(error ?? parseError ?? new Error(stderr || 'Relay CLI gateway tool failed'));
      }
    });
  });
}
