import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_FRAMEWORKS,
  resolveFramework,
  type AgentFramework,
  type EventSourceType,
} from './types.js';
import { probeHermesGatewayApi } from './protocol-adapters/hermes-adapter.js';

export interface FrameworkAvailability {
  installed: boolean;
  path?: string;
  reason?: string;
}

export interface FrameworkWebAvailability {
  available: boolean;
  endpoint?: string;
  reason?: string;
}

export interface FrameworkClientInfo {
  id: string;
  displayName: string;
  command: string;
  capabilities: AgentFramework['capabilities'];
  eventSource: EventSourceType;
  availability: FrameworkAvailability;
  webAvailability?: FrameworkWebAvailability;
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
      if (framework.id !== 'hermes' || !framework.availability.installed) {
        return framework;
      }
      const probe = await probeHermesGatewayApi(undefined, 300);
      return {
        ...framework,
        webAvailability: {
          available: probe.available,
          endpoint: probe.endpoint,
          ...(probe.reason ? { reason: probe.reason } : {}),
        },
      };
    })
  );
}

export async function getFrameworkWebAvailability(
  framework: AgentFramework
): Promise<FrameworkWebAvailability> {
  // Claude web sessions are de-advertised pending end-to-end verification.
  // See issue #300. The hook-backed spawned-CLI adapter exists but has not
  // been verified for real assistant text streaming or e2e round-trip.
  if (framework.id === 'claude') {
    return {
      available: false,
      reason:
        'Claude web sessions are not yet verified end-to-end (see issue #300). Use the tui (PTY) mode instead.',
    };
  }
  if (framework.id !== 'hermes') {
    return { available: true };
  }
  const probe = await probeHermesGatewayApi(undefined, 500);
  return {
    available: probe.available,
    endpoint: probe.endpoint,
    ...(probe.reason ? { reason: probe.reason } : {}),
  };
}
