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
import { enrichManifest } from './node-manifest-build.js';
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
  homeDir?: string;
  relayVersion?: string;
  cwd?: string;
  /** Config dir path (dirname of config.json) — forwarded to resolvedPaths. */
  configDir?: string;
  /** Service log dir — forwarded to resolvedPaths. */
  logDir?: string | null;
  /** Socket dir — forwarded to resolvedPaths. */
  socketDir?: string | null;
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
  // `decorateManifestWithFrameworks`. Core never references framework
  // ids directly — neither in code nor in this comment.
  const tmux = probeCommand('tmux', 'tmux', 'tmux', env);
  return {
    tmux,
    git: probeCommand('git', 'Git', 'git', env),
    clipboard: probeClipboard(env, platform),
    browserAutomation: probeBrowserAutomation(),
    githubCli: probeCommand('githubCli', 'GitHub CLI', 'gh', env),
    tailscale: probeCommand('tailscale', 'Tailscale CLI', 'tailscale', env),
    ssh: probeCommand('ssh', 'SSH client', 'ssh', env, { versionArgs: ['-V'] }),
    // #467: hosts with tmux get attach-by-name resume; others get a
    // raw shell that dies on detach. #469 will introduce
    // 'canonical-emulator' for server-side terminal state.
    sessionResume: tmux.status === 'available' ? 'tmux' : 'none',
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
  const relayVersion = options.relayVersion ?? getRelayVersion();
  // #651: new required fields are populated with stub values here so that
  // the core manifest satisfies NodeManifest's type. `getNodeManifest` and
  // `enrichManifest` will overwrite these with the real values.
  return {
    schemaVersion: 1,
    platform,
    arch: options.arch ?? os.arch(),
    hostname: options.hostname ?? os.hostname(),
    homeDir: options.homeDir ?? os.homedir(),
    relayVersion,
    helperVersion: relayVersion,
    protocolVersion: '',
    resolvedPaths: {},
    fileRpc: { available: true, capabilities: [] },
    degradedReasons: [],
    generatedAt: (options.now ?? new Date()).toISOString(),
    wsl,
    serviceManager,
    capabilities: getNodeCapabilities(env, platform),
  };
}

/**
 * Build a manifest with framework / agent probes applied. This is the
 * back-compat entry point that pre-#436 callers used. Internally it
 * builds a core manifest, layers the frameworks feature on top, then
 * enriches with the #651 fields (protocolVersion, helperVersion, distro,
 * resolvedPaths, fileRpc, authStatus on agents, degradedReasons).
 *
 * Callers that don't need agent probing (or want to inject their own
 * decoration order) can call `getCoreNodeManifest` + decorate themselves.
 */
async function getNodeManifest(
  options: NodeManifestOptions = {}
): Promise<NodeManifest> {
  const env = options.env ?? process.env;
  const manifest = await getCoreNodeManifest(options);
  const decorated = await decorateManifestWithFrameworks(manifest, {
    config: options.config,
    env,
  });
  const enrichDeps: import('./node-manifest-build.js').EnrichManifestDeps = {
    env,
  };
  if (options.configDir !== undefined) enrichDeps.configDir = options.configDir;
  if (options.logDir !== undefined) enrichDeps.logDir = options.logDir;
  if (options.socketDir !== undefined) enrichDeps.socketDir = options.socketDir;
  if (options.homeDir !== undefined) enrichDeps.homeDir = options.homeDir;
  if (options.platform !== undefined) enrichDeps.platform = options.platform;
  return enrichManifest(decorated, enrichDeps);
}

export {
  getCoreNodeManifest,
  getNodeManifest,
  getNodeCapabilities,
  probeCommand,
  probeClipboard,
  probeBrowserAutomation,
};
