import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Config } from './types.js';
import {
  getFrameworkClientInfoWithRuntime,
  resolveExecutablePath,
} from './frameworks.js';
import { detectServiceManager, detectWslInfo } from './service.js';
import type {
  NodeCapabilities,
  NodeCapabilityProbe,
  NodeManifest,
} from '../shared/node-manifest.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface NodeManifestOptions {
  config?: Pick<Config, 'frameworks'>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  platform?: NodeJS.Platform;
  arch?: string;
  hostname?: string;
  relayVersion?: string;
  cwd?: string;
}

function packageJsonPath(): string {
  return path.join(__dirname, '..', '..', 'package.json');
}

function getRelayVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath(), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function commandVersion(
  command: string,
  args = ['--version']
): string | undefined {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 1_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return undefined;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (!output) return undefined;
  return output.split('\n')[0]?.trim();
}

function probeCommand(
  id: string,
  label: string,
  command: string,
  env: NodeJS.ProcessEnv,
  options: { versionArgs?: string[]; missingMessage?: string } = {}
): NodeCapabilityProbe {
  const resolved = resolveExecutablePath(command, env);
  if (!resolved) {
    return {
      id,
      label,
      status: 'unavailable',
      message: options.missingMessage ?? `${command} was not found on PATH.`,
    };
  }
  const version = commandVersion(resolved, options.versionArgs);
  return {
    id,
    label,
    status: 'available',
    message: `${command} is available.`,
    path: resolved,
    ...(version ? { version } : {}),
  };
}

function probeClipboard(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeCapabilityProbe {
  if (platform === 'darwin') {
    return probeCommand('clipboard', 'Clipboard', 'osascript', env, {
      versionArgs: ['-e', 'return "osascript"'],
      missingMessage:
        'osascript is missing; image clipboard passthrough will fall back to file paths.',
    });
  }
  const candidates = ['wl-copy', 'xclip', 'xsel', 'pbcopy'];
  for (const command of candidates) {
    const resolved = resolveExecutablePath(command, env);
    if (resolved) {
      return {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'available',
        message: `${command} is available for clipboard integration.`,
        path: resolved,
      };
    }
  }
  return {
    id: 'clipboard',
    label: 'Clipboard',
    status: 'degraded',
    message:
      'No supported clipboard CLI found (wl-copy/xclip/xsel). Image paste can still return file paths.',
  };
}

function probeBrowserAutomation(): NodeCapabilityProbe {
  try {
    require.resolve('@playwright/test');
    return {
      id: 'browserAutomation',
      label: 'Browser automation',
      status: 'available',
      message: 'Playwright package is installed for agent browser automation.',
    };
  } catch {
    return {
      id: 'browserAutomation',
      label: 'Browser automation',
      status: 'degraded',
      message:
        'Playwright package is not resolvable; relay-ide-browser features may need dependencies installed.',
    };
  }
}

function frameworkProbeFromClientInfo(framework: {
  id: string;
  displayName: string;
  availability?: { installed: boolean; path?: string; reason?: string };
  webAvailability?: { available: boolean; reason?: string };
}): NodeCapabilityProbe {
  const availability = framework.availability;
  if (!availability?.installed) {
    return {
      id: framework.id,
      label: framework.displayName,
      status: 'unavailable',
      message:
        availability?.reason ?? `${framework.displayName} is not installed.`,
    };
  }
  if (framework.webAvailability && !framework.webAvailability.available) {
    return {
      id: framework.id,
      label: framework.displayName,
      status: 'degraded',
      message:
        framework.webAvailability.reason ??
        'CLI is installed but web runtime probe failed.',
      ...(availability.path ? { path: availability.path } : {}),
    };
  }
  return {
    id: framework.id,
    label: framework.displayName,
    status: 'available',
    message: `${framework.displayName} CLI is available.`,
    ...(availability.path ? { path: availability.path } : {}),
  };
}

async function probeAgents(
  config: Pick<Config, 'frameworks'> | undefined,
  env: NodeJS.ProcessEnv
): Promise<Record<string, NodeCapabilityProbe>> {
  try {
    const frameworks = await getFrameworkClientInfoWithRuntime(
      config?.frameworks,
      env
    );
    return Object.fromEntries(
      frameworks.map((framework) => [
        framework.id,
        frameworkProbeFromClientInfo(framework),
      ])
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      frameworks: {
        id: 'frameworks',
        label: 'Agent framework registry',
        status: 'degraded',
        message: `Agent framework probes failed non-fatally: ${message}`,
      },
    };
  }
}

async function getNodeCapabilities(
  config: Pick<Config, 'frameworks'> | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<NodeCapabilities> {
  return {
    tmux: probeCommand('tmux', 'tmux', 'tmux', env),
    git: probeCommand('git', 'Git', 'git', env),
    clipboard: probeClipboard(env, platform),
    browserAutomation: probeBrowserAutomation(),
    githubCli: probeCommand('githubCli', 'GitHub CLI', 'gh', env),
    tailscale: probeCommand('tailscale', 'Tailscale CLI', 'tailscale', env),
    ssh: probeCommand('ssh', 'SSH client', 'ssh', env, { versionArgs: ['-V'] }),
    agents: await probeAgents(config, env),
  };
}

async function getNodeManifest(
  options: NodeManifestOptions = {}
): Promise<NodeManifest> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const wsl = detectWslInfo({
    platform,
    env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const serviceManager = detectServiceManager({ platform, env, wsl });
  return {
    schemaVersion: 1,
    platform,
    arch: options.arch ?? os.arch(),
    hostname: options.hostname ?? os.hostname(),
    relayVersion: options.relayVersion ?? getRelayVersion(),
    generatedAt: (options.now ?? new Date()).toISOString(),
    wsl,
    serviceManager,
    capabilities: await getNodeCapabilities(options.config, env, platform),
  };
}

export {
  getNodeManifest,
  getNodeCapabilities,
  probeCommand,
  probeClipboard,
  probeBrowserAutomation,
  probeAgents,
};
