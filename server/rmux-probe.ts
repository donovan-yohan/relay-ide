import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutablePath } from './frameworks.js';
import type {
  RmuxCapabilityProbe,
  RmuxIpcShape,
  RmuxProbeStatus,
  RmuxR0ChecklistItem,
} from '../shared/node-manifest.js';

const RMUX_BINARY_ENV = 'RMUX_SDK_DAEMON_BINARY';
const RMUX_ENDPOINT_ENV = 'RMUX_SDK_ENDPOINT';
const RMUX_TIMEOUT_ENV = 'RMUX_SDK_TIMEOUT_MS';
const PINNED_RMUX_SOURCE = 'Helvesec/rmux@a37614c026e18616fa57bc27ae23e1f8241c43fe';
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const MINIMUM_SUPPORTED_VERSION = { major: 0, minor: 1, patch: 0 };

interface RmuxProbeDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  resolveExecutable?: (command: string, env: NodeJS.ProcessEnv) => string | null;
  spawn?: (
    command: string,
    args: string[],
    options: {
      encoding: BufferEncoding;
      timeout: number;
      stdio: ['ignore', 'pipe', 'pipe'];
      env: NodeJS.ProcessEnv;
    }
  ) => SpawnSyncReturns<string>;
}

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

interface RmuxResolvedPaths {
  binaryPath: string | undefined;
  helperPath: string | undefined;
  command: string | undefined;
}

function optionalStringProperty<K extends string>(
  key: K,
  value: string | undefined
): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function parsePositiveTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.floor(parsed), 10_000);
}

function firstOutputLine(result: SpawnSyncReturns<string>): string | undefined {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const first = output.split('\n')[0]?.trim();
  return first || undefined;
}

function parseRmuxVersion(output: string | undefined): ParsedVersion | undefined {
  if (!output) return undefined;
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(output);
  if (!match) return undefined;
  const [, majorRaw, minorRaw, patchRaw, prerelease] = match;
  if (majorRaw === undefined || minorRaw === undefined || patchRaw === undefined)
    return undefined;
  return {
    raw: match[0],
    major: Number(majorRaw),
    minor: Number(minorRaw),
    patch: Number(patchRaw),
    ...(prerelease ? { prerelease } : {}),
  };
}

function compareVersion(a: ParsedVersion, b: typeof MINIMUM_SUPPORTED_VERSION): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isAbsoluteUnixPath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0');
}

function endpointFromEnv(
  endpoint: string | undefined,
  platform: NodeJS.Platform
): RmuxIpcShape | undefined {
  if (!endpoint) return undefined;
  if (platform === 'win32') {
    const isPipe = endpoint.startsWith('\\\\.\\pipe\\');
    return {
      kind: isPipe ? 'windows-pipe' : 'unknown',
      source: 'env',
      endpoint,
      shape: isPipe
        ? '\\\\.\\pipe\\rmux-{SID}-il-{integrity}-{label} named pipe override'
        : 'RMUX_SDK_ENDPOINT override is present but does not match the default Windows pipe prefix.',
    };
  }
  return {
    kind: isAbsoluteUnixPath(endpoint) ? 'unix-socket' : 'unknown',
    source: 'env',
    endpoint,
    shape: isAbsoluteUnixPath(endpoint)
      ? 'absolute Unix socket path from RMUX_SDK_ENDPOINT'
      : 'RMUX_SDK_ENDPOINT override is present but is not an absolute Unix socket path.',
  };
}

function platformDefaultIpcShape(platform: NodeJS.Platform): RmuxIpcShape {
  if (platform === 'win32') {
    return {
      kind: 'windows-pipe',
      source: 'platform-default',
      shape: '\\\\.\\pipe\\rmux-{SID}-il-{integrity}-{label} per-user named pipe',
    };
  }
  return {
    kind: 'unix-socket',
    source: 'platform-default',
    shape: 'owner-only Unix socket under rmux-$uid runtime directory',
  };
}

function buildR0Checklist(input: {
  status: RmuxProbeStatus;
  version?: ParsedVersion;
  ipc: RmuxIpcShape;
  binaryPath?: string;
  helperPath?: string;
}): RmuxR0ChecklistItem[] {
  const versionPinned = input.version !== undefined && input.status === 'available-experimental';
  return [
    {
      id: 'version-pinning',
      status: versionPinned ? 'warn' : input.status === 'available-but-unsupported' ? 'fail' : 'unknown',
      message: versionPinned
        ? `rmux ${input.version?.raw} detected; Relay has not adopted rmux by default and only records diagnostics against ${PINNED_RMUX_SOURCE}.`
        : input.status === 'available-but-unsupported'
          ? 'rmux responded, but its version is below the diagnostic compatibility floor.'
          : 'rmux version could not be pinned by this diagnostic probe.',
    },
    {
      id: 'crash-restart-behavior',
      status: input.status === 'available-experimental' ? 'warn' : 'unknown',
      message:
        input.status === 'available-experimental'
          ? 'rmux SDK startup has documented daemon race/restart handling, but Relay does not supervise or depend on it yet.'
          : 'Crash/restart behavior was not exercised; Relay runtime remains on the existing backend.',
    },
    {
      id: 'socket-ipc-exposure',
      status: input.ipc.kind === 'unknown' ? 'warn' : 'pass',
      message: `IPC shape: ${input.ipc.shape}`,
    },
    {
      id: 'permission-boundary',
      status: input.ipc.kind === 'unknown' ? 'unknown' : 'pass',
      message:
        input.ipc.kind === 'windows-pipe'
          ? 'Expected rmux named pipe remains scoped by Windows per-user pipe ACLs; Relay opens no listener.'
          : input.ipc.kind === 'unix-socket'
            ? 'Expected rmux socket remains owner-only; Relay opens no listener.'
            : 'Permission boundary could not be inferred from the endpoint shape.',
    },
    {
      id: 'packaging-update-path',
      status: input.binaryPath || input.helperPath ? 'warn' : 'unknown',
      message:
        input.binaryPath || input.helperPath
          ? 'rmux is externally installed; Relay does not bundle, install, or update it by default.'
          : 'No rmux binary/helper found; Relay packaging remains unchanged.',
    },
  ];
}

function unavailableProbe(platform: NodeJS.Platform, arch: string, ipc: RmuxIpcShape): RmuxCapabilityProbe {
  return {
    id: 'rmux',
    label: 'rmux optional backend probe',
    status: 'unavailable',
    binaryPresent: false,
    helperPresent: false,
    platform,
    arch,
    ipc,
    message: 'rmux is not installed or not on PATH; optional rmux backend remains disabled.',
    r0Checklist: buildR0Checklist({ status: 'unavailable', ipc }),
  };
}

function failureMessage(result: SpawnSyncReturns<string>): string {
  if (result.error) return result.error.message;
  const line = firstOutputLine(result);
  if (line) return line;
  return `rmux --version exited with status ${result.status ?? 'unknown'}`;
}

function resolveRmuxPaths(
  resolveExecutable: (name: string, env: NodeJS.ProcessEnv) => string | null,
  env: NodeJS.ProcessEnv
): RmuxResolvedPaths {
  const binaryPath = resolveExecutable('rmux', env) ?? undefined;
  const configuredHelper = env[RMUX_BINARY_ENV];
  const helperPath = configuredHelper
    ? path.isAbsolute(configuredHelper)
      ? configuredHelper
      : (resolveExecutable(configuredHelper, env) ?? undefined)
    : binaryPath;
  return {
    binaryPath,
    helperPath,
    command: helperPath ?? binaryPath,
  };
}

function rmuxProbeBase(input: {
  platform: NodeJS.Platform;
  arch: string;
  ipc: RmuxIpcShape;
  paths: RmuxResolvedPaths;
}) {
  return {
    id: 'rmux' as const,
    label: 'rmux optional backend probe',
    binaryPresent: Boolean(input.paths.binaryPath),
    helperPresent: Boolean(input.paths.helperPath),
    platform: input.platform,
    arch: input.arch,
    ipc: input.ipc,
    ...optionalStringProperty('binaryPath', input.paths.binaryPath),
    ...optionalStringProperty('helperPath', input.paths.helperPath),
  };
}

function failedRmuxProbe(
  base: ReturnType<typeof rmuxProbeBase>,
  result: SpawnSyncReturns<string>
): RmuxCapabilityProbe {
  const message = `rmux probe failed non-fatally: ${failureMessage(result)}`;
  return {
    ...base,
    status: 'probe-failed',
    message,
    r0Checklist: buildR0Checklist({
      status: 'probe-failed',
      ipc: base.ipc,
      ...optionalStringProperty('binaryPath', base.binaryPath),
      ...optionalStringProperty('helperPath', base.helperPath),
    }),
  };
}

function availableRmuxProbe(
  base: ReturnType<typeof rmuxProbeBase>,
  output: string | undefined
): RmuxCapabilityProbe {
  const version = parseRmuxVersion(output);
  const unsupported = version ? compareVersion(version, MINIMUM_SUPPORTED_VERSION) < 0 : false;
  const status: RmuxProbeStatus = unsupported
    ? 'available-but-unsupported'
    : 'available-experimental';
  const displayVersion = version?.raw ?? output ?? 'unknown';
  return {
    ...base,
    status,
    ...optionalStringProperty('version', output),
    message: unsupported
      ? `rmux ${displayVersion} is present but below Relay's diagnostic compatibility floor.`
      : `rmux ${displayVersion} is present as an optional experimental capability; Relay will not use it by default.`,
    r0Checklist: buildR0Checklist({
      status,
      ipc: base.ipc,
      ...(version ? { version } : {}),
      ...optionalStringProperty('binaryPath', base.binaryPath),
      ...optionalStringProperty('helperPath', base.helperPath),
    }),
  };
}

export function probeRmuxCapability(deps: RmuxProbeDeps = {}): RmuxCapabilityProbe {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? os.arch();
  const resolveExecutable = deps.resolveExecutable ?? resolveExecutablePath;
  const spawn = deps.spawn ?? ((command, args, options) => spawnSync(command, args, options));
  const ipc = endpointFromEnv(env[RMUX_ENDPOINT_ENV], platform) ?? platformDefaultIpcShape(platform);
  const paths = resolveRmuxPaths(resolveExecutable, env);

  if (!paths.command) return unavailableProbe(platform, arch, ipc);

  const timeout = parsePositiveTimeout(env[RMUX_TIMEOUT_ENV]) ?? DEFAULT_PROBE_TIMEOUT_MS;
  const result = spawn(paths.command, ['--version'], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const base = rmuxProbeBase({ platform, arch, ipc, paths });

  if (result.error || result.status !== 0) return failedRmuxProbe(base, result);
  return availableRmuxProbe(base, firstOutputLine(result));
}

export { PINNED_RMUX_SOURCE, RMUX_BINARY_ENV, RMUX_ENDPOINT_ENV, RMUX_TIMEOUT_ENV };
