import pty from 'node-pty';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentFramework,
  AgentType,
  AgentState,
  ContinuePolicy,
  EventSourceType,
  PtySession,
  Session,
  SessionStatus,
  SessionSummary,
  TerminalBackend,
  SessionType,
} from './types.js';
import {
  AGENT_COMMANDS,
  AGENT_CONTINUE_ARGS,
  collaborationPromptArgsForFramework,
  resolveFramework,
} from './types.js';
import { readMeta, writeMeta } from './config.js';
import { cleanEnv } from './utils.js';
import { outputParsers } from './output-parsers/index.js';
import type { OutputParser } from './output-parsers/index.js';
import { installOpenCodeRelayPlugin } from './opencode-relay.js';
import { writeCodexHooksAdapter } from './codex-hooks-adapter.js';
import { createLogger } from './logger.js';
import { getDefaultAllocator, type PortAllocator } from './port-allocator.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { fileURLToPath } from 'node:url';
import type { SessionLane } from '../shared/session-lane.js';
import {
  createLegacyControlStateSummary,
  normalizeControlStateSummary,
  type ControlStateSummary,
} from '../shared/control-state.js';
import {
  appendTerminalStreamData,
  createTerminalStreamState,
} from '../shared/session-replay.js';
import {
  createLibghosttyTerminalModelBackend,
  type TerminalModelBackend,
} from './terminal-model-backend.js';
import { detectTerminalAttentionPrompt } from './terminal-attention.js';
import { buildRelayPtySessionEnv } from './relay-pty-session.js';

const IDLE_TIMEOUT_MS = 5000;
/** Default per-session scrollback cap. Overridable via createPtySession options. */
const DEFAULT_MAX_SCROLLBACK_PER_SESSION = 256 * 1024; // 256KB
const logger = createLogger('pty');

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function readGlobalStatusLineCommand(): string {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { statusLine?: { command?: string } };
    return typeof parsed.statusLine?.command === 'string'
      ? parsed.statusLine.command
      : '';
  } catch {
    return '';
  }
}

export function buildStatusLineRelayScript(
  sessionId: string,
  configDir: string,
  globalCmd: string
): string {
  const telemetryDir = path.join(configDir, 'telemetry');
  const telemetryPath = path.join(telemetryDir, `${sessionId}.json`);
  const tempPattern = `${telemetryPath}.tmp.XXXXXX`;
  return `#!/usr/bin/env bash
set -u
mkdir -p ${shellQuote(telemetryDir)}
tmp_file=$(mktemp ${shellQuote(tempPattern)})
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT
GLOBAL_CMD=${shellQuote(globalCmd)}
if [ -n "$GLOBAL_CMD" ] && [ -x "$GLOBAL_CMD" ]; then
  tee "$tmp_file" | "$GLOBAL_CMD"
  pipeline_statuses=("\${PIPESTATUS[@]}")
else
  tee "$tmp_file" | node -e 'let raw="";process.stdin.setEncoding("utf8");process.stdin.on("data", (chunk) => raw += chunk);process.stdin.on("end", () => { try { const data = JSON.parse(raw); const model = data?.model?.display_name ?? "Claude"; const remaining = data?.context_window?.remaining_percentage ?? "?"; process.stdout.write(model + " | " + remaining + "% ctx\n"); } catch { process.stdout.write("Claude | ?% ctx\n"); } });'
  pipeline_statuses=("\${PIPESTATUS[@]}")
fi

pipeline_status=0
for status in "\${pipeline_statuses[@]}"; do
  if [ "$status" -ne 0 ]; then
    pipeline_status=$status
  fi
done

if [ "\${pipeline_statuses[0]}" -eq 0 ]; then
  mv "$tmp_file" ${shellQuote(telemetryPath)}
  trap - EXIT
fi

exit "$pipeline_status"
`;
}

function writeStatusLineScript(
  sessionId: string,
  dir: string,
  configDir: string
): string {
  const scriptPath = path.join(dir, 'relay-statusline.sh');
  const script = buildStatusLineRelayScript(
    sessionId,
    configDir,
    readGlobalStatusLineCommand()
  );
  fs.writeFileSync(scriptPath, script, 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Upgrade an existing hooks-settings.json to include statusLine if missing.
 * Called on session restore to ensure sessions created before telemetry support
 * get the relay script written to disk. The running Claude process will pick this
 * up on its next statusLine poll cycle (Claude re-reads the settings file).
 */
export function upgradeHooksSettings(
  sessionId: string,
  configDir: string
): boolean {
  const dir = path.join(os.tmpdir(), 'relay-ide', sessionId);
  const filePath = path.join(dir, 'hooks-settings.json');

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (settings.statusLine) return false; // already has statusLine
  } catch {
    return false; // file doesn't exist or is malformed
  }

  // Write the relay script and patch the settings file
  try {
    const statusLinePath = writeStatusLineScript(sessionId, dir, configDir);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    settings.statusLine = { type: 'command', command: statusLinePath };
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    logger.warn(
      `Failed to upgrade hooks settings for session ${sessionId}:`,
      err
    );
    return false;
  }
}

function writeHooksSettingsFile(
  sessionId: string,
  port: number,
  token: string,
  configDir: string
): string {
  const dir = path.join(os.tmpdir(), 'relay-ide', sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, 'hooks-settings.json');
  const statusLinePath = writeStatusLineScript(sessionId, dir, configDir);
  const base = `http://127.0.0.1:${port}`;
  const q = `sessionId=${sessionId}&token=${token}`;
  const settings = {
    hooks: {
      Stop: [
        {
          hooks: [{ type: 'http', url: `${base}/hooks/stop?${q}`, timeout: 5 }],
        },
      ],
      Notification: [
        {
          matcher: 'permission_prompt',
          hooks: [
            {
              type: 'http',
              url: `${base}/hooks/notification?${q}&type=permission_prompt`,
              timeout: 5,
            },
          ],
        },
        {
          matcher: 'idle_prompt',
          hooks: [
            {
              type: 'http',
              url: `${base}/hooks/notification?${q}&type=idle_prompt`,
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'http',
              url: `${base}/hooks/prompt-submit?${q}`,
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            { type: 'http', url: `${base}/hooks/session-end?${q}`, timeout: 5 },
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            { type: 'http', url: `${base}/hooks/tool-use?${q}`, timeout: 5 },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            { type: 'http', url: `${base}/hooks/tool-result?${q}`, timeout: 5 },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: statusLinePath,
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

export type CreatePtyParams = {
  id: string;
  type?: SessionType | undefined;
  agent?: AgentType | undefined;
  repoName?: string | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | null | undefined;
  cwd: string;
  branchName?: string | undefined;
  displayName?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  configPath?: string | undefined;
  configDir?: string | undefined;
  terminalBackend?: TerminalBackend | undefined;
  sessionCustomCommand?: string | null | undefined;
  sessionLane?: SessionLane | undefined;
  initialScrollback?: string[] | undefined;
  restored?: boolean | undefined;
  port?: number | undefined;
  forceOutputParser?: boolean | undefined;
  yolo?: boolean | undefined;
  claudeArgs?: string[] | undefined;
  hookToken?: string | undefined;
  hooksActive?: boolean | undefined;
  continuePolicy?: ContinuePolicy | undefined;
  controlState?: ControlStateSummary | undefined;
  frameworks?: Record<string, Partial<AgentFramework>> | undefined;
  claudeFullscreen?: boolean | undefined;
  /** Environment variable names to inject with allocated ports (per-worktree) */
  portVariables?: string[] | undefined;
  /** Optional port allocator instance (uses default if not provided) */
  portAllocator?: PortAllocator | undefined;
  /** Per-session scrollback cap in bytes. Defaults to 256 KB. */
  maxScrollbackBytes?: number | undefined;
  /** Relay node ID to inject as RELAY_NODE_ID (defaults to DEFAULT_LOCAL_NODE_ID). */
  nodeId?: string | undefined;
  /** WorkContext ID to inject as RELAY_WORK_CONTEXT_ID (omitted when not set). */
  workContextId?: string | undefined;
  /**
   * Additional env vars layered on top of the base session env (#740: a Tab
   * inherits its anchoring Bench's persisted `envOverrides`). Applied
   * ADDITIVELY before Relay-owned identity injection, so Relay's own
   * `RELAY_*`/`RELAY_HUB_URL` vars and the per-session relayctl PATH shim
   * always win — caller env can never clobber them. An empty/undefined record
   * is a no-op (unchanged behavior).
   */
  envOverrides?: Record<string, string> | undefined;
  callbacks?:
    | {
        onStateChange?: Array<(sessionId: string, state: AgentState) => void>;
        onSessionEnd?: Array<
          (sessionId: string, cwd: string, branchName?: string) => void
        >;
        fireBackendStateIfChanged?: (session: Session) => void;
        /**
         * Called after each scrollback append so the global cap can be enforced.
         * Receives the ID of the session that just appended and the size of the
         * appended chunk in bytes so callers can maintain an incremental total.
         */
        onScrollbackAppend?: (sessionId: string, appendedBytes: number) => void;
      }
    | undefined;
};

export type CreatePtyResult = SessionSummary & { pid: number | undefined };

function resolveAgentFramework(
  agent: AgentType,
  frameworks: Record<string, Partial<AgentFramework>> | undefined
): AgentFramework {
  try {
    return resolveFramework(frameworks ? { frameworks } : {}, agent);
  } catch {
    return {
      id: agent,
      displayName: agent,
      command: AGENT_COMMANDS[agent] ?? agent,
      continueArgs: AGENT_CONTINUE_ARGS[agent] ?? [],
      yoloArgs: [],
      parserType: 'none',
      eventSource: 'parser',
      capabilities: {
        supportsHooks: false,
        supportsContinue: false,
        supportsYolo: false,
        supportsTelemetry: false,
        supportsAttachedRuntime: false,
      },
    };
  }
}

type HookSetupResult = {
  env: NodeJS.ProcessEnv;
  hookToken: string;
  hooksActive: boolean;
  settingsPath: string;
  args: string[];
};

function setupPluginHooks(
  id: string,
  port: number,
  hookToken: string,
  env: Record<string, string>
): { hookToken: string; hooksActive: boolean } {
  if (!hookToken) hookToken = crypto.randomBytes(32).toString('hex');
  try {
    installOpenCodeRelayPlugin();
    const pluginEnv = {
      RELAY_IDE_URL: `http://127.0.0.1:${port}`,
      RELAY_IDE_SESSION_ID: id,
      RELAY_IDE_TOKEN: hookToken,
    };
    Object.assign(env, pluginEnv);
    return { hookToken, hooksActive: true };
  } catch (err) {
    logger.warn(
      `Failed to install opencode relay plugin for session ${id}:`,
      err
    );
    return { hookToken, hooksActive: false };
  }
}

function setupCodexHooks(
  id: string,
  port: number,
  hookToken: string,
  configDir: string,
  env: Record<string, string>
): { hookToken: string; hooksActive: boolean } {
  if (!hookToken) hookToken = crypto.randomBytes(32).toString('hex');
  try {
    const codexConfigDir = writeCodexHooksAdapter(
      id,
      port,
      hookToken,
      configDir
    );
    env.CODEX_CONFIG_DIR = codexConfigDir;
    return { hookToken, hooksActive: true };
  } catch (err) {
    logger.warn(`Failed to write codex hooks adapter for session ${id}:`, err);
    return { hookToken, hooksActive: false };
  }
}

type PortInjectionParams = {
  repoPath: string;
  worktreePath: string | null | undefined;
  cwd: string;
  portVariables?: string[] | undefined;
  portAllocator?: PortAllocator | undefined;
};

/**
 * Inject per-worktree allocated port environment variables into the PTY environment.
 *
 * Uses the port allocator to look up existing allocations for the worktree
 * identified by worktreePath (or cwd if no worktree). Ports are injected as
 * environment variables matching the configured port variable names.
 */
function injectPortEnvVars(
  env: Record<string, string>,
  params: PortInjectionParams
): void {
  const { repoPath, worktreePath, cwd, portVariables, portAllocator } = params;

  // Skip if no port variable names configured
  if (!portVariables || portVariables.length === 0) return;

  // Get the port allocator - use provided instance or fall back to default
  let allocator: PortAllocator;
  try {
    allocator = portAllocator ?? getDefaultAllocator();
  } catch {
    // Default allocator not initialized - skip silently
    logger.debug('Port env injection skipped: allocator not available');
    return;
  }

  // Derive worktree ID: use worktreePath if available, otherwise cwd
  const worktreeId = worktreePath ?? cwd;
  if (!worktreeId) return;

  // Get existing port allocations (synchronous)
  const portMapping = allocator.getPortsForWorktree(repoPath, worktreeId);
  if (!portMapping) return;

  // Inject allocated ports as environment variables
  for (const [varName, port] of Object.entries(portMapping)) {
    if (portVariables.includes(varName)) {
      env[varName] = String(port);
    }
  }
}

/**
 * Resolve the path to the compiled relayctl binary.
 * Searches relative to this file's location in dist/ (compiled output).
 */
function resolveRelayctlBinaryPath(): string | null {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    // selfPath is something like /…/dist/server/pty-handler.js
    // relayctl is compiled to /…/dist/bin/relayctl.js
    const distDir = path.dirname(path.dirname(selfPath));
    const candidate = path.join(distDir, 'bin', 'relayctl.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // non-ESM context or path not resolvable — skip
  }
  return null;
}

/**
 * Write a per-session bin directory containing a `relayctl` shim that delegates
 * to the compiled relayctl.js binary via node. Returns the bin dir path, or null
 * if the relayctl binary cannot be located.
 *
 * The shim is written to `{tmpdir}/relay-ide/{sessionId}/bin/relayctl`.
 * Callers must prepend this path to PATH in the session environment so that
 * `relayctl` is only discoverable from within a Relay-spawned PTY.
 */
function writeRelayctlShim(sessionId: string): string | null {
  const binaryPath = resolveRelayctlBinaryPath();
  if (!binaryPath) return null;
  try {
    const binDir = path.join(os.tmpdir(), 'relay-ide', sessionId, 'bin');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const shimPath = path.join(binDir, 'relayctl');
    const shim = `#!/bin/sh\nexec node ${shellQuote(binaryPath)} "$@"\n`;
    fs.writeFileSync(shimPath, shim, { encoding: 'utf-8', mode: 0o755 });
    fs.chmodSync(shimPath, 0o755);
    return binDir;
  } catch (err) {
    logger.warn(`Failed to write relayctl shim for session ${sessionId}:`, err);
    return null;
  }
}

type RelaySessionEnvParams = {
  sessionId: string;
  nodeId: string;
  port: number | undefined;
  workContextId: string | undefined;
};

/**
 * Inject Relay-owned session identity env vars into the PTY environment.
 *
 * - RELAY_NODE_ID — the node this session is running on
 * - RELAY_SESSION_ID — the local session ID
 * - RELAY_HUB_URL — the local hub base URL (http://127.0.0.1:{port})
 * - RELAY_SOCKET — alias for the local hub endpoint for terminal mailroom CLIs
 * - RELAY_WORK_CONTEXT_ID — set only when a WorkContext is bound
 *
 * Also writes a per-session bin dir with a `relayctl` shim and prepends it
 * to PATH so relayctl is only discoverable from within a Relay-spawned PTY.
 *
 * These env vars are injected here (inside Relay's PTY spawn path) so they
 * never appear in shells the user opens outside Relay.
 *
 * @internal exported for testing only; use `createPtySession` in production.
 */
export function injectRelaySessionEnvForTest(
  env: Record<string, string>,
  params: RelaySessionEnvParams
): void {
  return injectRelaySessionEnv(env, params);
}

function injectRelaySessionEnv(
  env: Record<string, string>,
  params: RelaySessionEnvParams
): void {
  const { sessionId, nodeId, port, workContextId } = params;

  env.RELAY_NODE_ID = nodeId;
  env.RELAY_SESSION_ID = sessionId;

  if (port !== undefined) {
    const hubUrl = `http://127.0.0.1:${port}`;
    env.RELAY_HUB_URL = hubUrl;
    env.RELAY_SOCKET = hubUrl;
  }

  if (workContextId) {
    env.RELAY_WORK_CONTEXT_ID = workContextId;
  }

  // Write per-session relayctl shim and prepend to PATH so it is only
  // reachable from within Relay-spawned PTY sessions.
  const shimBinDir = writeRelayctlShim(sessionId);
  if (shimBinDir) {
    const currentPath = env.PATH ?? process.env.PATH ?? '';
    env.PATH = `${shimBinDir}:${currentPath}`;
  }
}

/**
 * Reserved env keys that bench overrides may NOT set. These are Relay-owned:
 * `PATH` carries the per-session relayctl shim, and any `RELAY_*` var is part
 * of the session identity/control contract. A bench override targeting one of
 * these is dropped (logged once) rather than applied, so a misconfigured bench
 * can never break session identity or shim discovery.
 */
function isReservedEnvKey(key: string): boolean {
  return key === 'PATH' || key.startsWith('RELAY_');
}

/**
 * Layer a Bench's persisted `envOverrides` onto the base PTY env (#740).
 * Additive: each non-reserved key is set (or overwritten) on both the process
 * env. Reserved keys (`PATH`, `RELAY_*`)
 * are skipped so Relay's own injection always wins. Empty record is a no-op.
 *
 * @internal exported as injectBenchEnvOverridesForTest for testing only.
 */
function applyBenchEnvOverrides(
  env: Record<string, string>,
  overrides: Record<string, string>
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof value !== 'string') continue;
    if (isReservedEnvKey(key)) {
      logger.warn(
        `Skipping reserved bench env override "${key}" (Relay-owned, not overridable)`
      );
      continue;
    }
    env[key] = value;
  }
}

/** @internal Exposed for unit tests of bench env-override precedence. */
export function injectBenchEnvOverridesForTest(
  env: Record<string, string>,
  overrides: Record<string, string>
): void {
  applyBenchEnvOverrides(env, overrides);
}

function buildPortInjectionParams(
  repoPath: string | undefined,
  worktreePath: string | null,
  cwd: string,
  portVariables: string[] | undefined,
  portAllocator: PortAllocator | undefined
): PortInjectionParams | undefined {
  if (!repoPath || (!portVariables && !portAllocator)) return undefined;
  return { repoPath, worktreePath, cwd, portVariables, portAllocator };
}

interface ClaudeHookInjection {
  hookToken: string;
  hooksActive: boolean;
  settingsPath: string;
  args: string[];
}

function injectClaudeHooks(
  id: string,
  port: number,
  configDir: string | undefined,
  existingToken: string,
  args: string[]
): ClaudeHookInjection {
  const hookToken = existingToken || crypto.randomBytes(32).toString('hex');
  try {
    const settingsPath = writeHooksSettingsFile(
      id,
      port,
      hookToken,
      configDir ?? process.cwd()
    );
    return {
      hookToken,
      hooksActive: true,
      settingsPath,
      args: ['--settings', settingsPath, ...args],
    };
  } catch (err) {
    logger.warn(`Failed to generate hooks settings for session ${id}:`, err);
    return { hookToken: '', hooksActive: false, settingsPath: '', args };
  }
}

function setupEnvAndHooks(
  id: string,
  framework: AgentFramework,
  effectiveEventSource: EventSourceType,
  command: string | undefined,
  port: number | undefined,
  configDir: string | undefined,
  paramYolo: boolean | undefined,
  paramHookToken: string | undefined,
  paramHooksActive: boolean | undefined,
  paramClaudeFullscreen: boolean | undefined,
  rawArgs: string[],
  portInjectionParams?: PortInjectionParams,
  relaySessionEnvParams?: RelaySessionEnvParams,
  envOverrides?: Record<string, string> | undefined
): HookSetupResult {
  const env = cleanEnv();

  if (framework.id === 'claude' && paramClaudeFullscreen === true) {
    env.CLAUDE_CODE_NO_FLICKER = '1';
  }

  if (paramYolo && framework.yoloEnv) {
    Object.assign(env, framework.yoloEnv);
  }

  let hookToken = paramHookToken ?? '';
  let args = rawArgs;
  let pluginHooksActive = paramHooksActive ?? false;
  let codexHooksActive = false;
  let claudeHooksActive = false;
  let settingsPath = '';

  if (effectiveEventSource === 'plugin' && port !== undefined) {
    const result = setupPluginHooks(id, port, hookToken, env);
    hookToken = result.hookToken;
    pluginHooksActive = result.hooksActive;
  }

  if (framework.id === 'codex' && port !== undefined) {
    const result = setupCodexHooks(
      id,
      port,
      hookToken,
      configDir ?? process.cwd(),
      env
    );
    hookToken = result.hookToken;
    codexHooksActive = result.hooksActive;
  }

  if (
    framework.id === 'claude' &&
    framework.capabilities.supportsHooks &&
    effectiveEventSource === 'hooks' &&
    !command &&
    port !== undefined
  ) {
    const result = injectClaudeHooks(id, port, configDir, hookToken, args);
    hookToken = result.hookToken;
    args = result.args;
    settingsPath = result.settingsPath;
    claudeHooksActive = result.hooksActive;
  }

  if (portInjectionParams) {
    injectPortEnvVars(env, portInjectionParams);
  }

  // #740: layer the anchoring Bench's persisted env overrides on top of the
  // base session env. Applied BEFORE Relay identity injection below so the
  // Relay-owned vars + relayctl PATH shim always win and can never be clobbered
  // by caller-supplied env.
  if (envOverrides) {
    applyBenchEnvOverrides(env, envOverrides);
  }

  // Inject Relay-owned session identity env vars. These are set last so they
  // are never overwritten by hook, port, or bench-override injection above.
  if (relaySessionEnvParams) {
    injectRelaySessionEnv(env, relaySessionEnvParams);
  }

  return {
    env,
    hookToken,
    hooksActive: claudeHooksActive || codexHooksActive || pluginHooksActive,
    settingsPath,
    args,
  };
}

function resolveSpawnTarget(
  resolvedCommand: string,
  args: string[],
  paramTerminalBackend: TerminalBackend | undefined,
  workContextId: string | undefined,
  id: string,
  env: NodeJS.ProcessEnv
): {
  spawnCommand: string;
  spawnArgs: string[];
  spawnEnv: NodeJS.ProcessEnv;
  terminalBackend: TerminalBackend;
} {
  if (paramTerminalBackend && paramTerminalBackend !== 'relay-pty') {
    throw new Error(
      `Unsupported terminal backend "${paramTerminalBackend}"; Relay now supports relay-pty only.`
    );
  }
  return {
    spawnCommand: resolvedCommand,
    spawnArgs: args,
    spawnEnv: buildRelayPtySessionEnv({
      id,
      env,
      ...(workContextId ? { workContextId } : {}),
    }),
    terminalBackend: 'relay-pty',
  };
}

function buildSessionObject(
  params: CreatePtyParams,
  ptyProcess: pty.IPty,
  scrollback: string[],
  parser: OutputParser,
  hookToken: string,
  hooksActive: boolean,
  effectiveEventSource: EventSourceType,
  terminalBackend: TerminalBackend,
  terminalModel: TerminalModelBackend | undefined,
  createdAt: string,
  scrollbackCapacityBytes: number
): PtySession {
  const {
    id,
    type,
    agent = 'claude',
    repoName,
    repoPath,
    worktreePath = null,
    cwd,
    branchName,
    displayName,
    command,
    sessionCustomCommand,
    restored: paramRestored,
    yolo: paramYolo,
    claudeArgs: paramClaudeArgs,
    continuePolicy,
    controlState,
  } = params;

  const normalizedControlState = normalizeControlStateSummary(
    controlState ?? createLegacyControlStateSummary()
  );

  return {
    id,
    nodeId: DEFAULT_LOCAL_NODE_ID,
    type: type || 'agent',
    agent,
    mode: 'pty' as const,
    ...(repoPath ? { repoPath } : {}),
    ...(repoPath ? { worktreePath: worktreePath ?? null } : {}),
    ...(repoName ? { repoName } : {}),
    ...(repoPath ? { branchName: branchName ?? '' } : {}),
    displayName: displayName || repoName || path.basename(cwd) || '',
    pty: ptyProcess,
    createdAt,
    lastActivity: createdAt,
    scrollback,
    scrollbackBytesEvicted: 0,
    scrollbackCapacityBytes,
    terminalStream: createTerminalStreamState({
      sessionId: id,
      capacityBytes: scrollbackCapacityBytes,
      initialChunks: scrollback,
    }),
    terminalStreamSubscribers: [],
    terminalBackend,
    ...(terminalModel ? { terminalModel } : {}),
    idle: false,
    cwd,
    customCommand:
      sessionCustomCommand !== undefined
        ? sessionCustomCommand
        : command || null,
    onPtyReplacedCallbacks: [],
    status: 'active' as SessionStatus,
    restored: paramRestored || false,
    needsBranchRename: false,
    agentState: 'initializing',
    outputParser: parser,
    hookToken,
    hooksActive,
    cleanedUp: false,
    yolo: paramYolo ?? false,
    sessionArgs: paramClaudeArgs ?? [],
    claudeArgs: paramClaudeArgs ?? [],
    continuePolicy: continuePolicy ?? 'never',
    dataQuality: hooksActive ? effectiveEventSource : 'parser',
    controlState: normalizedControlState,
    _lastHookTime: undefined,
  };
}

function isParserOverrideAllowed(
  session: PtySession,
  lastHook: number | undefined
): boolean {
  const sessionAge = Date.now() - new Date(session.createdAt).getTime();
  if (lastHook && Date.now() - lastHook > 30000) return true;
  if (!lastHook && sessionAge > 30000) return true;
  return false;
}

function shouldAcceptStartupParserState(
  session: PtySession,
  newState: AgentState,
  lastHook: number | undefined
): boolean {
  return (
    !lastHook &&
    session.agentState === 'initializing' &&
    newState !== 'initializing'
  );
}

function handleParserStateUpdate(
  session: PtySession,
  newState: AgentState,
  stateChangeCallbacks: Array<(sessionId: string, state: AgentState) => void>,
  fireBackendStateIfChanged: ((session: PtySession) => void) | undefined
): void {
  if (session.hooksActive) {
    const lastHook = session._lastHookTime;
    const allowStartupParserState = shouldAcceptStartupParserState(
      session,
      newState,
      lastHook
    );
    if (
      !allowStartupParserState &&
      !isParserOverrideAllowed(session, lastHook)
    ) {
      return;
    }
  }
  if (newState !== 'permission-prompt') {
    delete session.permissionType;
    delete session.permissionPromptSource;
  }
  session.agentState = newState;
  for (const cb of stateChangeCallbacks) cb(session.id, newState);
  fireBackendStateIfChanged?.(session);
}

export function handleTerminalAttentionUpdate(
  session: PtySession,
  stateChangeCallbacks: Array<(sessionId: string, state: AgentState) => void>,
  fireBackendStateIfChanged: ((session: PtySession) => void) | undefined
): void {
  const terminalModel = session.terminalModel;
  if (!terminalModel) return;

  const attention = detectTerminalAttentionPrompt(
    terminalModel.getVisibleText()
  );
  if (!attention) {
    if (
      session.agentState === 'permission-prompt' &&
      session.permissionPromptSource === 'terminal-model'
    ) {
      delete session.permissionType;
      delete session.permissionPromptSource;
      session.agentState = 'idle';
      for (const cb of stateChangeCallbacks) cb(session.id, 'idle');
      fireBackendStateIfChanged?.(session);
    }
    return;
  }

  session.permissionType = attention.kind;
  session.permissionPromptSource = attention.source;
  if (session.agentState !== 'permission-prompt') {
    session.agentState = 'permission-prompt';
    for (const cb of stateChangeCallbacks) cb(session.id, 'permission-prompt');
  }
  fireBackendStateIfChanged?.(session);
}

type ResolvedPtyCallbacks = {
  stateChangeCallbacks: Array<(sessionId: string, state: AgentState) => void>;
  sessionEndCallbacks: Array<
    (sessionId: string, cwd: string, branchName?: string) => void
  >;
  fireBackendStateIfChanged: ((session: Session) => void) | undefined;
  onScrollbackAppend:
    | ((sessionId: string, appendedBytes: number) => void)
    | undefined;
};

function resolveCallbacks(
  callbacks: CreatePtyParams['callbacks']
): ResolvedPtyCallbacks {
  return {
    stateChangeCallbacks: callbacks?.onStateChange ?? [],
    sessionEndCallbacks: callbacks?.onSessionEnd ?? [],
    fireBackendStateIfChanged: callbacks?.fireBackendStateIfChanged,
    onScrollbackAppend: callbacks?.onScrollbackAppend,
  };
}

export function createPtySession(
  params: CreatePtyParams,
  sessionsMap: Map<string, Session>
): { session: PtySession; result: CreatePtyResult } {
  const {
    stateChangeCallbacks,
    sessionEndCallbacks,
    fireBackendStateIfChanged,
    onScrollbackAppend,
  } = resolveCallbacks(params.callbacks);
  const {
    id,
    agent = 'claude',
    repoPath,
    worktreePath = null,
    cwd,
    command,
    args: rawArgs = [],
    cols = 80,
    rows = 24,
    configPath,
    configDir,
    initialScrollback,
    port,
    forceOutputParser,
    yolo: paramYolo,
    hookToken: paramHookToken,
    hooksActive: paramHooksActive,
    frameworks,
    claudeFullscreen: paramClaudeFullscreen,
    portVariables,
    portAllocator,
    maxScrollbackBytes: paramMaxScrollbackBytes,
    nodeId: paramNodeId,
    workContextId: paramWorkContextId,
    envOverrides: paramEnvOverrides,
  } = params;

  const maxScrollbackPerSession =
    paramMaxScrollbackBytes ?? DEFAULT_MAX_SCROLLBACK_PER_SESSION;

  const createdAt = new Date().toISOString();

  const framework = resolveAgentFramework(agent, frameworks);
  const resolvedCommand =
    command || framework.commandOverride || framework.command;

  // #955: teach Relay-launched agents to collaborate through Relay's CLI
  // gateway by appending the provider-supported collaboration system-prompt
  // flag (e.g. Claude `--append-system-prompt`). Appended to the TAIL so the
  // existing continue/claudeArgs/yolo ordering is preserved verbatim. Skipped
  // when a custom `command` overrides the framework CLI (the provider flag may
  // be invalid there, matching the `injectClaudeHooks` gate) and for any
  // framework that does not declare support. Derived fresh here and never
  // persisted on the session, so it survives restore and never enters
  // serialized state.
  const launchArgs = command
    ? rawArgs
    : [...rawArgs, ...collaborationPromptArgsForFramework(framework)];

  const effectiveEventSource: EventSourceType = forceOutputParser
    ? 'parser'
    : framework.eventSource;

  // Prepare port injection params for setupEnvAndHooks
  const portInjectionParams = buildPortInjectionParams(
    repoPath,
    worktreePath,
    cwd,
    portVariables,
    portAllocator
  );

  const relaySessionEnvParams: RelaySessionEnvParams = {
    sessionId: id,
    nodeId: paramNodeId ?? DEFAULT_LOCAL_NODE_ID,
    port,
    workContextId: paramWorkContextId,
  };

  const hookSetup = setupEnvAndHooks(
    id,
    framework,
    effectiveEventSource,
    command,
    port,
    configDir,
    paramYolo,
    paramHookToken,
    paramHooksActive,
    paramClaudeFullscreen,
    launchArgs,
    portInjectionParams,
    relaySessionEnvParams,
    paramEnvOverrides
  );

  const { env, hookToken, hooksActive, settingsPath } = hookSetup;
  const args = hookSetup.args;

  const { spawnCommand, spawnArgs, spawnEnv, terminalBackend } =
    resolveSpawnTarget(
      resolvedCommand,
      args,
      params.terminalBackend,
      params.workContextId,
      id,
      env
    );

  const ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: spawnEnv,
  });

  const scrollback: string[] = initialScrollback ? [...initialScrollback] : [];
  const terminalModel = createLibghosttyTerminalModelBackend({
    cols,
    rows,
    scrollbackLimit: 1000,
  });
  for (const chunk of scrollback) terminalModel.feed(chunk);
  // Use a ref so tryRetrySpawn (called from onExit) can reset the byte counter
  const scrollbackRef = {
    bytes: initialScrollback
      ? initialScrollback.reduce((sum, s) => sum + s.length, 0)
      : 0,
  };

  const parserFactory =
    outputParsers[framework.parserType] ?? outputParsers['none'];
  const parser: OutputParser = parserFactory!();

  const session = buildSessionObject(
    params,
    ptyProcess,
    scrollback,
    parser,
    hookToken,
    hooksActive,
    effectiveEventSource,
    terminalBackend,
    terminalModel,
    createdAt,
    maxScrollbackPerSession
  );
  sessionsMap.set(id, session);

  if (configPath && worktreePath) {
    const existing = readMeta(configPath, worktreePath);
    if (existing && existing.displayName) {
      session.displayName = existing.displayName;
    }
    writeMeta(configPath, {
      worktreePath,
      displayName: session.displayName,
      lastActivity: createdAt,
    });
  }

  let metaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (session.idle) {
      session.idle = false;
      fireBackendStateIfChanged?.(session);
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!session.idle) {
        session.idle = true;
        fireBackendStateIfChanged?.(session);
      }
    }, IDLE_TIMEOUT_MS);
  }

  const continueArgs = framework.continueArgs;

  function attachHandlers(proc: pty.IPty, canRetry: boolean): void {
    const spawnTime = Date.now();
    const restoredClearTimer = session.restored
      ? setTimeout(() => {
          session.restored = false;
        }, 3000)
      : null;

    proc.onData((data) => {
      session.lastActivity = new Date().toISOString();
      resetIdleTimer();
      scrollback.push(data);
      session.terminalModel?.feed(data);
      scrollbackRef.bytes += data.length;
      const terminalStreamEnvelope = session.terminalStream
        ? appendTerminalStreamData(session.terminalStream, data)
        : null;
      if (terminalStreamEnvelope) {
        for (const cb of session.terminalStreamSubscribers ?? []) {
          cb(terminalStreamEnvelope);
        }
      }
      // Trim oldest entries if over limit; track total bytes evicted so
      // `SessionReplaySnapshot.bytesDropped` can report lost history.
      while (
        scrollbackRef.bytes > maxScrollbackPerSession &&
        scrollback.length > 1
      ) {
        const evicted = (scrollback.shift() as string).length;
        scrollbackRef.bytes -= evicted;
        session.scrollbackBytesEvicted += evicted;
      }
      // Notify sessions layer so global cap can be enforced.
      // Pass the session id and chunk size so the caller can maintain an
      // incremental total and skip the O(N) walk when still under cap.
      onScrollbackAppend?.(id, data.length);
      if (configPath && worktreePath && !metaFlushTimer) {
        metaFlushTimer = setTimeout(() => {
          metaFlushTimer = null;
          writeMeta(configPath, {
            worktreePath,
            displayName: session.displayName,
            lastActivity: session.lastActivity,
          });
        }, 5000);
      }

      const parseResult = session.outputParser.onData(
        data,
        scrollback.slice(-20)
      );
      if (parseResult && parseResult.state !== session.agentState) {
        handleParserStateUpdate(
          session,
          parseResult.state,
          stateChangeCallbacks,
          fireBackendStateIfChanged
        );
      }
      handleTerminalAttentionUpdate(
        session,
        stateChangeCallbacks,
        fireBackendStateIfChanged
      );
    });

    proc.onExit(() => {
      if (canRetry && Date.now() - spawnTime < 3000) {
        const retried = tryRetrySpawn(session, {
          rawArgs: launchArgs,
          continueArgs,
          settingsPath,
          resolvedCommand,
          cols,
          rows,
          cwd,
          env,
          workContextId: params.workContextId,
          scrollback,
          scrollbackRef,
          timers: {
            restoredClear: restoredClearTimer,
            idle: idleTimer,
            metaFlush: metaFlushTimer,
          },
          sessionsMap,
          id,
        });
        if (retried !== null) {
          session.pty = retried;
          for (const cb of session.onPtyReplacedCallbacks) cb(retried);
          attachHandlers(retried, false);
          return;
        }
        // Retry spawn failed — fall through to exit cleanup
        return;
      }

      if (session.cleanedUp) return;
      session.cleanedUp = true;

      if (restoredClearTimer) clearTimeout(restoredClearTimer);

      if (session.restored) {
        session.status = 'disconnected';
        session.restored = false;
        if (idleTimer) clearTimeout(idleTimer);
        if (metaFlushTimer) clearTimeout(metaFlushTimer);
        releasePtySessionResources(session, id);
        return;
      }

      runExitCleanup(
        session,
        idleTimer,
        metaFlushTimer,
        configPath,
        worktreePath,
        sessionEndCallbacks,
        sessionsMap,
        id,
        cwd
      );
    });
  }

  attachHandlers(
    ptyProcess,
    continueArgs.some((a) => args.includes(a))
  );

  const result: CreatePtyResult = {
    id,
    type: session.type,
    agent: session.agent,
    mode: 'pty' as const,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    ...(session.worktreePath !== undefined
      ? { worktreePath: session.worktreePath }
      : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
    ...(session.branchName !== undefined
      ? { branchName: session.branchName }
      : {}),
    displayName: session.displayName,
    pid: ptyProcess.pid,
    createdAt,
    lastActivity: createdAt,
    idle: false,
    cwd,
    customCommand: session.customCommand,
    terminalBackend,
    status: 'active' as SessionStatus,
    needsBranchRename: false,
    agentState: 'initializing',
    ...session.controlState,
  };

  return { session, result };
}

type RetryContext = {
  rawArgs: string[];
  continueArgs: string[];
  settingsPath: string;
  resolvedCommand: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  workContextId: string | undefined;
  scrollback: string[];
  scrollbackRef: { bytes: number };
  timers: {
    restoredClear: ReturnType<typeof setTimeout> | null;
    idle: ReturnType<typeof setTimeout> | null;
    metaFlush: ReturnType<typeof setTimeout> | null;
  };
  sessionsMap: Map<string, Session>;
  id: string;
};

function tryRetrySpawn(
  session: PtySession,
  ctx: RetryContext
): pty.IPty | null {
  let retryArgs = ctx.rawArgs.filter((a) => !ctx.continueArgs.includes(a));
  if (session.hooksActive && ctx.settingsPath) {
    retryArgs = ['--settings', ctx.settingsPath, ...retryArgs];
  }

  const retryNotice =
    '\r\n[relay-ide] --continue not available; starting new session...\r\n';
  ctx.scrollback.length = 0;
  ctx.scrollbackRef.bytes = 0;
  ctx.scrollback.push(retryNotice);
  ctx.scrollbackRef.bytes = retryNotice.length;

  try {
    return pty.spawn(ctx.resolvedCommand, retryArgs, {
      name: 'xterm-256color',
      cols: ctx.cols,
      rows: ctx.rows,
      cwd: ctx.cwd,
      env: buildRelayPtySessionEnv({
        id: ctx.id,
        env: ctx.env,
        ...(ctx.workContextId ? { workContextId: ctx.workContextId } : {}),
      }),
    });
  } catch {
    if (ctx.timers.restoredClear) clearTimeout(ctx.timers.restoredClear);
    if (ctx.timers.idle) clearTimeout(ctx.timers.idle);
    if (ctx.timers.metaFlush) clearTimeout(ctx.timers.metaFlush);
    ctx.sessionsMap.delete(ctx.id);
    return null;
  }
}

function runExitCleanup(
  session: PtySession,
  idleTimer: ReturnType<typeof setTimeout> | null,
  metaFlushTimer: ReturnType<typeof setTimeout> | null,
  configPath: string | undefined,
  worktreePath: string | null | undefined,
  sessionEndCallbacks: Array<
    (sessionId: string, cwd: string, branchName?: string) => void
  >,
  sessionsMap: Map<string, Session>,
  id: string,
  cwd: string
): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (metaFlushTimer) clearTimeout(metaFlushTimer);
  if (configPath && worktreePath) {
    writeMeta(configPath, {
      worktreePath,
      displayName: session.displayName,
      lastActivity: session.lastActivity,
    });
  }
  for (const cb of sessionEndCallbacks) {
    try {
      cb(id, cwd, session.branchName);
    } catch (err) {
      logger.error('sessionEnd callback error:', err);
    }
  }
  sessionsMap.delete(id);
  releasePtySessionResources(session, id);
}

/**
 * Release the heavyweight live PTY/vt state while leaving session metadata and
 * scrollback available to cold-resume callers. Idempotent for overlapping
 * explicit-kill and PTY-exit cleanup.
 */
function releasePtySessionResources(session: PtySession, id: string): void {
  session.terminalModel?.dispose();
  delete session.terminalModel;
  delete session.terminalStream;
  session.terminalStreamSubscribers?.splice(0);
  delete session.terminalStreamSubscribers;
  if (!session.preserveRuntimeFilesOnExit) {
    const tmpDir = path.join(os.tmpdir(), 'relay-ide', id);
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}
