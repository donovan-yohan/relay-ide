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
  SessionType,
} from './types.js';
import {
  AGENT_COMMANDS,
  AGENT_CONTINUE_ARGS,
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

const IDLE_TIMEOUT_MS = 5000;
/** Default per-session scrollback cap. Overridable via createPtySession options. */
const DEFAULT_MAX_SCROLLBACK_PER_SESSION = 256 * 1024; // 256KB
const logger = createLogger('pty');

function normalizeTmuxPrefix(prefix: string | undefined): string | null {
  const sanitized = prefix
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '');
  if (!sanitized) return null;
  return sanitized.endsWith('-') ? sanitized : `${sanitized}-`;
}

export function getTmuxPrefix(): string {
  return (
    normalizeTmuxPrefix(process.env.RELAY_IDE_TMUX_PREFIX) ??
    (process.env.NO_PIN === '1' ? 'relay-dev-' : 'relay-ide-')
  );
}

export function generateTmuxSessionName(
  displayName: string,
  id: string
): string {
  const sanitized = displayName
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);
  return `${getTmuxPrefix()}${sanitized}-${id.slice(0, 8)}`;
}

export function resolveTmuxSpawn(
  command: string,
  args: string[],
  tmuxSessionName: string,
  env?: NodeJS.ProcessEnv
): { command: string; args: string[] } {
  const envArgs = tmuxEnvArgs(env);
  return {
    command: 'tmux',
    args: [
      '-u',
      'new-session',
      ...envArgs,
      '-s',
      tmuxSessionName,
      '--',
      command,
      ...args,
      ';',
      'set',
      'set-clipboard',
      'on',
      ';',
      'set',
      'allow-passthrough',
      'on',
      ';',
      'set',
      'mode-keys',
      'vi',
    ],
  };
}

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TMUX_ENV_SENSITIVE_NAME = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|KEY)/i;
const TMUX_ENV_SENSITIVE_ALLOWLIST = new Set(['RELAY_IDE_TOKEN']);

function tmuxEnvArgs(env: NodeJS.ProcessEnv | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).flatMap(([key, value]) => {
    if (!VALID_ENV_NAME.test(key) || value === undefined) return [];
    if (
      TMUX_ENV_SENSITIVE_NAME.test(key) &&
      !TMUX_ENV_SENSITIVE_ALLOWLIST.has(key)
    ) {
      return [];
    }
    return ['-e', `${key}=${value}`];
  });
}

function tmuxEnvWrapperPath(id: string): string {
  return path.join(os.tmpdir(), 'relay-ide', id, 'tmux-env-wrapper.sh');
}

function writeTmuxEnvWrapper(
  id: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { command: string; args: string[]; wrapperPath: string } {
  const dir = path.join(os.tmpdir(), 'relay-ide', id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wrapperPath = tmuxEnvWrapperPath(id);
  const exports = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        VALID_ENV_NAME.test(entry[0]) && entry[1] !== undefined
    )
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh
set -eu
rm -f "$0"
${exports}
exec "$@"
`,
    { encoding: 'utf-8', mode: 0o700 }
  );
  fs.chmodSync(wrapperPath, 0o700);
  return {
    command: '/bin/sh',
    args: [wrapperPath, command, ...args],
    wrapperPath,
  };
}

export function resolveTmuxWrappedSpawn(
  id: string,
  command: string,
  args: string[],
  tmuxSessionName: string,
  env: NodeJS.ProcessEnv
): { command: string; args: string[]; wrapperPath: string } {
  const wrapped = writeTmuxEnvWrapper(id, command, args, env);
  return {
    ...resolveTmuxSpawn(wrapped.command, wrapped.args, tmuxSessionName),
    wrapperPath: wrapped.wrapperPath,
  };
}

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
  useTmux?: boolean | undefined;
  tmuxSessionName?: string | undefined;
  tmuxDisplayName?: string | undefined;
  tmuxAttach?: boolean | undefined;
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
  tmuxEnv: NodeJS.ProcessEnv;
  hookToken: string;
  hooksActive: boolean;
  settingsPath: string;
  args: string[];
};

function setupPluginHooks(
  id: string,
  port: number,
  hookToken: string,
  env: Record<string, string>,
  tmuxEnv: Record<string, string>
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
    Object.assign(tmuxEnv, pluginEnv);
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
  env: Record<string, string>,
  tmuxEnv: Record<string, string>
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
    tmuxEnv.CODEX_CONFIG_DIR = codexConfigDir;
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
  tmuxEnv: Record<string, string>,
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
      tmuxEnv[varName] = String(port);
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
    fs.writeFileSync(
      shimPath,
      `#!/bin/sh\nexec node ${shellQuote(binaryPath)} "$@"\n`,
      { encoding: 'utf-8', mode: 0o755 }
    );
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
  tmuxEnv: Record<string, string>,
  params: RelaySessionEnvParams
): void {
  return injectRelaySessionEnv(env, tmuxEnv, params);
}

function injectRelaySessionEnv(
  env: Record<string, string>,
  tmuxEnv: Record<string, string>,
  params: RelaySessionEnvParams
): void {
  const { sessionId, nodeId, port, workContextId } = params;

  env.RELAY_NODE_ID = nodeId;
  env.RELAY_SESSION_ID = sessionId;
  tmuxEnv.RELAY_NODE_ID = nodeId;
  tmuxEnv.RELAY_SESSION_ID = sessionId;

  if (port !== undefined) {
    const hubUrl = `http://127.0.0.1:${port}`;
    env.RELAY_HUB_URL = hubUrl;
    tmuxEnv.RELAY_HUB_URL = hubUrl;
  }

  if (workContextId) {
    env.RELAY_WORK_CONTEXT_ID = workContextId;
    tmuxEnv.RELAY_WORK_CONTEXT_ID = workContextId;
  }

  // Write per-session relayctl shim and prepend to PATH so it is only
  // reachable from within Relay-spawned PTY sessions.
  const shimBinDir = writeRelayctlShim(sessionId);
  if (shimBinDir) {
    const currentPath = env.PATH ?? process.env.PATH ?? '';
    const currentTmuxPath = tmuxEnv.PATH ?? currentPath;
    env.PATH = `${shimBinDir}:${currentPath}`;
    tmuxEnv.PATH = `${shimBinDir}:${currentTmuxPath}`;
  }
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
  relaySessionEnvParams?: RelaySessionEnvParams
): HookSetupResult {
  const env = cleanEnv();
  const tmuxEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      ([
        'HOME',
        'PATH',
        'SHELL',
        'TMPDIR',
        'TEMP',
        'TMP',
        'TMUX_TMPDIR',
        'LANG',
        'LC_ALL',
        'USER',
        'LOGNAME',
      ].includes(key) ||
        key.startsWith('LC_'))
    ) {
      tmuxEnv[key] = value;
    }
  }

  if (framework.id === 'claude' && paramClaudeFullscreen === true) {
    env.CLAUDE_CODE_NO_FLICKER = '1';
    tmuxEnv.CLAUDE_CODE_NO_FLICKER = '1';
  }

  if (paramYolo && framework.yoloEnv) {
    Object.assign(env, framework.yoloEnv);
    Object.assign(tmuxEnv, framework.yoloEnv);
  }

  let hookToken = paramHookToken ?? '';
  let args = rawArgs;
  let pluginHooksActive = paramHooksActive ?? false;
  let codexHooksActive = false;
  let claudeHooksActive = false;
  let settingsPath = '';

  if (effectiveEventSource === 'plugin' && port !== undefined) {
    const result = setupPluginHooks(id, port, hookToken, env, tmuxEnv);
    hookToken = result.hookToken;
    pluginHooksActive = result.hooksActive;
  }

  if (framework.id === 'codex' && port !== undefined) {
    const result = setupCodexHooks(
      id,
      port,
      hookToken,
      configDir ?? process.cwd(),
      env,
      tmuxEnv
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
    injectPortEnvVars(env, tmuxEnv, portInjectionParams);
  }

  // Inject Relay-owned session identity env vars. These are set last so they
  // are never overwritten by hook or port injection above.
  if (relaySessionEnvParams) {
    injectRelaySessionEnv(env, tmuxEnv, relaySessionEnvParams);
  }

  return {
    env,
    tmuxEnv,
    hookToken,
    hooksActive: claudeHooksActive || codexHooksActive || pluginHooksActive,
    settingsPath,
    args,
  };
}

function resolveSpawnTarget(
  command: string | undefined,
  resolvedCommand: string,
  args: string[],
  _paramUseTmux: boolean | undefined,
  paramTmuxSessionName: string | undefined,
  tmuxAttach: boolean | undefined,
  tmuxDisplayName: string | undefined,
  displayName: string | undefined,
  repoName: string | undefined,
  cwd: string,
  id: string,
  env: NodeJS.ProcessEnv,
  tmuxEnv: NodeJS.ProcessEnv
): {
  spawnCommand: string;
  spawnArgs: string[];
  spawnEnv: NodeJS.ProcessEnv;
  useTmux: boolean;
  tmuxSessionName: string;
} {
  const useTmux = true;
  const tmuxSessionName =
    paramTmuxSessionName ||
    generateTmuxSessionName(
      tmuxDisplayName ||
        displayName ||
        repoName ||
        path.basename(cwd) ||
        'session',
      id
    );

  const spawnEnv = tmuxEnv;

  if (tmuxAttach) {
    return {
      spawnCommand: resolvedCommand,
      spawnArgs: args,
      spawnEnv,
      useTmux,
      tmuxSessionName,
    };
  } else {
    const tmux = resolveTmuxWrappedSpawn(
      id,
      resolvedCommand,
      args,
      tmuxSessionName,
      env
    );
    return {
      spawnCommand: tmux.command,
      spawnArgs: tmux.args,
      spawnEnv,
      useTmux,
      tmuxSessionName,
    };
  }
}

function buildSessionObject(
  params: CreatePtyParams,
  ptyProcess: pty.IPty,
  scrollback: string[],
  parser: OutputParser,
  hookToken: string,
  hooksActive: boolean,
  effectiveEventSource: EventSourceType,
  useTmux: boolean,
  tmuxSessionName: string,
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
    idle: false,
    cwd,
    customCommand:
      sessionCustomCommand !== undefined
        ? sessionCustomCommand
        : command || null,
    useTmux,
    tmuxSessionName,
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
  session.agentState = newState;
  for (const cb of stateChangeCallbacks) cb(session.id, newState);
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
    repoName,
    repoPath,
    worktreePath = null,
    cwd,
    displayName,
    command,
    args: rawArgs = [],
    cols = 80,
    rows = 24,
    configPath,
    configDir,
    useTmux: paramUseTmux,
    tmuxSessionName: paramTmuxSessionName,
    tmuxAttach,
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
  } = params;

  const maxScrollbackPerSession =
    paramMaxScrollbackBytes ?? DEFAULT_MAX_SCROLLBACK_PER_SESSION;

  const createdAt = new Date().toISOString();

  const framework = resolveAgentFramework(agent, frameworks);
  const resolvedCommand =
    command || framework.commandOverride || framework.command;

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
    rawArgs,
    portInjectionParams,
    relaySessionEnvParams
  );

  const { env, tmuxEnv, hookToken, hooksActive, settingsPath } = hookSetup;
  const args = hookSetup.args;

  const { spawnCommand, spawnArgs, spawnEnv, useTmux, tmuxSessionName } =
    resolveSpawnTarget(
      command,
      resolvedCommand,
      args,
      paramUseTmux,
      paramTmuxSessionName,
      tmuxAttach,
      params.tmuxDisplayName,
      displayName,
      repoName,
      cwd,
      id,
      env,
      tmuxEnv
    );

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: spawnEnv,
    });
  } catch (err) {
    if (!tmuxAttach) {
      try {
        fs.rmSync(tmuxEnvWrapperPath(id), { force: true });
      } catch {
        /* best effort */
      }
    }
    throw err;
  }

  const scrollback: string[] = initialScrollback ? [...initialScrollback] : [];
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
    useTmux,
    tmuxSessionName,
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
      scrollbackRef.bytes += data.length;
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
    });

    proc.onExit(() => {
      if (canRetry && Date.now() - spawnTime < 3000) {
        const retried = tryRetrySpawn(session, {
          rawArgs,
          continueArgs,
          settingsPath,
          resolvedCommand,
          useTmux,
          tmuxSessionName,
          cols,
          rows,
          cwd,
          env,
          tmuxEnv,
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
    useTmux,
    tmuxSessionName,
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
  useTmux: boolean;
  tmuxSessionName: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  tmuxEnv: NodeJS.ProcessEnv;
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

  let retryCommand = ctx.resolvedCommand;
  let retrySpawnArgs = retryArgs;
  if (ctx.useTmux && ctx.tmuxSessionName) {
    const retryTmuxName = ctx.tmuxSessionName + '-retry';
    session.tmuxSessionName = retryTmuxName;
    const tmux = resolveTmuxWrappedSpawn(
      ctx.id,
      ctx.resolvedCommand,
      retryArgs,
      retryTmuxName,
      ctx.env
    );
    retryCommand = tmux.command;
    retrySpawnArgs = tmux.args;
  }

  try {
    return pty.spawn(retryCommand, retrySpawnArgs, {
      name: 'xterm-256color',
      cols: ctx.cols,
      rows: ctx.rows,
      cwd: ctx.cwd,
      env: ctx.tmuxEnv,
    });
  } catch {
    try {
      fs.rmSync(tmuxEnvWrapperPath(ctx.id), { force: true });
    } catch {
      /* best effort */
    }
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
  if (!session.preserveRuntimeFilesOnExit) {
    const tmpDir = path.join(os.tmpdir(), 'relay-ide', id);
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}
