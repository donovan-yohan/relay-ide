import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AgentType,
  Config,
  ContinuePolicy,
  FilterPreset,
  TerminalBackend,
  WorkspaceSettings,
  WorktreeMetadata,
} from './types.js';
import { createLogger } from './logger.js';

export const DEFAULT_PRESETS: FilterPreset[] = [
  {
    name: 'Needs Attention',
    builtIn: true,
    filters: {},
    sort: { column: 'role', direction: 'asc' },
  },
  {
    name: 'All PRs',
    builtIn: true,
    filters: {},
    sort: { column: 'age', direction: 'desc' },
  },
];

/** Default per-session scrollback cap: 256 KB. */
export const DEFAULT_MAX_SCROLLBACK_PER_SESSION_BYTES = 256 * 1024;

/** Default global scrollback cap across all sessions: 4 MB. */
export const DEFAULT_MAX_SCROLLBACK_GLOBAL_BYTES = 4 * 1024 * 1024;

export const DEFAULTS: Omit<
  Config,
  'pinHash' | 'rootDirs' | 'repoSettings' | 'vapidPublicKey' | 'vapidPrivateKey'
> = {
  host: '0.0.0.0',
  port: 3456,
  cookieTTL: '24h',
  repos: [],
  claudeArgs: [],
  defaultFramework: 'claude',
  defaultContinue: true,
  defaultYolo: false,
  maxPtySessions: 64,
  launchInTmux: true,
  terminalBackend: 'tmux-compat',
  defaultNotifications: true,
  claudeFullscreen: true,
  updateChannel: 'stable',
  maxScrollbackPerSessionBytes: DEFAULT_MAX_SCROLLBACK_PER_SESSION_BYTES,
  maxScrollbackGlobalBytes: DEFAULT_MAX_SCROLLBACK_GLOBAL_BYTES,
};

export function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Config>;
  const config: Config = { ...DEFAULTS, ...parsed };
  config.launchInTmux = true;

  // Set default filter presets if not present in saved config (clone to avoid mutating the constant)
  if (config.filterPresets == null) {
    config.filterPresets = DEFAULT_PRESETS.map((p) => ({
      ...p,
      filters: { ...p.filters },
      sort: { ...p.sort },
    }));
  }

  return config;
}

export function saveConfig(configPath: string, config: Config): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

export function getConfigDir(configPath: string): string {
  return path.dirname(configPath);
}

function metaDir(configPath: string): string {
  return path.join(getConfigDir(configPath), 'worktree-meta');
}

function metaFilePath(configPath: string, worktreePath: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(worktreePath)
    .digest('hex')
    .slice(0, 16);
  return path.join(metaDir(configPath), hash + '.json');
}

export function ensureMetaDir(configPath: string): void {
  const dir = metaDir(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readMeta(
  configPath: string,
  worktreePath: string
): WorktreeMetadata | null {
  const fp = metaFilePath(configPath, worktreePath);
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as WorktreeMetadata;
  } catch (_) {
    return null;
  }
}

export function writeMeta(configPath: string, meta: WorktreeMetadata): void {
  const fp = metaFilePath(configPath, meta.worktreePath);
  ensureMetaDir(configPath);
  fs.writeFileSync(fp, JSON.stringify(meta, null, 2), 'utf8');
}

export function deleteMeta(configPath: string, worktreePath: string): void {
  const fp = metaFilePath(configPath, worktreePath);
  try {
    fs.unlinkSync(fp);
  } catch (_) {
    // File may not exist; ignore
  }
}

export function getRepoSettings(
  config: Config,
  repoPath: string
): WorkspaceSettings {
  const globalDefaults: WorkspaceSettings = {
    defaultFramework: config.defaultFramework,
    defaultContinue: config.defaultContinue,
    defaultYolo: config.defaultYolo,
    launchInTmux: true,
    terminalBackend: defaultTerminalBackend(config),
    claudeArgs: config.claudeArgs,
  };
  const perWorkspace = config.repoSettings?.[repoPath] ?? {};
  // Per-repo settings override global — only for defined keys
  return { ...globalDefaults, ...perWorkspace, launchInTmux: true };
}

export interface ResolvedSessionSettings {
  agent: AgentType;
  yolo: boolean;
  continuePolicy: ContinuePolicy;
  useTmux: boolean;
  terminalBackend: TerminalBackend;
  claudeArgs: string[];
  /** #614 slice 4: effective per-session scrollback cap, undefined = use pty-handler default. */
  scrollbackBytes?: number;
}

const SESSION_DURABILITY_LOG = createLogger('session-durability-config');

/**
 * Resolve the effective per-session scrollback cap for a (config, workspace,
 * repo) tuple. Precedence (most specific first):
 *   1. repo-specific `WorkspaceSettings.sessionDurability.scrollbackBytes`
 *   2. workspace-level `WorkspaceSettings.sessionDurability.scrollbackBytes`
 *   3. global `Config.sessionDurability.scrollbackBytes`
 *   4. legacy `Config.maxScrollbackPerSessionBytes`
 *   5. undefined — pty-handler applies its own 256 KB default.
 * Non-positive values are rejected with a warning and fall through.
 */
export function resolveSessionDurabilityScrollbackBytes(
  config: Config,
  repoPath: string,
  workspaceId?: string
): number | undefined {
  const repoOverride =
    config.repoSettings?.[repoPath]?.sessionDurability?.scrollbackBytes;
  const wsOverride = workspaceId
    ? config.workspaces?.find((w) => w.id === workspaceId)?.settings
        ?.sessionDurability?.scrollbackBytes
    : undefined;
  const globalOverride = config.sessionDurability?.scrollbackBytes;
  const legacyTopLevel = config.maxScrollbackPerSessionBytes;

  for (const [layer, value] of [
    ['repo', repoOverride],
    ['workspace', wsOverride],
    ['global.sessionDurability', globalOverride],
    ['legacy.maxScrollbackPerSessionBytes', legacyTopLevel],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      SESSION_DURABILITY_LOG.warn(
        'ignoring non-positive scrollbackBytes at layer %s (got %s); falling through',
        layer,
        String(value)
      );
      continue;
    }
    return value;
  }
  return undefined;
}

export interface SessionSettingsOverrides {
  agent?: AgentType | undefined;
  yolo?: boolean | undefined;
  continuePolicy?: ContinuePolicy | undefined;
  useTmux?: boolean | undefined;
  terminalBackend?: TerminalBackend | undefined;
  claudeArgs?: string[] | undefined;
}

export function normalizeTerminalBackend(
  value: unknown
): TerminalBackend | undefined {
  return value === 'relay-pty' || value === 'tmux-compat' ? value : undefined;
}

export function defaultTerminalBackend(config: Config): TerminalBackend {
  return (
    normalizeTerminalBackend(process.env.RELAY_IDE_TERMINAL_BACKEND) ??
    normalizeTerminalBackend(config.terminalBackend) ??
    'tmux-compat'
  );
}

export function resolveSessionSettings(
  config: Config,
  repoPath: string,
  overrides: SessionSettingsOverrides,
  workspaceId?: string
): ResolvedSessionSettings {
  const globalDefaults: Partial<WorkspaceSettings> = {
    defaultFramework: config.defaultFramework,
    defaultContinue: config.defaultContinue,
    defaultYolo: config.defaultYolo,
    launchInTmux: true,
    terminalBackend: defaultTerminalBackend(config),
    claudeArgs: config.claudeArgs,
  };

  let wsDefaults: Partial<WorkspaceSettings> = {};
  if (workspaceId) {
    const workspace = config.workspaces?.find((w) => w.id === workspaceId);
    if (workspace?.settings) wsDefaults = workspace.settings;
  }

  const repoSpecific = config.repoSettings?.[repoPath] ?? {};

  // Merge: repo overrides workspace overrides global
  const merged = { ...globalDefaults, ...wsDefaults, ...repoSpecific };
  const terminalBackend =
    overrides.terminalBackend ??
    (overrides.useTmux === false
      ? 'relay-pty'
      : overrides.useTmux === true
        ? 'tmux-compat'
        : undefined) ??
    normalizeTerminalBackend(process.env.RELAY_IDE_TERMINAL_BACKEND) ??
    normalizeTerminalBackend(merged.terminalBackend) ??
    'tmux-compat';

  // Map boolean defaultContinue → ContinuePolicy for backward compat
  const configPolicy: ContinuePolicy =
    merged.defaultContinuePolicy ??
    (merged.defaultContinue ? 'always' : 'never');

  // Resolve agent: prefer the most specific layer's defaultFramework
  const agentFromLayers = (() => {
    // Repo layer (most specific)
    if (repoSpecific.defaultFramework)
      return repoSpecific.defaultFramework as AgentType;
    // Workspace layer
    if (wsDefaults.defaultFramework)
      return wsDefaults.defaultFramework as AgentType;
    // Global layer
    return (globalDefaults.defaultFramework ?? 'claude') as AgentType;
  })();

  const scrollbackBytes = resolveSessionDurabilityScrollbackBytes(
    config,
    repoPath,
    workspaceId
  );

  return {
    agent: overrides.agent ?? agentFromLayers,
    yolo: overrides.yolo ?? merged.defaultYolo ?? false,
    continuePolicy: overrides.continuePolicy ?? configPolicy,
    terminalBackend,
    useTmux: terminalBackend === 'tmux-compat',
    ...(scrollbackBytes !== undefined ? { scrollbackBytes } : {}),
    claudeArgs: overrides.claudeArgs ?? merged.claudeArgs ?? [],
  };
}

export function deleteRepoSettingKeys(
  configPath: string,
  config: Config,
  repoPath: string,
  keys: string[]
): void {
  if (!config.repoSettings?.[repoPath]) return;
  for (const key of keys) {
    delete (config.repoSettings[repoPath] as Record<string, unknown>)[key];
  }
  // Clean up empty repo setting entries
  if (Object.keys(config.repoSettings[repoPath]!).length === 0) {
    delete config.repoSettings[repoPath];
  }
  saveConfig(configPath, config);
}

export function setRepoSettings(
  configPath: string,
  config: Config,
  repoPath: string,
  settings: Partial<WorkspaceSettings>
): void {
  if (!config.repoSettings) config.repoSettings = {};
  config.repoSettings[repoPath] = {
    ...config.repoSettings[repoPath],
    ...settings,
  };
  saveConfig(configPath, config);
}
