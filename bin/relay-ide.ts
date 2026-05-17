#!/usr/bin/env node
/* eslint-disable no-console -- CLI entry point, user-facing stdout/stderr output */
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as service from '../server/service.js';
import { DEFAULTS, loadConfig } from '../server/config.js';
import { createLogger } from '../server/logger.js';
import { getNodeManifest } from '../server/node-manifest.js';
import {
  BOOTSTRAP_DIAGNOSTICS,
  redactBootstrapSecrets,
} from '../shared/bootstrap-diagnostics.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../shared/relay-node-protocol.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import type { Config } from '../server/types.js';
import { createNodeLinkClient } from '../server/node-link-client.js';
import { createNodeLinkPtyHost } from '../server/node-link-pty-host.js';
import { createNodeLinkRpcHost } from '../server/node-link-rpc-host.js';
import { createLocalRelayNode } from '../server/local-node.js';
import { collectLocalRepoInventory } from '../server/repo-inventory.js';
import {
  createLocalLogFollower,
  parseLogLineCount,
  readLocalLogSnapshot,
  resolveLocalLogPlan,
  type LocalLogRole,
} from '../server/local-logs.js';
import { parseCliNodeLogLineCount } from '../server/node-logs.js';
import { createDiagnosticsBundle } from '../server/diagnostics-bundle.js';
import { writeNodeCredentialFile } from './node-credential-file.js';
import {
  RELAY_CLI_GATEWAY_CONTRACT,
  gatewayError,
  gatewayOk,
  type RelayCliGatewayCommand,
  type RelayCliGatewayEnvelope,
  type RelayCliGatewayErrorCode,
} from '../shared/cli-gateway-contract.js';
import {
  gatewayCliInvalidArgumentError,
  gatewayCliInvalidJsonError,
  gatewayErrorMessage,
  gatewayErrorRetryable,
  normalizeGatewayErrorCode,
  sanitizedGatewayErrorDetails,
  validateAndSanitizeGatewayCreateInput,
} from '../shared/cli-gateway-runtime.js';
import { isFileRpcOperation, type FileRpcOperation } from '../shared/file-rpc.js';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('cli');

function execErrorMessage(err: unknown, fallback: string): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || fallback).trimEnd();
}

// Parse CLI flags
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  logger.info(`Usage: relay-ide [options]
       relay-ide <command>

Commands:
  dev [--self-host]  Run backend + Vite frontend with HMR (source checkout)
  update             Update this single relay-ide package from npm
  hub                Run the Relay hub web server (same as bare relay-ide)
    install                           Install/start the hub background service
    uninstall                         Stop and remove the hub background service
    status                            Show hub service status
    logs [--lines <n>] [--follow]     Print or follow local hub log files
    node-logs <nodeId> [--lines <n>] [--follow]
                                       Print or follow logs from a paired remote node
  install            Back-compat alias for relay-ide hub install
  uninstall          Back-compat alias for relay-ide hub uninstall
  status             Back-compat alias for relay-ide hub status
  manifest           Print local node capability manifest as JSON
  v1 ... --json      Versioned CLI gateway JSON contract for nodes/sessions/files
  diag               Collect local diagnostics
    bundle [--output <dir>] [--lines <n>] [--json]
                                       Write a timestamped redacted diagnostics directory
  audit              Manage local security audit logs
    verify [--db <path>] [--json]
                                       Verify the hash-chained security audit log
  node               Manage relay-node pairing and diagnostics
    status                             Show local node/service status
    logs [--lines <n>] [--follow]      Print or follow local node log files
    doctor --hub <url>                 Check hub reachability and local node capability
    connect --hub <url> --pair-token <token>
                                       Exchange a pair token and send one heartbeat
    install --hub <url> --pair-token <token> [--service auto|manual|launchd|systemd-user|wsl-systemd|wsl-manual]
                                       Pair the node, then install/start the local Relay-managed service when requested/available
    link --hub <url>                   Open and hold the persistent /hub/node-link reverse WebSocket (foreground)
  worktree           Manage git worktrees (wraps git worktree)
    add [path] [-b branch] [--yolo]   Create worktree and launch Claude
    remove <path>                      Forward to git worktree remove
    list                               Forward to git worktree list
  browser            Open an HTML file in the remote viewer
    <path>             Path to HTML file
  pin                Manage authentication PIN
    reset              Reset the PIN (interactive, requires TTY)

Options:
  --bg               Shortcut: install and start as background service
  --port <port>      Override server port (default: 3456)
  --host <host>      Override bind address (default: 0.0.0.0)
  --config <path>    Path to config.json (default: ~/.config/relay-ide/config.json)
  --compact          With 'manifest': print compact JSON
  --debug-log        Enable SDK event debug logging to ~/.config/relay-ide/debug/
  --yolo             With 'worktree add': pass --dangerously-skip-permissions to Claude
  --version, -v      Show version
  --help, -h         Show this help`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
  ) as { version: string };
  const sourceTag = describeSourceCheckout();
  console.log(sourceTag ? `${pkg.version} (${sourceTag})` : pkg.version);
  process.exit(0);
}

function describeSourceCheckout(): string | undefined {
  // dist/bin/relay-ide.js -> repo root is two levels up
  const repoRoot = path.resolve(__dirname, '../..');
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) return undefined;
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    let dirty = '';
    try {
      const status = execFileSync(
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        }
      );
      if (status.trim()) dirty = '-dirty';
    } catch {
      /* ignore */
    }
    return `source ${head}${dirty}`;
  } catch {
    return undefined;
  }
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function resolveConfigPath(): string {
  const explicit = getArg('--config');
  if (explicit) return explicit;
  return path.join(service.CONFIG_DIR, 'config.json');
}

function runServiceCommand(fn: () => void): never {
  try {
    fn();
  } catch (e) {
    logger.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

async function runAsyncCommand(fn: () => Promise<void> | void): Promise<never> {
  try {
    await fn();
  } catch (e) {
    logger.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

const command = args[0];

function printGatewayEnvelope(
  envelope: RelayCliGatewayEnvelope,
  exitCode: number
): never {
  console.log(JSON.stringify(envelope, null, 2));
  process.exit(exitCode);
}

function gatewayInvalid(
  commandName: RelayCliGatewayCommand,
  message: string,
  details?: Record<string, unknown>
): never {
  printGatewayEnvelope(gatewayError(commandName, gatewayCliInvalidArgumentError(commandName, message, details)), 1);
}

function gatewayArg(commandArgs: string[], flag: string): string | undefined {
  const idx = commandArgs.indexOf(flag);
  if (idx === -1 || idx + 1 >= commandArgs.length) return undefined;
  const value = commandArgs[idx + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function parseGatewayJson(
  commandName: RelayCliGatewayCommand,
  raw: string
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    gatewayInvalid(commandName, 'input JSON must be an object');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printGatewayEnvelope(gatewayError(commandName, gatewayCliInvalidJsonError(commandName, message)), 1);
  }
}

function parseGatewayCreateInput(sessionArgs: string[]): Record<string, unknown> {
  const inputJson = gatewayArg(sessionArgs, '--input-json');
  if (inputJson) return parseGatewayJson('sessions.create', inputJson);
  const inputFile = gatewayArg(sessionArgs, '--input-file');
  if (inputFile) {
    try {
      return parseGatewayJson(
        'sessions.create',
        fs.readFileSync(path.resolve(inputFile), 'utf8')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gatewayInvalid('sessions.create', `could not read --input-file: ${message}`);
    }
  }

  const input: Record<string, unknown> = {};
  for (const [flag, key] of [
    ['--node-id', 'nodeId'],
    ['--repo-path', 'repoPath'],
    ['--worktree-path', 'worktreePath'],
    ['--cwd', 'cwd'],
    ['--type', 'type'],
    ['--mode', 'mode'],
    ['--agent', 'agent'],
    ['--branch-name', 'branchName'],
    ['--initial-prompt', 'initialPrompt'],
    ['--continue-policy', 'continuePolicy'],
    ['--control-mode', 'controlMode'],
    ['--confirmation-token', 'confirmationToken'],
    ['--expires-at', 'expiresAt'],
  ] as const) {
    const value = gatewayArg(sessionArgs, flag);
    if (value !== undefined) input[key] = value;
  }
  for (const [flag, key] of [
    ['--cols', 'cols'],
    ['--rows', 'rows'],
    ['--ttl-seconds', 'ttlSeconds'],
  ] as const) {
    const value = gatewayArg(sessionArgs, flag);
    if (value !== undefined) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        gatewayInvalid('sessions.create', `${flag} must be numeric`, { flag, value });
      }
      input[key] = numeric;
    }
  }
  if (sessionArgs.includes('--yolo')) input['yolo'] = true;
  const envelopeRaw = gatewayArg(sessionArgs, '--session-envelope-json');
  if (envelopeRaw) {
    input['sessionEnvelope'] = parseGatewayJson('sessions.create', envelopeRaw);
  }
  return input;
}

async function gatewayHttpJson(input: {
  commandName: RelayCliGatewayCommand;
  pathName: string;
  method?: string;
  body?: unknown;
  capabilities?: readonly string[];
}): Promise<unknown> {
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';
  if (!token) {
    printGatewayEnvelope(
      gatewayError(input.commandName, {
        code: 'UNAUTHORIZED',
        message:
          'RELAY_IDE_BROWSER_TOKEN not set. Run from an authenticated Relay session or set a scoped API token.',
        retryable: false,
      }),
      1
    );
  }

  const port = getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-relay-cli-gateway': 'v1',
  };
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  if (input.capabilities?.length) {
    headers['x-relay-capabilities'] = input.capabilities.join(',');
  }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${input.pathName}`, {
      method: input.method ?? 'GET',
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printGatewayEnvelope(
      gatewayError(input.commandName, {
        code: 'SERVER_UNAVAILABLE',
        message: `could not connect to Relay hub on port ${port}: ${message}`,
        retryable: true,
      }),
      1
    );
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const upstream =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : undefined;
    const message = gatewayErrorMessage(res.status, upstream);
    printGatewayEnvelope(
      gatewayError(input.commandName, {
        code: normalizeGatewayErrorCode(res.status, upstream),
        message,
        retryable: gatewayErrorRetryable(res.status, upstream),
        details: sanitizedGatewayErrorDetails(res.status, upstream),
      }),
      1
    );
  }
  return body;
}

function requireGatewaySessionId(
  commandName: RelayCliGatewayCommand,
  sessionArgs: string[]
): string {
  const id = gatewayArg(sessionArgs, '--id') ?? sessionArgs[0];
  if (!id || id.startsWith('--')) gatewayInvalid(commandName, '--id is required');
  return id;
}

function gatewayUsage(): never {
  logger.error(
    'Usage: relay-ide v1 (--list|schema|nodes manifest|nodes list|sessions list|sessions get|sessions create|sessions renew|sessions attach|sessions detach|sessions stream|sessions input|sessions interventions|sessions hand-back|files list|files stat|files read) --json'
  );
  process.exit(1);
}

function loadGatewayManifestConfig(): Pick<Config, 'frameworks'> | undefined {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) return undefined;
  try {
    return loadConfig(configPath);
  } catch {
    return undefined;
  }
}

async function runGatewayNodes(gatewayArgs: string[]): Promise<never> {
  const nodeSubcommand = gatewayArgs[1];
  if (nodeSubcommand === 'manifest') {
    const config = loadGatewayManifestConfig();
    const manifest = await getNodeManifest(config ? { config } : {});
    printGatewayEnvelope(gatewayOk('nodes.manifest', manifest), 0);
  }
  if (nodeSubcommand === 'list') {
    const data = await gatewayHttpJson({
      commandName: 'nodes.list',
      pathName: '/nodes',
      capabilities: ['session:read'],
    });
    printGatewayEnvelope(gatewayOk('nodes.list', data), 0);
  }
  gatewayInvalid('nodes.list', 'unknown nodes command', { args: gatewayArgs });
}

async function runGatewaySessionList(): Promise<never> {
  const sessions = await gatewayHttpJson({
    commandName: 'sessions.list',
    pathName: '/sessions',
    capabilities: ['session:read'],
  });
  printGatewayEnvelope(gatewayOk('sessions.list', { sessions }), 0);
}

async function runGatewaySessionGet(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.get', sessionArgs);
  const session = await gatewayHttpJson({
    commandName: 'sessions.get',
    pathName: `/sessions/${encodeURIComponent(id)}`,
    capabilities: ['session:read'],
  });
  printGatewayEnvelope(gatewayOk('sessions.get', session), 0);
}


interface GatewaySessionDescriptor {
  id?: string;
  nodeId?: string;
  globalSessionId?: string;
}

async function gatewaySessionDescriptor(
  id: string,
  errorCommandName: RelayCliGatewayCommand = 'sessions.get'
): Promise<GatewaySessionDescriptor> {
  const session = await gatewayHttpJson({
    commandName: errorCommandName,
    pathName: `/sessions/${encodeURIComponent(id)}`,
    capabilities: ['session:read'],
  });
  return typeof session === 'object' && session !== null
    ? (session as GatewaySessionDescriptor)
    : {};
}

const gatewayFileStringFields = [
  'nodeId',
  'sessionId',
  'id',
  'path',
  'cwd',
  'confirmationToken',
] as const;

const gatewayFileAllowedFields = new Set<string>([
  ...gatewayFileStringFields,
  'maxEntries',
  'maxBytes',
  'maxLines',
]);

function gatewayFileInputFromArgs(
  commandName: RelayCliGatewayCommand,
  fileArgs: string[]
): Record<string, unknown> {
  const inputJson = gatewayArg(fileArgs, '--input-json');
  if (inputJson) return parseGatewayJson(commandName, inputJson);
  const inputFile = gatewayArg(fileArgs, '--input-file');
  if (!inputFile) return gatewayFileInputFromFlags(fileArgs);
  try {
    return parseGatewayJson(commandName, fs.readFileSync(path.resolve(inputFile), 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gatewayInvalid(commandName, `could not read --input-file: ${message}`);
  }
}

function gatewayFileInputFromFlags(fileArgs: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const sessionId = gatewayArg(fileArgs, '--session-id') ?? gatewayArg(fileArgs, '--id') ?? fileArgs[0];
  if (sessionId && !sessionId.startsWith('--')) input['sessionId'] = sessionId;
  for (const [flag, field] of [
    ['--node-id', 'nodeId'],
    ['--path', 'path'],
    ['--cwd', 'cwd'],
    ['--confirmation-token', 'confirmationToken'],
  ] as const) {
    const value = gatewayArg(fileArgs, flag);
    if (value) input[field] = value;
  }
  return input;
}

function assertGatewayFileStringFields(
  commandName: RelayCliGatewayCommand,
  input: Record<string, unknown>
): void {
  for (const field of gatewayFileStringFields) {
    if (input[field] !== undefined && typeof input[field] !== 'string') {
      gatewayInvalid(commandName, `${field} must be a string`, { field });
    }
  }
}

function normalizeGatewayFileRequiredFields(
  commandName: RelayCliGatewayCommand,
  input: Record<string, unknown>
): void {
  if (input['sessionId'] === undefined && typeof input['id'] === 'string') {
    input['sessionId'] = input['id'];
  }
  if (typeof input['sessionId'] !== 'string' || !input['sessionId'].trim()) {
    gatewayInvalid(commandName, '--session-id is required', { field: 'sessionId' });
  }
  if (input['path'] === undefined) input['path'] = '.';
  if (typeof input['path'] !== 'string' || !input['path'].trim()) {
    gatewayInvalid(commandName, '--path must be a non-empty string', { field: 'path' });
  }
}

function gatewayBoundedNumber(
  commandName: RelayCliGatewayCommand,
  field: string,
  value: unknown,
  max: number
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    gatewayInvalid(commandName, `${field} must be a positive integer <= ${max}`, {
      field,
      value,
      max,
    });
  }
  return parsed;
}

function applyGatewayFileCaps(
  operation: FileRpcOperation,
  commandName: RelayCliGatewayCommand,
  input: Record<string, unknown>,
  fileArgs: string[]
): void {
  if (operation === 'list') {
    const value = input['maxEntries'] ?? gatewayArg(fileArgs, '--max-entries');
    if (value !== undefined) input['maxEntries'] = gatewayBoundedNumber(commandName, 'maxEntries', value, 500);
  }
  if (operation !== 'read') return;
  const caps = [
    ['maxBytes', '--max-bytes', 65536],
    ['maxLines', '--max-lines', 2000],
  ] as const;
  for (const [field, flag, max] of caps) {
    const value = input[field] ?? gatewayArg(fileArgs, flag);
    if (value !== undefined) input[field] = gatewayBoundedNumber(commandName, field, value, max);
  }
}

function assertGatewayFileAllowedFields(
  commandName: RelayCliGatewayCommand,
  operation: FileRpcOperation,
  input: Record<string, unknown>
): void {
  for (const field of Object.keys(input)) {
    if (!gatewayFileAllowedFields.has(field)) {
      gatewayInvalid(commandName, `files.${operation} field is not in the v1 contract: ${field}`, {
        field,
      });
    }
  }
}

function parseGatewayFileInput(
  operation: FileRpcOperation,
  fileArgs: string[]
): Record<string, unknown> {
  const commandName = `files.${operation}` as RelayCliGatewayCommand;
  const input = gatewayFileInputFromArgs(commandName, fileArgs);
  assertGatewayFileStringFields(commandName, input);
  normalizeGatewayFileRequiredFields(commandName, input);
  applyGatewayFileCaps(operation, commandName, input, fileArgs);
  assertGatewayFileAllowedFields(commandName, operation, input);
  return input;
}

async function runGatewaySessionCreate(sessionArgs: string[]): Promise<never> {
  const input = parseGatewayCreateInput(sessionArgs);
  const validated = validateAndSanitizeGatewayCreateInput(input);
  if (validated.ok === false) {
    printGatewayEnvelope(gatewayError('sessions.create', validated.error), 1);
  }
  const nodeId = validated.nodeId;
  const body = { ...validated.input };
  delete body['nodeId'];
  const session = await gatewayHttpJson({
    commandName: 'sessions.create',
    pathName: nodeId
      ? `/hub/nodes/${encodeURIComponent(nodeId)}/sessions`
      : '/sessions',
    method: 'POST',
    body,
    capabilities: [
      validated.sessionType === 'terminal'
        ? 'session:create:terminal'
        : 'session:create:agent',
      ...(validated.input['controlMode'] === 'agent-driven' ? ['tab:mode:set-agent'] : []),
    ],
  });
  printGatewayEnvelope(gatewayOk('sessions.create', session), 0);
}

async function runGatewaySessionAttach(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.attach', sessionArgs);
  const session = await gatewayHttpJson({
    commandName: 'sessions.attach',
    pathName: `/sessions/${encodeURIComponent(id)}`,
    capabilities: ['session:read', 'session:attach'],
  });
  printGatewayEnvelope(
    gatewayOk('sessions.attach', {
      session,
      attach: {
        streaming: false,
        mode: 'descriptor',
        message:
          'resolved session descriptor only; v1 attach does not start an adapter runtime or PTY stream',
      },
    }),
    0
  );
}

async function runGatewaySessionDetach(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.detach', sessionArgs);
  const session = await gatewayHttpJson({
    commandName: 'sessions.detach',
    pathName: `/sessions/${encodeURIComponent(id)}`,
    capabilities: ['session:read', 'session:attach'],
  });
  printGatewayEnvelope(
    gatewayOk('sessions.detach', {
      detached: true,
      killed: false,
      session,
      message:
        'detached CLI gateway handle only; underlying Relay session/process was left running',
    }),
    0
  );
}

interface GatewayPtyTarget {
  requestedId: string;
  sessionId: string;
  nodeId?: string;
  globalSessionId?: string;
  wsPath: string;
}

function gatewayOptionalPositiveInt(
  commandName: RelayCliGatewayCommand,
  sessionArgs: string[],
  flag: string,
  max: number
): number | undefined {
  const raw = gatewayArg(sessionArgs, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    gatewayInvalid(commandName, `${flag} must be a positive integer <= ${max}`, {
      flag,
      value: raw,
      max,
    });
  }
  return parsed;
}

function gatewayRequiredToken(commandName: RelayCliGatewayCommand): string {
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';
  if (!token) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'UNAUTHORIZED',
        message:
          'RELAY_IDE_BROWSER_TOKEN not set. Run from an authenticated Relay session or set a scoped API token.',
        retryable: false,
      }),
      1
    );
  }
  return token;
}

function gatewayWsPort(): string {
  return getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);
}

async function resolveGatewayPtyTarget(
  id: string,
  commandName: RelayCliGatewayCommand
): Promise<GatewayPtyTarget> {
  const session = await gatewaySessionDescriptor(id, commandName);
  const sessionId = session.id ?? id;
  const nodeId = session.nodeId;
  const globalSessionId = session.globalSessionId;
  const wsPath = nodeId
    ? `/nodes/${encodeURIComponent(nodeId)}/ws/sessions/${encodeURIComponent(sessionId)}`
    : `/ws/${encodeURIComponent(sessionId)}`;
  return {
    requestedId: id,
    sessionId,
    ...(nodeId ? { nodeId } : {}),
    ...(globalSessionId ? { globalSessionId } : {}),
    wsPath,
  };
}

function gatewayWsErrorCode(message: string): RelayCliGatewayErrorCode {
  if (message.includes('Unexpected server response: 401')) return 'UNAUTHORIZED';
  if (message.includes('Unexpected server response: 403')) return 'FORBIDDEN';
  if (message.includes('Unexpected server response: 404')) return 'NODE_OFFLINE';
  if (message.includes('ECONNREFUSED') || message.includes('connect')) return 'SERVER_UNAVAILABLE';
  return 'UPSTREAM_ERROR';
}

interface GatewayPtyWebSocketHandle {
  ws: WebSocket;
  opened: Promise<WebSocket>;
}

function gatewayCreatePtyWebSocket(
  commandName: RelayCliGatewayCommand,
  target: GatewayPtyTarget
): GatewayPtyWebSocketHandle {
  const token = gatewayRequiredToken(commandName);
  const port = gatewayWsPort();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${target.wsPath}`, {
    headers: {
      Cookie: `token=${encodeURIComponent(token)}`,
      'x-relay-cli-gateway': 'v1',
    },
  });
  const opened = new Promise<WebSocket>((resolve) => {
    let isOpen = false;
    ws.once('open', () => {
      isOpen = true;
      resolve(ws);
    });
    ws.once('error', (error) => {
      if (isOpen) return;
      const message = error instanceof Error ? error.message : String(error);
      printGatewayEnvelope(
        gatewayError(commandName, {
          code: gatewayWsErrorCode(message),
          message: `could not attach PTY stream: ${message}`,
          retryable: true,
          details: {
            sessionId: target.sessionId,
            ...(target.nodeId ? { nodeId: target.nodeId } : {}),
          },
        }),
        1
      );
    });
  });
  return { ws, opened };
}

function gatewayTargetPayload(target: GatewayPtyTarget): Record<string, unknown> {
  return {
    sessionId: target.sessionId,
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.globalSessionId ? { globalSessionId: target.globalSessionId } : {}),
  };
}

function writeGatewayNdjson(envelope: RelayCliGatewayEnvelope): boolean {
  return process.stdout.write(`${JSON.stringify(envelope)}
`);
}

async function runGatewaySessionStream(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.stream', sessionArgs);
  const mode = gatewayArg(sessionArgs, '--mode') ?? 'ndjson';
  if (mode !== 'ndjson') {
    gatewayInvalid('sessions.stream', '--mode must be ndjson', { field: 'mode', value: mode });
  }
  const maxEvents = gatewayOptionalPositiveInt('sessions.stream', sessionArgs, '--max-events', 10000);
  const maxBytes = gatewayOptionalPositiveInt('sessions.stream', sessionArgs, '--max-bytes', 1048576);
  const idleTimeoutMs = gatewayOptionalPositiveInt(
    'sessions.stream',
    sessionArgs,
    '--idle-timeout-ms',
    300000
  );
  const target = await resolveGatewayPtyTarget(id, 'sessions.stream');
  const { ws, opened } = gatewayCreatePtyWebSocket('sessions.stream', target);
  let sequence = 0;
  let frames = 0;
  let bytesReceived = 0;
  let truncated = false;
  let backpressureClosed = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const refreshIdleTimer = (): void => {
    if (!idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(1000, 'idle timeout'), idleTimeoutMs);
    idleTimer.unref?.();
  };
  refreshIdleTimer();

  ws.on('message', (data) => {
    refreshIdleTimer();
    let text = data.toString('utf8');
    const rawBytes = Buffer.byteLength(text, 'utf8');
    if (maxBytes !== undefined && bytesReceived + rawBytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - bytesReceived);
      text = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
      truncated = true;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    bytesReceived += bytes;
    if (bytes > 0) {
      frames += 1;
      const ok = writeGatewayNdjson(
        gatewayOk('sessions.stream', {
          event: 'data',
          ...gatewayTargetPayload(target),
          encoding: 'utf8',
          data: text,
          bytes,
          sequence: sequence++,
        })
      );
      if (!ok) {
        backpressureClosed = true;
        ws.close(1013, 'stdout backpressure');
        return;
      }
    }
    if (truncated || (maxEvents !== undefined && frames >= maxEvents)) {
      ws.close(1000, truncated ? 'maxBytes reached' : 'maxEvents reached');
    }
  });

  ws.once('close', (code, reason) => {
    if (idleTimer) clearTimeout(idleTimer);
    writeGatewayNdjson(
      gatewayOk('sessions.stream', {
        event: 'closed',
        ...gatewayTargetPayload(target),
        closeCode: code,
        reason: reason.toString('utf8'),
        frames,
        bytesReceived,
        truncated,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        backpressureClosed,
      })
    );
    process.exit(0);
  });
  ws.once('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeGatewayNdjson(
      gatewayError('sessions.stream', {
        code: gatewayWsErrorCode(message),
        message: `PTY stream error: ${message}`,
        retryable: true,
        details: gatewayTargetPayload(target),
      })
    );
  });
  await opened;
  await new Promise(() => {});
  process.exit(0);
}

function gatewayInputData(sessionArgs: string[]): string {
  const data = gatewayArg(sessionArgs, '--data');
  const dataBase64 = gatewayArg(sessionArgs, '--data-base64');
  const stdin = sessionArgs.includes('--stdin');
  const sourceCount = [data !== undefined, dataBase64 !== undefined, stdin].filter(Boolean).length;
  if (sourceCount !== 1) {
    gatewayInvalid('sessions.input', 'exactly one of --data, --data-base64, or --stdin is required');
  }
  if (data !== undefined) return data;
  if (dataBase64 !== undefined) return Buffer.from(dataBase64, 'base64').toString('utf8');
  return fs.readFileSync(0, 'utf8');
}

async function runGatewaySessionInput(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.input', sessionArgs);
  const input = gatewayInputData(sessionArgs);
  const waitFor = gatewayArg(sessionArgs, '--wait-for');
  const timeoutMs =
    gatewayOptionalPositiveInt('sessions.input', sessionArgs, '--timeout-ms', 300000) ?? 5000;
  const maxBytes =
    gatewayOptionalPositiveInt('sessions.input', sessionArgs, '--max-bytes', 1048576) ?? 65536;
  const target = await resolveGatewayPtyTarget(id, 'sessions.input');
  const { ws, opened } = gatewayCreatePtyWebSocket('sessions.input', target);
  const bytesSent = Buffer.byteLength(input, 'utf8');
  let output = '';
  let bytesReceived = 0;
  let truncated = false;
  let settled = false;

  const finish = (matched: boolean): void => {
    if (settled) return;
    settled = true;
    try {
      ws.close(1000, 'sessions.input complete');
    } catch {
      /* already closing */
    }
    printGatewayEnvelope(
      gatewayOk('sessions.input', {
        sent: true,
        ...gatewayTargetPayload(target),
        bytesSent,
        output,
        matched,
        ...(waitFor !== undefined ? { waitFor } : {}),
        bytesReceived,
        truncated,
        maxBytes,
      }),
      0
    );
  };

  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    try {
      ws.close(1011, message);
    } catch {
      /* already closing */
    }
    printGatewayEnvelope(
      gatewayError('sessions.input', {
        code: 'UPSTREAM_ERROR',
        message,
        retryable: true,
        details: {
          ...gatewayTargetPayload(target),
          ...(waitFor !== undefined ? { waitFor } : {}),
          bytesReceived,
          truncated,
        },
      }),
      1
    );
  };

  const timer = waitFor
    ? setTimeout(() => fail(`timed out waiting for PTY output: ${waitFor}`), timeoutMs)
    : undefined;
  timer?.unref?.();

  ws.on('message', (data) => {
    if (settled) return;
    const text = data.toString('utf8');
    const nextBytes = Buffer.byteLength(text, 'utf8');
    if (bytesReceived + nextBytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - bytesReceived);
      output += Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
      bytesReceived = maxBytes;
      truncated = true;
      fail(`PTY output exceeded maxBytes before waitFor matched`);
      return;
    }
    output += text;
    bytesReceived += nextBytes;
    if (waitFor && output.includes(waitFor)) finish(true);
  });
  ws.once('close', () => {
    if (settled) return;
    if (waitFor) fail(`PTY stream closed before waitFor matched: ${waitFor}`);
    else finish(false);
  });
  ws.once('error', (error) => {
    if (settled) return;
    const message = error instanceof Error ? error.message : String(error);
    fail(`PTY input stream error: ${message}`);
  });

  await opened;
  ws.send(input, (error) => {
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`could not send PTY input: ${message}`);
      return;
    }
    if (!waitFor) setTimeout(() => finish(false), 10).unref?.();
  });
  await new Promise(() => {});
  process.exit(0);
}

async function runGatewaySessionRenew(sessionArgs: string[]): Promise<never> {
  const requestedId = requireGatewaySessionId('sessions.renew', sessionArgs);
  const input: Record<string, unknown> = {};
  const nodeIdArg = gatewayArg(sessionArgs, '--node-id');
  if (nodeIdArg) input['nodeId'] = nodeIdArg;
  const expiresAt = gatewayArg(sessionArgs, '--expires-at');
  if (expiresAt) input['expiresAt'] = expiresAt;
  const ttlSeconds = gatewayArg(sessionArgs, '--ttl-seconds');
  if (ttlSeconds !== undefined) {
    const numeric = Number(ttlSeconds);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      gatewayInvalid('sessions.renew', '--ttl-seconds must be a positive number', {
        field: 'ttlSeconds',
        value: ttlSeconds,
      });
    }
    input['ttlSeconds'] = numeric;
  }
  if (input['expiresAt'] === undefined && input['ttlSeconds'] === undefined) {
    gatewayInvalid('sessions.renew', '--ttl-seconds or --expires-at is required');
  }

  let sessionId = requestedId;
  if (!input['nodeId']) {
    const session = await gatewaySessionDescriptor(requestedId, 'sessions.renew');
    if (typeof session.nodeId === 'string') input['nodeId'] = session.nodeId;
    sessionId = session.id ?? requestedId;
  }

  const result = await gatewayHttpJson({
    commandName: 'sessions.renew',
    pathName: `/hub/scoped-sessions/${encodeURIComponent(sessionId)}/renew`,
    method: 'POST',
    body: input,
    capabilities: ['session:attach'],
  });
  printGatewayEnvelope(gatewayOk('sessions.renew', result), 0);
}

async function runGatewaySessionInterventions(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.interventions', sessionArgs);
  const limit = gatewayArg(sessionArgs, '--limit');
  const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  const data = await gatewayHttpJson({
    commandName: 'sessions.interventions',
    pathName: `/sessions/${encodeURIComponent(id)}/interventions${query}`,
    capabilities: ['session:read', 'tab:intervention:read'],
  });
  printGatewayEnvelope(gatewayOk('sessions.interventions', data), 0);
}

async function runGatewaySessionHandBack(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.handBack', sessionArgs);
  const latestSeenInterventionEventId = gatewayArg(
    sessionArgs,
    '--latest-seen-intervention-event-id'
  );
  if (!latestSeenInterventionEventId) {
    gatewayInvalid(
      'sessions.handBack',
      '--latest-seen-intervention-event-id is required'
    );
  }
  const data = await gatewayHttpJson({
    commandName: 'sessions.handBack',
    pathName: `/sessions/${encodeURIComponent(id)}/control/hand-back`,
    method: 'POST',
    body: { latestSeenInterventionEventId },
    capabilities: ['session:attach', 'tab:mode:set-agent'],
  });
  printGatewayEnvelope(gatewayOk('sessions.handBack', data), 0);
}

async function runGatewaySessions(gatewayArgs: string[]): Promise<never> {
  const sessionSubcommand = gatewayArgs[1];
  const sessionArgs = gatewayArgs.slice(2);
  if (sessionSubcommand === 'list') return runGatewaySessionList();
  if (sessionSubcommand === 'get') return runGatewaySessionGet(sessionArgs);
  if (sessionSubcommand === 'create') return runGatewaySessionCreate(sessionArgs);
  if (sessionSubcommand === 'renew') return runGatewaySessionRenew(sessionArgs);
  if (sessionSubcommand === 'attach') return runGatewaySessionAttach(sessionArgs);
  if (sessionSubcommand === 'detach') return runGatewaySessionDetach(sessionArgs);
  if (sessionSubcommand === 'stream') return runGatewaySessionStream(sessionArgs);
  if (sessionSubcommand === 'input') return runGatewaySessionInput(sessionArgs);
  if (sessionSubcommand === 'interventions') {
    return runGatewaySessionInterventions(sessionArgs);
  }
  if (sessionSubcommand === 'hand-back') {
    return runGatewaySessionHandBack(sessionArgs);
  }
  gatewayInvalid('sessions.list', 'unknown sessions command', { args: gatewayArgs });
}


async function runGatewayFiles(gatewayArgs: string[]): Promise<never> {
  const operation = gatewayArgs[1];
  if (!isFileRpcOperation(operation)) {
    gatewayInvalid('files.list', 'unknown files command', { args: gatewayArgs });
  }
  const commandName = `files.${operation}` as RelayCliGatewayCommand;
  const input = parseGatewayFileInput(operation, gatewayArgs.slice(2));
  const requestedSessionId = input['sessionId'] as string;
  let nodeId = typeof input['nodeId'] === 'string' ? input['nodeId'] : undefined;
  let sessionId = requestedSessionId;
  if (!nodeId) {
    const session = await gatewaySessionDescriptor(requestedSessionId, commandName);
    nodeId = session.nodeId;
    sessionId = session.id ?? requestedSessionId;
  }
  if (!nodeId) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'UNSUPPORTED',
        message:
          'files commands require a routed session with nodeId; pass --node-id or use a session descriptor that includes nodeId',
        retryable: false,
        details: { field: 'nodeId', sessionId: requestedSessionId },
      }),
      1
    );
  }
  const body: Record<string, unknown> = {};
  for (const field of ['path', 'cwd', 'maxEntries', 'maxBytes', 'maxLines', 'confirmationToken']) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  const result = await gatewayHttpJson({
    commandName,
    pathName: `/hub/nodes/${encodeURIComponent(nodeId)}/sessions/${encodeURIComponent(
      sessionId
    )}/files/${operation}`,
    method: 'POST',
    body,
    capabilities: ['session:read', operation === 'list' ? 'rpc:fs:list' : 'rpc:fs:read'],
  });
  printGatewayEnvelope(gatewayOk(commandName, result), 0);
}

async function runGatewayV1(): Promise<never> {
  const gatewayArgs = args.slice(1);
  const json = gatewayArgs.includes('--json');
  const top = gatewayArgs[0];

  if ((top === '--list' || top === 'list') && json) {
    printGatewayEnvelope(
      gatewayOk('contract.list', {
        commands: RELAY_CLI_GATEWAY_CONTRACT.commandSchemas,
        errorEnvelopeSchema: RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema,
      }),
      0
    );
  }
  if (top === 'schema' && json) {
    printGatewayEnvelope(gatewayOk('contract.schema', RELAY_CLI_GATEWAY_CONTRACT), 0);
  }
  if (!json) gatewayUsage();
  if (top === 'nodes') return runGatewayNodes(gatewayArgs);
  if (top === 'sessions') return runGatewaySessions(gatewayArgs);
  if (top === 'files') return runGatewayFiles(gatewayArgs);
  gatewayInvalid('contract.list', 'unknown v1 gateway command', { args: gatewayArgs });
}

if (command === 'v1') {
  await runGatewayV1();
}

if (command === 'dev') {
  await import('../scripts/dev.js');
  await new Promise(() => {});
}

if (command === 'update') {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
    ) as { version: string };
    logger.info(`Current version: ${pkg.version}`);
    const configPath = resolveConfigPath();
    let channel = 'stable';
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        updateChannel?: string;
      };
      if (
        config.updateChannel === 'nightly' ||
        config.updateChannel === 'stable'
      ) {
        channel = config.updateChannel;
      }
    }
    const tag = channel === 'nightly' ? 'nightly' : 'latest';
    logger.info(`Updating relay-ide from ${channel} channel...`);
    await execFileAsync('npm', ['install', '-g', `relay-ide@${tag}`]);
    const updatedPkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
    ) as { version: string };
    if (updatedPkg.version === pkg.version) {
      logger.info(`Already on the latest version (${pkg.version}).`);
    } else {
      logger.info(`Updated to ${updatedPkg.version}.`);
      if (service.isInstalled()) {
        logger.info('Background service detected — restarting...');
        service.uninstall();
        service.install({
          configPath: resolveConfigPath(),
          port: getArg('--port') ?? String(DEFAULTS.port),
          host: getArg('--host') ?? DEFAULTS.host,
        });
        logger.info('Service restarted.');
      }
    }
  } catch (e) {
    logger.error(`Update failed: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'manifest') {
  const configPath = resolveConfigPath();
  let config: Pick<Config, 'frameworks'> | undefined;
  if (fs.existsSync(configPath)) {
    try {
      config = loadConfig(configPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[cli] Warning: could not load config for framework probes: ${message}\n`
      );
    }
  }

  const manifest = await getNodeManifest(config ? { config } : {});
  console.log(
    JSON.stringify(manifest, null, args.includes('--compact') ? 0 : 2)
  );
  process.exit(0);
}

if (command === 'diag') {
  const diagArgs = args.slice(1);
  const subCommand = diagArgs[0];
  if (subCommand !== 'bundle') {
    logger.error(
      'Usage: relay-ide diag bundle [--output <dir>] [--lines <n>] [--json] [--config <path>]'
    );
    process.exit(1);
  }
  const outputRoot = getArg('--output');
  const result = await createDiagnosticsBundle({
    configPath: resolveConfigPath(),
    ...(outputRoot ? { outputRoot } : {}),
    lines: parseLogLineCount(getArg('--lines'), 200),
  });
  if (diagArgs.includes('--json')) {
    console.log(
      JSON.stringify(
        { bundleDir: result.bundleDir, manifestPath: result.manifestPath },
        null,
        2
      )
    );
  } else {
    logger.info(`Diagnostics bundle written to ${result.bundleDir}`);
    logger.info(`Manifest: ${result.manifestPath}`);
  }
  process.exit(0);
}

if (command === 'audit') {
  const auditArgs = args.slice(1);
  const subCommand = auditArgs[0];
  if (subCommand !== 'verify') {
    logger.error('Usage: relay-ide audit verify [--db <path>] [--json]');
    process.exit(1);
  }
  const jsonOutput = auditArgs.includes('--json');
  let explicitDbPath = false;
  let dbPath = path.join(
    path.dirname(resolveConfigPath()),
    'security-audit.db'
  );
  for (let idx = 1; idx < auditArgs.length; idx += 1) {
    const auditArg = auditArgs[idx];
    if (auditArg === '--json') continue;
    if (auditArg === '--db') {
      const candidate = auditArgs[idx + 1];
      if (!candidate || candidate.startsWith('--')) {
        logger.error('Usage: relay-ide audit verify [--db <path>] [--json]');
        process.exit(1);
      }
      explicitDbPath = true;
      dbPath = path.resolve(candidate);
      idx += 1;
      continue;
    }
    logger.error(`Unknown audit verify option: ${auditArg}`);
    logger.error('Usage: relay-ide audit verify [--db <path>] [--json]');
    process.exit(1);
  }
  if (explicitDbPath && !fs.existsSync(dbPath)) {
    const result = {
      ok: false,
      entriesVerified: 0,
      lastHash: null,
      break: {
        sequence: 0,
        reason: 'storage_corrupt',
        actual: 'database file does not exist',
      },
    };
    if (jsonOutput) {
      console.log(JSON.stringify({ dbPath, ...result }, null, 2));
    } else {
      logger.error(
        `Security audit log FAILED at ${dbPath}: explicit --db path does not exist`
      );
    }
    process.exit(1);
  }
  const { verifySecurityAuditLog } = await import(
    '../server/security-audit-log.js'
  );
  const result = verifySecurityAuditLog(dbPath);
  if (jsonOutput) {
    console.log(JSON.stringify({ dbPath, ...result }, null, 2));
  } else if (result.ok) {
    logger.info(
      `Security audit log OK: ${result.entriesVerified} entries verified at ${dbPath}`
    );
  } else {
    logger.error(
      `Security audit log FAILED at ${dbPath}: ${JSON.stringify(result.break)}`
    );
  }
  process.exit(result.ok ? 0 : 1);
}

function getNodeArg(nodeArgs: string[], flag: string): string | undefined {
  const idx = nodeArgs.indexOf(flag);
  if (idx === -1 || idx + 1 >= nodeArgs.length) return undefined;
  return nodeArgs[idx + 1];
}

async function printLocalLogs(
  role: LocalLogRole,
  commandArgs: string[]
): Promise<void> {
  const lines = parseLogLineCount(getNodeArg(commandArgs, '--lines'));
  const follow = commandArgs.includes('--follow') || commandArgs.includes('-f');
  const configPath = resolveConfigPath();
  const serviceLogDir = service.getServicePaths().logDir;
  const snapshot = readLocalLogSnapshot({
    role,
    configPath,
    serviceLogDir,
    lines,
  });

  if (snapshot.output) {
    process.stdout.write(snapshot.output);
  } else {
    logger.info(snapshot.message);
  }

  if (!follow) return;

  const plan = resolveLocalLogPlan(configPath, serviceLogDir);
  logger.info(
    snapshot.status === 'missing'
      ? 'Waiting for local Relay log files; press Ctrl-C to stop.'
      : 'Following local Relay log files; press Ctrl-C to stop.'
  );
  const follower = createLocalLogFollower({
    files: plan.files,
    write: (chunk) => process.stdout.write(chunk),
    onError: (error) => logger.error(`Log follow error: ${error.message}`),
  });

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      follower.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function printHubStatus(): void {
  const st = service.status();
  logger.info(`Hub service manager: ${st.manager.label} (${st.manager.kind})`);
  logger.info(st.manager.message);
  if (!st.installed) {
    logger.info('Hub service is not installed.');
  } else if (st.running) {
    logger.info('Hub service is installed and running.');
  } else {
    logger.info('Hub service is installed but not running.');
  }
  if (st.manager.statusCommand) {
    logger.info(`Status command: ${st.manager.statusCommand}`);
  }
  logger.info(st.installed ? st.manager.uninstallHint : st.manager.installHint);
  for (const caveat of st.manager.caveats) logger.info(caveat);
}

async function printHubLogs(commandArgs: string[]): Promise<void> {
  await printLocalLogs('hub', commandArgs);
}

async function printRemoteNodeLogs(commandArgs: string[]): Promise<void> {
  const nodeId = commandArgs[0];
  if (!nodeId || nodeId.startsWith('-')) {
    logger.error('Usage: relay-ide hub node-logs <nodeId> [--lines <n>] [--follow]');
    process.exit(1);
  }
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';
  if (!token) {
    logger.error(
      'RELAY_IDE_BROWSER_TOKEN not set. Run from an authenticated Relay session or set a scoped API token.'
    );
    process.exit(1);
  }
  let lines: number;
  try {
    lines = parseCliNodeLogLineCount(getNodeArg(commandArgs, '--lines'));
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const follow = commandArgs.includes('--follow') || commandArgs.includes('-f');
  const port = getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);
  const url = new URL(
    `/hub/nodes/${encodeURIComponent(nodeId)}/logs`,
    `http://127.0.0.1:${port}`
  );
  url.searchParams.set('lines', String(lines));
  if (follow) url.searchParams.set('follow', '1');
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-relay-cli-gateway': 'v1',
        'x-relay-capabilities': 'session:read',
      },
    });
  } catch (error) {
    logger.error(
      `could not connect to Relay hub on port ${port}: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
  if (!res.ok) {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const message = gatewayErrorMessage(res.status, body);
      logger.error(message);
    } catch {
      logger.error(text || `HTTP ${res.status}`);
    }
    process.exit(1);
  }
  if (!follow) {
    const body = (await res.json()) as Record<string, unknown>;
    const log = typeof body['log'] === 'object' && body['log'] !== null ? (body['log'] as Record<string, unknown>) : {};
    const output = log['output'];
    const message = log['message'];
    if (typeof output === 'string' && output) process.stdout.write(output);
    else if (typeof message === 'string') logger.info(message);
    return;
  }
  logger.info(`Following remote Relay node logs for ${nodeId}; press Ctrl-C to stop.`);
  const reader = res.body?.getReader();
  if (!reader) {
    logger.error('Remote log stream is unavailable.');
    process.exit(1);
  }
  const decoder = new TextDecoder();
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void reader.cancel().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) process.stdout.write(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        logger.error(
          `Log stream error: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        const tail = decoder.decode();
        if (tail) process.stdout.write(tail);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      }
    };
    void pump();
  });
}

async function printNodeStatus(): Promise<void> {
  const manifest = await getNodeManifest();
  const st = service.status();
  logger.info(
    `Node host: ${manifest.hostname} (${manifest.platform}/${manifest.arch})`
  );
  logger.info(`Relay version: ${manifest.relayVersion}`);
  logger.info(
    `Service manager: ${manifest.serviceManager.label} (${manifest.serviceManager.kind})`
  );
  logger.info(manifest.serviceManager.message);
  logger.info(`Local service installed: ${st.installed ? 'yes' : 'no'}`);
  logger.info(`Local service running: ${st.running ? 'yes' : 'no'}`);
  for (const caveat of manifest.serviceManager.caveats) logger.info(caveat);
}

async function printNodeLogs(commandArgs: string[]): Promise<void> {
  await printLocalLogs('node', commandArgs);
}

async function runNodeDoctor(hubUrl: string | undefined): Promise<void> {
  const manifest = await getNodeManifest();
  logger.info(
    `Local manifest: ${manifest.hostname} ${manifest.platform}/${manifest.arch}`
  );
  logger.info(`Service manager: ${manifest.serviceManager.kind}`);
  if (!manifest.serviceManager.supported) {
    const diagnostic = BOOTSTRAP_DIAGNOSTICS.find(
      (entry) => entry.code === 'SERVICE_MANAGER_UNSUPPORTED'
    );
    logger.info(`${diagnostic?.code}: ${diagnostic?.meaning}`);
    logger.info(manifest.serviceManager.installHint);
  }
  if (!hubUrl) {
    logger.info('No --hub supplied; skipping hub reachability check.');
    return;
  }
  try {
    const res = await fetch(new URL('/version', hubUrl));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logger.info(`Hub reachable: ${hubUrl}`);
  } catch (error) {
    const diagnostic = BOOTSTRAP_DIAGNOSTICS.find(
      (entry) => entry.code === 'NODE_CONNECT_FAILED'
    );
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      redactBootstrapSecrets(
        `${diagnostic?.code}: ${diagnostic?.meaning} (${message})`
      )
    );
    process.exit(1);
  }
}

function nodeEndpoint(hubUrl: string, pathname: string): string {
  return new URL(pathname, hubUrl).toString();
}

type RequestedNodeServiceMode =
  | 'auto'
  | 'manual'
  | 'launchd'
  | 'systemd-user'
  | 'wsl-systemd'
  | 'wsl-manual';
const requestedNodeServiceModes: RequestedNodeServiceMode[] = [
  'auto',
  'manual',
  'launchd',
  'systemd-user',
  'wsl-systemd',
  'wsl-manual',
];

function parseNodeServiceMode(value: string): RequestedNodeServiceMode {
  if (requestedNodeServiceModes.includes(value as RequestedNodeServiceMode))
    return value as RequestedNodeServiceMode;
  logger.error(
    `Invalid --service ${value}. Expected one of: ${requestedNodeServiceModes.join(', ')}`
  );
  process.exit(1);
}

function validateNodeServiceMode(
  manifest: NodeManifest,
  mode: RequestedNodeServiceMode
): void {
  if (mode === 'auto' || mode === 'manual') return;
  if (mode === 'wsl-manual') {
    if (manifest.wsl.detected && manifest.wsl.version === 2) return;
    logger.error(
      'SERVICE_MANAGER_UNSUPPORTED: --service wsl-manual requires running relay-ide inside a WSL2 distro. Native Windows relay-node is unsupported.'
    );
    process.exit(1);
  }
  if (mode !== manifest.serviceManager.kind) {
    logger.error(
      `SERVICE_MANAGER_UNSUPPORTED: --service ${mode} requested, but this node reports ${manifest.serviceManager.kind}. ${manifest.serviceManager.installHint}`
    );
    process.exit(1);
  }
}

function nodeCredentialPath(): string {
  return path.join(service.CONFIG_DIR, 'node-credential.json');
}

function writeNodeCredential(credential: unknown): void {
  writeNodeCredentialFile(nodeCredentialPath(), credential);
}

function loadNodeCredential(): { nodeId: string; token: string; credentialId?: string } {
  const credentialPath = nodeCredentialPath();
  if (!fs.existsSync(credentialPath)) {
    logger.error(
      `NODE_LINK_FAILED: no node credential at ${credentialPath}. Run 'relay-ide node connect' first.`
    );
    process.exit(1);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      logger.error(
        `NODE_LINK_FAILED: malformed credential at ${credentialPath}.`
      );
      process.exit(1);
    }
    const parsed = raw as { nodeId?: unknown; token?: unknown; credentialId?: unknown };
    if (
      typeof parsed.nodeId !== 'string' ||
      !parsed.nodeId ||
      typeof parsed.token !== 'string' ||
      !parsed.token
    ) {
      logger.error(
        `NODE_LINK_FAILED: malformed credential at ${credentialPath}.`
      );
      process.exit(1);
    }
    return {
      nodeId: parsed.nodeId,
      token: parsed.token,
      ...(typeof parsed.credentialId === 'string' && parsed.credentialId
        ? { credentialId: parsed.credentialId }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(redactBootstrapSecrets(`NODE_LINK_FAILED: ${message}`));
    process.exit(1);
  }
}

async function runNodeLink(nodeArgs: string[]): Promise<void> {
  const hubUrl = getNodeArg(nodeArgs, '--hub');
  if (!hubUrl) {
    logger.error('Usage: relay-ide node link --hub <url>');
    process.exit(1);
  }
  const credential = loadNodeCredential();
  const configPath = resolveConfigPath();
  let config: Config | undefined;
  try {
    config = loadConfig(configPath) as Config;
  } catch {
    config = undefined;
  }
  // #467: ask the manifest probe which resume mode this host supports
  // so the pty host can pick tmux vs raw without re-probing.
  const initialManifest = await getNodeManifest();
  const sessionResume = initialManifest.capabilities.sessionResume ?? 'none';
  const ptyHost = createNodeLinkPtyHost({
    nodeId: credential.nodeId,
    sessionResume,
  });
  const localRelayNode = createLocalRelayNode({ nodeId: credential.nodeId });
  const nodeLinkClient: { current?: ReturnType<typeof createNodeLinkClient> } = {};
  const rpcHost = createNodeLinkRpcHost({
    localRelayNode,
    localLogConfigPath: configPath,
    localLogDir: service.getServicePaths().logDir,
    rotateCredential: (rotatedCredential) => {
      if (rotatedCredential.nodeId !== credential.nodeId) {
        throw new Error('credential rotation nodeId mismatch');
      }
      writeNodeCredential(rotatedCredential);
      logger.info(
        `credential rotated to ${rotatedCredential.credentialId}; restarting node link to prove possession`
      );
      setTimeout(() => {
        void nodeLinkClient.current?.stop('credential rotated');
      }, 25).unref?.();
    },
  });
  const client = createNodeLinkClient({
    hubUrl,
    credential,
    getManifest: () => getNodeManifest(),
    getRepoInventory: async () => {
      if (!config) return undefined;
      try {
        return await collectLocalRepoInventory({
          config,
          configPath,
          nodeId: credential.nodeId,
        });
      } catch {
        return undefined;
      }
    },
    onPtyEnvelope: (envelope, ctx) => ptyHost.handle(envelope, ctx),
    onRpcEnvelope: (envelope, ctx) => rpcHost.handle(envelope, ctx),
  });
  nodeLinkClient.current = client;
  await new Promise<void>((resolve) => {
    let exiting = false;
    const finish = (exitCode: number): void => {
      if (exiting) return;
      exiting = true;
      const safetyTimer = setTimeout(() => process.exit(exitCode), 5_000);
      safetyTimer.unref?.();
      // #467: ptyHost.closeAll is async — await it so attachment
      // teardown (which may detach tmux clients) completes before the
      // process exits, while keeping the 5s safety timer above as a
      // hard cap. Default close() leaves tmux sessions alive so a
      // reconnect can resume them.
      rpcHost.closeAllLogFollowers();
      void Promise.allSettled([
        ptyHost.closeAll('node-link client stopping'),
        client.stop(),
      ]).then(() => {
        clearTimeout(safetyTimer);
        resolve();
        process.exit(exitCode);
      });
    };
    client.onStateChange((state) => {
      logger.info(`node-link state: ${state}`);
      if (state === 'stopped') finish(0);
    });
    const shutdown = (signal: string) => {
      logger.info(`received ${signal}; closing node-link`);
      finish(0);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    client.start();
  });
}

type NodePairLifecycle = 'connect' | 'install';

async function pairNode(
  nodeArgs: string[],
  lifecycle: NodePairLifecycle = 'connect'
): Promise<void> {
  const hubUrl = getNodeArg(nodeArgs, '--hub');
  const pairToken = getNodeArg(nodeArgs, '--pair-token');
  if (!hubUrl || !pairToken) {
    logger.error(
      'Usage: relay-ide node connect --hub <url> --pair-token <token>'
    );
    process.exit(1);
  }

  try {
    const manifest = await getNodeManifest();
    const exchangeRes = await fetch(
      nodeEndpoint(hubUrl, '/hub/pairing/exchange'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairToken,
          manifest,
          protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        }),
      }
    );
    const exchange = (await exchangeRes.json()) as {
      credential?: { token: string; nodeId: string };
      node?: { displayName: string };
      error?: { code: string; message: string };
    };
    if (!exchangeRes.ok || !exchange.credential) {
      const code =
        exchange.error?.code === 'TOKEN_EXPIRED'
          ? 'PAIR_TOKEN_EXPIRED'
          : 'PAIR_TOKEN_INVALID';
      logger.error(
        redactBootstrapSecrets(
          `${code}: ${exchange.error?.message ?? 'pairing failed'}`
        )
      );
      process.exit(1);
    }

    writeNodeCredential(exchange.credential);

    const heartbeatRes = await fetch(
      nodeEndpoint(hubUrl, '/hub/node-heartbeat'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${exchange.credential.token}`,
        },
        body: JSON.stringify({
          nodeId: exchange.credential.nodeId,
          protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
          manifest,
        }),
      }
    );
    if (!heartbeatRes.ok) {
      const body = await heartbeatRes.text();
      logger.error(
        redactBootstrapSecrets(
          `NODE_CONNECT_FAILED: heartbeat rejected: ${body}`
        )
      );
      process.exit(1);
    }

    logger.info(
      `Node paired as ${exchange.node?.displayName ?? exchange.credential.nodeId}.`
    );
    logger.info(`Credential saved to ${nodeCredentialPath()}.`);
    if (lifecycle === 'install') {
      logger.info(
        'Sent initial heartbeat; node install is pairing plus local service setup only and does not start or maintain /hub/node-link.'
      );
    } else {
      logger.info(
        'Sent initial heartbeat; node connect is pair-only and exits without starting /hub/node-link.'
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(redactBootstrapSecrets(`NODE_CONNECT_FAILED: ${message}`));
    process.exit(1);
  }
}

if (command === 'hub') {
  const hubArgs = args.slice(1);
  const subCommand = hubArgs[0];
  if (subCommand === 'install') {
    runServiceCommand(() => {
      process.env['RELAY_IDE_BACKGROUND'] = '1';
      service.install({
        configPath: resolveConfigPath(),
        port: getArg('--port') ?? String(DEFAULTS.port),
        host: getArg('--host') ?? DEFAULTS.host,
      });
    });
  } else if (subCommand === 'uninstall') {
    runServiceCommand(() => {
      service.uninstall();
    });
  } else if (subCommand === 'status') {
    runServiceCommand(printHubStatus);
  } else if (subCommand === 'logs') {
    await runAsyncCommand(() => printHubLogs(hubArgs.slice(1)));
  } else if (subCommand === 'node-logs') {
    await runAsyncCommand(() => printRemoteNodeLogs(hubArgs.slice(1)));
  } else if (
    hubArgs.includes('--bg') &&
    (!subCommand || subCommand.startsWith('-'))
  ) {
    runServiceCommand(() => {
      process.env['RELAY_IDE_BACKGROUND'] = '1';
      service.install({
        configPath: resolveConfigPath(),
        port: getArg('--port') ?? String(DEFAULTS.port),
        host: getArg('--host') ?? DEFAULTS.host,
      });
    });
  } else if (!subCommand || subCommand.startsWith('-')) {
    logger.info('Starting Relay hub web server.');
    // Fall through to the default server startup path below. Keeping this as
    // an alias preserves bare `relay-ide` while making the runtime role explicit.
  } else {
    logger.error(
      'Usage: relay-ide hub [install|uninstall|status|logs|node-logs] [--port <port>] [--host <host>] [--config <path>]'
    );
    process.exit(1);
  }
}

if (command === 'node') {
  const nodeArgs = args.slice(1);
  const subCommand = nodeArgs[0];
  if (subCommand === 'status') {
    await printNodeStatus();
    process.exit(0);
  }
  if (subCommand === 'logs') {
    await runAsyncCommand(() => printNodeLogs(nodeArgs.slice(1)));
  }
  if (subCommand === 'doctor') {
    await runNodeDoctor(getNodeArg(nodeArgs, '--hub'));
    process.exit(0);
  }
  if (subCommand === 'link') {
    await runNodeLink(nodeArgs);
    process.exit(0);
  }
  if (subCommand === 'connect' || subCommand === 'install') {
    if (subCommand === 'install') {
      const serviceMode = parseNodeServiceMode(
        getNodeArg(nodeArgs, '--service') ?? 'auto'
      );
      const manifest = await getNodeManifest();
      validateNodeServiceMode(manifest, serviceMode);
      logger.info(`Bootstrap service mode requested: ${serviceMode}`);
      logger.info(
        'SSH/Tailscale are bootstrap transports only; current bootstrap does not establish a persistent /hub/node-link.'
      );
      await pairNode(nodeArgs, 'install');
      if (serviceMode === 'manual' || serviceMode === 'wsl-manual') {
        logger.info(
          'Manual service mode requested; paired credentials only. No foreground node process was started.'
        );
        process.exit(0);
      }
      runServiceCommand(() => {
        process.env['RELAY_IDE_BACKGROUND'] = '1';
        service.install({
          configPath: resolveConfigPath(),
          port: getArg('--port') ?? String(DEFAULTS.port),
          host: getArg('--host') ?? DEFAULTS.host,
        });
      });
    } else {
      await pairNode(nodeArgs, 'connect');
      process.exit(0);
    }
  }
  logger.error(
    'Usage: relay-ide node <status|logs|doctor|connect|install|link>'
  );
  process.exit(1);
}

if (command === 'worktree') {
  const wtArgs = args.slice(1);
  const subCommand = wtArgs[0];

  if (!subCommand) {
    logger.error('Usage: relay-ide worktree <add|remove|list> [options]');
    process.exit(1);
  }

  if (subCommand !== 'add') {
    try {
      const result = await execFileAsync('git', ['worktree', ...wtArgs]);
      if (result.stdout) console.log(result.stdout.trimEnd());
    } catch (err: unknown) {
      logger.error(execErrorMessage(err, 'git worktree failed'));
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle 'add' -- strip --yolo, determine path, forward to git, then launch claude
  const hasYolo = wtArgs.includes('--yolo');
  const gitWtArgs = wtArgs.filter(function (a) {
    return a !== '--yolo';
  });
  const addSubArgs = gitWtArgs.slice(1);
  let targetDir: string | undefined;

  const bIdx = gitWtArgs.indexOf('-b');
  const branchForDefault =
    bIdx !== -1 && bIdx + 1 < gitWtArgs.length
      ? gitWtArgs[bIdx + 1]!
      : undefined;

  if (addSubArgs.length === 0 || addSubArgs[0]!.startsWith('-')) {
    let repoRoot: string;
    try {
      const result = await execFileAsync('git', [
        'rev-parse',
        '--show-toplevel',
      ]);
      repoRoot = result.stdout.trim();
    } catch {
      logger.error('Not inside a git repository.');
      process.exit(1);
    }
    const dirName = branchForDefault
      ? branchForDefault.replace(/\//g, '-')
      : 'worktree-' + Date.now().toString(36);
    targetDir = path.join(repoRoot, '.worktrees', dirName);
    gitWtArgs.splice(1, 0, targetDir);
  } else {
    targetDir = path.resolve(addSubArgs[0]!);
  }

  try {
    const result = await execFileAsync('git', ['worktree', ...gitWtArgs]);
    if (result.stdout) console.log(result.stdout.trimEnd());
  } catch (err: unknown) {
    logger.error(execErrorMessage(err, 'git worktree add failed'));
    process.exit(1);
  }

  logger.info(`Worktree created at ${targetDir}`);

  const claudeArgs: string[] = [];
  if (hasYolo) claudeArgs.push('--dangerously-skip-permissions');

  logger.info(
    `Launching claude${hasYolo ? ' (yolo mode)' : ''} in ${targetDir}...`
  );

  const child = spawn('claude', claudeArgs, {
    cwd: targetDir,
    stdio: 'inherit',
    env: { ...process.env, CLAUDECODE: undefined },
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  // Block until child exits via the handler above
  await new Promise(() => {});
}

if (command === 'sessions') {
  const sessionArgs = args.slice(1);
  const subCommand = sessionArgs[0];
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';
  const port = getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);

  if (!token) {
    logger.error(
      'Error: RELAY_IDE_BROWSER_TOKEN not set. Run from an authenticated Relay session or set a scoped API token.'
    );
    process.exit(1);
  }

  const scopedSessionRequest = async (
    pathName: string,
    init: RequestInit = {}
  ): Promise<unknown> => {
    const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`server returned ${res.status}: ${body}`);
    }
    return res.json();
  }

  try {
    if (subCommand === 'get') {
      const sessionId = sessionArgs[1];
      if (!sessionId) {
        logger.error('Usage: relay-ide sessions get <session-id>');
        process.exit(1);
      }
      const data = await scopedSessionRequest(
        `/sessions/${encodeURIComponent(sessionId)}`
      );
      console.log(JSON.stringify(data, null, 2));
      process.exit(0);
    }

    if (subCommand === 'interventions') {
      const sessionId = sessionArgs[1];
      if (!sessionId) {
        logger.error('Usage: relay-ide sessions interventions <session-id> [--limit <n>]');
        process.exit(1);
      }
      const limit = getNodeArg(sessionArgs, '--limit');
      const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
      const data = await scopedSessionRequest(
        `/sessions/${encodeURIComponent(sessionId)}/interventions${query}`
      );
      console.log(JSON.stringify(data, null, 2));
      process.exit(0);
    }

    if (subCommand === 'hand-back') {
      const sessionId = sessionArgs[1];
      const latestSeenInterventionEventId = getNodeArg(
        sessionArgs,
        '--latest-seen-intervention-event-id'
      );
      if (!sessionId || !latestSeenInterventionEventId) {
        logger.error(
          'Usage: relay-ide sessions hand-back <session-id> --latest-seen-intervention-event-id <event-id>'
        );
        process.exit(1);
      }
      const data = await scopedSessionRequest(
        `/sessions/${encodeURIComponent(sessionId)}/control/hand-back`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latestSeenInterventionEventId }),
        }
      );
      console.log(JSON.stringify(data, null, 2));
      process.exit(0);
    }

    if (subCommand === 'scoped' && sessionArgs[1] === 'list') {
      const includeRevoked = sessionArgs.includes('--include-revoked') ? '1' : '0';
      const includeExpired = sessionArgs.includes('--active-only') ? '0' : '1';
      const data = await scopedSessionRequest(
        `/hub/scoped-sessions?includeRevoked=${includeRevoked}&includeExpired=${includeExpired}`
      );
      console.log(JSON.stringify(data, null, 2));
      process.exit(0);
    }

    if (subCommand === 'scoped' && sessionArgs[1] === 'revoke') {
      const sessionId = sessionArgs[2];
      if (!sessionId) {
        logger.error('Usage: relay-ide sessions scoped revoke <session-id> [--node-id <nodeId>] [--reason <reason>]');
        process.exit(1);
      }
      const nodeId = getNodeArg(sessionArgs, '--node-id');
      const reason = getNodeArg(sessionArgs, '--reason');
      const data = await scopedSessionRequest(
        `/hub/scoped-sessions/${encodeURIComponent(sessionId)}/revoke`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(nodeId ? { nodeId } : {}),
            ...(reason ? { reason } : {}),
          }),
        }
      );
      console.log(JSON.stringify(data, null, 2));
      process.exit(0);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error: ${msg}`);
    process.exit(1);
  }

  logger.error(`Usage: relay-ide sessions <command>

Commands:
  relay-ide sessions get <session-id>
  relay-ide sessions interventions <session-id> [--limit <n>]
  relay-ide sessions hand-back <session-id> --latest-seen-intervention-event-id <event-id>
  relay-ide sessions scoped list [--include-revoked] [--active-only]
  relay-ide sessions scoped revoke <session-id> [--node-id <nodeId>] [--reason <reason>]

Environment:
  RELAY_IDE_BROWSER_TOKEN   Auth token for session/scoped-session API
  RELAY_IDE_PORT            Server port (default: 3456)`);
  process.exit(1);
}

if (command === 'pin') {
  const subCommand = args[1];
  if (subCommand !== 'reset') {
    logger.error('Usage: relay-ide pin reset');
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    logger.error('PIN reset requires an interactive terminal.');
    process.exit(1);
  }

  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    logger.error('No config file found. Run relay-ide first to create one.');
    process.exit(1);
  }

  const { loadConfig: loadCfg, saveConfig: saveCfg } =
    await import('../server/config.js');
  const { hashPin, verifyPin } = await import('../server/auth.js');

  const config = loadCfg(configPath);
  const readline = await import('node:readline');

  function prompt(query: string, hidden = false): Promise<string> {
    return new Promise((resolve) => {
      if (hidden) {
        process.stdout.write(query);
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        if (stdin.setRawMode) stdin.setRawMode(true);
        let value = '';
        const onData = (ch: Buffer) => {
          const c = ch.toString('utf8');
          if (c === '\n' || c === '\r') {
            if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(value);
          } else if (c === '\u007f' || c === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (c >= ' ') {
            value += c;
            process.stdout.write('*');
          }
        };
        stdin.on('data', onData);
      } else {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(query, (answer) => {
          rl.close();
          resolve(answer);
        });
      }
    });
  }

  // If PIN exists, optionally verify current PIN.
  // Skipping is intentional: local shell access is proof of ownership
  // (the user could edit the config file directly to delete pinHash).
  if (config.pinHash) {
    const current = await prompt('Current PIN (press Enter to skip): ', true);
    if (current) {
      const valid = await verifyPin(current, config.pinHash);
      if (!valid) {
        logger.error('Current PIN is incorrect.');
        process.exit(1);
      }
    }
  }

  const newPin = await prompt('New PIN: ', true);
  if (!newPin || newPin.length < 4) {
    logger.error('PIN must be at least 4 characters.');
    process.exit(1);
  }

  const confirmPin = await prompt('Confirm new PIN: ', true);
  if (newPin !== confirmPin) {
    logger.error('PINs do not match.');
    process.exit(1);
  }

  config.pinHash = await hashPin(newPin);
  saveCfg(configPath, config);
  logger.info(
    'PIN updated successfully. All existing sessions will need to re-authenticate.'
  );
  process.exit(0);
}

if (
  command === 'install' ||
  command === 'uninstall' ||
  command === 'status' ||
  args.includes('--bg')
) {
  if (command === 'uninstall') {
    runServiceCommand(() => {
      service.uninstall();
    });
  } else if (command === 'status') {
    runServiceCommand(() => {
      const st = service.status();
      logger.info(`Service manager: ${st.manager.label} (${st.manager.kind})`);
      logger.info(st.manager.message);
      if (!st.installed) {
        logger.info('Service is not installed.');
      } else if (st.running) {
        logger.info('Service is installed and running.');
      } else {
        logger.info('Service is installed but not running.');
      }
      if (st.manager.statusCommand) {
        logger.info(`Status command: ${st.manager.statusCommand}`);
      }
      logger.info(
        st.installed ? st.manager.uninstallHint : st.manager.installHint
      );
      for (const caveat of st.manager.caveats) logger.info(caveat);
    });
  } else {
    runServiceCommand(() => {
      process.env['RELAY_IDE_BACKGROUND'] = '1';
      service.install({
        configPath: resolveConfigPath(),
        port: getArg('--port') ?? String(DEFAULTS.port),
        host: getArg('--host') ?? DEFAULTS.host,
      });
    });
  }
}

if (command === 'browser') {
  const browserArgs = args.slice(1);

  if (
    browserArgs.includes('--help') ||
    browserArgs.includes('-h') ||
    browserArgs.length === 0
  ) {
    logger.error(`Usage: relay-ide browser <path>

Opens an HTML file in the remote browser viewer tab.

Arguments:
  <path>    Path to HTML file (absolute or relative)

Environment:
  RELAY_IDE_PORT            Server port (default: 3456)
  RELAY_IDE_BROWSER_TOKEN   Auth token for browser tab API`);
    process.exit(
      browserArgs.includes('--help') || browserArgs.includes('-h') ? 0 : 1
    );
  }

  const filePath = path.resolve(browserArgs[0]!);

  if (!fs.existsSync(filePath)) {
    logger.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const port = process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';

  if (!token) {
    logger.error(
      'Error: RELAY_IDE_BROWSER_TOKEN not set. Are you running inside a relay-ide session?'
    );
    process.exit(1);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/browser-tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: filePath }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Error: server returned ${res.status}: ${body}`);
      process.exit(1);
    }

    const data = (await res.json()) as { token: string; refreshed: boolean };
    if (data.refreshed) {
      logger.info(`Refreshed: ${filePath}`);
    } else {
      logger.info(`Opened: ${filePath}`);
    }
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error: could not connect to server on port ${port}: ${msg}`);
    process.exit(1);
  }
}

const configPath = resolveConfigPath();
const configDir = path.dirname(configPath);

// Ensure config directory exists
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Pass config path and CLI overrides to the server
process.env['RELAY_IDE_CONFIG'] = configPath;
const portArg = getArg('--port');
if (portArg !== undefined) process.env['RELAY_IDE_PORT'] = portArg;
const hostArg = getArg('--host');
if (hostArg !== undefined) process.env['RELAY_IDE_HOST'] = hostArg;
if (args.includes('--debug-log')) process.env['RELAY_IDE_DEBUG_LOG'] = '1';

await import('../server/index.js');
