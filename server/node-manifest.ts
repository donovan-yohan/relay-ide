import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Config } from './types.js';
import { resolveExecutablePath } from './frameworks.js';
import { detectServiceManager, detectWslInfo } from './service.js';
import { decorateManifestWithFrameworks } from './features/frameworks.js';
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

function getNodeCapabilities(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeCapabilities {
  // Core probes only host-tool availability. Agent / framework probes
  // live in `server/features/frameworks.ts` and are layered on top via
  // `decorateManifestWithFrameworks`. Core never names Claude, Codex,
  // OpenCode, Hermes, or any other framework id.
  return {
    tmux: probeCommand('tmux', 'tmux', 'tmux', env),
    git: probeCommand('git', 'Git', 'git', env),
    clipboard: probeClipboard(env, platform),
    browserAutomation: probeBrowserAutomation(),
    githubCli: probeCommand('githubCli', 'GitHub CLI', 'gh', env),
    tailscale: probeCommand('tailscale', 'Tailscale CLI', 'tailscale', env),
    ssh: probeCommand('ssh', 'SSH client', 'ssh', env, { versionArgs: ['-V'] }),
    agents: {},
  };
}

async function getCoreNodeManifest(
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
    capabilities: getNodeCapabilities(env, platform),
  };
}

/**
 * Build a manifest with framework / agent probes applied. This is the
 * back-compat entry point that pre-#436 callers used. Internally it
 * builds a core manifest then layers the frameworks feature on top, so
 * callers that don't need agent probing (or want to inject their own
 * decoration order) can call `getCoreNodeManifest` + decorate
 * themselves.
 */
async function getNodeManifest(
  options: NodeManifestOptions = {}
): Promise<NodeManifest> {
  const env = options.env ?? process.env;
  const manifest = await getCoreNodeManifest(options);
  return decorateManifestWithFrameworks(manifest, {
    config: options.config,
    env,
  });
}

export {
  getCoreNodeManifest,
  getNodeManifest,
  getNodeCapabilities,
  probeCommand,
  probeClipboard,
  probeBrowserAutomation,
};
