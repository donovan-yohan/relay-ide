import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { getNodeManifest } from './node-manifest.js';
import {
  readLocalLogSnapshot,
  resolveLocalLogPlan,
  type LocalLogRole,
} from './local-logs.js';
import * as service from './service.js';
import type { Config, ServicePaths } from './types.js';
import type { NodeManifest } from '../shared/node-manifest.js';

export interface DiagnosticsBundleOptions {
  configPath: string;
  outputRoot?: string;
  lines?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  config?: Config;
  manifest?: NodeManifest;
  servicePaths?: ServicePaths;
  serviceStatus?: unknown;
  versionInfo?: DiagnosticsVersionInfo;
}

export interface DiagnosticsBundleResult {
  bundleDir: string;
  manifestPath: string;
  entries: DiagnosticsManifestEntry[];
}

export interface DiagnosticsManifestEntry {
  path: string;
  source: string;
  status: 'included' | 'skipped';
  redacted: boolean;
  reason?: string;
}

export interface DiagnosticsVersionInfo {
  relayVersion: string;
  source?: string;
  nodeVersion: string;
  platform: string;
  arch: string;
}

export interface DiagnosticsRedactionRule {
  id: string;
  description: string;
}

interface RedactionResult<T> {
  value: T;
  counts: Record<string, number>;
}

interface ConfigSummary {
  configPath: string;
  exists: boolean;
  loaded: boolean;
  error?: string;
  settings?: {
    host: string;
    port: number;
    updateChannel?: string;
    defaultFramework: string;
    defaultContinue: boolean;
    defaultYolo: boolean;
    maxPtySessions: number;
    repoCount: number;
    workspaceCount: number;
    repoSettingsCount: number;
    frameworkOverrideCount: number;
    githubConfigured: boolean;
    webhookConfigured: boolean;
    pinConfigured: boolean;
    vapidConfigured: boolean;
  };
}

interface NodeCredentialSummary {
  path: string;
  exists: boolean;
  loaded: boolean;
  nodeId?: string;
  tokenPresent?: boolean;
  error?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REDACTED = '[REDACTED]';
const DEFAULT_LOG_LINES = 200;
const SENSITIVE_KEY_PATTERN =
  'token|secret|password|passwd|pwd|pin|cookie|authorization|credential|private[_-]?key|privatekey|access[_-]?key|accesskey|api[_-]?key|apikey|webhook|hash';

export const DIAGNOSTICS_REDACTION_RULES: readonly DiagnosticsRedactionRule[] = [
  {
    id: 'sensitive-json-key',
    description:
      'JSON object keys matching token/secret/password/passwd/pwd/pin/cookie/authorization/credential/private-key/access-key/api-key/webhook/hash',
  },
  { id: 'private-key-block', description: 'private key PEM blocks' },
  { id: 'authorization-header', description: 'full Authorization header values' },
  { id: 'bearer-token', description: 'standalone Bearer token values' },
  { id: 'cookie-header', description: 'cookie header values' },
  { id: 'github-token', description: 'GitHub token formats' },
  { id: 'url-credential', description: 'URL embedded credentials' },
  {
    id: 'secret-assignment',
    description:
      'text assignments for sensitive key terms, including quoted values',
  },
] as const;

const SENSITIVE_KEY_RE = new RegExp(SENSITIVE_KEY_PATTERN, 'i');
const NON_SECRET_STATE_KEY_RE = /(configured|present|count|status|state)$/i;
const SECRET_ASSIGNMENT_RE = new RegExp(
  `\\b(${SENSITIVE_KEY_PATTERN})(["']?\\s*[:=]\\s*)("([^"\\r\\n]*)"|'([^'\\r\\n]*)'|[^"'\\s,}\\]\\[]+)`,
  'gi'
);
const SAFE_ENV_KEYS = [
  'CI',
  'GITHUB_ACTIONS',
  'HOME',
  'NODE_ENV',
  'NO_PIN',
  'PATH',
  'PWD',
  'RELAY_IDE_BACKGROUND',
  'RELAY_IDE_CONFIG',
  'RELAY_IDE_DEBUG_LOG',
  'RELAY_IDE_HOST',
  'RELAY_IDE_PORT',
  'SHELL',
  'TERM',
  'USER',
] as const;

export async function createDiagnosticsBundle(
  options: DiagnosticsBundleOptions
): Promise<DiagnosticsBundleResult> {
  const now = options.now ?? new Date();
  const configPath = path.resolve(options.configPath);
  const configDir = path.dirname(configPath);
  const outputRoot = path.resolve(
    options.outputRoot ?? path.join(configDir, 'diagnostics')
  );
  const bundleDir = path.join(
    outputRoot,
    `relay-diagnostics-${formatTimestampForPath(now)}`
  );
  fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });

  const entries: DiagnosticsManifestEntry[] = [];
  const redactionSummary: Record<string, number> = {};
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const lines = options.lines ?? DEFAULT_LOG_LINES;
  const servicePaths = options.servicePaths ?? service.getServicePaths();

  const recordRedactions = (counts: Record<string, number>): boolean => {
    let redacted = false;
    for (const [rule, count] of Object.entries(counts)) {
      if (count === 0) continue;
      redacted = true;
      redactionSummary[rule] = (redactionSummary[rule] ?? 0) + count;
    }
    return redacted;
  };

  const addEntry = (entry: DiagnosticsManifestEntry): void => {
    entries.push(entry);
  };

  const writeJson = (relativePath: string, source: string, value: unknown): void => {
    const redacted = redactJson(value);
    const filePath = writeBundleFile(
      bundleDir,
      relativePath,
      `${JSON.stringify(redacted.value, null, 2)}\n`
    );
    addEntry({
      path: path.relative(bundleDir, filePath),
      source,
      status: 'included',
      redacted: recordRedactions(redacted.counts),
    });
  };

  const writeText = (relativePath: string, source: string, value: string): void => {
    const redacted = redactText(value);
    const filePath = writeBundleFile(bundleDir, relativePath, redacted.value);
    addEntry({
      path: path.relative(bundleDir, filePath),
      source,
      status: 'included',
      redacted: recordRedactions(redacted.counts),
    });
  };

  writeText(
    'README.txt',
    'generated diagnostics readme',
    [
      'Relay IDE local diagnostics bundle',
      `Generated: ${now.toISOString()}`,
      '',
      'This bundle is local-only. It contains redacted config, version, environment, service, node, and recent log diagnostics.',
      'Redaction is best-effort; review before sharing outside your machine.',
      '',
    ].join('\n')
  );

  const config = options.config ?? loadConfigIfPresent(configPath);
  writeJson('config-summary.json', 'config summary', buildConfigSummary(configPath, config));
  if (config instanceof Error) {
    addEntry({
      path: 'config-redacted.json',
      source: configPath,
      status: 'skipped',
      redacted: false,
      reason: config.message,
    });
  } else if (config) {
    writeJson('config-redacted.json', configPath, config);
  } else {
    addEntry({
      path: 'config-redacted.json',
      source: configPath,
      status: 'skipped',
      redacted: false,
      reason: 'config file does not exist',
    });
  }

  writeJson(
    'version.json',
    'package and runtime version info',
    options.versionInfo ?? collectVersionInfo(cwd)
  );
  writeJson('environment.json', 'selected environment hints', buildEnvironmentHints(env, cwd));

  const manifest =
    options.manifest ??
    (await getNodeManifest(config && !(config instanceof Error) ? { config } : {}));
  writeJson('node-manifest.json', 'local node capability manifest', manifest);

  writeJson('service-status.json', 'local service status', {
    paths: servicePaths,
    status: options.serviceStatus ?? service.status(),
  });

  writeLogSnapshot('hub', lines, configPath, servicePaths, writeText, addEntry);
  writeLogSnapshot('node', lines, configPath, servicePaths, writeText, addEntry);

  writeJson(
    'node-credential-summary.json',
    'local relay-node credential metadata',
    readNodeCredentialSummary(path.join(service.CONFIG_DIR, 'node-credential.json'))
  );

  writeOptionalRedactedJsonFile({
    bundleDir,
    relativePath: 'hub-node-registry-redacted.json',
    sourcePath: path.join(configDir, 'hub-node-registry.json'),
    sourceLabel: 'hub/node pairing registry',
    addEntry,
    recordRedactions,
  });

  addEntry({
    path: 'remote-node-fan-in',
    source: 'remote paired-node diagnostics',
    status: 'skipped',
    redacted: false,
    reason: 'local diagnostics bundle only; remote node fan-in is intentionally out of scope',
  });

  entries.push({
    path: 'manifest.json',
    source: 'diagnostics bundle manifest',
    status: 'included',
    redacted: false,
  });

  const manifestPath = writeBundleFile(
    bundleDir,
    'manifest.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: now.toISOString(),
        bundleDir,
        configPath,
        redactionRules: DIAGNOSTICS_REDACTION_RULES,
        redactionSummary,
        entries,
      },
      null,
      2
    )}\n`
  );

  return { bundleDir, manifestPath, entries };
}

function writeLogSnapshot(
  role: LocalLogRole,
  lines: number,
  configPath: string,
  servicePaths: ServicePaths,
  writeText: (relativePath: string, source: string, value: string) => void,
  addEntry: (entry: DiagnosticsManifestEntry) => void
): void {
  const snapshot = readLocalLogSnapshot({
    role,
    configPath,
    serviceLogDir: servicePaths.logDir,
    lines,
  });
  if (snapshot.output) {
    writeText(`logs/${role}.log`, `${role} local log snapshot`, snapshot.output);
  } else {
    const plan = resolveLocalLogPlan(configPath, servicePaths.logDir);
    addEntry({
      path: `logs/${role}.log`,
      source: plan.files.join(', '),
      status: 'skipped',
      redacted: false,
      reason: snapshot.message,
    });
  }
}

function writeOptionalRedactedJsonFile(options: {
  bundleDir: string;
  relativePath: string;
  sourcePath: string;
  sourceLabel: string;
  addEntry: (entry: DiagnosticsManifestEntry) => void;
  recordRedactions: (counts: Record<string, number>) => boolean;
}): void {
  if (!fs.existsSync(options.sourcePath)) {
    options.addEntry({
      path: options.relativePath,
      source: options.sourcePath,
      status: 'skipped',
      redacted: false,
      reason: `${options.sourceLabel} file does not exist`,
    });
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(options.sourcePath, 'utf8')) as unknown;
    const redacted = redactJson(parsed);
    const filePath = writeBundleFile(
      options.bundleDir,
      options.relativePath,
      `${JSON.stringify(redacted.value, null, 2)}\n`
    );
    options.addEntry({
      path: path.relative(options.bundleDir, filePath),
      source: options.sourcePath,
      status: 'included',
      redacted: options.recordRedactions(redacted.counts),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.addEntry({
      path: options.relativePath,
      source: options.sourcePath,
      status: 'skipped',
      redacted: false,
      reason: message,
    });
  }
}

function loadConfigIfPresent(configPath: string): Config | Error | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    return loadConfig(configPath);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function buildConfigSummary(
  configPath: string,
  config: Config | Error | null
): ConfigSummary {
  if (config instanceof Error) {
    return {
      configPath,
      exists: fs.existsSync(configPath),
      loaded: false,
      error: config.message,
    };
  }
  if (!config) {
    return { configPath, exists: false, loaded: false };
  }
  return {
    configPath,
    exists: true,
    loaded: true,
    settings: {
      host: config.host,
      port: config.port,
      ...(config.updateChannel ? { updateChannel: config.updateChannel } : {}),
      defaultFramework: config.defaultFramework,
      defaultContinue: config.defaultContinue,
      defaultYolo: config.defaultYolo,
      maxPtySessions: config.maxPtySessions,
      repoCount: config.repos.length,
      workspaceCount: config.workspaces?.length ?? 0,
      repoSettingsCount: Object.keys(config.repoSettings ?? {}).length,
      frameworkOverrideCount: Object.keys(config.frameworks ?? {}).length,
      githubConfigured: Boolean(config.github?.accessToken || config.github?.username),
      webhookConfigured: Boolean(config.github?.webhookSecret || config.github?.smeeUrl),
      pinConfigured: Boolean(config.pinHash),
      vapidConfigured: Boolean(config.vapidPublicKey || config.vapidPrivateKey),
    },
  };
}

function buildEnvironmentHints(
  env: NodeJS.ProcessEnv,
  cwd: string
): Record<string, unknown> {
  const selected: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) selected[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('RELAY_IDE_') && value !== undefined) selected[key] = value;
  }
  return {
    cwd,
    process: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
    },
    os: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      homedir: os.homedir(),
      tmpdir: os.tmpdir(),
    },
    selectedEnv: selected,
    secretLikeEnvKeysPresent: Object.keys(env)
      .filter((key) => isSensitiveKey(key))
      .sort(),
  };
}

function readNodeCredentialSummary(credentialPath: string): NodeCredentialSummary {
  if (!fs.existsSync(credentialPath)) {
    return { path: credentialPath, exists: false, loaded: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as {
      nodeId?: unknown;
      token?: unknown;
    };
    return {
      path: credentialPath,
      exists: true,
      loaded: true,
      ...(typeof parsed.nodeId === 'string' ? { nodeId: parsed.nodeId } : {}),
      tokenPresent: typeof parsed.token === 'string' && parsed.token.length > 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path: credentialPath, exists: true, loaded: false, error: message };
  }
}

function collectVersionInfo(cwd: string): DiagnosticsVersionInfo {
  const relayVersion = readPackageVersion();
  const source = describeSourceCheckout(cwd);
  return {
    relayVersion,
    ...(source ? { source } : {}),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function describeSourceCheckout(cwd: string): string | undefined {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }
    ).trim();
    return `source ${head}${dirty ? '-dirty' : ''}`;
  } catch {
    return undefined;
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key) && !NON_SECRET_STATE_KEY_RE.test(key);
}

export function redactJson(value: unknown): RedactionResult<unknown> {
  const counts: Record<string, number> = {};
  const redacted = redactJsonValue(value, undefined, counts);
  return { value: redacted, counts };
}

function redactJsonValue(
  value: unknown,
  key: string | undefined,
  counts: Record<string, number>
): unknown {
  if (key && isSensitiveKey(key)) {
    increment(counts, 'sensitive-json-key');
    return REDACTED;
  }
  if (typeof value === 'string') {
    const redacted = redactText(value);
    mergeCounts(counts, redacted.counts);
    return redacted.value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, undefined, counts));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactJsonValue(childValue, childKey, counts);
    }
    return output;
  }
  return value;
}

export function redactText(value: string): RedactionResult<string> {
  const counts: Record<string, number> = {};
  let output = value;
  output = replaceAndCount(
    output,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    'private-key-block',
    REDACTED,
    counts
  );
  output = replaceAndCount(
    output,
    /\b(authorization\s*[:=]\s*)[^\r\n]+/gi,
    'authorization-header',
    `$1${REDACTED}`,
    counts
  );
  output = replaceAndCount(
    output,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    'bearer-token',
    `Bearer ${REDACTED}`,
    counts
  );
  output = replaceAndCount(
    output,
    /\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    'github-token',
    REDACTED,
    counts
  );
  output = replaceAndCount(
    output,
    /(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/g,
    'url-credential',
    `$1${REDACTED}:${REDACTED}@`,
    counts
  );
  output = replaceAndCount(
    output,
    /(cookie\s*[:=]\s*)([^\n\r]+)/gi,
    'cookie-header',
    `$1${REDACTED}`,
    counts
  );
  output = replaceAndCountWith(
    output,
    SECRET_ASSIGNMENT_RE,
    'secret-assignment',
    (_match, key: string, separator: string, rawValue: string) =>
      `${key}${separator}${redactAssignedValue(rawValue)}`,
    counts
  );
  return { value: output, counts };
}

function redactAssignedValue(rawValue: string): string {
  if (rawValue.startsWith('"')) return `"${REDACTED}"`;
  if (rawValue.startsWith("'")) return `'${REDACTED}'`;
  return REDACTED;
}

function replaceAndCount(
  input: string,
  pattern: RegExp,
  rule: string,
  replacement: string,
  counts: Record<string, number>
): string {
  const matches = input.match(pattern);
  if (matches?.length) increment(counts, rule, matches.length);
  return input.replace(pattern, replacement);
}

function replaceAndCountWith(
  input: string,
  pattern: RegExp,
  rule: string,
  replacement: (...args: string[]) => string,
  counts: Record<string, number>
): string {
  return input.replace(pattern, (...args: string[]) => {
    increment(counts, rule);
    return replacement(...args);
  });
}

function increment(
  counts: Record<string, number>, rule: string, amount = 1): void {
  counts[rule] = (counts[rule] ?? 0) + amount;
}

function mergeCounts(
  target: Record<string, number>, source: Record<string, number>): void {
  for (const [rule, count] of Object.entries(source)) increment(target, rule, count);
}

function writeBundleFile(bundleDir: string, relativePath: string, content: string): string {
  const resolved = path.resolve(bundleDir, relativePath);
  const root = path.resolve(bundleDir);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to write outside diagnostics bundle: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, content, { encoding: 'utf8', mode: 0o600 });
  return resolved;
}

function formatTimestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
