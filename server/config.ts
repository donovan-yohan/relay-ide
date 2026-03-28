import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentType, Config, FilterPreset, Workspace, WorkspaceSettings, WorktreeMetadata } from './types.js';

export const DEFAULT_PRESETS: FilterPreset[] = [
  { name: 'Needs Attention', builtIn: true, filters: {}, sort: { column: 'role', direction: 'asc' } },
  { name: 'All PRs', builtIn: true, filters: {}, sort: { column: 'age', direction: 'desc' } },
];

export const DEFAULTS: Omit<Config, 'pinHash' | 'rootDirs' | 'workspaceSettings' | 'repoSettings' | 'vapidPublicKey' | 'vapidPrivateKey'> = {
  host: '0.0.0.0',
  port: 3456,
  cookieTTL: '24h',
  repos: [],
  claudeCommand: 'claude',
  claudeArgs: [],
  defaultAgent: 'claude',
  defaultContinue: true,
  defaultYolo: false,
  launchInTmux: false,
  defaultNotifications: true,
};

function migrateToV4(config: Config, configPath: string): void {
  if (config.configVersion != null && config.configVersion >= 4) return;

  // Step 1: Reconcile repo arrays
  const legacyWorkspaces = config.workspaces as unknown as string[] | undefined;
  const isLegacyStringArray = Array.isArray(legacyWorkspaces) &&
    (legacyWorkspaces.length === 0 || typeof legacyWorkspaces[0] === 'string');

  if (isLegacyStringArray && legacyWorkspaces!.length > 0) {
    if (!config.repos) config.repos = [];
    const repoSet = new Set(config.repos);
    for (const w of legacyWorkspaces!) {
      if (!repoSet.has(w)) {
        config.repos.push(w);
        repoSet.add(w);
      }
    }
  }

  // Step 2: Rename workspaceSettings → repoSettings
  if (config.workspaceSettings != null && config.repoSettings == null) {
    config.repoSettings = config.workspaceSettings;
    delete config.workspaceSettings;
  }

  // Step 3: Promote workspaceGroups → workspaces (Workspace[])
  const promoted: Workspace[] = [];
  if (config.workspaceGroups != null) {
    const validPaths = new Set(config.repos ?? []);
    let order = 0;
    for (const [groupName, paths] of Object.entries(config.workspaceGroups)) {
      if (!Array.isArray(paths)) continue;
      const validRepos = paths.filter(p => validPaths.has(p));
      if (validRepos.length > 0) {
        promoted.push({
          id: crypto.randomUUID(),
          name: groupName,
          repos: validRepos,
          order: order++,
        });
      }
    }
    delete config.workspaceGroups;
  }

  // Set workspaces to promoted entities (or empty array if nothing was promoted)
  (config as any).workspaces = promoted;

  // Step 4: Set version
  config.configVersion = 4;

  // Persist migrated config
  saveConfig(configPath, config);
}

export function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Config>;
  const config: Config = { ...DEFAULTS, ...parsed };

  // Set default filter presets if not present in saved config (clone to avoid mutating the constant)
  if (config.filterPresets == null) {
    config.filterPresets = DEFAULT_PRESETS.map(p => ({ ...p, filters: { ...p.filters }, sort: { ...p.sort } }));
  }

  // Validate and clean workspaceGroups
  if (config.workspaceGroups != null) {
    // Valid paths come from repos[] and legacy workspaces[] (string array, pre-v4)
    const legacyWs = config.workspaces as unknown as string[] | undefined;
    const legacyWsPaths = Array.isArray(legacyWs) && (legacyWs.length === 0 || typeof legacyWs[0] === 'string')
      ? legacyWs
      : [];
    const validPaths = new Set([...(config.repos ?? []), ...legacyWsPaths]);
    const seenPaths = new Set<string>();
    const cleaned: Record<string, string[]> = {};

    for (const [groupName, paths] of Object.entries(config.workspaceGroups)) {
      if (!Array.isArray(paths)) {
        console.warn(`workspaceGroups: group "${groupName}" value is not an array, skipping`);
        continue;
      }
      const filteredPaths: string[] = [];
      for (const p of paths) {
        if (!validPaths.has(p)) {
          console.warn(`workspaceGroups: path "${p}" in group "${groupName}" is not in workspaces[], skipping`);
          continue;
        }
        if (seenPaths.has(p)) {
          console.warn(`workspaceGroups: path "${p}" in group "${groupName}" is already assigned to another group, skipping`);
          continue;
        }
        seenPaths.add(p);
        filteredPaths.push(p);
      }
      if (filteredPaths.length > 0) {
        cleaned[groupName] = filteredPaths;
      }
    }

    config.workspaceGroups = cleaned;
  }

  migrateToV4(config, configPath);

  return config;
}

export function saveConfig(configPath: string, config: Config): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function metaDir(configPath: string): string {
  return path.join(path.dirname(configPath), 'worktree-meta');
}

function metaFilePath(configPath: string, worktreePath: string): string {
  const hash = crypto.createHash('sha256').update(worktreePath).digest('hex').slice(0, 16);
  return path.join(metaDir(configPath), hash + '.json');
}

export function ensureMetaDir(configPath: string): void {
  const dir = metaDir(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readMeta(configPath: string, worktreePath: string): WorktreeMetadata | null {
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

export function getWorkspaceSettings(config: Config, workspacePath: string): WorkspaceSettings {
  const globalDefaults: WorkspaceSettings = {
    defaultAgent: config.defaultAgent,
    defaultContinue: config.defaultContinue,
    defaultYolo: config.defaultYolo,
    launchInTmux: config.launchInTmux,
    claudeArgs: config.claudeArgs,
  };
  const perWorkspace = config.repoSettings?.[workspacePath] ?? config.workspaceSettings?.[workspacePath] ?? {};
  // Per-workspace settings override global — only for defined keys
  return { ...globalDefaults, ...perWorkspace };
}

export interface ResolvedSessionSettings {
  agent: AgentType;
  yolo: boolean;
  continue: boolean;
  useTmux: boolean;
  claudeArgs: string[];
}

export interface SessionSettingsOverrides {
  agent?: AgentType | undefined;
  yolo?: boolean | undefined;
  continue?: boolean | undefined;
  useTmux?: boolean | undefined;
  claudeArgs?: string[] | undefined;
}

export function resolveSessionSettings(
  config: Config,
  repoPath: string,
  overrides: SessionSettingsOverrides,
): ResolvedSessionSettings {
  const ws = getWorkspaceSettings(config, repoPath);
  return {
    agent: overrides.agent ?? ws.defaultAgent ?? 'claude' as AgentType,
    yolo: overrides.yolo ?? ws.defaultYolo ?? false,
    continue: overrides.continue ?? ws.defaultContinue ?? true,
    useTmux: overrides.useTmux ?? ws.launchInTmux ?? false,
    claudeArgs: overrides.claudeArgs ?? ws.claudeArgs ?? [],
  };
}

export function deleteWorkspaceSettingKeys(
  configPath: string,
  config: Config,
  workspacePath: string,
  keys: string[],
): void {
  if (!config.workspaceSettings?.[workspacePath]) return;
  for (const key of keys) {
    delete (config.workspaceSettings[workspacePath] as Record<string, unknown>)[key];
  }
  // Clean up empty workspace entries
  if (Object.keys(config.workspaceSettings[workspacePath]!).length === 0) {
    delete config.workspaceSettings[workspacePath];
  }
  saveConfig(configPath, config);
}

export function setWorkspaceSettings(
  configPath: string,
  config: Config,
  workspacePath: string,
  settings: Partial<WorkspaceSettings>,
): void {
  if (!config.workspaceSettings) config.workspaceSettings = {};
  config.workspaceSettings[workspacePath] = {
    ...config.workspaceSettings[workspacePath],
    ...settings,
  };
  saveConfig(configPath, config);
}
