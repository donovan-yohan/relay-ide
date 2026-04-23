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

const IDLE_TIMEOUT_MS = 5000;
const MAX_SCROLLBACK = 256 * 1024; // 256KB max
const logger = createLogger('pty');

export function getTmuxPrefix(): string {
  return process.env.NO_PIN === '1' ? 'relay-dev-' : 'relay-ide-';
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
  tmuxSessionName: string
): { command: string; args: string[] } {
  return {
    command: 'tmux',
    args: [
      '-u',
      'new-session',
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
  repoPath: string;
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
  initialScrollback?: string[] | undefined;
  restored?: boolean | undefined;
  port?: number | undefined;
  forceOutputParser?: boolean | undefined;
  yolo?: boolean | undefined;
  claudeArgs?: string[] | undefined;
  hookToken?: string | undefined;
  hooksActive?: boolean | undefined;
  continuePolicy?: ContinuePolicy | undefined;
  frameworks?: Record<string, Partial<AgentFramework>> | undefined;
  claudeFullscreen?: boolean | undefined;
  /** Environment variable names to inject with allocated ports (per-worktree) */
  portVariables?: string[] | undefined;
  /** Optional port allocator instance (uses default if not provided) */
  portAllocator?: PortAllocator | undefined;
  callbacks?:
    | {
        onStateChange?: Array<(sessionId: string, state: AgentState) => void>;
        onSessionEnd?: Array<
          (sessionId: string, cwd: string, branchName?: string) => void
        >;
        fireBackendStateIfChanged?: (session: Session) => void;
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
    env.RELAY_IDE_URL = `http://127.0.0.1:${port}`;
    env.RELAY_IDE_SESSION_ID = id;
    env.RELAY_IDE_TOKEN = hookToken;
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

function buildPortInjectionParams(
  repoPath: string,
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
  portInjectionParams?: PortInjectionParams
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

  return {
    env,
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
  paramUseTmux: boolean | undefined,
  paramTmuxSessionName: string | undefined,
  tmuxDisplayName: string | undefined,
  displayName: string | undefined,
  repoName: string | undefined,
  cwd: string,
  id: string
): {
  spawnCommand: string;
  spawnArgs: string[];
  useTmux: boolean;
  tmuxSessionName: string;
} {
  const useTmux = !command && !!paramUseTmux;
  const tmuxSessionName =
    paramTmuxSessionName ||
    (useTmux
      ? generateTmuxSessionName(
          tmuxDisplayName ||
            displayName ||
            repoName ||
            path.basename(cwd) ||
            'session',
          id
        )
      : '');

  let spawnCommand = resolvedCommand;
  let spawnArgs = args;

  if (useTmux) {
    const tmux = resolveTmuxSpawn(resolvedCommand, args, tmuxSessionName);
    spawnCommand = tmux.command;
    spawnArgs = tmux.args;
  }

  return { spawnCommand, spawnArgs, useTmux, tmuxSessionName };
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
  createdAt: string
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
    restored: paramRestored,
    yolo: paramYolo,
    claudeArgs: paramClaudeArgs,
    continuePolicy,
  } = params;

  return {
    id,
    type: type || 'agent',
    agent,
    mode: 'pty' as const,
    repoPath: repoPath || '',
    worktreePath: worktreePath ?? null,
    repoName: repoName || '',
    branchName: branchName || '',
    displayName: displayName || repoName || path.basename(cwd) || '',
    pty: ptyProcess,
    createdAt,
    lastActivity: createdAt,
    scrollback,
    idle: false,
    cwd,
    customCommand: command || null,
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

function handleParserStateUpdate(
  session: PtySession,
  newState: AgentState,
  stateChangeCallbacks: Array<(sessionId: string, state: AgentState) => void>,
  fireBackendStateIfChanged: ((session: PtySession) => void) | undefined
): void {
  if (session.hooksActive) {
    if (!isParserOverrideAllowed(session, session._lastHookTime)) return;
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
};

function resolveCallbacks(
  callbacks: CreatePtyParams['callbacks']
): ResolvedPtyCallbacks {
  return {
    stateChangeCallbacks: callbacks?.onStateChange ?? [],
    sessionEndCallbacks: callbacks?.onSessionEnd ?? [],
    fireBackendStateIfChanged: callbacks?.fireBackendStateIfChanged,
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
  } = params;

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
    portInjectionParams
  );

  const { env, hookToken, hooksActive, settingsPath } = hookSetup;
  const args = hookSetup.args;

  const { spawnCommand, spawnArgs, useTmux, tmuxSessionName } =
    resolveSpawnTarget(
      command,
      resolvedCommand,
      args,
      paramUseTmux,
      paramTmuxSessionName,
      params.tmuxDisplayName,
      displayName,
      repoName,
      cwd,
      id
    );

  const ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

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
    createdAt
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
      // Trim oldest entries if over limit
      while (scrollbackRef.bytes > MAX_SCROLLBACK && scrollback.length > 1) {
        scrollbackRef.bytes -= (scrollback.shift() as string).length;
      }
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
    repoPath: session.repoPath,
    worktreePath: session.worktreePath,
    repoName: session.repoName,
    branchName: session.branchName,
    displayName: session.displayName,
    pid: ptyProcess.pid,
    createdAt,
    lastActivity: createdAt,
    idle: false,
    cwd,
    customCommand: command || null,
    useTmux,
    tmuxSessionName,
    status: 'active' as SessionStatus,
    needsBranchRename: false,
    agentState: 'initializing',
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
    const tmux = resolveTmuxSpawn(
      ctx.resolvedCommand,
      retryArgs,
      retryTmuxName
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
      env: ctx.env,
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
  const tmpDir = path.join(os.tmpdir(), 'relay-ide', id);
  fs.rm(tmpDir, { recursive: true, force: true }, () => {});
}
