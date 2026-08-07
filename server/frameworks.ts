import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_FRAMEWORKS,
  resolveFramework,
  type AgentFramework,
  type EventSourceType,
} from './types.js';
import {
  channelAdapterLaunchRequirement,
  type ChannelGatewayProbe,
} from './protocol-adapters/index.js';

export interface FrameworkAvailability {
  installed: boolean;
  path?: string;
  reason?: string;
}

export interface FrameworkChannelAvailability {
  available: boolean;
  endpoint?: string;
  reason?: string;
  /** Actual subprocess command used by the registered channel adapter. */
  command?: string;
}

export interface FrameworkChannelAvailabilityOptions {
  /** Roster targets defer this check until each profile's effective env is known. */
  probeLaunchCommand?: boolean;
  /** Test/host overrides keyed by the gateway id declared by the adapter. */
  gatewayProbeOverrides?: Readonly<
    Record<string, ChannelGatewayProbe | undefined>
  >;
}

export interface FrameworkClientInfo {
  id: string;
  displayName: string;
  command: string;
  capabilities: AgentFramework['capabilities'];
  eventSource: EventSourceType;
  availability: FrameworkAvailability;
  channelAvailability?: FrameworkChannelAvailability;
}

function executableCandidates(
  command: string,
  env: NodeJS.ProcessEnv
): string[] {
  if (command.includes('/') || command.includes('\\')) return [command];

  const pathValue = env.PATH ?? '';
  const pathExt =
    os.platform() === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => pathExt.map((ext) => path.join(dir, command + ext)));
}

export function resolveExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  for (const candidate of executableCandidates(command, env)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH candidate.
    }
  }
  return null;
}

export function getFrameworkAvailability(
  framework: AgentFramework,
  env: NodeJS.ProcessEnv = process.env
): FrameworkAvailability {
  const launchCommand = framework.commandOverride ?? framework.command;
  const resolvedPath = resolveExecutablePath(launchCommand, env);
  if (resolvedPath) return { installed: true, path: resolvedPath };
  return {
    installed: false,
    reason: `${launchCommand} CLI not found on PATH`,
  };
}

export function listConfiguredFrameworks(
  frameworkOverrides?: Record<string, Partial<AgentFramework>>
): AgentFramework[] {
  const ids = new Set([
    ...Object.keys(BUILTIN_FRAMEWORKS),
    ...Object.keys(frameworkOverrides ?? {}),
  ]);
  return [...ids].map((id) =>
    resolveFramework(
      frameworkOverrides ? { frameworks: frameworkOverrides } : {},
      id
    )
  );
}

export function getFrameworkClientInfo(
  frameworkOverrides?: Record<string, Partial<AgentFramework>>,
  env: NodeJS.ProcessEnv = process.env
): FrameworkClientInfo[] {
  return listConfiguredFrameworks(frameworkOverrides).map((framework) => ({
    id: framework.id,
    displayName: framework.displayName,
    command: framework.command,
    capabilities: framework.capabilities,
    eventSource: framework.eventSource,
    availability: getFrameworkAvailability(framework, env),
  }));
}

export async function getFrameworkClientInfoWithRuntime(
  frameworkOverrides?: Record<string, Partial<AgentFramework>>,
  env: NodeJS.ProcessEnv = process.env
): Promise<FrameworkClientInfo[]> {
  const frameworks = getFrameworkClientInfo(frameworkOverrides, env);
  return Promise.all(
    frameworks.map(async (framework) => {
      const requirement = channelAdapterLaunchRequirement(framework.id);
      if (requirement?.kind !== 'gateway') return framework;
      // Terminal installation and attached channel gateway reachability are
      // independent: gateway adapters spawn no local CLI.
      const probe = await requirement.probe(undefined, 300);
      return {
        ...framework,
        channelAvailability: {
          available: probe.available,
          endpoint: probe.endpoint,
          ...(probe.reason ? { reason: probe.reason } : {}),
        },
      };
    })
  );
}

const CHANNEL_DEADVERTISE_REASONS: Record<string, string> = {};

export async function getFrameworkChannelAvailability(
  framework: AgentFramework,
  env: NodeJS.ProcessEnv = process.env,
  options: FrameworkChannelAvailabilityOptions = {}
): Promise<FrameworkChannelAvailability> {
  if (!framework.capabilities.supportsChannelAgents) {
    return {
      available: false,
      reason:
        CHANNEL_DEADVERTISE_REASONS[framework.id] ??
        `${framework.displayName} is not currently available in channels.`,
    };
  }

  const requirement = channelAdapterLaunchRequirement(framework.id);
  if (!requirement) {
    return {
      available: false,
      reason: `${framework.displayName} has no registered channel runtime.`,
    };
  }

  if (requirement.kind === 'gateway') {
    const gatewayProbe =
      options.gatewayProbeOverrides?.[requirement.gateway] ?? requirement.probe;
    const probe = await gatewayProbe(undefined, 500);
    return {
      available: probe.available,
      endpoint: probe.endpoint,
      ...(probe.reason ? { reason: probe.reason } : {}),
    };
  }

  if (requirement.kind === 'embedded') return { available: true };

  // Framework commandOverride config currently controls terminal sessions only;
  // channel adapters own their subprocess command. Probe that actual command so
  // the roster never promises an override the adapter will not launch.
  if (
    options.probeLaunchCommand !== false &&
    !resolveExecutablePath(requirement.command, env)
  ) {
    return {
      available: false,
      reason: `${requirement.command} is not installed on this node (not found on PATH).`,
      command: requirement.command,
    };
  }
  return { available: true, command: requirement.command };
}
