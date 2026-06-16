/**
 * node-manifest-build.ts
 *
 * Testable builder functions for the enriched NodeManifest fields introduced
 * in #651 (Slice 1 — manifest hardening). Separated from CLI wiring so that
 * vitest can exercise builders without spawning processes or requiring a real
 * relay-ide install.
 *
 * All public functions in this module accept injectable deps so tests can
 * substitute mocks without monkeypatching globals.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_RPC_OPERATIONS } from '../shared/file-rpc.js';
import type {
  NodeCapabilityProbe,
  NodeCapabilityStatus,
  NodeManifest,
  NodeManifestDegradedReason,
  NodeResolvedPaths,
  NodeFileRpcStatus,
  NodeAgentAuthStatus,
} from '../shared/node-manifest.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../shared/relay-node-protocol.js';

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const NODE_LINK_PROTOCOL_VERSION: string =
  RELAY_NODE_LINK_PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Distro detection (Linux only)
// ---------------------------------------------------------------------------

export interface DistroDetectionDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFileSync?: (p: string, encoding: BufferEncoding) => string;
}

/**
 * Best-effort Linux distro name. Returns the `ID` field from
 * `/etc/os-release`, falling back to `WSL_DISTRO_NAME`, then undefined.
 * Always returns undefined on non-Linux platforms.
 */
export function detectDistro(
  deps: DistroDetectionDeps = {}
): string | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return undefined;

  const env = deps.env ?? process.env;
  const readFile = deps.readFileSync ?? fs.readFileSync;

  // WSL distro name is the most reliable on WSL environments
  if (env['WSL_DISTRO_NAME']) return env['WSL_DISTRO_NAME'];

  // Parse /etc/os-release for the ID field
  try {
    const content = readFile('/etc/os-release', 'utf8');
    for (const line of content.split('\n')) {
      const match = /^ID=["']?([^"'\n]+)["']?/.exec(line.trim());
      if (match?.[1]) return match[1].trim();
    }
  } catch {
    // /etc/os-release absent or unreadable
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Resolved paths
// ---------------------------------------------------------------------------

export interface ResolvedPathsDeps {
  /** Path to the relay-ide script entry point (e.g. dist/bin/relay-ide.js). */
  scriptUrl?: string;
  /** Config directory path (dirname of config.json). */
  configDir?: string;
  /** Service log directory, if any. */
  logDir?: string | null;
  /** Optional socket directory override. */
  socketDir?: string | null;
}

/**
 * Resolve the canonical paths for this node installation.
 *
 * - `binary`: the relay-ide script path derived from import.meta.url or a
 *   provided override (scriptUrl). Resolved to the project root binary
 *   (`dist/bin/relay-ide.js`).
 * - `configDir`, `logDir`, `socketDir`: injected from the caller (CLI wiring)
 *   or left absent.
 */
export function buildResolvedPaths(
  deps: ResolvedPathsDeps = {}
): NodeResolvedPaths {
  let binary: string | undefined;
  if (deps.scriptUrl) {
    try {
      binary = fileURLToPath(deps.scriptUrl);
    } catch {
      binary = deps.scriptUrl;
    }
  } else {
    // Derive from this module's __dirname: we live in dist/server/
    // so go up one level to dist/ then into bin/relay-ide.js.
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const candidate = path.join(__dirname, '..', 'bin', 'relay-ide.js');
      if (fs.existsSync(candidate)) binary = candidate;
    } catch {
      // Ignore — binary stays undefined
    }
  }

  const result: NodeResolvedPaths = {};
  if (binary) result.binary = binary;
  if (deps.configDir) result.configDir = deps.configDir;
  if (deps.logDir) result.logDir = deps.logDir;
  if (deps.socketDir) result.socketDir = deps.socketDir;

  return result;
}

// ---------------------------------------------------------------------------
// File RPC status
// ---------------------------------------------------------------------------

/**
 * Build a NodeFileRpcStatus descriptor.
 *
 * The node-link-rpc-host always enables the full FILE_RPC_OPERATIONS set when
 * the hub has routed a session to this node. At manifest time we cannot know
 * the per-session policy, so we report the static operation set and leave
 * `restrictions` absent unless a policy override is injected.
 *
 * `available` is true iff the file-rpc subsystem is compiled-in (always true
 * for the built-in relay-ide node; could be false for a stripped embedded
 * deployment). Pass `available: false` to signal a deployment that stripped
 * file-rpc.
 */
export function buildFileRpcStatus(
  available = true,
  restrictions?: string[]
): NodeFileRpcStatus {
  return {
    available,
    capabilities: available ? [...FILE_RPC_OPERATIONS] : [],
    ...(restrictions && restrictions.length > 0 ? { restrictions } : {}),
  };
}

// ---------------------------------------------------------------------------
// Auth status probing for agent CLIs
// ---------------------------------------------------------------------------

export interface AgentAuthProbeDeps {
  env?: NodeJS.ProcessEnv;
}

/**
 * Probe auth status for an agent CLI.
 *
 * Strategy (best-effort, no secrets in output):
 * - claude: checks for the presence of ~/.claude/.credentials.json or
 *   ~/.config/claude/credentials.json. File presence → 'authed'. This is a
 *   heuristic — the file could be expired, but it's non-destructive and fast.
 * - All others: 'unknown'.
 *
 * Never logs token values. Only reports the three-state enum.
 */
export function probeAgentAuthStatus(
  agentId: string,
  deps: AgentAuthProbeDeps & { homeDir?: string } = {}
): NodeAgentAuthStatus {
  const homeDir = deps.homeDir ?? os.homedir();

  if (agentId === 'claude') {
    // Check common credential file locations for Claude
    const candidates = [
      path.join(homeDir, '.claude', '.credentials.json'),
      path.join(homeDir, '.config', 'claude', 'credentials.json'),
    ];
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return 'authed';
      } catch {
        // file absent or unreadable, try next
      }
    }
    // No credential file found — likely unauthenticated
    return 'unauthed';
  }

  if (agentId === 'codex') {
    // Codex stores auth state in ~/.codex/auth.json
    const codexAuthFile = path.join(homeDir, '.codex', 'auth.json');
    try {
      fs.accessSync(codexAuthFile, fs.constants.R_OK);
      return 'authed';
    } catch {
      return 'unauthed';
    }
  }

  // opencode, hermes, and custom agents: no reliable heuristic
  return 'unknown';
}

/**
 * Enrich an existing agent capability probe with an authStatus field.
 * Input probe is not mutated; returns a new object.
 */
export function enrichProbeWithAuthStatus(
  probe: NodeCapabilityProbe,
  deps: AgentAuthProbeDeps & { homeDir?: string } = {}
): NodeCapabilityProbe {
  if (probe.status === 'unavailable') {
    // Can't be authed if the CLI isn't installed
    return { ...probe, authStatus: 'unknown' };
  }
  const authStatus = probeAgentAuthStatus(probe.id, deps);
  return { ...probe, authStatus };
}

// ---------------------------------------------------------------------------
// Degraded reason derivation
// ---------------------------------------------------------------------------

/**
 * Derive structured degraded reasons from an assembled manifest.
 * This runs after all probes have been collected so that a single pass
 * produces a complete, de-duplicated list.
 */
export function deriveDegradedReasons(
  manifest: Omit<NodeManifest, 'degradedReasons'>
): NodeManifestDegradedReason[] {
  const reasons: NodeManifestDegradedReason[] = [];
  const caps = manifest.capabilities;

  // Core capability degraded states
  const coreProbeKeys: Array<keyof typeof caps> = [
    'git',
    'clipboard',
    'browserAutomation',
    'githubCli',
    'tailscale',
    'ssh',
  ];

  for (const key of coreProbeKeys) {
    const probe = caps[key] as NodeCapabilityProbe | undefined;
    if (!probe) continue;
    const status: NodeCapabilityStatus = probe.status;

    if (status === 'unavailable') {
      reasons.push({
        code: `CAPABILITY_UNAVAILABLE_${String(key).toUpperCase()}`,
        description: probe.message,
        severity: key === 'git' ? 'warn' : 'info',
      });
    } else if (status === 'degraded') {
      reasons.push({
        code: `CAPABILITY_DEGRADED_${String(key).toUpperCase()}`,
        description: probe.message,
        severity: 'warn',
      });
    }
  }

  // Agent CLI probes
  for (const [agentId, probe] of Object.entries(caps.agents)) {
    if (probe.status === 'unavailable') {
      reasons.push({
        code: `AGENT_UNAVAILABLE_${agentId.toUpperCase()}`,
        description: probe.message,
        severity: 'info',
      });
    } else if (probe.status === 'degraded') {
      reasons.push({
        code: `AGENT_DEGRADED_${agentId.toUpperCase()}`,
        description: probe.message,
        severity: 'warn',
      });
    }
  }

  // File RPC unavailable
  if (!manifest.fileRpc.available) {
    reasons.push({
      code: 'FILE_RPC_UNAVAILABLE',
      description:
        'File RPC subsystem is not available on this node. Remote file access from the hub will be disabled.',
      severity: 'error',
    });
  }

  // Service manager not installable
  if (!manifest.serviceManager.supported) {
    reasons.push({
      code: `SERVICE_MANAGER_UNSUPPORTED_${manifest.serviceManager.kind.toUpperCase().replace(/-/g, '_')}`,
      description: manifest.serviceManager.message,
      severity: 'info',
    });
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Top-level helper: enrich a core manifest with all #651 fields
// ---------------------------------------------------------------------------

export interface EnrichManifestDeps {
  configDir?: string;
  logDir?: string | null;
  socketDir?: string | null;
  scriptUrl?: string;
  homeDir?: string;
  fileRpcAvailable?: boolean;
  fileRpcRestrictions?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFileSync?: (p: string, encoding: BufferEncoding) => string;
}

/**
 * Enrich a raw NodeManifest (as produced by getCoreNodeManifest +
 * decorateManifestWithFrameworks) with the new #651 fields:
 * - protocolVersion
 * - helperVersion (alias of relayVersion)
 * - distro
 * - resolvedPaths
 * - fileRpc
 * - authStatus on each agent probe
 * - degradedReasons (derived last, after all probes are populated)
 *
 * Returns a new manifest; input is not mutated.
 */
export function enrichManifest(
  manifest: NodeManifest,
  deps: EnrichManifestDeps = {}
): NodeManifest {
  const homeDir = deps.homeDir ?? os.homedir();
  const platform = deps.platform ?? (manifest.platform as NodeJS.Platform);
  const env = deps.env ?? process.env;

  // Enrich agent probes with authStatus
  const enrichedAgents: Record<string, NodeCapabilityProbe> = {};
  for (const [id, probe] of Object.entries(manifest.capabilities.agents)) {
    enrichedAgents[id] = enrichProbeWithAuthStatus(probe, { homeDir });
  }

  const resolvedPathsDeps: ResolvedPathsDeps = {};
  if (deps.scriptUrl !== undefined)
    resolvedPathsDeps.scriptUrl = deps.scriptUrl;
  if (deps.configDir !== undefined)
    resolvedPathsDeps.configDir = deps.configDir;
  if (deps.logDir !== undefined) resolvedPathsDeps.logDir = deps.logDir;
  if (deps.socketDir !== undefined)
    resolvedPathsDeps.socketDir = deps.socketDir;
  const resolvedPaths = buildResolvedPaths(resolvedPathsDeps);

  const fileRpc = buildFileRpcStatus(
    deps.fileRpcAvailable ?? true,
    deps.fileRpcRestrictions
  );

  const distroDeps: DistroDetectionDeps = { platform, env };
  if (deps.readFileSync !== undefined)
    distroDeps.readFileSync = deps.readFileSync;
  const distro = detectDistro(distroDeps);

  const partial: Omit<NodeManifest, 'degradedReasons'> = {
    ...manifest,
    helperVersion: manifest.relayVersion,
    protocolVersion: NODE_LINK_PROTOCOL_VERSION,
    ...(distro !== undefined ? { distro } : {}),
    resolvedPaths,
    fileRpc,
    capabilities: {
      ...manifest.capabilities,
      agents: enrichedAgents,
    },
  };

  const degradedReasons = deriveDegradedReasons(partial);

  return { ...partial, degradedReasons };
}
