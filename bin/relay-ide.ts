#!/usr/bin/env node
/* eslint-disable no-console -- CLI entry point, user-facing stdout/stderr output */
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as service from '../server/service.js';
import { DEFAULTS, loadConfig } from '../server/config.js';
import { createLogger } from '../server/logger.js';
import { getNodeManifest } from '../server/node-manifest.js';
import {
  buildRemedyCommand,
  buildUpdateCommand,
  detectRunningInstall,
  readInstalledVersion as readInstallRootVersion,
  resolveDetectedScriptPath,
  verifyUpdateLanded,
} from '../server/self-update.js';
import { redactBootstrapSecrets } from '../shared/bootstrap-diagnostics.js';
import {
  NODE_PAIR_TOKEN_CREATE_CAPABILITY,
  NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE,
} from '../shared/operator-handshake-grants.js';
import {
  nodeHasTerminalBackend,
  nodeTerminalBackends,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeSummary,
} from '../shared/relay-node-protocol.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import type { Config, SessionSummary } from '../server/types.js';
import { createSupervisorSnapshot } from '../server/supervisor-snapshot.js';
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
  createNodeLinkProof,
  generateNodeIdentityKeyPair,
  parseStoredNodeIdentityKey,
  redactNodeIdentityMaterial,
  type NodeIdentityKeyPair,
  type NodeLinkProofAudience,
} from '../shared/node-identity-keys.js';
import {
  DEFAULT_NODE_PAIRING_TRUST_PROFILE,
  isNodePairingTrustProfile,
  type NodePairingRequestSummary,
  type NodePairingTrustProfile,
} from '../shared/node-pairing-requests.js';
import {
  EVENTS_SUBSCRIBE_TOPICS,
  EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES,
  RELAY_CLI_GATEWAY_CONTRACT,
  gatewayError,
  gatewayOk,
  type EventsSubscribeTopic,
  type RelayCliGatewayCommand,
  type RelayCliGatewayEnvelope,
  type RelayCliGatewayErrorCode,
} from '../shared/cli-gateway-contract.js';
import {
  channelSubscriptionFilterValidationError,
  normalizeChannelSubscriptionFilter,
  type ChannelSubscriptionFilter,
} from '../shared/channel-chat-protocol.js';
import { retainOutputPredicateSuffix } from '../shared/cli-gateway-sessions-wait.js';
import {
  gatewayCliInvalidArgumentError,
  gatewayCliInvalidJsonError,
  gatewayErrorMessage,
  gatewayErrorRetryable,
  normalizeGatewayErrorCode,
  sanitizedGatewayErrorDetails,
  validateAndSanitizeGatewayCreateInput,
} from '../shared/cli-gateway-runtime.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  parseRepoInstanceId,
  parseWorktreeInstanceId,
} from '../shared/identity.js';
import {
  SUPERVISOR_SEND_KEY_NAMES,
  supervisorActionCommandId,
  supervisorActionRequiredCapabilities,
  supervisorSubmitRequiredCapabilities,
  type SupervisorActionType,
} from '../shared/supervisor-actions.js';
import {
  isFileRpcOperation,
  FILE_RPC_MAX_WRITE_BYTES,
  type FileRpcOperation,
} from '../shared/file-rpc.js';
import {
  buildTerminalCockpitDetail,
  buildTerminalCockpitView,
  renderTerminalCockpit,
  renderTerminalCockpitDetail,
  type TerminalCockpitActiveGroupInput,
  type TerminalCockpitDetail,
  type TerminalCockpitView,
} from '../shared/terminal-cockpit.js';
import { WebSocket, type RawData } from 'ws';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('cli');

function execErrorMessage(err: unknown, fallback: string): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || fallback).trimEnd();
}

function isMissingCommandError(err: unknown, command: string): boolean {
  const e = err as { code?: unknown; path?: unknown; message?: unknown };
  return (
    e.code === 'ENOENT' &&
    (e.path === command ||
      (typeof e.message === 'string' &&
        e.message.includes(`spawn ${command} ENOENT`)))
  );
}

// Parse CLI flags
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  logger.info(`Usage: relay-ide [options]
       relay-ide <command>

Commands:
  dev [--self-host]  Run backend + Vite frontend with HMR (source checkout)
  update             Update this single relay-ide package from npm
  hub [--allow-degraded]
                     Run the Relay hub web server (same as bare relay-ide)
    install                           Install/start the hub background service
    uninstall                         Stop and remove the hub background service
    status                            Show hub service status
    logs [--lines <n>] [--follow]     Print or follow local hub log files
    nodes [--json]                    List paired nodes with status/capability summary
    doctor [--json]                   Run bounded hub/node diagnostics
    node-logs <nodeId> [--lines <n>] [--follow]
                                       Print or follow logs from a paired remote node
  install            Alias for relay-ide hub install
  uninstall          Alias for relay-ide hub uninstall
  status             Alias for relay-ide hub status
  cockpit [--json]   Read-first terminal cockpit: what needs operator attention
    get <work-context-id> [--json]
                     Show one cockpit item with safe follow-up commands
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
    doctor [--hub <url>] [--json]      Diagnose local node health and hub reachability; surfaces all degraded reasons
    pair <hub> [--json]                 Create a device-code pairing request and wait for approval (pair-only)
    pair --hub <url> --pair-token <token>
                                       Exchange an operator-minted pair token with a hub and send one heartbeat
    mint-pair-token --hub <url> --operator-grant <handle> [--display-name <name>] [--platform <name>] [--task-ref <ref>] [--json]
                                       Mint a short-lived node pair token through the scoped operator-grant lane
    install --hub <url> [--service auto|manual|launchd|systemd-user|wsl-systemd|wsl-manual]
                                       Install relay-ide globally via npm and optionally set up the local service (no pairing)
    connect --hub <url> --pair-token <token>
                                       Alias for token-based node pairing
    ssh-bootstrap --target <host> --hub <url>
                                       Print a paste-able bash script to install and pair on a remote host via SSH
    link --hub <url>                   Open and hold the persistent /hub/node-link reverse WebSocket (foreground)
    update [--check]                   Update the relay-ide install on this node (--check reports only)
  sessions           Read and control terminal sessions (requires RELAY_IDE_BROWSER_TOKEN)
    get <session-id>                   Print one session descriptor as JSON
    interventions <session-id> [--limit <n>]
                                       List recorded human interventions for a session
    scoped list [--include-revoked] [--active-only]
                                       List scoped session grants
    scoped revoke <session-id> [--node-id <nodeId>] [--reason <reason>]
                                       Revoke a scoped session grant
  worktree           Manage git worktrees (wraps git worktree)
    add [path] [-b branch]            Create a git worktree
    remove <path>                      Forward to git worktree remove
    list                               Forward to git worktree list
  browser            Open an HTML file in the remote viewer
    <path>             Path to HTML file
  v1 work-context-artifacts publish --artifact-file <json>|--view-file <json> --work-context-id <id> --json
                     Publish a handoff artifact or agent-authored static HTML view artifact
  pin                Manage authentication PIN
    reset              Reset the PIN (interactive, requires TTY)

Options:
  --bg               Shortcut: install and start as background service
  --port <port>      Override server port (default: 3456)
  --host <host>      Override bind address (default: 0.0.0.0)
  --config <path>    Path to config.json (default: ~/.config/relay-ide/config.json)
  --compact          With 'manifest': print compact JSON
  --debug-log        Enable SDK event debug logging to ~/.config/relay-ide/debug/
  --allow-degraded   Permit the hub to start with failed persistence stores (unsafe; health reports degraded)
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
  const payload = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  let offset = 0;
  const waitBuffer = new SharedArrayBuffer(4);
  const waitView = new Int32Array(waitBuffer);
  while (offset < payload.length) {
    try {
      offset += fs.writeSync(
        process.stdout.fd,
        payload,
        offset,
        Math.min(16 * 1024, payload.length - offset)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      Atomics.wait(waitView, 0, 0, 10);
    }
  }
  process.exit(exitCode);
}

function gatewayInvalid(
  commandName: RelayCliGatewayCommand,
  message: string,
  details?: Record<string, unknown>
): never {
  printGatewayEnvelope(
    gatewayError(
      commandName,
      gatewayCliInvalidArgumentError(commandName, message, details)
    ),
    1
  );
}

function writeGatewayOutputFile(
  commandName: RelayCliGatewayCommand,
  outputPath: string,
  payload: unknown
): void {
  const resolvedOutputPath = path.resolve(outputPath);
  try {
    fs.writeFileSync(
      resolvedOutputPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'INTERNAL',
        message: `failed to write --output: ${message}`,
        retryable: false,
        details: {
          reasonCode: 'CLI_GATEWAY_OUTPUT_WRITE_FAILED',
          field: 'output',
          path: resolvedOutputPath,
        },
      }),
      1
    );
  }
}

function gatewayArg(commandArgs: string[], flag: string): string | undefined {
  const idx = commandArgs.indexOf(flag);
  if (idx === -1 || idx + 1 >= commandArgs.length) return undefined;
  const value = commandArgs[idx + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function gatewayArgs(commandArgs: string[], flag: string): string[] {
  const values: string[] = [];
  for (let idx = 0; idx < commandArgs.length - 1; idx += 1) {
    if (commandArgs[idx] !== flag) continue;
    const value = commandArgs[idx + 1];
    if (value && !value.startsWith('--')) values.push(value);
  }
  return values;
}

function appendGatewayListQuery(
  query: URLSearchParams,
  commandArgs: string[],
  flag: string,
  key: string
): void {
  for (const value of gatewayArgs(commandArgs, flag)) {
    for (const entry of value.split(/[\s,]+/)) {
      const trimmed = entry.trim();
      if (trimmed) query.append(key, trimmed);
    }
  }
}

function parseGatewayJson(
  commandName: RelayCliGatewayCommand,
  raw: string
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    gatewayInvalid(commandName, 'input JSON must be an object');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printGatewayEnvelope(
      gatewayError(
        commandName,
        gatewayCliInvalidJsonError(commandName, message)
      ),
      1
    );
  }
}

function parseGatewayCreateInput(
  sessionArgs: string[]
): Record<string, unknown> {
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
      gatewayInvalid(
        'sessions.create',
        `could not read --input-file: ${message}`
      );
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
    ['--branch-name', 'branchName'],
    ['--work-context-id', 'workContextId'],
    ['--workspace-topic-id', 'workspaceTopicId'],
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
        gatewayInvalid('sessions.create', `${flag} must be numeric`, {
          flag,
          value,
        });
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

function parseGatewayInputObject(
  commandName: RelayCliGatewayCommand,
  commandArgs: string[]
): Record<string, unknown> {
  const inputJson = gatewayArg(commandArgs, '--input-json');
  if (inputJson) return parseGatewayJson(commandName, inputJson);
  const inputFile = gatewayArg(commandArgs, '--input-file');
  if (inputFile) {
    try {
      return parseGatewayJson(
        commandName,
        fs.readFileSync(path.resolve(inputFile), 'utf8')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gatewayInvalid(commandName, `could not read --input-file: ${message}`);
    }
  }
  return {};
}

function parseGatewaySessionRenameInput(sessionArgs: string[]): {
  id: string;
  displayName: string;
} {
  const parsed = parseGatewayInputObject('sessions.rename', sessionArgs);
  const id =
    typeof parsed['id'] === 'string'
      ? parsed['id']
      : (gatewayArg(sessionArgs, '--id') ?? sessionArgs[0]);
  const displayName =
    typeof parsed['displayName'] === 'string'
      ? parsed['displayName']
      : (gatewayArg(sessionArgs, '--display-name') ??
        gatewayArg(sessionArgs, '--name'));
  if (!id || id.startsWith('--'))
    gatewayInvalid('sessions.rename', '--id is required');
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    gatewayInvalid('sessions.rename', '--display-name is required', {
      field: 'displayName',
    });
  }
  return { id, displayName };
}

function parseGatewaySessionKillInput(sessionArgs: string[]): {
  id: string;
  confirmationToken?: string;
} {
  const parsed = parseGatewayInputObject('sessions.kill', sessionArgs);
  const id =
    typeof parsed['id'] === 'string'
      ? parsed['id']
      : (gatewayArg(sessionArgs, '--id') ?? sessionArgs[0]);
  if (!id || id.startsWith('--'))
    gatewayInvalid('sessions.kill', '--id is required');

  const rawConfirmationToken =
    typeof parsed['confirmationToken'] === 'string'
      ? parsed['confirmationToken']
      : gatewayArg(sessionArgs, '--confirmation-token');
  const confirmationToken = rawConfirmationToken?.trim();
  return {
    id,
    ...(confirmationToken ? { confirmationToken } : {}),
  };
}

function gatewaySessionIdentityPayload(
  requestedId: string,
  sessionId: string,
  session: GatewaySessionDescriptor,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: sessionId,
    sessionId,
    ...(requestedId !== sessionId ? { requestedId } : {}),
    ...(session.nodeId ? { nodeId: session.nodeId } : {}),
    ...(session.globalSessionId
      ? { globalSessionId: session.globalSessionId }
      : {}),
    ...extras,
  };
}

type WorkflowGatewayCommand = 'tickets.startWork' | 'branches.openSession';

type WorkflowWorktreeMode =
  | 'reuse-existing'
  | 'create-if-missing'
  | 'reject-if-missing';

interface WorkflowGitResult {
  stdout: string;
  stderr: string;
}

interface WorkflowWorktreeResolution {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  createdWorktree: boolean;
  reusedWorktree: boolean;
  dirty: boolean;
  conflicted: boolean;
}

interface WorkflowPrResolutionMeta extends Record<string, unknown> {
  number?: number;
  head: string;
  base?: unknown;
  headOid?: string;
  fetchRef?: string;
  remoteRef?: string;
}

function isGatewayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function workflowError(
  commandName: WorkflowGatewayCommand,
  code: RelayCliGatewayErrorCode,
  message: string,
  details?: Record<string, unknown>,
  retryable = false
): never {
  printGatewayEnvelope(
    gatewayError(commandName, {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    }),
    1
  );
}

function workflowInputRecord(
  commandName: WorkflowGatewayCommand,
  input: Record<string, unknown>,
  field: string,
  required = false
): Record<string, unknown> | undefined {
  const value = input[field];
  if (value === undefined) {
    if (required) {
      workflowError(commandName, 'INVALID_ARGUMENT', `${field} is required`, {
        field,
      });
    }
    return undefined;
  }
  if (!isGatewayRecord(value)) {
    workflowError(
      commandName,
      'INVALID_ARGUMENT',
      `${field} must be an object`,
      {
        field,
      }
    );
  }
  return value;
}

function workflowString(
  commandName: WorkflowGatewayCommand,
  record: Record<string, unknown> | undefined,
  field: string,
  required = false
): string | undefined {
  const value = record?.[field];
  if (value === undefined || value === null || value === '') {
    if (required) {
      workflowError(commandName, 'INVALID_ARGUMENT', `${field} is required`, {
        field,
      });
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    workflowError(
      commandName,
      'INVALID_ARGUMENT',
      `${field} must be a string`,
      {
        field,
      }
    );
  }
  return value;
}

function workflowBoolean(
  commandName: WorkflowGatewayCommand,
  record: Record<string, unknown> | undefined,
  field: string
): boolean | undefined {
  const value = record?.[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    workflowError(
      commandName,
      'INVALID_ARGUMENT',
      `${field} must be a boolean`,
      {
        field,
      }
    );
  }
  return value;
}

function workflowWorktreeMode(
  commandName: WorkflowGatewayCommand,
  worktree: Record<string, unknown> | undefined
): WorkflowWorktreeMode {
  const raw = worktree?.['mode'];
  if (raw === undefined) return 'reuse-existing';
  if (
    raw === 'reuse-existing' ||
    raw === 'create-if-missing' ||
    raw === 'reject-if-missing'
  ) {
    return raw;
  }
  workflowError(commandName, 'INVALID_ARGUMENT', 'worktree.mode is invalid', {
    field: 'worktree.mode',
    allowed: ['reuse-existing', 'create-if-missing', 'reject-if-missing'],
  });
}

function branchSlug(branchName: string): string {
  return branchName
    .replace(/^refs\/heads\//, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

async function workflowGit(
  commandName: WorkflowGatewayCommand,
  repoPath: string,
  args: string[],
  errorCode: RelayCliGatewayErrorCode,
  reasonCode: string
): Promise<WorkflowGitResult> {
  try {
    return (await execFileAsync('git', args, {
      cwd: repoPath,
      timeout: 15000,
    })) as WorkflowGitResult;
  } catch (error) {
    const message = execErrorMessage(error, 'git command failed');
    workflowError(commandName, errorCode, message, {
      reasonCode,
      gitArgs: args,
    });
  }
}

async function workflowGitOptional(
  repoPath: string,
  args: string[]
): Promise<WorkflowGitResult | null> {
  try {
    return (await execFileAsync('git', args, {
      cwd: repoPath,
      timeout: 15000,
    })) as WorkflowGitResult;
  } catch {
    return null;
  }
}

function parseGitWorktreePorcelain(stdout: string): Array<{
  path: string;
  branchName?: string;
}> {
  const entries: Array<{ path: string; branchName?: string }> = [];
  let current: { path?: string; branchName?: string } = {};
  const flush = () => {
    if (current.path) {
      entries.push({
        path: current.path,
        ...(current.branchName ? { branchName: current.branchName } : {}),
      });
    }
    current = {};
  };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current.path) flush();
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branchName = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    }
  }
  flush();
  return entries;
}

async function workflowBranchExists(
  repoPath: string,
  branchName: string
): Promise<{ local: boolean; remote: boolean }> {
  const local = await workflowGitOptional(repoPath, [
    'rev-parse',
    '--verify',
    `refs/heads/${branchName}`,
  ]);
  const remote = await workflowGitOptional(repoPath, [
    'rev-parse',
    '--verify',
    `refs/remotes/origin/${branchName}`,
  ]);
  return { local: Boolean(local), remote: Boolean(remote) };
}

async function workflowRefOid(
  repoPath: string,
  refName: string
): Promise<string | undefined> {
  const result = await workflowGitOptional(repoPath, [
    'rev-parse',
    '--verify',
    refName,
  ]);
  return result?.stdout.trim() || undefined;
}

function assertWorkflowRefMatchesPrHead(
  commandName: WorkflowGatewayCommand,
  refName: string,
  actualOid: string | undefined,
  prMeta: WorkflowPrResolutionMeta
): void {
  if (!prMeta.headOid || !actualOid || actualOid === prMeta.headOid) return;
  workflowError(
    commandName,
    'SESSION_CONFLICT',
    'resolved branch does not match the PR head commit',
    {
      reasonCode: 'PR_HEAD_MISMATCH',
      branchName: prMeta.head,
      refName,
      actualOid,
      expectedOid: prMeta.headOid,
      prNumber: prMeta.number ?? null,
    }
  );
}

async function prepareWorkflowPrHeadBranch(
  commandName: WorkflowGatewayCommand,
  repoPath: string,
  branchName: string,
  branchState: { local: boolean; remote: boolean },
  prMeta: WorkflowPrResolutionMeta | undefined
): Promise<void> {
  if (!prMeta?.fetchRef || !prMeta.remoteRef) return;

  await workflowGit(
    commandName,
    repoPath,
    ['fetch', 'origin', `+${prMeta.fetchRef}:${prMeta.remoteRef}`],
    'UPSTREAM_ERROR',
    'PR_HEAD_FETCH_FAILED'
  );

  const fetchedOid = await workflowRefOid(repoPath, prMeta.remoteRef);
  assertWorkflowRefMatchesPrHead(
    commandName,
    prMeta.remoteRef,
    fetchedOid,
    prMeta
  );

  if (branchState.local) {
    const localOid = await workflowRefOid(repoPath, `refs/heads/${branchName}`);
    assertWorkflowRefMatchesPrHead(
      commandName,
      `refs/heads/${branchName}`,
      localOid,
      prMeta
    );
    return;
  }

  await workflowGit(
    commandName,
    repoPath,
    ['branch', branchName, prMeta.remoteRef],
    'UPSTREAM_ERROR',
    'BRANCH_CREATE_FROM_PR_HEAD_FAILED'
  );
  branchState.local = true;
}

async function assertWorkflowWorktreeMatchesPrHead(
  commandName: WorkflowGatewayCommand,
  worktreePath: string,
  prMeta: WorkflowPrResolutionMeta | undefined
): Promise<void> {
  if (!prMeta?.headOid) return;
  const worktreeOid = await workflowRefOid(worktreePath, 'HEAD');
  assertWorkflowRefMatchesPrHead(commandName, 'HEAD', worktreeOid, prMeta);
}

async function resolveWorkflowBranchFromPr(
  commandName: WorkflowGatewayCommand,
  repoPath: string,
  pr: Record<string, unknown> | undefined,
  explicitBranch: string | undefined
): Promise<{ branchName: string; prMeta?: WorkflowPrResolutionMeta }> {
  if (explicitBranch) {
    return pr
      ? { branchName: explicitBranch, prMeta: { ...pr, head: explicitBranch } }
      : { branchName: explicitBranch };
  }
  const prHead = workflowString(commandName, pr, 'head');
  if (prHead) {
    return pr
      ? { branchName: prHead, prMeta: { ...pr, head: prHead } }
      : { branchName: prHead };
  }
  const prNumber = pr?.['number'];
  if (prNumber === undefined) {
    workflowError(
      commandName,
      'INVALID_ARGUMENT',
      'branch.name or pr.head/number is required',
      {
        field: 'branch.name',
      }
    );
  }
  if (
    typeof prNumber !== 'number' ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0
  ) {
    workflowError(
      commandName,
      'INVALID_ARGUMENT',
      'pr.number must be a positive integer',
      {
        field: 'pr.number',
      }
    );
  }
  try {
    const { stdout } = (await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'headRefName,headRefOid,baseRefName,url,title,number',
      ],
      { cwd: repoPath, timeout: 15000 }
    )) as WorkflowGitResult;
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const head =
      typeof data['headRefName'] === 'string' ? data['headRefName'] : '';
    const headOid =
      typeof data['headRefOid'] === 'string' ? data['headRefOid'] : '';
    if (!head) throw new Error('PR headRefName missing');
    if (!headOid) throw new Error('PR headRefOid missing');
    return {
      branchName: head,
      prMeta: {
        number: typeof data['number'] === 'number' ? data['number'] : prNumber,
        url: data['url'],
        title: data['title'],
        head,
        base: data['baseRefName'],
        headOid,
        fetchRef: `refs/pull/${prNumber}/head`,
        remoteRef: `refs/remotes/origin/pr-${prNumber}`,
      },
    };
  } catch (error) {
    if (isMissingCommandError(error, 'gh')) {
      workflowError(
        commandName,
        'UPSTREAM_ERROR',
        'gh CLI is required to resolve PR numbers but was not found',
        {
          reasonCode: 'GH_CLI_MISSING',
          command: 'gh',
          prNumber,
        }
      );
    }
    workflowError(
      commandName,
      'NOT_FOUND',
      execErrorMessage(error, 'unknown PR'),
      {
        reasonCode: 'UNKNOWN_PR',
        prNumber,
      }
    );
  }
}

async function resolveWorkflowWorktree(
  commandName: WorkflowGatewayCommand,
  input: Record<string, unknown>
): Promise<WorkflowWorktreeResolution> {
  const repo = workflowInputRecord(commandName, input, 'repo', true)!;
  const branch = workflowInputRecord(commandName, input, 'branch');
  const pr = workflowInputRecord(commandName, input, 'pr');
  const worktree = workflowInputRecord(commandName, input, 'worktree');
  const nodeId = workflowString(commandName, repo, 'nodeId');
  if (nodeId && nodeId !== 'local') {
    workflowError(
      commandName,
      'UNSUPPORTED',
      'ticket/branch workflow resolution is local-only in this slice; remote node execution must wait for node-side git capability routing',
      { reasonCode: 'REMOTE_WORKFLOW_UNSUPPORTED', nodeId }
    );
  }
  const rawRepoPath = workflowString(commandName, repo, 'repoPath', true)!;
  const repoPath = path.resolve(rawRepoPath);
  const topLevel = await workflowGit(
    commandName,
    repoPath,
    ['rev-parse', '--show-toplevel'],
    'INVALID_ARGUMENT',
    'MISSING_REPO_BINDING'
  );
  const resolvedRepoPath = topLevel.stdout.trim() || repoPath;
  const explicitBranch = workflowString(commandName, branch, 'name');
  const { branchName, prMeta } = await resolveWorkflowBranchFromPr(
    commandName,
    resolvedRepoPath,
    pr,
    explicitBranch
  );
  const mode = workflowWorktreeMode(commandName, worktree);
  const allowDirty =
    workflowBoolean(commandName, worktree, 'allowDirty') ?? false;
  const allowConflicted =
    workflowBoolean(commandName, worktree, 'allowConflicted') ?? false;
  const explicitWorktreePath = workflowString(
    commandName,
    worktree,
    'worktreePath'
  );
  const worktrees = parseGitWorktreePorcelain(
    (
      await workflowGit(
        commandName,
        resolvedRepoPath,
        ['worktree', 'list', '--porcelain'],
        'UPSTREAM_ERROR',
        'WORKTREE_LIST_FAILED'
      )
    ).stdout
  );
  const requestedWorktreePath = explicitWorktreePath
    ? path.resolve(explicitWorktreePath)
    : undefined;
  let existing = requestedWorktreePath
    ? worktrees.find(
        (entry) => path.resolve(entry.path) === requestedWorktreePath
      )
    : worktrees.find((entry) => entry.branchName === branchName);
  let createdWorktree = false;

  if (requestedWorktreePath && existing && existing.branchName !== branchName) {
    workflowError(
      commandName,
      'SESSION_CONFLICT',
      'explicit worktree path is checked out on a different branch than requested',
      {
        reasonCode: 'WORKTREE_BRANCH_MISMATCH',
        worktreePath: requestedWorktreePath,
        branchName,
        actualBranchName: existing.branchName ?? null,
      }
    );
  }

  if (!existing && mode === 'reuse-existing') {
    workflowError(
      commandName,
      'NOT_FOUND',
      'no existing worktree for requested branch',
      {
        reasonCode: 'WORKTREE_NOT_FOUND',
        branchName,
        worktreePolicy: mode,
      }
    );
  }
  if (!existing && mode === 'reject-if-missing') {
    workflowError(
      commandName,
      'NOT_FOUND',
      'worktree is required to already exist',
      {
        reasonCode: 'WORKTREE_NOT_FOUND',
        branchName,
        worktreePolicy: mode,
      }
    );
  }
  if (!existing) {
    const targetPath =
      requestedWorktreePath ??
      path.join(resolvedRepoPath, '.worktrees', branchSlug(branchName));
    const branchState = await workflowBranchExists(
      resolvedRepoPath,
      branchName
    );
    const branchBase =
      workflowString(commandName, branch, 'base') ??
      workflowString(commandName, prMeta, 'base');
    await prepareWorkflowPrHeadBranch(
      commandName,
      resolvedRepoPath,
      branchName,
      branchState,
      prMeta
    );
    if (!branchState.local && branchState.remote) {
      await workflowGit(
        commandName,
        resolvedRepoPath,
        ['branch', branchName, `origin/${branchName}`],
        'UPSTREAM_ERROR',
        'BRANCH_CREATE_FROM_REMOTE_FAILED'
      );
    }
    const addArgs =
      branchState.local || branchState.remote
        ? ['worktree', 'add', targetPath, branchName]
        : branchBase
          ? ['worktree', 'add', '-b', branchName, targetPath, branchBase]
          : undefined;
    if (!addArgs) {
      workflowError(
        commandName,
        'NOT_FOUND',
        'branch was not found and no base branch was provided for creation',
        {
          reasonCode: 'UNKNOWN_BRANCH',
          branchName,
        }
      );
    }
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await workflowGit(
      commandName,
      resolvedRepoPath,
      addArgs,
      'UPSTREAM_ERROR',
      'WORKTREE_CREATE_FAILED'
    );
    existing = { path: targetPath, branchName };
    createdWorktree = true;
  }

  const finalWorktreePath = path.resolve(existing.path);
  await assertWorkflowWorktreeMatchesPrHead(
    commandName,
    finalWorktreePath,
    prMeta
  );
  const conflicted = Boolean(
    (
      await workflowGit(
        commandName,
        finalWorktreePath,
        ['ls-files', '-u'],
        'UPSTREAM_ERROR',
        'WORKTREE_CONFLICT_CHECK_FAILED'
      )
    ).stdout.trim()
  );
  const dirty = Boolean(
    (
      await workflowGit(
        commandName,
        finalWorktreePath,
        ['status', '--porcelain'],
        'UPSTREAM_ERROR',
        'WORKTREE_DIRTY_CHECK_FAILED'
      )
    ).stdout.trim()
  );
  if (conflicted && !allowConflicted) {
    workflowError(
      commandName,
      'SESSION_CONFLICT',
      'worktree has unresolved conflicts',
      {
        reasonCode: 'WORKTREE_CONFLICTED',
        worktreePath: finalWorktreePath,
        branchName,
      }
    );
  }
  if (dirty && !allowDirty) {
    workflowError(
      commandName,
      'SESSION_CONFLICT',
      'worktree has uncommitted changes',
      {
        reasonCode: 'WORKTREE_DIRTY',
        worktreePath: finalWorktreePath,
        branchName,
      }
    );
  }
  return {
    repoPath: resolvedRepoPath,
    worktreePath: finalWorktreePath,
    branchName,
    createdWorktree,
    reusedWorktree: !createdWorktree,
    dirty,
    conflicted,
  };
}

function workflowSessionBody(
  commandName: WorkflowGatewayCommand,
  input: Record<string, unknown>,
  resolved: WorkflowWorktreeResolution
): {
  body: Record<string, unknown>;
  promptHandoff: Record<string, unknown>;
  controlHandoff: Record<string, unknown>;
} {
  const session = workflowInputRecord(commandName, input, 'session') ?? {};
  const prompt = workflowInputRecord(commandName, input, 'prompt');
  const body: Record<string, unknown> = {
    repoPath: resolved.repoPath,
    worktreePath: resolved.worktreePath,
    branchName: resolved.branchName,
  };
  for (const field of [
    'type',
    'mode',
    'agent',
    'yolo',
    'terminalBackend',
    'cols',
    'rows',
    'continuePolicy',
    'workContextId',
    'controlMode',
  ]) {
    if (session[field] !== undefined) body[field] = session[field];
  }
  const promptMode = workflowString(commandName, prompt, 'mode') ?? 'none';
  const promptText = workflowString(commandName, prompt, 'prompt');
  const requireTypedDelivery =
    workflowBoolean(commandName, prompt, 'requireTypedDelivery') ?? false;
  if (promptMode === 'unsupported' && requireTypedDelivery) {
    workflowError(
      commandName,
      'UNSUPPORTED',
      'requested prompt handoff policy is explicitly unsupported and raw PTY bytes are not a stable contract',
      { reasonCode: 'PROMPT_HANDOFF_UNSUPPORTED', promptMode }
    );
  }
  let promptHandoff: Record<string, unknown> = {
    requested: Boolean(promptText),
    policy: promptMode,
    delivered: false,
    method: 'none',
  };
  if (promptMode === 'initial-prompt' && promptText) {
    body['initialPrompt'] = promptText;
    promptHandoff = {
      requested: true,
      policy: promptMode,
      delivered: true,
      method: 'sessions.create.initialPrompt',
    };
  } else if (promptText) {
    promptHandoff = {
      requested: true,
      policy: promptMode,
      delivered: false,
      method: 'none',
      reasonCode: 'PROMPT_HANDOFF_NOT_REQUESTED',
    };
  }
  return {
    body,
    promptHandoff,
    controlHandoff: {
      requested: typeof session['controlMode'] === 'string',
      mode: session['controlMode'] ?? null,
      delivered: typeof session['controlMode'] === 'string',
      method:
        typeof session['controlMode'] === 'string'
          ? 'sessions.create.controlMode'
          : 'none',
    },
  };
}

function requireWorkflowGatewayAuth(commandName: WorkflowGatewayCommand): void {
  const actorToken = gatewayActorToken();
  if (actorToken) {
    gatewayInvalid(
      commandName,
      '--actor-token is only supported for read-only CLI gateway commands in this slice',
      {
        allowedCommands: Array.from(CLI_GATEWAY_ACTOR_TOKEN_COMMANDS),
      }
    );
  }
  if (!process.env['RELAY_IDE_BROWSER_TOKEN']) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'UNAUTHORIZED',
        message:
          'RELAY_IDE_BROWSER_TOKEN not set. Starting ticket work or opening branch sessions is a write workflow and requires an authenticated Relay session in this slice.',
        retryable: false,
      }),
      1
    );
  }
}

async function runGatewayWorkflow(
  commandName: WorkflowGatewayCommand,
  commandArgs: string[]
): Promise<never> {
  const input = parseGatewayInputObject(commandName, commandArgs);
  requireWorkflowGatewayAuth(commandName);
  if (commandName === 'tickets.startWork') {
    const ticket = workflowInputRecord(commandName, input, 'ticket', true);
    workflowString(commandName, ticket, 'source', true);
    workflowString(commandName, ticket, 'id', true);
  }
  const resolved = await resolveWorkflowWorktree(commandName, input);
  const { body, promptHandoff, controlHandoff } = workflowSessionBody(
    commandName,
    input,
    resolved
  );
  const validated = validateAndSanitizeGatewayCreateInput(body);
  if (validated.ok === false) {
    printGatewayEnvelope(gatewayError(commandName, validated.error), 1);
  }
  const session = await gatewayHttpJson({
    commandName,
    pathName: '/sessions',
    method: 'POST',
    body: validated.input,
    capabilities: ['session:create:terminal'],
  });
  const sessionRecord = isGatewayRecord(session) ? session : {};
  const workContextId =
    workflowString(
      commandName,
      workflowInputRecord(commandName, input, 'session'),
      'workContextId'
    ) ??
    (typeof sessionRecord['workContextId'] === 'string'
      ? sessionRecord['workContextId']
      : undefined);
  printGatewayEnvelope(
    gatewayOk(commandName, {
      session,
      nodeId: 'local',
      repo: {
        repoPath: resolved.repoPath,
        repoIdentity:
          workflowString(
            commandName,
            workflowInputRecord(commandName, input, 'repo'),
            'repoIdentity'
          ) ?? null,
        repoInstanceId:
          workflowString(
            commandName,
            workflowInputRecord(commandName, input, 'repo'),
            'repoInstanceId'
          ) ?? null,
      },
      worktree: {
        path: resolved.worktreePath,
        dirty: resolved.dirty,
        conflicted: resolved.conflicted,
      },
      branch: { name: resolved.branchName },
      ...(workflowInputRecord(commandName, input, 'pr')
        ? { pr: workflowInputRecord(commandName, input, 'pr') }
        : {}),
      ...(workContextId ? { workContextId } : {}),
      created: { session: true, worktree: resolved.createdWorktree },
      reused: { session: false, worktree: resolved.reusedWorktree },
      promptHandoff,
      controlHandoff,
    }),
    0
  );
}

type GatewayLifecycleInput = Record<string, unknown> & {
  environment?: Record<string, unknown>;
};

function gatewayLifecycleEnvironment(
  commandName: RelayCliGatewayCommand,
  input: Record<string, unknown>
): Record<string, unknown> | undefined {
  const environment = input['environment'];
  if (environment === undefined) return undefined;
  if (!isGatewayRecord(environment)) {
    gatewayInvalid(commandName, 'environment must be an object when provided');
  }
  return environment;
}

function gatewayLifecycleNodeId(
  input: GatewayLifecycleInput
): string | undefined {
  const environment = input.environment;
  const explicitNodeId = environment?.['nodeId'];
  if (typeof explicitNodeId === 'string' && explicitNodeId.trim()) {
    return explicitNodeId;
  }
  const repoInstanceId = environment?.['repoInstanceId'];
  if (typeof repoInstanceId === 'string') {
    const parsed = parseRepoInstanceId(repoInstanceId);
    if (parsed) return parsed.nodeId;
  }
  const benchId = environment?.['benchId'];
  if (typeof benchId === 'string') {
    const parsed = parseWorktreeInstanceId(benchId);
    if (parsed) return parsed.nodeId;
  }
  return undefined;
}

function rejectRemoteLifecycleWrite(
  commandName: RelayCliGatewayCommand,
  input: GatewayLifecycleInput
): void {
  const nodeId = gatewayLifecycleNodeId(input);
  if (nodeId && nodeId !== DEFAULT_LOCAL_NODE_ID) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'UNSUPPORTED',
        message:
          'repo/worktree lifecycle writes are local-only in v1; remote node mutation is unsupported until routed node worktree capabilities exist',
        retryable: false,
        details: { nodeId },
      }),
      1
    );
  }
}

function lifecycleRepoPath(
  commandName: RelayCliGatewayCommand,
  input: GatewayLifecycleInput
): string {
  if (typeof input['repoPath'] === 'string' && input['repoPath'].trim()) {
    return path.resolve(input['repoPath']);
  }
  const repoInstanceId = input.environment?.['repoInstanceId'];
  if (typeof repoInstanceId === 'string') {
    const parsed = parseRepoInstanceId(repoInstanceId);
    if (parsed?.nodeId === DEFAULT_LOCAL_NODE_ID) {
      return path.resolve(parsed.localPath);
    }
  }
  gatewayInvalid(
    commandName,
    'repoPath or local environment.repoInstanceId is required',
    {
      required: ['repoPath', 'environment.repoInstanceId'],
    }
  );
}

function lifecycleWorktreePath(
  commandName: RelayCliGatewayCommand,
  input: GatewayLifecycleInput
): string {
  if (
    typeof input['worktreePath'] === 'string' &&
    input['worktreePath'].trim()
  ) {
    return path.resolve(input['worktreePath']);
  }
  const benchId = input.environment?.['benchId'];
  if (typeof benchId === 'string') {
    const parsed = parseWorktreeInstanceId(benchId);
    if (parsed?.nodeId === DEFAULT_LOCAL_NODE_ID) {
      return path.resolve(parsed.localPath);
    }
  }
  const cwd = input.environment?.['cwd'];
  if (typeof cwd === 'string' && cwd.trim()) {
    return path.resolve(cwd);
  }
  gatewayInvalid(
    commandName,
    'worktreePath, local environment.benchId, or environment.cwd is required',
    {
      required: ['worktreePath', 'environment.benchId', 'environment.cwd'],
    }
  );
}

function parseLifecycleInput(
  commandName: RelayCliGatewayCommand,
  commandArgs: string[]
): GatewayLifecycleInput {
  const input = parseGatewayInputObject(commandName, commandArgs);
  const environment = gatewayLifecycleEnvironment(commandName, input);
  const lifecycleInput: GatewayLifecycleInput = { ...input };
  if (environment) lifecycleInput.environment = environment;
  return lifecycleInput;
}

async function assertGitRepoIfRequested(
  commandName: RelayCliGatewayCommand,
  input: Record<string, unknown>
): Promise<void> {
  if (input['requireGitRepo'] !== true) return;
  const repoPath = input['path'];
  if (typeof repoPath !== 'string' || !repoPath.trim()) return;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: path.resolve(repoPath), timeout: 5000 }
    );
    if (stdout.trim() === 'true') return;
  } catch {
    // fall through to fail-closed argument error
  }
  gatewayInvalid(commandName, 'path is not a git repo/worktree', {
    field: 'path',
  });
}

const CLI_GATEWAY_ACTOR_TOKEN_COMMANDS = new Set<RelayCliGatewayCommand>([
  'nodes.list',
  'nodes.pair.requests',
  'sessions.list',
  'sessions.get',
  'sessions.create',
  'sessions.screen',
  'work-contexts.get',
  'work-contexts.resume',
  // context/inbox mail loop: a scoped actor credential can create/read context
  // packets and send/read/transition its own inbox (server allowlist + capability
  // gates enforce scope). events.subscribe carries the inbox topic push channel.
  'context.create',
  'context.get',
  'context.list',
  'context.pin',
  'context.unpin',
  'inbox.send',
  'inbox.list',
  'inbox.get',
  'inbox.ack',
  'inbox.resolve',
  'inbox.ignore',
  'events.subscribe',
  'work-context-messages.list',
  'work-context-messages.show',
  'work-context-messages.query',
  'work-context-messages.templates.list',
  'work-context-messages.templates.show',
  'work-context-messages.templates.render',
  'work-context-artifacts.list',
  'work-context-artifacts.show',
  'work-context-artifacts.export',
  'work-context-artifacts.doctor',
  'handoff-artifacts.list',
  'handoff-artifacts.show',
  'handoff-artifacts.copy',
  'workflow-runs.publish',
  'workflow-runs.update',
  'workflow-runs.list',
  'workflow-runs.get',
  'inbox.send',
  'automation-runs.list',
  'automation-runs.get',
  'pr-overseer.list',
  'pr-overseer.get',
  'workspace-surfaces.list',
  'workspace-surfaces.publish',
  'workspace-topics.list',
  'workspace-topics.get',
  'workspace-topics.create',
  'workspace-topics.update',
  'workspace-topics.archive',
  'channels.list',
  'channels.get',
  'channels.run.get',
  'channels.history',
  'channels.subscribe',
  'channels.threads.history',
  'channels.roster',
  'channels.post',
  'cockpit.list',
  'cockpit.get',
]);

function gatewayActorToken(): string {
  return getArg('--actor-token') ?? process.env['RELAY_IDE_ACTOR_TOKEN'] ?? '';
}

function gatewayCorrelationId(): string | undefined {
  return getArg('--correlation-id') ?? process.env['RELAY_IDE_CORRELATION_ID'];
}

async function gatewayHttpJson(input: {
  commandName: RelayCliGatewayCommand;
  pathName: string;
  method?: string;
  body?: unknown;
  capabilities?: readonly string[];
  confirmationToken?: string;
}): Promise<unknown> {
  const actorToken = gatewayActorToken();
  if (actorToken && !CLI_GATEWAY_ACTOR_TOKEN_COMMANDS.has(input.commandName)) {
    gatewayInvalid(
      input.commandName,
      '--actor-token is only supported for scoped CLI gateway actor commands in this slice',
      {
        allowedCommands: Array.from(CLI_GATEWAY_ACTOR_TOKEN_COMMANDS),
      }
    );
  }
  const token = actorToken || (process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '');
  if (!token) {
    printGatewayEnvelope(
      gatewayError(input.commandName, {
        code: 'UNAUTHORIZED',
        message:
          'RELAY_IDE_ACTOR_TOKEN/--actor-token or RELAY_IDE_BROWSER_TOKEN not set. Use a scoped CLI actor credential for the actor lane or run from an authenticated Relay session.',
        retryable: false,
      }),
      1
    );
  }

  const port =
    getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-relay-cli-gateway': 'v1',
  };
  if (actorToken) {
    headers['x-relay-cli-actor-token'] = 'v1';
    headers['x-relay-cli-command'] = input.commandName;
  }
  const correlationId = gatewayCorrelationId();
  if (correlationId) headers['x-relay-correlation-id'] = correlationId;
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  if (input.capabilities?.length) {
    headers['x-relay-capabilities'] = input.capabilities.join(',');
  }
  if (input.confirmationToken?.trim()) {
    headers['x-confirmation-token'] = input.confirmationToken.trim();
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
  if (!id || id.startsWith('--'))
    gatewayInvalid(commandName, '--id is required');
  return id;
}

function gatewayUsage(): never {
  logger.error(
    'Usage: relay-ide v1 (--list|schema|nodes manifest|nodes list|sessions list|sessions get|sessions create|tickets start-work|branches open-session|sessions renew|sessions attach|sessions detach|sessions kill|sessions rename|sessions stream|sessions wait|sessions input|sessions interventions|files list|files stat|files read|files write|work-contexts get|work-contexts resume|context create|context get|context list|context pin|context unpin|work-context-artifacts publish|work-context-artifacts list|work-context-artifacts show|work-context-artifacts pin|work-context-artifacts unpin|work-context-artifacts export|work-context-artifacts doctor|handoff-artifacts attach|handoff-artifacts list|handoff-artifacts show|handoff-artifacts copy|channels post|cockpit list|cockpit get|inbox send|inbox list|inbox get|inbox ack|inbox resolve|inbox ignore|workflow-runs publish|workflow-runs update|workflow-runs list|workflow-runs get|handoffs plan|artifacts read|supervisor snapshot|supervisor sessions|supervisor send-text|supervisor submit|events subscribe|settings get|settings update|webhooks status|webhooks ping) --json'
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

// eslint-disable-next-line sonarjs/cognitive-complexity
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
  if (nodeSubcommand === 'pair') {
    const pairSubcommand = gatewayArgs[2];
    if (pairSubcommand === 'requests') {
      const input = parseGatewayInputObject(
        'nodes.pair.requests',
        gatewayArgs.slice(3)
      );
      const params = new URLSearchParams();
      if (typeof input['state'] === 'string' && input['state'].trim())
        params.set('state', input['state'].trim());
      if (typeof input['deviceCode'] === 'string' && input['deviceCode'].trim())
        params.set('deviceCode', input['deviceCode'].trim());
      if (input['includeResolved'] === true)
        params.set('includeResolved', 'true');
      const query = params.toString();
      const data = await gatewayHttpJson({
        commandName: 'nodes.pair.requests',
        pathName: `/hub/pairing/requests${query ? `?${query}` : ''}`,
        capabilities: ['session:read'],
      });
      printGatewayEnvelope(gatewayOk('nodes.pair.requests', data), 0);
    }
    if (pairSubcommand === 'approve') {
      const input = parseGatewayInputObject(
        'nodes.pair.approve',
        gatewayArgs.slice(3)
      );
      const requestId = input['requestId'];
      if (typeof requestId !== 'string' || !requestId.trim())
        gatewayInvalid('nodes.pair.approve', 'requestId is required', {
          field: 'requestId',
        });
      const body = { ...input };
      delete body['requestId'];
      delete body['confirmationToken'];
      const confirmationToken =
        typeof input['confirmationToken'] === 'string'
          ? input['confirmationToken']
          : undefined;
      const data = await gatewayHttpJson({
        commandName: 'nodes.pair.approve',
        pathName: `/hub/pairing/requests/${encodeURIComponent(requestId)}/approve`,
        method: 'POST',
        body,
        capabilities: ['session:create:terminal'],
        ...(confirmationToken ? { confirmationToken } : {}),
      });
      printGatewayEnvelope(gatewayOk('nodes.pair.approve', data), 0);
    }
    if (pairSubcommand === 'deny') {
      const input = parseGatewayInputObject(
        'nodes.pair.deny',
        gatewayArgs.slice(3)
      );
      const requestId = input['requestId'];
      if (typeof requestId !== 'string' || !requestId.trim())
        gatewayInvalid('nodes.pair.deny', 'requestId is required', {
          field: 'requestId',
        });
      const body =
        typeof input['reason'] === 'string' && input['reason'].trim()
          ? { reason: input['reason'].trim() }
          : {};
      const data = await gatewayHttpJson({
        commandName: 'nodes.pair.deny',
        pathName: `/hub/pairing/requests/${encodeURIComponent(requestId)}/deny`,
        method: 'POST',
        body,
        capabilities: ['session:read'],
      });
      printGatewayEnvelope(gatewayOk('nodes.pair.deny', data), 0);
    }
    if (pairSubcommand === 'edit-access') {
      const input = parseGatewayInputObject(
        'nodes.pair.editAccess',
        gatewayArgs.slice(3)
      );
      const requestId = input['requestId'];
      if (typeof requestId !== 'string' || !requestId.trim())
        gatewayInvalid('nodes.pair.editAccess', 'requestId is required', {
          field: 'requestId',
        });
      const body = { ...input };
      delete body['requestId'];
      const data = await gatewayHttpJson({
        commandName: 'nodes.pair.editAccess',
        pathName: `/hub/pairing/requests/${encodeURIComponent(requestId)}/access`,
        method: 'PATCH',
        body,
        capabilities: ['session:read'],
      });
      printGatewayEnvelope(gatewayOk('nodes.pair.editAccess', data), 0);
    }
  }
  if (nodeSubcommand === 'rotate-credential') {
    const input = parseGatewayInputObject(
      'nodes.rotateCredential',
      gatewayArgs.slice(2)
    );
    const nodeId = input['nodeId'];
    if (typeof nodeId !== 'string' || !nodeId.trim())
      gatewayInvalid('nodes.rotateCredential', 'nodeId is required', {
        field: 'nodeId',
      });
    const confirmationToken =
      typeof input['confirmationToken'] === 'string'
        ? input['confirmationToken']
        : undefined;
    const data = await gatewayHttpJson({
      commandName: 'nodes.rotateCredential',
      pathName: `/hub/nodes/${encodeURIComponent(nodeId)}/credential-rotation`,
      method: 'POST',
      body: { delivery: input['delivery'] === 'manual' ? 'manual' : 'online' },
      capabilities: ['session:read'],
      ...(confirmationToken ? { confirmationToken } : {}),
    });
    printGatewayEnvelope(gatewayOk('nodes.rotateCredential', data), 0);
  }
  if (nodeSubcommand === 'revoke') {
    const input = parseGatewayInputObject('nodes.revoke', gatewayArgs.slice(2));
    const nodeId = input['nodeId'];
    if (typeof nodeId !== 'string' || !nodeId.trim())
      gatewayInvalid('nodes.revoke', 'nodeId is required', { field: 'nodeId' });
    const confirmationToken =
      typeof input['confirmationToken'] === 'string'
        ? input['confirmationToken']
        : undefined;
    const data = await gatewayHttpJson({
      commandName: 'nodes.revoke',
      pathName: `/nodes/${encodeURIComponent(nodeId)}`,
      method: 'DELETE',
      capabilities: ['session:read'],
      ...(confirmationToken ? { confirmationToken } : {}),
    });
    printGatewayEnvelope(gatewayOk('nodes.revoke', data), 0);
  }
  gatewayInvalid('nodes.list', 'unknown nodes command', { args: gatewayArgs });
}

async function runGatewayRepos(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  if (subcommand === 'add') {
    const input = parseGatewayInputObject('repos.add', gatewayArgs.slice(2));
    if (typeof input['path'] !== 'string' || !input['path'].trim()) {
      gatewayInvalid('repos.add', 'path is required', { field: 'path' });
    }
    await assertGitRepoIfRequested('repos.add', input);
    const result = await gatewayHttpJson({
      commandName: 'repos.add',
      pathName: '/workspaces',
      method: 'POST',
      body: { path: input['path'] },
      capabilities: ['rpc:git:read', 'rpc:git:write'],
    });
    printGatewayEnvelope(gatewayOk('repos.add', result), 0);
  }
  gatewayInvalid('repos.add', 'unknown repos command', { args: gatewayArgs });
}

async function runGatewayWorkspaces(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  if (subcommand === 'launch') {
    const input = parseGatewayInputObject(
      'workspaces.launch',
      gatewayArgs.slice(2)
    );
    const workspaceId = input['workspaceId'];
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      gatewayInvalid('workspaces.launch', 'workspaceId is required', {
        field: 'workspaceId',
      });
    }
    const body = { ...input };
    delete body['workspaceId'];
    const result = await gatewayHttpJson({
      commandName: 'workspaces.launch',
      pathName: `/workspace-groups/${encodeURIComponent(workspaceId)}/session`,
      method: 'POST',
      body,
      capabilities: ['session:create:terminal'],
    });
    printGatewayEnvelope(gatewayOk('workspaces.launch', result), 0);
  }
  gatewayInvalid('workspaces.launch', 'unknown workspaces command', {
    args: gatewayArgs,
  });
}

async function runGatewayWorktreeStatus(
  commandName: RelayCliGatewayCommand,
  input: GatewayLifecycleInput
): Promise<Record<string, unknown>> {
  rejectRemoteLifecycleWrite(commandName, input);
  const worktreePath = lifecycleWorktreePath(commandName, input);
  const query = new URLSearchParams({ path: worktreePath });
  const result = await gatewayHttpJson({
    commandName,
    pathName: `/worktrees/status?${query.toString()}`,
    capabilities: ['session:read', 'rpc:git:read'],
  });
  return isGatewayRecord(result) ? result : {};
}

async function runGatewayWorktreeCleanup(
  commandName: 'worktrees.delete' | 'worktrees.archive',
  input: GatewayLifecycleInput
): Promise<never> {
  rejectRemoteLifecycleWrite(commandName, input);
  const repoPath = lifecycleRepoPath(commandName, input);
  const worktreePath = lifecycleWorktreePath(commandName, input);
  const force = input['force'] === true;
  const confirmationToken =
    typeof input['confirmationToken'] === 'string'
      ? input['confirmationToken'].trim()
      : '';
  const hasConfirmation = confirmationToken.length > 0;
  const statusInput: GatewayLifecycleInput = { worktreePath };
  if (input.environment) statusInput.environment = input.environment;
  const status = await runGatewayWorktreeStatus(commandName, statusInput);
  const activeSessions = Array.isArray(status['activeSessions'])
    ? status['activeSessions'].filter(
        (id): id is string => typeof id === 'string'
      )
    : [];
  const hasUncommittedChanges = status['hasUncommittedChanges'] === true;
  if (
    (activeSessions.length > 0 || hasUncommittedChanges) &&
    !force &&
    !hasConfirmation
  ) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'CONFIRMATION_REQUIRED',
        message:
          'worktree cleanup requires force or confirmationToken when active sessions or uncommitted changes are present',
        retryable: false,
        details: {
          activeSessionCount: activeSessions.length,
          hasUncommittedChanges,
        },
      }),
      1
    );
  }
  const deleteBranch = commandName === 'worktrees.delete';
  const result = await gatewayHttpJson({
    commandName,
    pathName: '/worktrees',
    method: 'DELETE',
    body: {
      repoPath,
      worktreePath,
      force: force || hasConfirmation,
      deleteBranch,
    },
    ...(hasConfirmation ? { confirmationToken } : {}),
    capabilities: [
      'session:read',
      'session:control:kill',
      'rpc:git:read',
      'rpc:git:write',
    ],
  });
  const data = isGatewayRecord(result) ? result : {};
  const branchDeleted = data['branchDeleted'] === true;
  printGatewayEnvelope(
    gatewayOk(commandName, {
      ok: true,
      action: commandName === 'worktrees.delete' ? 'delete' : 'archive',
      branchDeleted,
      audit: {
        repoPath,
        worktreePath,
        force: force || hasConfirmation,
        deleteBranch,
        branchDeleted,
      },
    }),
    0
  );
}

async function runGatewayWorktrees(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  if (subcommand === 'create') {
    const input = parseLifecycleInput('worktrees.create', gatewayArgs.slice(2));
    rejectRemoteLifecycleWrite('worktrees.create', input);
    const repoPath = lifecycleRepoPath('worktrees.create', input);
    const body: Record<string, unknown> = {};
    if (typeof input['branch'] === 'string' && input['branch'].trim()) {
      body['branch'] = input['branch'];
    }
    const query = new URLSearchParams({ path: repoPath });
    const result = await gatewayHttpJson({
      commandName: 'worktrees.create',
      pathName: `/workspaces/worktree?${query.toString()}`,
      method: 'POST',
      body,
      capabilities: ['rpc:git:read', 'rpc:git:write'],
    });
    printGatewayEnvelope(gatewayOk('worktrees.create', result), 0);
  }
  if (subcommand === 'status') {
    const input = parseLifecycleInput('worktrees.status', gatewayArgs.slice(2));
    const result = await runGatewayWorktreeStatus('worktrees.status', input);
    printGatewayEnvelope(gatewayOk('worktrees.status', result), 0);
  }
  if (subcommand === 'delete') {
    const input = parseLifecycleInput('worktrees.delete', gatewayArgs.slice(2));
    await runGatewayWorktreeCleanup('worktrees.delete', input);
  }
  if (subcommand === 'archive') {
    const input = parseLifecycleInput(
      'worktrees.archive',
      gatewayArgs.slice(2)
    );
    await runGatewayWorktreeCleanup('worktrees.archive', input);
  }
  gatewayInvalid('worktrees.status', 'unknown worktrees command', {
    args: gatewayArgs,
  });
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
  'mode',
  'contentBase64',
  'expectedHash',
] as const;

const gatewayFileAllowedFields = new Set<string>([
  ...gatewayFileStringFields,
  'maxEntries',
  'maxBytes',
  'maxLines',
  'permissions',
]);

function gatewayFileInputFromArgs(
  commandName: RelayCliGatewayCommand,
  fileArgs: string[]
): Record<string, unknown> {
  const inputJson = gatewayArg(fileArgs, '--input-json');
  if (inputJson) return parseGatewayJson(commandName, inputJson);
  const inputFile = gatewayArg(fileArgs, '--input-file');
  if (!inputFile) return gatewayFileInputFromFlags(commandName, fileArgs);
  try {
    return parseGatewayJson(
      commandName,
      fs.readFileSync(path.resolve(inputFile), 'utf8')
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gatewayInvalid(commandName, `could not read --input-file: ${message}`);
  }
}

function readFileArgStdin(commandName: RelayCliGatewayCommand): Buffer {
  if (process.stdin.isTTY) {
    gatewayInvalid(
      commandName,
      '--file - requires piped stdin (stdin is a TTY)',
      {
        field: 'file',
        reason: 'stdin_requires_pipe',
      }
    );
  }
  // fd 0 = stdin, portable on Windows and POSIX; cap at 2× write limit to guard OOM
  const buf = fs.readFileSync(0);
  if (buf.length > FILE_RPC_MAX_WRITE_BYTES * 2) {
    gatewayInvalid(
      commandName,
      `stdin exceeds maximum buffered size of ${FILE_RPC_MAX_WRITE_BYTES * 2} bytes`,
      {
        field: 'file',
        reason: 'size_exceeded',
        size: buf.length,
        max: FILE_RPC_MAX_WRITE_BYTES * 2,
      }
    );
  }
  return buf;
}

function readFileArgPath(
  commandName: RelayCliGatewayCommand,
  fileArg: string
): Buffer {
  const resolvedPath = path.resolve(fileArg);
  let stat: ReturnType<typeof fs.statSync>;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    gatewayInvalid(
      commandName,
      `cannot access --file path: ${err instanceof Error ? err.message : String(err)}`,
      {
        field: 'file',
        reason:
          code === 'ENOENT'
            ? 'not_found'
            : code === 'EACCES'
              ? 'permission_denied'
              : 'io_error',
      }
    );
  }
  if (stat!.isDirectory()) {
    gatewayInvalid(commandName, '--file path is a directory', {
      field: 'file',
      reason: 'is_directory',
    });
  }
  if (stat!.size > FILE_RPC_MAX_WRITE_BYTES) {
    gatewayInvalid(
      commandName,
      `file size exceeds maximum write size of ${FILE_RPC_MAX_WRITE_BYTES} bytes`,
      {
        field: 'file',
        reason: 'size_exceeded',
        size: stat!.size,
        max: FILE_RPC_MAX_WRITE_BYTES,
      }
    );
  }
  try {
    return fs.readFileSync(resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    gatewayInvalid(
      commandName,
      `could not read --file: ${err instanceof Error ? err.message : String(err)}`,
      {
        field: 'file',
        reason:
          code === 'ENOENT'
            ? 'not_found'
            : code === 'EACCES'
              ? 'permission_denied'
              : 'io_error',
      }
    );
  }
}

function gatewayFileInputFromFlags(
  commandName: RelayCliGatewayCommand,
  fileArgs: string[]
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const sessionId =
    gatewayArg(fileArgs, '--session-id') ??
    gatewayArg(fileArgs, '--id') ??
    fileArgs[0];
  if (sessionId && !sessionId.startsWith('--')) input['sessionId'] = sessionId;
  for (const [flag, field] of [
    ['--node-id', 'nodeId'],
    ['--path', 'path'],
    ['--cwd', 'cwd'],
    ['--confirmation-token', 'confirmationToken'],
    ['--mode', 'mode'],
    ['--expected-hash', 'expectedHash'],
  ] as const) {
    const value = gatewayArg(fileArgs, flag);
    if (value) input[field] = value;
  }
  const permissionsStr = gatewayArg(fileArgs, '--permissions');
  if (permissionsStr !== undefined) {
    input['permissions'] = parseInt(permissionsStr, 8);
  }
  const fileArg = gatewayArg(fileArgs, '--file');
  if (fileArg !== undefined) {
    const raw =
      fileArg === '-'
        ? readFileArgStdin(commandName)
        : readFileArgPath(commandName, fileArg);
    input['contentBase64'] = raw.toString('base64');
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
    gatewayInvalid(commandName, '--session-id is required', {
      field: 'sessionId',
    });
  }
  if (input['path'] === undefined) input['path'] = '.';
  if (typeof input['path'] !== 'string' || !input['path'].trim()) {
    gatewayInvalid(commandName, '--path must be a non-empty string', {
      field: 'path',
    });
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
    gatewayInvalid(
      commandName,
      `${field} must be a positive integer <= ${max}`,
      {
        field,
        value,
        max,
      }
    );
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
    if (value !== undefined)
      input['maxEntries'] = gatewayBoundedNumber(
        commandName,
        'maxEntries',
        value,
        500
      );
  }
  if (operation === 'read' || operation === 'tail') {
    const caps = [
      ['maxBytes', '--max-bytes', 65536],
      ['maxLines', '--max-lines', 2000],
    ] as const;
    for (const [field, flag, max] of caps) {
      const value = input[field] ?? gatewayArg(fileArgs, flag);
      if (value !== undefined)
        input[field] = gatewayBoundedNumber(commandName, field, value, max);
    }
  }
  if (operation === 'write') {
    // Validate and size-cap contentBase64
    if (typeof input['contentBase64'] === 'string') {
      const b64 = input['contentBase64'];
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        gatewayInvalid(commandName, 'contentBase64 is malformed base64', {
          field: 'contentBase64',
          reason: 'malformed_base64',
        });
      }
      const decodedBytes = Math.floor((b64.length * 3) / 4);
      if (decodedBytes > FILE_RPC_MAX_WRITE_BYTES) {
        gatewayInvalid(
          commandName,
          `file content exceeds maximum write size of ${FILE_RPC_MAX_WRITE_BYTES} bytes`,
          {
            field: 'contentBase64',
            decodedBytes,
            max: FILE_RPC_MAX_WRITE_BYTES,
          }
        );
      }
    }
    // Clamp permissions to 0..0o777 (0..511)
    if (input['permissions'] !== undefined) {
      const perms =
        typeof input['permissions'] === 'number'
          ? input['permissions']
          : Number(input['permissions']);
      if (!Number.isInteger(perms) || perms < 0 || perms > 0o777) {
        gatewayInvalid(
          commandName,
          'permissions must be an octal integer between 0 and 0o777 (511)',
          {
            field: 'permissions',
            value: input['permissions'],
          }
        );
      }
      input['permissions'] = perms & 0o777;
    }
  }
}

function assertGatewayFileAllowedFields(
  commandName: RelayCliGatewayCommand,
  operation: FileRpcOperation,
  input: Record<string, unknown>
): void {
  for (const field of Object.keys(input)) {
    if (!gatewayFileAllowedFields.has(field)) {
      gatewayInvalid(
        commandName,
        `files.${operation} field is not in the v1 contract: ${field}`,
        {
          field,
        }
      );
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
      'session:create:terminal',
      ...(validated.input['workspaceTopicId'] ? ['context:write'] : []),
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

async function runGatewaySessionKill(sessionArgs: string[]): Promise<never> {
  const { id: requestedId, confirmationToken } =
    parseGatewaySessionKillInput(sessionArgs);
  const session = await gatewaySessionDescriptor(requestedId, 'sessions.kill');
  const sessionId = session.id ?? requestedId;
  const result = await gatewayHttpJson({
    commandName: 'sessions.kill',
    pathName: session.nodeId
      ? `/hub/nodes/${encodeURIComponent(
          session.nodeId
        )}/sessions/${encodeURIComponent(sessionId)}`
      : `/sessions/${encodeURIComponent(sessionId)}`,
    method: 'DELETE',
    capabilities: ['session:read', 'session:control:kill'],
    ...(confirmationToken ? { confirmationToken } : {}),
  });
  printGatewayEnvelope(
    gatewayOk(
      'sessions.kill',
      gatewaySessionIdentityPayload(requestedId, sessionId, session, {
        ...(typeof result === 'object' && result !== null
          ? (result as Record<string, unknown>)
          : {}),
        ok: true,
        killed: true,
      })
    ),
    0
  );
}

async function runGatewaySessionRename(sessionArgs: string[]): Promise<never> {
  const { id: requestedId, displayName } =
    parseGatewaySessionRenameInput(sessionArgs);
  const session = await gatewaySessionDescriptor(
    requestedId,
    'sessions.rename'
  );
  const sessionId = session.id ?? requestedId;
  const result = await gatewayHttpJson({
    commandName: 'sessions.rename',
    pathName: session.nodeId
      ? `/hub/nodes/${encodeURIComponent(
          session.nodeId
        )}/sessions/${encodeURIComponent(sessionId)}`
      : `/sessions/${encodeURIComponent(sessionId)}`,
    method: 'PATCH',
    body: { displayName },
    capabilities: ['session:read', 'session:control:rename'],
  });
  printGatewayEnvelope(
    gatewayOk(
      'sessions.rename',
      gatewaySessionIdentityPayload(requestedId, sessionId, session, {
        ...(typeof result === 'object' && result !== null
          ? (result as Record<string, unknown>)
          : {}),
        renamed: true,
        displayName,
      })
    ),
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
    gatewayInvalid(
      commandName,
      `${flag} must be a positive integer <= ${max}`,
      {
        flag,
        value: raw,
        max,
      }
    );
  }
  return parsed;
}

function gatewayRequiredToken(commandName: RelayCliGatewayCommand): string {
  // The scoped actor lane (events.subscribe, etc.) prefers RELAY_IDE_ACTOR_TOKEN
  // / --actor-token; other WS paths (PTY streams) stay on the browser token.
  const actorToken = gatewayActorToken();
  const actorCapable = CLI_GATEWAY_ACTOR_TOKEN_COMMANDS.has(commandName);
  if (actorToken && actorCapable) {
    return actorToken;
  }
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';
  if (!token) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'UNAUTHORIZED',
        message: actorCapable
          ? 'RELAY_IDE_ACTOR_TOKEN/--actor-token or RELAY_IDE_BROWSER_TOKEN not set. Use a scoped CLI actor credential for the actor lane or run from an authenticated Relay session.'
          : 'RELAY_IDE_BROWSER_TOKEN not set. Run from an authenticated Relay session or set a scoped API token.',
        retryable: false,
      }),
      1
    );
  }
  return token;
}

function gatewayWsPort(): string {
  return (
    getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port)
  );
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
  if (message.includes('Unexpected server response: 401'))
    return 'UNAUTHORIZED';
  if (message.includes('Unexpected server response: 403')) return 'FORBIDDEN';
  if (message.includes('Unexpected server response: 404'))
    return 'NODE_OFFLINE';
  if (message.includes('ECONNREFUSED') || message.includes('connect'))
    return 'SERVER_UNAVAILABLE';
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

function gatewayTargetPayload(
  target: GatewayPtyTarget
): Record<string, unknown> {
  return {
    sessionId: target.sessionId,
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.globalSessionId
      ? { globalSessionId: target.globalSessionId }
      : {}),
  };
}

function writeGatewayNdjson(envelope: RelayCliGatewayEnvelope): boolean {
  return process.stdout.write(`${JSON.stringify(envelope)}
`);
}

/**
 * Write one streaming gateway frame without treating stdout's high-water mark
 * as a dropped frame. A piped consumer may intentionally close early (for
 * example, `head` after it has its result); EPIPE is therefore a clean local
 * cancellation signal, not a gateway failure to print over the broken pipe.
 */
function writeGatewayNdjsonDrained(
  envelope: RelayCliGatewayEnvelope
): Promise<boolean> {
  const payload = `${JSON.stringify(envelope)}\n`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let writeCompleted = false;
    let drainCompleted = false;
    let accepted = false;

    const cleanup = (): void => {
      process.stdout.removeListener('error', onError);
      process.stdout.removeListener('drain', onDrain);
    };
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishIfReady = (): void => {
      if (writeCompleted && (accepted || drainCompleted)) settle(true);
    };
    const onError = (error: Error): void => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        settle(false);
      } else {
        fail(error);
      }
    };
    const onDrain = (): void => {
      drainCompleted = true;
      finishIfReady();
    };
    const onWrite = (error?: Error | null): void => {
      if (error) {
        onError(error);
        return;
      }
      writeCompleted = true;
      finishIfReady();
    };

    process.stdout.once('error', onError);
    try {
      accepted = process.stdout.write(payload, onWrite);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!accepted) process.stdout.once('drain', onDrain);
  });
}

async function runGatewaySessionStream(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.stream', sessionArgs);
  const mode = gatewayArg(sessionArgs, '--mode') ?? 'ndjson';
  if (mode !== 'ndjson') {
    gatewayInvalid('sessions.stream', '--mode must be ndjson', {
      field: 'mode',
      value: mode,
    });
  }
  const maxEvents = gatewayOptionalPositiveInt(
    'sessions.stream',
    sessionArgs,
    '--max-events',
    10000
  );
  const maxBytes = gatewayOptionalPositiveInt(
    'sessions.stream',
    sessionArgs,
    '--max-bytes',
    1048576
  );
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

type GatewaySessionWaitPredicate =
  | { kind: 'output-text'; value: string }
  | { kind: 'idle-ms'; value: number };

function parseGatewaySessionWaitPredicate(
  sessionArgs: string[]
): GatewaySessionWaitPredicate {
  const outputText = gatewayArg(sessionArgs, '--output-text');
  const idleMs = gatewayOptionalPositiveInt(
    'sessions.wait',
    sessionArgs,
    '--idle-ms',
    300000
  );
  const screenText = gatewayArg(sessionArgs, '--screen-text');
  const providedCount = [
    outputText !== undefined,
    idleMs !== undefined,
    screenText !== undefined,
  ].filter(Boolean).length;

  if (providedCount !== 1) {
    gatewayInvalid(
      'sessions.wait',
      'exactly one of --output-text, --idle-ms, or --screen-text is required',
      {
        reasonCode:
          providedCount === 0
            ? 'WAIT_PREDICATE_REQUIRED'
            : 'WAIT_PREDICATES_MIXED',
        predicates: {
          outputText: outputText !== undefined,
          idleMs: idleMs !== undefined,
          screenText: screenText !== undefined,
        },
      }
    );
  }

  if (screenText !== undefined) {
    printGatewayEnvelope(
      gatewayError('sessions.wait', {
        code: 'UNSUPPORTED',
        message:
          'sessions.wait --screen-text requires rendered-screen matching, which is not implemented by the raw-output MVP',
        retryable: false,
        details: {
          reasonCode: 'RENDERED_SCREEN_UNSUPPORTED',
          model: 'rendered-screen',
          supportedModels: ['raw-output'],
          predicate: { kind: 'screen-text', value: screenText },
        },
      }),
      1
    );
  }

  if (outputText !== undefined)
    return { kind: 'output-text', value: outputText };
  return { kind: 'idle-ms', value: idleMs! };
}

async function runGatewaySessionWait(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.wait', sessionArgs);
  const predicate = parseGatewaySessionWaitPredicate(sessionArgs);
  const timeoutMs =
    gatewayOptionalPositiveInt(
      'sessions.wait',
      sessionArgs,
      '--timeout-ms',
      300000
    ) ?? 30000;
  const maxBytes =
    gatewayOptionalPositiveInt(
      'sessions.wait',
      sessionArgs,
      '--max-bytes',
      1048576
    ) ?? 65536;
  const target = await resolveGatewayPtyTarget(id, 'sessions.wait');
  const { ws, opened } = gatewayCreatePtyWebSocket('sessions.wait', target);
  const startedAt = Date.now();
  let outputWindow = '';
  let bytesObserved = 0;
  let truncated = false;
  let settled = false;
  const waitTimers: { timeout?: NodeJS.Timeout; idle?: NodeJS.Timeout } = {};

  const elapsedMs = (): number => Math.max(0, Date.now() - startedAt);

  const clearWaitTimers = (): void => {
    if (waitTimers.timeout) clearTimeout(waitTimers.timeout);
    if (waitTimers.idle) clearTimeout(waitTimers.idle);
  };

  const closeWaitSocket = (code: number, reason: string): void => {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  };

  const finishOk = (status: 'matched' | 'idle'): void => {
    if (settled) return;
    settled = true;
    clearWaitTimers();
    closeWaitSocket(1000, 'sessions.wait complete');
    printGatewayEnvelope(
      gatewayOk('sessions.wait', {
        model: 'raw-output',
        status,
        ...gatewayTargetPayload(target),
        predicate,
        elapsedMs: elapsedMs(),
        bytesObserved,
        truncated,
        timeoutMs,
        maxBytes,
      }),
      0
    );
  };

  const finishError = (
    reasonCode: string,
    message: string,
    extraDetails: Record<string, unknown> = {},
    code: RelayCliGatewayErrorCode = 'UPSTREAM_ERROR',
    retryable = true
  ): void => {
    if (settled) return;
    settled = true;
    clearWaitTimers();
    closeWaitSocket(1011, reasonCode);
    printGatewayEnvelope(
      gatewayError('sessions.wait', {
        code,
        message,
        retryable,
        details: {
          reasonCode,
          model: 'raw-output',
          ...gatewayTargetPayload(target),
          predicate,
          elapsedMs: elapsedMs(),
          bytesObserved,
          truncated,
          timeoutMs,
          maxBytes,
          ...extraDetails,
        },
      }),
      1
    );
  };

  const refreshIdleTimer = (): void => {
    if (predicate.kind !== 'idle-ms') return;
    if (waitTimers.idle) clearTimeout(waitTimers.idle);
    waitTimers.idle = setTimeout(() => finishOk('idle'), predicate.value);
    waitTimers.idle.unref?.();
  };

  const outputDecoder = new StringDecoder('utf8');

  const observeWaitOutput = (data: RawData): void => {
    const frame = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    const nextBytes = frame.byteLength;
    const remainingBytes = Math.max(0, maxBytes - bytesObserved);
    const exceedsMaxBytes = nextBytes > remainingBytes;
    const observedBytes = exceedsMaxBytes ? remainingBytes : nextBytes;
    const observedFrame = exceedsMaxBytes
      ? frame.subarray(0, observedBytes)
      : frame;

    bytesObserved += observedBytes;
    if (exceedsMaxBytes) truncated = true;
    if (observedBytes > 0) refreshIdleTimer();
    if (predicate.kind === 'output-text') {
      outputWindow +=
        observedBytes > 0 ? outputDecoder.write(observedFrame) : '';
      if (outputWindow.includes(predicate.value)) {
        finishOk('matched');
        return;
      }
      outputWindow = retainOutputPredicateSuffix(outputWindow, predicate.value);
    }

    if (exceedsMaxBytes) {
      finishError(
        'WAIT_MAX_BYTES_EXCEEDED',
        `PTY output exceeded maxBytes before sessions.wait predicate completed`,
        { status: 'max-bytes' }
      );
    }
  };

  waitTimers.timeout = setTimeout(() => {
    finishError(
      'WAIT_TIMEOUT',
      predicate.kind === 'output-text'
        ? `timed out waiting for raw PTY output: ${predicate.value}`
        : `timed out waiting for PTY idle period: ${predicate.value}ms`,
      { status: 'timeout' }
    );
  }, timeoutMs);
  waitTimers.timeout.unref?.();

  ws.on('message', (data) => {
    if (settled) return;
    observeWaitOutput(data);
  });

  ws.once('close', (code, reason) => {
    if (settled) return;
    finishError(
      'SESSION_STREAM_CLOSED',
      'PTY stream closed before sessions.wait completed',
      {
        status: 'closed',
        closeCode: code,
        reason: reason.toString('utf8'),
      }
    );
  });
  ws.once('error', (error) => {
    if (settled) return;
    const message = error instanceof Error ? error.message : String(error);
    finishError(
      'PTY_STREAM_ERROR',
      `PTY stream error: ${message}`,
      {},
      gatewayWsErrorCode(message)
    );
  });

  await opened;
  refreshIdleTimer();
  await new Promise(() => {});
  process.exit(0);
}

function gatewayInputData(sessionArgs: string[]): string {
  const data = gatewayArg(sessionArgs, '--data');
  const dataBase64 = gatewayArg(sessionArgs, '--data-base64');
  const stdin = sessionArgs.includes('--stdin');
  const sourceCount = [
    data !== undefined,
    dataBase64 !== undefined,
    stdin,
  ].filter(Boolean).length;
  if (sourceCount !== 1) {
    gatewayInvalid(
      'sessions.input',
      'exactly one of --data, --data-base64, or --stdin is required'
    );
  }
  if (data !== undefined) return data;
  if (dataBase64 !== undefined)
    return Buffer.from(dataBase64, 'base64').toString('utf8');
  return fs.readFileSync(0, 'utf8');
}

async function runGatewaySessionScreen(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.screen', sessionArgs);
  const maxLines = gatewayOptionalPositiveInt(
    'sessions.screen',
    sessionArgs,
    '--max-lines',
    1000
  );
  const includeScrollback = sessionArgs.includes('--scrollback');
  const query = new URLSearchParams();
  if (includeScrollback) query.set('scrollback', '1');
  if (maxLines !== undefined) query.set('maxLines', String(maxLines));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await gatewayHttpJson({
    commandName: 'sessions.screen',
    pathName: `/sessions/${encodeURIComponent(id)}/screen${suffix}`,
    capabilities: ['session:read'],
  });
  printGatewayEnvelope(gatewayOk('sessions.screen', data), 0);
}

async function runGatewaySessionInput(sessionArgs: string[]): Promise<never> {
  const id = requireGatewaySessionId('sessions.input', sessionArgs);
  const input = gatewayInputData(sessionArgs);
  const waitFor = gatewayArg(sessionArgs, '--wait-for');
  const timeoutMs =
    gatewayOptionalPositiveInt(
      'sessions.input',
      sessionArgs,
      '--timeout-ms',
      300000
    ) ?? 5000;
  const maxBytes =
    gatewayOptionalPositiveInt(
      'sessions.input',
      sessionArgs,
      '--max-bytes',
      1048576
    ) ?? 65536;
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
    ? setTimeout(
        () => fail(`timed out waiting for PTY output: ${waitFor}`),
        timeoutMs
      )
    : undefined;
  timer?.unref?.();

  ws.on('message', (data) => {
    if (settled) return;
    const text = data.toString('utf8');
    const nextBytes = Buffer.byteLength(text, 'utf8');
    if (bytesReceived + nextBytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - bytesReceived);
      output += Buffer.from(text, 'utf8')
        .subarray(0, remaining)
        .toString('utf8');
      bytesReceived = maxBytes;
      truncated = true;
      // Without --wait-for this is fire-and-forget: the attach replay can
      // exceed maxBytes on its own, which must not turn a delivered write
      // into an error envelope. The 10ms post-send finish() still runs.
      if (waitFor) fail(`PTY output exceeded maxBytes before waitFor matched`);
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
      gatewayInvalid(
        'sessions.renew',
        '--ttl-seconds must be a positive number',
        {
          field: 'ttlSeconds',
          value: ttlSeconds,
        }
      );
    }
    input['ttlSeconds'] = numeric;
  }
  if (input['expiresAt'] === undefined && input['ttlSeconds'] === undefined) {
    gatewayInvalid(
      'sessions.renew',
      '--ttl-seconds or --expires-at is required'
    );
  }

  let sessionId = requestedId;
  if (!input['nodeId']) {
    const session = await gatewaySessionDescriptor(
      requestedId,
      'sessions.renew'
    );
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

async function runGatewaySessionInterventions(
  sessionArgs: string[]
): Promise<never> {
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

async function runGatewaySessions(gatewayArgs: string[]): Promise<never> {
  const sessionSubcommand = gatewayArgs[1];
  const sessionArgs = gatewayArgs.slice(2);
  if (sessionSubcommand === 'list') return runGatewaySessionList();
  if (sessionSubcommand === 'get') return runGatewaySessionGet(sessionArgs);
  if (sessionSubcommand === 'create')
    return runGatewaySessionCreate(sessionArgs);
  if (sessionSubcommand === 'renew') return runGatewaySessionRenew(sessionArgs);
  if (sessionSubcommand === 'attach')
    return runGatewaySessionAttach(sessionArgs);
  if (sessionSubcommand === 'detach')
    return runGatewaySessionDetach(sessionArgs);
  if (sessionSubcommand === 'kill') return runGatewaySessionKill(sessionArgs);
  if (sessionSubcommand === 'rename')
    return runGatewaySessionRename(sessionArgs);
  if (sessionSubcommand === 'stream')
    return runGatewaySessionStream(sessionArgs);
  if (sessionSubcommand === 'wait') return runGatewaySessionWait(sessionArgs);
  if (sessionSubcommand === 'screen')
    return runGatewaySessionScreen(sessionArgs);
  if (sessionSubcommand === 'input') return runGatewaySessionInput(sessionArgs);
  if (sessionSubcommand === 'interventions') {
    return runGatewaySessionInterventions(sessionArgs);
  }
  gatewayInvalid('sessions.list', 'unknown sessions command', {
    args: gatewayArgs,
  });
}

async function runGatewayTickets(gatewayArgs: string[]): Promise<never> {
  const ticketSubcommand = gatewayArgs[1];
  if (ticketSubcommand === 'start-work') {
    return runGatewayWorkflow('tickets.startWork', gatewayArgs.slice(2));
  }
  gatewayInvalid('tickets.startWork', 'unknown tickets command', {
    args: gatewayArgs,
  });
}

async function runGatewayBranches(gatewayArgs: string[]): Promise<never> {
  const branchSubcommand = gatewayArgs[1];
  if (branchSubcommand === 'open-session') {
    return runGatewayWorkflow('branches.openSession', gatewayArgs.slice(2));
  }
  gatewayInvalid('branches.openSession', 'unknown branches command', {
    args: gatewayArgs,
  });
}

async function runGatewayFiles(gatewayArgs: string[]): Promise<never> {
  const operation = gatewayArgs[1];
  if (!isFileRpcOperation(operation)) {
    gatewayInvalid('files.list', 'unknown files command', {
      args: gatewayArgs,
    });
  }
  const commandName = `files.${operation}` as RelayCliGatewayCommand;
  const input = parseGatewayFileInput(operation, gatewayArgs.slice(2));
  const requestedSessionId = input['sessionId'] as string;
  let nodeId =
    typeof input['nodeId'] === 'string' ? input['nodeId'] : undefined;
  let sessionId = requestedSessionId;
  if (!nodeId) {
    const session = await gatewaySessionDescriptor(
      requestedSessionId,
      commandName
    );
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
  const bodyFields =
    operation === 'write'
      ? [
          'path',
          'cwd',
          'mode',
          'contentBase64',
          'expectedHash',
          'permissions',
          'confirmationToken',
        ]
      : [
          'path',
          'cwd',
          'maxEntries',
          'maxBytes',
          'maxLines',
          'confirmationToken',
        ];
  for (const field of bodyFields) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  let capabilities: string[];
  if (operation === 'list') {
    capabilities = ['session:read', 'rpc:fs:list'];
  } else if (operation === 'write') {
    capabilities = ['session:read', 'rpc:fs:write'];
  } else {
    capabilities = ['session:read', 'rpc:fs:read'];
  }
  const result = await gatewayHttpJson({
    commandName,
    pathName: `/hub/nodes/${encodeURIComponent(nodeId)}/sessions/${encodeURIComponent(
      sessionId
    )}/files/${operation}`,
    method: 'POST',
    body,
    capabilities,
  });
  printGatewayEnvelope(gatewayOk(commandName, result), 0);
}

async function runGatewayWorkContexts(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const workContextArgs = gatewayArgs.slice(2);
  if (subcommand === 'get') {
    const id = gatewayArg(workContextArgs, '--id') ?? workContextArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('work-contexts.get', '--id is required');
    const result = await gatewayHttpJson({
      commandName: 'work-contexts.get',
      pathName: `/work-contexts/${encodeURIComponent(id)}`,
      capabilities: ['session:read'],
    });
    printGatewayEnvelope(gatewayOk('work-contexts.get', result), 0);
  }

  if (subcommand === 'resume') {
    const commandName: RelayCliGatewayCommand = 'work-contexts.resume';
    const id = gatewayArg(workContextArgs, '--id') ?? workContextArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const query = new URLSearchParams();
    const currentHeadSha = gatewayArg(workContextArgs, '--current-head-sha');
    const maxArtifacts = gatewayArg(workContextArgs, '--max-artifacts');
    const maxAuditRefs = gatewayArg(workContextArgs, '--max-audit-refs');
    const maxChars = gatewayArg(workContextArgs, '--max-chars');
    if (currentHeadSha) query.set('currentHeadSha', currentHeadSha);
    if (maxArtifacts) query.set('maxArtifacts', maxArtifacts);
    if (maxAuditRefs) query.set('maxAuditRefs', maxAuditRefs);
    if (maxChars) query.set('maxChars', maxChars);
    if (workContextArgs.includes('--public')) query.set('public', 'true');
    const suffix = query.toString();
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-contexts/${encodeURIComponent(id)}/resume${suffix ? `?${suffix}` : ''}`,
      capabilities: ['session:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  gatewayInvalid('work-contexts.get', 'unknown work-contexts command', {
    args: gatewayArgs,
  });
}

async function runGatewayContext(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const contextArgs = gatewayArgs.slice(2);
  if (subcommand === 'create') {
    const input = parseGatewayInputObject('context.create', contextArgs);
    const result = await gatewayHttpJson({
      commandName: 'context.create',
      pathName: '/context',
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('context.create', result), 0);
  }
  if (subcommand === 'get') {
    const id = gatewayArg(contextArgs, '--id') ?? contextArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('context.get', '--id is required');
    const result = await gatewayHttpJson({
      commandName: 'context.get',
      pathName: `/context/${encodeURIComponent(id)}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('context.get', result), 0);
  }
  if (subcommand === 'list') {
    const query = new URLSearchParams();
    const nodeId = gatewayArg(contextArgs, '--node-id');
    const workspaceId = gatewayArg(contextArgs, '--workspace-id');
    const workContextId = gatewayArg(contextArgs, '--work-context-id');
    const limit = gatewayArg(contextArgs, '--limit');
    if (nodeId) query.set('nodeId', nodeId);
    if (workspaceId) query.set('workspaceId', workspaceId);
    if (workContextId) query.set('workContextId', workContextId);
    if (limit) query.set('limit', limit);
    const suffix = query.toString();
    const result = await gatewayHttpJson({
      commandName: 'context.list',
      pathName: suffix ? `/context?${suffix}` : '/context',
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('context.list', result), 0);
  }
  if (subcommand === 'pin' || subcommand === 'unpin') {
    const commandName: RelayCliGatewayCommand =
      subcommand === 'pin' ? 'context.pin' : 'context.unpin';
    const input = parseGatewayInputObject(commandName, contextArgs);
    const id =
      gatewayArg(contextArgs, '--id') ??
      contextArgs[0] ??
      (typeof input['id'] === 'string' ? input['id'] : undefined);
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const workContextId =
      gatewayArg(contextArgs, '--work-context-id') ??
      (typeof input['workContextId'] === 'string'
        ? input['workContextId']
        : undefined);
    if (!workContextId) {
      gatewayInvalid(commandName, '--work-context-id is required', {
        field: 'workContextId',
      });
    }
    const actorId = gatewayArg(contextArgs, '--actor-id');
    const createdBy = gatewayArg(contextArgs, '--created-by');
    const body: Record<string, unknown> = { ...input, workContextId };
    if (actorId) body['actorId'] = actorId;
    if (createdBy) body['createdBy'] = createdBy;
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/context/${encodeURIComponent(id)}/${subcommand}`,
      method: 'POST',
      body,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  gatewayInvalid('context.get', 'unknown context command', {
    args: gatewayArgs,
  });
}

async function runGatewayInbox(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const inboxArgs = gatewayArgs.slice(2);
  if (subcommand === 'send') {
    const input = parseGatewayInputObject('inbox.send', inboxArgs);
    const result = await gatewayHttpJson({
      commandName: 'inbox.send',
      pathName: '/inbox',
      method: 'POST',
      body: input,
      capabilities: ['inbox:write'],
    });
    printGatewayEnvelope(gatewayOk('inbox.send', result), 0);
  }
  if (subcommand === 'list') {
    const query = new URLSearchParams();
    const targetSessionId = gatewayArg(inboxArgs, '--target-session-id');
    const targetWorkContextId = gatewayArg(
      inboxArgs,
      '--target-work-context-id'
    );
    const state = gatewayArg(inboxArgs, '--state');
    const limit = gatewayArg(inboxArgs, '--limit');
    if (targetSessionId) query.set('targetSessionId', targetSessionId);
    if (targetWorkContextId)
      query.set('targetWorkContextId', targetWorkContextId);
    if (state) query.set('state', state);
    if (limit) query.set('limit', limit);
    const suffix = query.toString();
    const result = await gatewayHttpJson({
      commandName: 'inbox.list',
      pathName: suffix ? `/inbox?${suffix}` : '/inbox',
      capabilities: ['inbox:read'],
    });
    printGatewayEnvelope(gatewayOk('inbox.list', result), 0);
  }
  if (subcommand === 'get') {
    const id = gatewayArg(inboxArgs, '--id') ?? inboxArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('inbox.get', '--id is required');
    const result = await gatewayHttpJson({
      commandName: 'inbox.get',
      pathName: `/inbox/${encodeURIComponent(id)}`,
      capabilities: ['inbox:read'],
    });
    printGatewayEnvelope(gatewayOk('inbox.get', result), 0);
  }
  if (
    subcommand === 'ack' ||
    subcommand === 'resolve' ||
    subcommand === 'ignore'
  ) {
    const commandName =
      subcommand === 'ack'
        ? 'inbox.ack'
        : subcommand === 'resolve'
          ? 'inbox.resolve'
          : 'inbox.ignore';
    const id = gatewayArg(inboxArgs, '--id') ?? inboxArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const actorId = gatewayArg(inboxArgs, '--actor-id');
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/inbox/${encodeURIComponent(id)}/${subcommand}`,
      method: 'POST',
      body: actorId ? { actorId } : {},
      capabilities: ['inbox:write'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  gatewayInvalid('inbox.get', 'unknown inbox command', { args: gatewayArgs });
}

async function runGatewayHandoffs(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const handoffArgs = gatewayArgs.slice(2);
  if (subcommand === 'plan') {
    const input = parseGatewayInputObject('handoffs.plan', handoffArgs);
    const result = await gatewayHttpJson({
      commandName: 'handoffs.plan',
      pathName: '/handoffs/plan',
      method: 'POST',
      body: input,
      capabilities: ['session:read', 'rpc:fs:read'],
    });
    printGatewayEnvelope(gatewayOk('handoffs.plan', result), 0);
  }
  gatewayInvalid('handoffs.plan', 'unknown handoffs command', {
    args: gatewayArgs,
  });
}

async function runGatewaySupervisorSessions(): Promise<never> {
  const result = await gatewayHttpJson({
    commandName: 'supervisor.sessions',
    pathName: '/supervisor/sessions',
    capabilities: ['session:read', 'tab:intervention:read'],
  });
  printGatewayEnvelope(gatewayOk('supervisor.sessions', result), 0);
}

function parseGatewaySupervisorActionBody(
  commandName:
    | 'supervisor.sendText'
    | 'supervisor.sendKey'
    | 'supervisor.submit',
  supervisorArgs: string[]
): Record<string, unknown> {
  const body = parseGatewayInputObject(commandName, supervisorArgs);
  const id = gatewayArg(supervisorArgs, '--id') ?? supervisorArgs[0];
  if (
    id &&
    !id.startsWith('--') &&
    body['id'] === undefined &&
    body['targetIds'] === undefined
  ) {
    body['id'] = id;
  }
  const targetIds = gatewayArg(supervisorArgs, '--target-ids');
  if (targetIds && body['targetIds'] === undefined) {
    body['targetIds'] = targetIds
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const text = gatewayArg(supervisorArgs, '--text');
  if (
    (commandName === 'supervisor.sendText' ||
      commandName === 'supervisor.submit') &&
    text !== undefined &&
    body['text'] === undefined
  ) {
    body['text'] = text;
  }
  const key = gatewayArg(supervisorArgs, '--key');
  if (
    commandName === 'supervisor.sendKey' &&
    key !== undefined &&
    body['key'] === undefined
  ) {
    body['key'] = key;
  }
  // Submit-only boolean flags (#958).
  if (commandName === 'supervisor.submit') {
    if (
      supervisorArgs.includes('--clear-input') &&
      body['clearInput'] === undefined
    ) {
      body['clearInput'] = true;
    }
    if (supervisorArgs.includes('--paste') && body['paste'] === undefined) {
      body['paste'] = true;
    }
    if (supervisorArgs.includes('--dry-run') && body['dryRun'] === undefined) {
      body['dryRun'] = true;
    }
  }
  return body;
}

function validateGatewaySupervisorActionBody(
  commandName:
    | 'supervisor.sendText'
    | 'supervisor.sendKey'
    | 'supervisor.submit',
  body: Record<string, unknown>
): void {
  if (
    commandName === 'supervisor.sendText' &&
    (typeof body['text'] !== 'string' || body['text'].length === 0)
  ) {
    gatewayInvalid(commandName, '--text is required for supervisor send-text', {
      field: 'text',
    });
  }
  if (
    commandName === 'supervisor.sendKey' &&
    (typeof body['key'] !== 'string' || body['key'].length === 0)
  ) {
    gatewayInvalid(commandName, '--key is required for supervisor send-key', {
      field: 'key',
    });
  }
  if (
    commandName === 'supervisor.sendKey' &&
    typeof body['key'] === 'string' &&
    !(SUPERVISOR_SEND_KEY_NAMES as readonly string[]).includes(body['key'])
  ) {
    gatewayInvalid(
      commandName,
      '--key must be one canonical supervisor key name',
      {
        field: 'key',
        allowedKeys: SUPERVISOR_SEND_KEY_NAMES,
      }
    );
  }
  const id = body['id'];
  const targetIds = body['targetIds'];
  const hasId = typeof id === 'string' && id.trim().length > 0;
  if (targetIds !== undefined && !Array.isArray(targetIds)) {
    gatewayInvalid(
      commandName,
      '--target-ids must be a non-empty list of session ids',
      {
        field: 'targetIds',
      }
    );
  }
  const hasTargetIds = Array.isArray(targetIds);
  if (hasTargetIds) {
    const validTargetIds =
      targetIds.length > 0 &&
      targetIds.every(
        (entry) => typeof entry === 'string' && entry.trim().length > 0
      );
    if (!validTargetIds) {
      gatewayInvalid(
        commandName,
        '--target-ids must be a non-empty list of session ids',
        {
          field: 'targetIds',
        }
      );
    }
  }
  if (hasId === hasTargetIds) {
    gatewayInvalid(
      commandName,
      'exactly one of --id or --target-ids is required',
      { field: 'id' }
    );
  }
}

async function runGatewaySupervisorAction(
  subcommand: string,
  supervisorArgs: string[]
): Promise<never> {
  const action: SupervisorActionType =
    subcommand === 'submit'
      ? 'submit'
      : subcommand === 'send-key' || subcommand === 'sendKey'
        ? 'sendKey'
        : 'sendText';
  const commandName = supervisorActionCommandId(action);
  const body = parseGatewaySupervisorActionBody(commandName, supervisorArgs);
  validateGatewaySupervisorActionBody(commandName, body);
  // A submit that carries an inline text body must also present the send-text
  // capability so the hub accepts the typed content (#958).
  const capabilities =
    action === 'submit'
      ? supervisorSubmitRequiredCapabilities(
          typeof body['text'] === 'string' && body['text'].length > 0
        )
      : supervisorActionRequiredCapabilities(action);
  const result = await gatewayHttpJson({
    commandName,
    pathName: `/supervisor/actions/${action}`,
    method: 'POST',
    body,
    capabilities,
  });
  printGatewayEnvelope(gatewayOk(commandName, result), 0);
}

function parseGatewaySupervisorSnapshotPolicy(supervisorArgs: string[]): {
  expectedControlMode?: 'human-driven';
  latestSeenInterventionEventId?: string;
} {
  const expectedControlMode = gatewayArg(
    supervisorArgs,
    '--expected-control-mode'
  );
  const policy: {
    expectedControlMode?: 'human-driven';
    latestSeenInterventionEventId?: string;
  } = {};
  if (expectedControlMode !== undefined) {
    if (expectedControlMode !== 'human-driven') {
      gatewayInvalid(
        'supervisor.snapshot',
        '--expected-control-mode is invalid',
        {
          field: 'expectedControlMode',
          value: expectedControlMode,
        }
      );
    }
    policy.expectedControlMode = expectedControlMode;
  }
  const latestSeenInterventionEventId = gatewayArg(
    supervisorArgs,
    '--latest-seen-intervention-event-id'
  );
  if (latestSeenInterventionEventId)
    policy.latestSeenInterventionEventId = latestSeenInterventionEventId;
  return policy;
}

async function runGatewaySupervisorSnapshot(
  supervisorArgs: string[]
): Promise<never> {
  const id = requireGatewaySessionId('supervisor.snapshot', supervisorArgs);
  const session = await gatewayHttpJson({
    commandName: 'supervisor.snapshot',
    pathName: `/sessions/${encodeURIComponent(id)}`,
    capabilities: ['session:read', 'tab:intervention:read'],
  });
  const result = await createSupervisorSnapshot({
    session: session as SessionSummary,
    grantedCapabilities: ['session:read', 'tab:intervention:read'],
    policy: parseGatewaySupervisorSnapshotPolicy(supervisorArgs),
  });
  if (result.ok === false) {
    printGatewayEnvelope(
      gatewayError('supervisor.snapshot', {
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
        details: { audit: result.audit },
      }),
      1
    );
  }
  printGatewayEnvelope(
    gatewayOk('supervisor.snapshot', {
      snapshot: result.snapshot,
      audit: result.audit,
    }),
    0
  );
}

async function runGatewaySupervisor(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const supervisorArgs = gatewayArgs.slice(2);
  if (subcommand === 'sessions') return runGatewaySupervisorSessions();
  if (
    subcommand === 'send-text' ||
    subcommand === 'sendText' ||
    subcommand === 'send-key' ||
    subcommand === 'sendKey' ||
    subcommand === 'submit'
  ) {
    return runGatewaySupervisorAction(subcommand, supervisorArgs);
  }
  if (subcommand === 'snapshot')
    return runGatewaySupervisorSnapshot(supervisorArgs);
  gatewayInvalid('supervisor.snapshot', 'unknown supervisor command', {
    args: gatewayArgs,
  });
}

function gatewayReadJsonFile(
  commandName: RelayCliGatewayCommand,
  filePath: string
): Record<string, unknown> {
  try {
    return parseGatewayJson(
      commandName,
      fs.readFileSync(path.resolve(filePath), 'utf8')
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gatewayInvalid(commandName, `could not read JSON file: ${message}`);
  }
}

function workContextArtifactTaskRefFromArgs(
  commandName: RelayCliGatewayCommand,
  args: string[]
): Record<string, unknown> | undefined {
  const kind = gatewayArg(args, '--task-ref-kind');
  const id = gatewayArg(args, '--task-ref-id');
  if (!kind && !id) return undefined;
  if (!kind || !id) {
    gatewayInvalid(
      commandName,
      '--task-ref-kind and --task-ref-id are both required'
    );
  }
  return { kind, id };
}

function addWorkContextArtifactBodyFlags(
  commandName: RelayCliGatewayCommand,
  body: Record<string, unknown>,
  args: string[]
): Record<string, unknown> {
  const mappings = [
    ['--work-context-id', 'workContextId'],
    ['--project-id', 'projectId'],
    ['--stage', 'stage'],
    ['--visibility', 'visibility'],
    ['--actor-id', 'actorId'],
    ['--provenance-actor-id', 'provenanceActorId'],
    ['--current-head-sha', 'currentHeadSha'],
    ['--kind', 'kind'],
    ['--title', 'title'],
    ['--summary', 'summary'],
    ['--supersedes-artifact-id', 'supersedesArtifactId'],
  ] as const;
  for (const [flag, key] of mappings) {
    const value = gatewayArg(args, flag);
    if (value !== undefined) body[key] = value;
  }
  const taskRef = workContextArtifactTaskRefFromArgs(commandName, args);
  if (taskRef) body['taskRef'] = taskRef;
  if (args.includes('--pin')) body['pin'] = true;
  const artifactFile = gatewayArg(args, '--artifact-file');
  const viewFile = gatewayArg(args, '--view-file');
  if (artifactFile && viewFile) {
    gatewayInvalid(
      commandName,
      '--artifact-file and --view-file are mutually exclusive'
    );
  }
  if (artifactFile && body['artifact'] === undefined) {
    body['artifact'] = gatewayReadJsonFile(commandName, artifactFile);
  }
  if (viewFile && body['viewArtifact'] === undefined) {
    body['viewArtifact'] = gatewayReadJsonFile(commandName, viewFile);
  }
  return body;
}

async function runGatewayWorkContextArtifacts(
  gatewayArgs: string[]
): Promise<never> {
  const subcommand = gatewayArgs[1];
  const artifactArgs = gatewayArgs.slice(2);
  if (subcommand === 'publish') {
    const commandName: RelayCliGatewayCommand =
      'work-context-artifacts.publish';
    const input = addWorkContextArtifactBodyFlags(
      commandName,
      parseGatewayInputObject(commandName, artifactArgs),
      artifactArgs
    );
    if (typeof input['workContextId'] !== 'string') {
      gatewayInvalid(commandName, '--work-context-id is required', {
        field: 'workContextId',
      });
    }
    const hasArtifact = isGatewayRecord(input['artifact']);
    const hasViewArtifact = isGatewayRecord(input['viewArtifact']);
    if (hasArtifact === hasViewArtifact) {
      gatewayInvalid(
        commandName,
        'exactly one of artifact or viewArtifact is required',
        {
          fields: ['artifact', 'viewArtifact'],
        }
      );
    }
    const result = await gatewayHttpJson({
      commandName,
      pathName: '/work-context-artifacts',
      method: 'POST',
      body: input,
      capabilities: ['artifact:write'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'list') {
    const commandName: RelayCliGatewayCommand = 'work-context-artifacts.list';
    const query = new URLSearchParams();
    const workContextId = gatewayArg(artifactArgs, '--work-context-id');
    const projectId = gatewayArg(artifactArgs, '--project-id');
    const stage = gatewayArg(artifactArgs, '--stage');
    const limit = gatewayArg(artifactArgs, '--limit');
    const currentHeadSha = gatewayArg(artifactArgs, '--current-head-sha');
    const taskRef = workContextArtifactTaskRefFromArgs(
      commandName,
      artifactArgs
    );
    if (workContextId) query.set('workContextId', workContextId);
    if (projectId) query.set('projectId', projectId);
    if (stage) query.set('stage', stage);
    if (limit) query.set('limit', limit);
    if (currentHeadSha) query.set('currentHeadSha', currentHeadSha);
    if (artifactArgs.includes('--include-superseded'))
      query.set('includeSuperseded', 'true');
    if (taskRef) {
      query.set('taskRefKind', String(taskRef['kind']));
      query.set('taskRefId', String(taskRef['id']));
    }
    if (!workContextId && !taskRef) {
      gatewayInvalid(
        commandName,
        '--work-context-id or --task-ref-kind/--task-ref-id is required'
      );
    }
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-artifacts?${query.toString()}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'show') {
    const commandName: RelayCliGatewayCommand = 'work-context-artifacts.show';
    const id = gatewayArg(artifactArgs, '--id') ?? artifactArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const query = new URLSearchParams();
    const currentHeadSha = gatewayArg(artifactArgs, '--current-head-sha');
    if (currentHeadSha) query.set('currentHeadSha', currentHeadSha);
    if (artifactArgs.includes('--public')) query.set('public', 'true');
    const suffix = query.toString();
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-artifacts/${encodeURIComponent(id)}${suffix ? `?${suffix}` : ''}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'pin' || subcommand === 'unpin') {
    const commandName: RelayCliGatewayCommand =
      subcommand === 'pin'
        ? 'work-context-artifacts.pin'
        : 'work-context-artifacts.unpin';
    const id = gatewayArg(artifactArgs, '--id') ?? artifactArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const workContextId = gatewayArg(artifactArgs, '--work-context-id');
    if (!workContextId)
      gatewayInvalid(commandName, '--work-context-id is required', {
        field: 'workContextId',
      });
    const actorId = gatewayArg(artifactArgs, '--actor-id');
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-artifacts/${encodeURIComponent(id)}/${subcommand}`,
      method: 'POST',
      body: { workContextId, ...(actorId ? { actorId } : {}) },
      capabilities: ['artifact:write'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'export') {
    const commandName: RelayCliGatewayCommand = 'work-context-artifacts.export';
    const id = gatewayArg(artifactArgs, '--id') ?? artifactArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-artifacts/${encodeURIComponent(id)}/export`,
      capabilities: ['context:read'],
    });
    const output = gatewayArg(artifactArgs, '--output');
    if (output) {
      writeGatewayOutputFile(commandName, output, result);
    }
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'doctor') {
    const commandName: RelayCliGatewayCommand = 'work-context-artifacts.doctor';
    const result = await gatewayHttpJson({
      commandName,
      pathName: '/work-context-artifacts/doctor',
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  gatewayInvalid(
    'work-context-artifacts.show',
    'unknown work-context-artifacts command',
    {
      args: gatewayArgs,
    }
  );
}

function addWorkContextMessageQueryParam(
  query: URLSearchParams,
  args: string[],
  flag: string,
  key: string
): void {
  const value = gatewayArg(args, flag);
  if (value) query.set(key, value);
}

function addWorkContextMessageBodyFlags(
  body: Record<string, unknown>,
  args: string[]
): Record<string, unknown> {
  for (const [flag, key] of [
    ['--work-context-id', 'workContextId'],
    ['--kind', 'kind'],
    ['--summary', 'summary'],
    ['--payload-schema', 'payloadSchema'],
    ['--template', 'template'],
    ['--repo-path', 'repoPath'],
    ['--cwd', 'cwd'],
    ['--visibility', 'visibility'],
    ['--parent-message-id', 'parentMessageId'],
    ['--reply-to-message-id', 'replyToMessageId'],
  ] as const) {
    const value = gatewayArg(args, flag);
    if (value !== undefined) body[key] = value;
  }
  const payloadFile = gatewayArg(args, '--payload-file');
  const payloadJson = gatewayArg(args, '--payload-json');
  if (payloadFile && payloadJson) {
    gatewayInvalid(
      'work-context-messages.append',
      '--payload-file and --payload-json are mutually exclusive'
    );
  }
  if ((payloadFile || payloadJson) && body['payload'] !== undefined) {
    gatewayInvalid(
      'work-context-messages.append',
      '--input-json payload, --payload-file, and --payload-json are mutually exclusive'
    );
  }
  if (payloadFile) {
    body['payload'] = gatewayReadJsonFile(
      'work-context-messages.append',
      payloadFile
    );
  }
  if (payloadJson) {
    body['payload'] = parseGatewayJson(
      'work-context-messages.append',
      payloadJson
    );
  }
  return body;
}

function addWorkContextMessageTemplateQueryFlags(
  query: URLSearchParams,
  args: string[]
): void {
  for (const [flag, key] of [
    ['--repo-path', 'repoPath'],
    ['--cwd', 'cwd'],
    ['--work-context-id', 'workContextId'],
  ] as const) {
    addWorkContextMessageQueryParam(query, args, flag, key);
  }
  if (args.includes('--include-invalid')) query.set('includeInvalid', 'true');
}

async function runGatewayWorkContextMessageTemplates(
  gatewayArgs: string[],
  messageArgs: string[]
): Promise<never> {
  const templateSubcommand = messageArgs[0];
  const templateArgs = messageArgs.slice(1);
  if (templateSubcommand === 'list') {
    const commandName: RelayCliGatewayCommand =
      'work-context-messages.templates.list';
    const query = new URLSearchParams();
    addWorkContextMessageTemplateQueryFlags(query, templateArgs);
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-message-templates?${query.toString()}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (templateSubcommand === 'show') {
    const commandName: RelayCliGatewayCommand =
      'work-context-messages.templates.show';
    const template =
      gatewayArg(templateArgs, '--template') ??
      gatewayArg(templateArgs, '--id') ??
      templateArgs[0];
    if (!template || template.startsWith('--')) {
      gatewayInvalid(commandName, '--template is required');
    }
    const query = new URLSearchParams();
    addWorkContextMessageTemplateQueryFlags(query, templateArgs);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-message-templates/${encodeURIComponent(template)}${suffix}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (templateSubcommand === 'render') {
    const commandName: RelayCliGatewayCommand =
      'work-context-messages.templates.render';
    const input = parseGatewayInputObject(commandName, templateArgs);
    const template =
      gatewayArg(templateArgs, '--template') ??
      gatewayArg(templateArgs, '--id');
    if (template) input['template'] = template;
    for (const [flag, key] of [
      ['--repo-path', 'repoPath'],
      ['--cwd', 'cwd'],
      ['--work-context-id', 'workContextId'],
    ] as const) {
      const value = gatewayArg(templateArgs, flag);
      if (value !== undefined) input[key] = value;
    }
    const templateDataJson = gatewayArg(templateArgs, '--template-data-json');
    const payloadJson = gatewayArg(templateArgs, '--payload-json');
    if (templateDataJson && payloadJson) {
      gatewayInvalid(
        commandName,
        '--template-data-json and --payload-json are mutually exclusive'
      );
    }
    if (templateDataJson)
      input['templateData'] = parseGatewayJson(commandName, templateDataJson);
    if (payloadJson)
      input['templateData'] = parseGatewayJson(commandName, payloadJson);
    if (typeof input['template'] !== 'string') {
      gatewayInvalid(commandName, '--template is required');
    }
    const result = await gatewayHttpJson({
      commandName,
      pathName: '/work-context-message-templates/render',
      method: 'POST',
      body: input,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  gatewayInvalid(
    'work-context-messages.templates.show',
    'unknown work-context-messages templates command',
    { args: gatewayArgs }
  );
}

async function runGatewayWorkContextMessages(
  gatewayArgs: string[]
): Promise<never> {
  const subcommand = gatewayArgs[1];
  const messageArgs = gatewayArgs.slice(2);
  if (subcommand === 'templates') {
    return runGatewayWorkContextMessageTemplates(gatewayArgs, messageArgs);
  }
  if (subcommand === 'append') {
    const commandName: RelayCliGatewayCommand = 'work-context-messages.append';
    const input = addWorkContextMessageBodyFlags(
      parseGatewayInputObject(commandName, messageArgs),
      messageArgs
    );
    if (typeof input['workContextId'] !== 'string') {
      gatewayInvalid(commandName, '--work-context-id is required', {
        field: 'workContextId',
      });
    }
    if (
      typeof input['kind'] !== 'string' &&
      typeof input['template'] !== 'string'
    ) {
      gatewayInvalid(
        commandName,
        '--kind is required unless --template is set',
        { field: 'kind' }
      );
    }
    if (typeof input['summary'] !== 'string') {
      gatewayInvalid(commandName, '--summary is required', {
        field: 'summary',
      });
    }
    const result = await gatewayHttpJson({
      commandName,
      pathName: '/work-context-messages',
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'list') {
    const commandName: RelayCliGatewayCommand = 'work-context-messages.list';
    const query = new URLSearchParams();
    for (const [flag, key] of [
      ['--work-context-id', 'workContextId'],
      ['--kind', 'kind'],
      ['--sender-id', 'senderId'],
      ['--audience-kind', 'audienceKind'],
      ['--audience-id', 'audienceId'],
      ['--payload-schema', 'payloadSchema'],
      ['--thread-id', 'threadId'],
      ['--parent-message-id', 'parentMessageId'],
      ['--ref-kind', 'refKind'],
      ['--ref-value', 'refValue'],
      ['--limit', 'limit'],
    ] as const) {
      addWorkContextMessageQueryParam(query, messageArgs, flag, key);
    }
    if (
      !query.has('workContextId') &&
      !query.has('threadId') &&
      !query.has('parentMessageId') &&
      !(query.has('refKind') && query.has('refValue'))
    ) {
      gatewayInvalid(
        commandName,
        '--work-context-id, --thread-id, --parent-message-id, or --ref-kind/--ref-value is required'
      );
    }
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-messages?${query.toString()}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'show') {
    const commandName: RelayCliGatewayCommand = 'work-context-messages.show';
    const id = gatewayArg(messageArgs, '--id') ?? messageArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/work-context-messages/${encodeURIComponent(id)}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'query') {
    const commandName: RelayCliGatewayCommand = 'work-context-messages.query';
    const input = parseGatewayInputObject(commandName, messageArgs);
    const result = await gatewayHttpJson({
      commandName,
      pathName: '/work-context-messages/query',
      method: 'POST',
      body: input,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  gatewayInvalid(
    'work-context-messages.show',
    'unknown work-context-messages command',
    {
      args: gatewayArgs,
    }
  );
}

async function runGatewayHandoffArtifacts(
  gatewayArgs: string[]
): Promise<never> {
  const subcommand = gatewayArgs[1];
  const artifactArgs = gatewayArgs.slice(2);
  if (subcommand === 'attach') {
    const commandName: RelayCliGatewayCommand = 'handoff-artifacts.attach';
    const input = addWorkContextArtifactBodyFlags(
      commandName,
      parseGatewayInputObject(commandName, artifactArgs),
      artifactArgs
    );
    if (typeof input['workContextId'] !== 'string') {
      gatewayInvalid(commandName, '--work-context-id is required', {
        field: 'workContextId',
      });
    }
    if (typeof input['artifact'] !== 'object' || input['artifact'] === null) {
      gatewayInvalid(
        commandName,
        '--artifact-file or input artifact is required',
        { field: 'artifact' }
      );
    }
    const result = await gatewayHttpJson({
      commandName,
      pathName: '/pipeline-handoff-artifacts',
      method: 'POST',
      body: input,
      capabilities: ['artifact:write'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'list') {
    const commandName: RelayCliGatewayCommand = 'handoff-artifacts.list';
    const query = new URLSearchParams();
    const workContextId = gatewayArg(artifactArgs, '--work-context-id');
    const projectId = gatewayArg(artifactArgs, '--project-id');
    const stage = gatewayArg(artifactArgs, '--stage');
    const limit = gatewayArg(artifactArgs, '--limit');
    const currentHeadSha = gatewayArg(artifactArgs, '--current-head-sha');
    const taskRef = workContextArtifactTaskRefFromArgs(
      commandName,
      artifactArgs
    );
    if (workContextId) query.set('workContextId', workContextId);
    if (projectId) query.set('projectId', projectId);
    if (stage) query.set('stage', stage);
    if (limit) query.set('limit', limit);
    if (currentHeadSha) query.set('currentHeadSha', currentHeadSha);
    if (artifactArgs.includes('--include-superseded'))
      query.set('includeSuperseded', 'true');
    if (taskRef) {
      query.set('taskRefKind', String(taskRef['kind']));
      query.set('taskRefId', String(taskRef['id']));
    }
    if (!workContextId && !taskRef) {
      gatewayInvalid(
        commandName,
        '--work-context-id or --task-ref-kind/--task-ref-id is required'
      );
    }
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/pipeline-handoff-artifacts?${query.toString()}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'show') {
    const commandName: RelayCliGatewayCommand = 'handoff-artifacts.show';
    const id = gatewayArg(artifactArgs, '--id') ?? artifactArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const query = new URLSearchParams();
    const currentHeadSha = gatewayArg(artifactArgs, '--current-head-sha');
    if (currentHeadSha) query.set('currentHeadSha', currentHeadSha);
    if (artifactArgs.includes('--public')) query.set('public', 'true');
    const suffix = query.toString();
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/pipeline-handoff-artifacts/${encodeURIComponent(id)}${suffix ? `?${suffix}` : ''}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  if (subcommand === 'copy') {
    const commandName: RelayCliGatewayCommand = 'handoff-artifacts.copy';
    const id = gatewayArg(artifactArgs, '--id') ?? artifactArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid(commandName, '--id is required');
    const result = await gatewayHttpJson({
      commandName,
      pathName: `/pipeline-handoff-artifacts/${encodeURIComponent(id)}/copy`,
      capabilities: ['context:read'],
    });
    const output = gatewayArg(artifactArgs, '--output');
    if (output) {
      writeGatewayOutputFile(commandName, output, result);
    }
    printGatewayEnvelope(gatewayOk(commandName, result), 0);
  }
  gatewayInvalid(
    'handoff-artifacts.show',
    'unknown handoff-artifacts command',
    {
      args: gatewayArgs,
    }
  );
}

async function runGatewayArtifacts(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const artifactArgs = gatewayArgs.slice(2);
  if (subcommand !== 'read') {
    gatewayInvalid('artifacts.read', 'unknown artifacts command', {
      args: gatewayArgs,
    });
  }
  const ref = gatewayArg(artifactArgs, '--ref') ?? artifactArgs[0];
  if (!ref || ref.startsWith('--'))
    gatewayInvalid('artifacts.read', '--ref is required');
  const result = await gatewayHttpJson({
    commandName: 'artifacts.read',
    pathName: `/handoffs/artifacts/${encodeURIComponent(ref)}`,
    capabilities: ['session:read'],
  });
  printGatewayEnvelope(gatewayOk('artifacts.read', result), 0);
}

function parseEventsSubscribeTopic(
  value: string | undefined
): EventsSubscribeTopic {
  if (
    !value ||
    !EVENTS_SUBSCRIBE_TOPICS.includes(value as EventsSubscribeTopic)
  ) {
    printGatewayEnvelope(
      gatewayError('events.subscribe', {
        code: 'INVALID_ARGUMENT',
        message: `--topic must be one of: ${EVENTS_SUBSCRIBE_TOPICS.join(', ')}`,
        retryable: false,
        details: {
          field: 'topic',
          ...(value !== undefined ? { value } : {}),
          allowed: [...EVENTS_SUBSCRIBE_TOPICS],
        },
      }),
      1
    );
  }
  return value as EventsSubscribeTopic;
}

async function runGatewayEventsSubscribe(eventsArgs: string[]): Promise<never> {
  const topic = parseEventsSubscribeTopic(gatewayArg(eventsArgs, '--topic'));
  const maxEvents = gatewayOptionalPositiveInt(
    'events.subscribe',
    eventsArgs,
    '--max-events',
    10000
  );
  const idleTimeoutMs = gatewayOptionalPositiveInt(
    'events.subscribe',
    eventsArgs,
    '--idle-timeout-ms',
    300000
  );

  const token = gatewayRequiredToken('events.subscribe');
  const actorToken = gatewayActorToken();
  const usingActorToken = actorToken.length > 0 && token === actorToken;
  const correlationId = gatewayCorrelationId();
  const port = gatewayWsPort();
  const query = new URLSearchParams({ topic });
  for (const [flag, key] of [
    ['--cursor', 'cursor'],
    ['--work-context-id', 'workContextId'],
    ['--session-id', 'sessionId'],
    ['--global-session-id', 'globalSessionId'],
    ['--repo-path', 'repoPath'],
  ] as const) {
    const value = gatewayArg(eventsArgs, flag);
    if (value) query.set(key, value);
  }
  const url = `http://127.0.0.1:${port}/events?${query.toString()}`;

  // Use fetch with an AbortController; stream the body as NDJSON.
  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let res: Response;
  try {
    // Topic-specific capabilities are enforced by the hub router. Metadata
    // WorkContext topics use context:read, inbox uses inbox:read, and legacy
    // session/node topics use session:read.
    const capabilities = eventsSubscribeCapabilities(topic);
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-relay-cli-gateway': 'v1',
        'x-relay-capabilities': capabilities,
        Accept: 'application/x-ndjson',
        // Actor lane parity with gatewayHttpJson: mark the actor credential and
        // command so the hub routes to `requireCliGatewayEventsAuth`'s actor path.
        ...(usingActorToken
          ? {
              'x-relay-cli-actor-token': 'v1',
              'x-relay-cli-command': 'events.subscribe',
            }
          : {}),
        ...(correlationId ? { 'x-relay-correlation-id': correlationId } : {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printGatewayEnvelope(
      gatewayError('events.subscribe', {
        code: 'SERVER_UNAVAILABLE',
        message: `could not connect to Relay hub on port ${port}: ${message}`,
        retryable: true,
        details: { topic },
      }),
      1
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    const upstream =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : undefined;
    printGatewayEnvelope(
      gatewayError('events.subscribe', {
        code: normalizeGatewayErrorCode(res.status, upstream),
        message: gatewayErrorMessage(res.status, upstream),
        retryable: gatewayErrorRetryable(res.status, upstream),
        details: {
          ...sanitizedGatewayErrorDetails(res.status, upstream),
          topic,
        },
      }),
      1
    );
  }

  const body = res.body;
  if (!body) {
    printGatewayEnvelope(
      gatewayError('events.subscribe', {
        code: 'UPSTREAM_ERROR',
        message: 'hub /events response had no body stream',
        retryable: true,
        details: { topic },
      }),
      1
    );
  }

  let frames = 0;
  let dataFrames = 0;
  let sequence = 0;
  let buffer = '';
  let idleTimer: NodeJS.Timeout | undefined;
  let settled = false;

  const finalizeOk = (reason: string, closeCode = 1000): void => {
    if (settled) return;
    settled = true;
    if (idleTimer) clearTimeout(idleTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    writeGatewayNdjson(
      gatewayOk('events.subscribe', {
        event: 'closed',
        topic,
        sequence: sequence++,
        frames,
        closeCode,
        reason,
      })
    );
  };

  const refreshIdleTimer = (): void => {
    if (!idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* aborting */
      }
      finalizeOk('idle timeout', 1000);
      process.exit(0);
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  refreshIdleTimer();

  const emitFrame = (line: string): boolean => {
    if (!line) return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Ignore malformed lines; hub-side bug would be visible in its own logs.
      return true;
    }
    if (!parsed || typeof parsed !== 'object') return true;
    const frame = parsed as Record<string, unknown>;
    const eventType =
      typeof frame['event'] === 'string' ? (frame['event'] as string) : 'event';
    const frameTopic =
      typeof frame['topic'] === 'string' ? (frame['topic'] as string) : topic;
    const occurredAt =
      typeof frame['occurredAt'] === 'string'
        ? (frame['occurredAt'] as string)
        : undefined;
    const payload =
      frame['payload'] && typeof frame['payload'] === 'object'
        ? (frame['payload'] as Record<string, unknown>)
        : undefined;
    // Resume + gap signals: the per-event `cursor` is what an automation loop
    // passes back via `--cursor` to resume; `replay` marks backfilled frames
    // and `replayDropped` marks a gap where the cursor aged out of the buffer.
    const cursor =
      typeof frame['cursor'] === 'string'
        ? (frame['cursor'] as string)
        : undefined;
    const replay = frame['replay'] === true ? true : undefined;
    const replayDropped = frame['replayDropped'] === true ? true : undefined;

    const envelope: Record<string, unknown> = {
      event: eventType,
      topic: frameTopic,
      sequence: sequence++,
      ...(occurredAt ? { occurredAt } : {}),
      ...(cursor ? { cursor } : {}),
      ...(replay ? { replay } : {}),
      ...(replayDropped ? { replayDropped } : {}),
      ...(payload ? { payload } : {}),
    };

    const ok = writeGatewayNdjson(gatewayOk('events.subscribe', envelope));
    refreshIdleTimer();
    if (!ok) {
      try {
        controller.abort();
      } catch {
        /* aborting */
      }
      finalizeOk('stdout backpressure', 1013);
      process.exit(0);
    }
    if (eventType === 'event') {
      frames += 1;
      dataFrames += 1;
      if (maxEvents !== undefined && dataFrames >= maxEvents) {
        try {
          controller.abort();
        } catch {
          /* aborting */
        }
        finalizeOk('maxEvents reached', 1000);
        process.exit(0);
      }
    }
    return true;
  };

  try {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        emitFrame(line);
        newlineIdx = buffer.indexOf('\n');
      }
    }
    // Flush any remaining bytes the streaming decoder is holding so a
    // trailing partial multi-byte char doesn't get dropped.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) emitFrame(buffer.trim());
    finalizeOk('hub closed stream', 1000);
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      finalizeOk('aborted', 1000);
      process.exit(0);
    }
    const message = error instanceof Error ? error.message : String(error);
    printGatewayEnvelope(
      gatewayError('events.subscribe', {
        code: 'UPSTREAM_ERROR',
        message: `events stream error: ${message}`,
        retryable: true,
        details: { topic, frames },
      }),
      1
    );
  }
}

async function runGatewayWorkflowRuns(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const workflowArgs = gatewayArgs.slice(2);
  if (subcommand === 'publish') {
    const input = parseGatewayInputObject(
      'workflow-runs.publish',
      workflowArgs
    );
    const result = await gatewayHttpJson({
      commandName: 'workflow-runs.publish',
      pathName: '/workflow-runs',
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('workflow-runs.publish', result), 0);
  }
  if (subcommand === 'update') {
    const id = gatewayArg(workflowArgs, '--id') ?? workflowArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('workflow-runs.update', '--id is required');
    const input = parseGatewayInputObject('workflow-runs.update', workflowArgs);
    const result = await gatewayHttpJson({
      commandName: 'workflow-runs.update',
      pathName: `/workflow-runs/${encodeURIComponent(id)}`,
      method: 'PATCH',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('workflow-runs.update', result), 0);
  }
  if (subcommand === 'list') {
    const workContextId = gatewayArg(workflowArgs, '--work-context-id');
    if (!workContextId)
      gatewayInvalid('workflow-runs.list', '--work-context-id is required');
    const query = new URLSearchParams({ workContextId });
    const state = gatewayArg(workflowArgs, '--state');
    const providerRuntime = gatewayArg(workflowArgs, '--provider-runtime');
    const limit = gatewayArg(workflowArgs, '--limit');
    if (state) query.set('state', state);
    if (providerRuntime) query.set('providerRuntime', providerRuntime);
    if (limit) query.set('limit', limit);
    const result = await gatewayHttpJson({
      commandName: 'workflow-runs.list',
      pathName: `/workflow-runs?${query.toString()}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('workflow-runs.list', result), 0);
  }
  if (subcommand === 'get') {
    const id = gatewayArg(workflowArgs, '--id') ?? workflowArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('workflow-runs.get', '--id is required');
    const result = await gatewayHttpJson({
      commandName: 'workflow-runs.get',
      pathName: `/workflow-runs/${encodeURIComponent(id)}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('workflow-runs.get', result), 0);
  }
  gatewayInvalid('workflow-runs.get', 'unknown workflow-runs command', {
    args: gatewayArgs,
  });
}

function automationRunListSearch(runArgs: string[]): string {
  const query = new URLSearchParams();
  for (const [flag, key] of [
    ['--work-context-id', 'workContextId'],
    ['--repo-path', 'repoPath'],
    ['--status', 'status'],
    ['--kind', 'kind'],
    ['--orchestrator', 'orchestrator'],
    ['--limit', 'limit'],
  ] as const) {
    const value = gatewayArg(runArgs, flag);
    if (value) query.set(key, value);
  }
  if (runArgs.includes('--include-retired'))
    query.set('includeRetired', 'true');
  return query.toString();
}

async function runGatewayAutomationRuns(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const runArgs = gatewayArgs.slice(2);
  if (subcommand === 'register') {
    const input = parseGatewayInputObject('automation-runs.register', runArgs);
    const result = await gatewayHttpJson({
      commandName: 'automation-runs.register',
      pathName: '/automation-runs',
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('automation-runs.register', result), 0);
  }
  if (subcommand === 'observe') {
    const id = gatewayArg(runArgs, '--id') ?? runArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('automation-runs.observe', '--id is required');
    const input = parseGatewayInputObject('automation-runs.observe', runArgs);
    const result = await gatewayHttpJson({
      commandName: 'automation-runs.observe',
      pathName: `/automation-runs/${encodeURIComponent(id)}/observe`,
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('automation-runs.observe', result), 0);
  }
  if (subcommand === 'retire') {
    const id = gatewayArg(runArgs, '--id') ?? runArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('automation-runs.retire', '--id is required');
    const reason = gatewayArg(runArgs, '--reason');
    const retiredBy = gatewayArg(runArgs, '--retired-by');
    const body: Record<string, unknown> = {};
    if (reason) body['reason'] = reason;
    if (retiredBy) body['retiredBy'] = retiredBy;
    const result = await gatewayHttpJson({
      commandName: 'automation-runs.retire',
      pathName: `/automation-runs/${encodeURIComponent(id)}/retire`,
      method: 'POST',
      body,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('automation-runs.retire', result), 0);
  }
  if (subcommand === 'list') {
    const search = automationRunListSearch(runArgs);
    const result = await gatewayHttpJson({
      commandName: 'automation-runs.list',
      pathName: search ? `/automation-runs?${search}` : '/automation-runs',
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('automation-runs.list', result), 0);
  }
  if (subcommand === 'get') {
    const id = gatewayArg(runArgs, '--id') ?? runArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('automation-runs.get', '--id is required');
    const result = await gatewayHttpJson({
      commandName: 'automation-runs.get',
      pathName: `/automation-runs/${encodeURIComponent(id)}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('automation-runs.get', result), 0);
  }
  gatewayInvalid('automation-runs.get', 'unknown automation-runs command', {
    args: gatewayArgs,
  });
}

function prOverseerListSearch(runArgs: string[]): string {
  const query = new URLSearchParams();
  for (const [flag, key] of [
    ['--work-context-id', 'workContextId'],
    ['--repo-path', 'repoPath'],
    ['--owner-repo', 'ownerRepo'],
    ['--status', 'status'],
    ['--orchestrator', 'orchestrator'],
    ['--limit', 'limit'],
  ] as const) {
    const value = gatewayArg(runArgs, flag);
    if (value) query.set(key, value);
  }
  if (runArgs.includes('--include-retired'))
    query.set('includeRetired', 'true');
  return query.toString();
}

async function runGatewayPrOverseer(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  const runArgs = gatewayArgs.slice(2);
  if (subcommand === 'register') {
    const input = parseGatewayInputObject('pr-overseer.register', runArgs);
    const result = await gatewayHttpJson({
      commandName: 'pr-overseer.register',
      pathName: '/pr-overseers',
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('pr-overseer.register', result), 0);
  }
  if (subcommand === 'observe') {
    const id = gatewayArg(runArgs, '--id') ?? runArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('pr-overseer.observe', '--id is required');
    const input = parseGatewayInputObject('pr-overseer.observe', runArgs);
    const result = await gatewayHttpJson({
      commandName: 'pr-overseer.observe',
      pathName: `/pr-overseers/${encodeURIComponent(id)}/observe`,
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('pr-overseer.observe', result), 0);
  }
  if (subcommand === 'retire') {
    const id = gatewayArg(runArgs, '--id') ?? runArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('pr-overseer.retire', '--id is required');
    const reason = gatewayArg(runArgs, '--reason');
    const retiredBy = gatewayArg(runArgs, '--retired-by');
    const body: Record<string, unknown> = {};
    if (reason) body['reason'] = reason;
    if (retiredBy) body['retiredBy'] = retiredBy;
    const result = await gatewayHttpJson({
      commandName: 'pr-overseer.retire',
      pathName: `/pr-overseers/${encodeURIComponent(id)}/retire`,
      method: 'POST',
      body,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('pr-overseer.retire', result), 0);
  }
  if (subcommand === 'list') {
    const search = prOverseerListSearch(runArgs);
    const result = await gatewayHttpJson({
      commandName: 'pr-overseer.list',
      pathName: search ? `/pr-overseers?${search}` : '/pr-overseers',
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('pr-overseer.list', result), 0);
  }
  if (subcommand === 'get') {
    const id = gatewayArg(runArgs, '--id') ?? runArgs[0];
    if (!id || id.startsWith('--'))
      gatewayInvalid('pr-overseer.get', '--id is required');
    const currentHeadSha = gatewayArg(runArgs, '--current-head-sha');
    const query = currentHeadSha
      ? `?currentHeadSha=${encodeURIComponent(currentHeadSha)}`
      : '';
    const result = await gatewayHttpJson({
      commandName: 'pr-overseer.get',
      pathName: `/pr-overseers/${encodeURIComponent(id)}${query}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('pr-overseer.get', result), 0);
  }
  gatewayInvalid('pr-overseer.get', 'unknown pr-overseer command', {
    args: gatewayArgs,
  });
}

async function runGatewayWorkspaceSurfaces(
  gatewayArgs: string[]
): Promise<never> {
  const subcommand = gatewayArgs[1];
  const surfaceArgs = gatewayArgs.slice(2);
  if (subcommand === 'list') {
    const query = new URLSearchParams();
    for (const [flag, key] of [
      ['--root-id', 'rootId'],
      ['--workspace-id', 'workspaceId'],
      ['--repo-path', 'repoPath'],
    ] as const) {
      const value = gatewayArg(surfaceArgs, flag);
      if (value) query.set(key, value);
    }
    const search = query.toString();
    const result = await gatewayHttpJson({
      commandName: 'workspace-surfaces.list',
      pathName: `/workspace-surfaces${search ? `?${search}` : ''}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('workspace-surfaces.list', result), 0);
  }
  if (subcommand === 'publish') {
    const input = parseGatewayInputObject(
      'workspace-surfaces.publish',
      surfaceArgs
    );
    const result = await gatewayHttpJson({
      commandName: 'workspace-surfaces.publish',
      pathName: '/workspace-surfaces',
      method: 'POST',
      body: input,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('workspace-surfaces.publish', result), 0);
  }
  gatewayInvalid(
    'workspace-surfaces.list',
    'unknown workspace-surfaces command',
    {
      args: gatewayArgs,
    }
  );
}

function workspaceTopicsQueryString(
  topicArgs: string[],
  keys: readonly (readonly [string, string])[]
): string {
  const query = new URLSearchParams();
  for (const [flag, key] of keys) {
    const value = gatewayArg(topicArgs, flag);
    if (value) query.set(key, value);
  }
  if (topicArgs.includes('--include-archived'))
    query.set('includeArchived', 'true');
  return query.toString();
}

async function runGatewayWorkspaceTopicsList(
  topicArgs: string[]
): Promise<never> {
  const search = workspaceTopicsQueryString(topicArgs, [
    ['--workspace-id', 'workspaceId'],
  ]);
  const result = await gatewayHttpJson({
    commandName: 'workspace-topics.list',
    pathName: `/workspace-topics${search ? `?${search}` : ''}`,
    capabilities: ['context:read'],
  });
  printGatewayEnvelope(gatewayOk('workspace-topics.list', result), 0);
}

async function runGatewayWorkspaceTopicsSearch(
  topicArgs: string[]
): Promise<never> {
  const q = gatewayArg(topicArgs, '--q') ?? topicArgs[0];
  if (!q || q.startsWith('--'))
    gatewayInvalid('workspace-topics.search', '--q is required');
  const query = new URLSearchParams(
    workspaceTopicsQueryString(topicArgs, [
      ['--workspace-id', 'workspaceId'],
      ['--work-context-id', 'workContextId'],
      ['--limit', 'limit'],
    ])
  );
  appendGatewayListQuery(
    query,
    topicArgs,
    '--work-context-ids',
    'workContextIds'
  );
  query.set('q', q);
  const result = await gatewayHttpJson({
    commandName: 'workspace-topics.search',
    pathName: `/workspace-topics/search?${query.toString()}`,
    capabilities: ['context:read'],
  });
  printGatewayEnvelope(gatewayOk('workspace-topics.search', result), 0);
}

function gatewayWorkspaceTopicId(
  commandName: RelayCliGatewayCommand,
  topicArgs: string[],
  input?: Record<string, unknown>
): string {
  const id =
    typeof input?.['id'] === 'string'
      ? input['id']
      : (gatewayArg(topicArgs, '--id') ?? topicArgs[0]);
  if (!id || id.startsWith('--'))
    gatewayInvalid(commandName, '--id is required');
  return id;
}

async function runGatewayWorkspaceTopicsGet(
  topicArgs: string[]
): Promise<never> {
  const id = gatewayWorkspaceTopicId('workspace-topics.get', topicArgs);
  const result = await gatewayHttpJson({
    commandName: 'workspace-topics.get',
    pathName: `/workspace-topics/${encodeURIComponent(id)}`,
    capabilities: ['context:read'],
  });
  printGatewayEnvelope(gatewayOk('workspace-topics.get', result), 0);
}

async function runGatewayWorkspaceTopicsCreate(
  topicArgs: string[]
): Promise<never> {
  const result = await gatewayHttpJson({
    commandName: 'workspace-topics.create',
    pathName: '/workspace-topics',
    method: 'POST',
    body: parseGatewayInputObject('workspace-topics.create', topicArgs),
    capabilities: ['context:write'],
  });
  printGatewayEnvelope(gatewayOk('workspace-topics.create', result), 0);
}

async function runGatewayWorkspaceTopicsUpdate(
  topicArgs: string[]
): Promise<never> {
  const input = parseGatewayInputObject('workspace-topics.update', topicArgs);
  const id = gatewayWorkspaceTopicId(
    'workspace-topics.update',
    topicArgs,
    input
  );
  const result = await gatewayHttpJson({
    commandName: 'workspace-topics.update',
    pathName: `/workspace-topics/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body: input,
    capabilities: ['context:write'],
  });
  printGatewayEnvelope(gatewayOk('workspace-topics.update', result), 0);
}

async function runGatewayWorkspaceTopicsArchive(
  topicArgs: string[]
): Promise<never> {
  const input = parseGatewayInputObject('workspace-topics.archive', topicArgs);
  const id = gatewayWorkspaceTopicId(
    'workspace-topics.archive',
    topicArgs,
    input
  );
  const rawConfirmationToken =
    typeof input['confirmationToken'] === 'string'
      ? input['confirmationToken']
      : gatewayArg(topicArgs, '--confirmation-token');
  const confirmationToken = rawConfirmationToken?.trim();
  const result = await gatewayHttpJson({
    commandName: 'workspace-topics.archive',
    pathName: `/workspace-topics/${encodeURIComponent(id)}/archive`,
    method: 'POST',
    body: {},
    capabilities: ['context:write'],
    ...(confirmationToken ? { confirmationToken } : {}),
  });
  printGatewayEnvelope(gatewayOk('workspace-topics.archive', result), 0);
}

async function runGatewayWorkspaceTopics(
  gatewayArgs: string[]
): Promise<never> {
  const topicArgs = gatewayArgs.slice(2);
  switch (gatewayArgs[1]) {
    case 'list':
      return runGatewayWorkspaceTopicsList(topicArgs);
    case 'search':
      return runGatewayWorkspaceTopicsSearch(topicArgs);
    case 'get':
      return runGatewayWorkspaceTopicsGet(topicArgs);
    case 'create':
      return runGatewayWorkspaceTopicsCreate(topicArgs);
    case 'update':
      return runGatewayWorkspaceTopicsUpdate(topicArgs);
    case 'archive':
      return runGatewayWorkspaceTopicsArchive(topicArgs);
    default:
      gatewayInvalid(
        'workspace-topics.list',
        'unknown workspace-topics command',
        {
          args: gatewayArgs,
        }
      );
  }
}

type ChannelCliValueFlag =
  | '--channel-id'
  | '--run-id'
  | '--thread-id'
  | '--message-id'
  | '--sender-id'
  | '--mention-target-id'
  | '--status'
  | '--terminal-only'
  | '--principal-only'
  | '--limit'
  | '--before-seq'
  | '--after-seq'
  | '--max-events'
  | '--idle-timeout-ms'
  | '--input-json';

/** Strict, command-local parser for the six stable channel gateway commands. */
function parseChannelCliFlags(
  commandName: RelayCliGatewayCommand,
  commandArgs: readonly string[],
  valueFlags: readonly ChannelCliValueFlag[]
): ReadonlyMap<ChannelCliValueFlag, string> {
  const allowed = new Set<string>(['--json', ...valueFlags]);
  const seen = new Set<string>();
  const values = new Map<ChannelCliValueFlag, string>();
  for (let index = 0; index < commandArgs.length; index += 1) {
    const flag = commandArgs[index];
    if (!flag || !allowed.has(flag)) {
      gatewayInvalid(commandName, `unsupported ${commandName} argument`, {
        argument: flag,
        allowed: [...allowed],
      });
    }
    if (seen.has(flag)) {
      gatewayInvalid(commandName, `duplicate ${flag} is not allowed`, {
        argument: flag,
      });
    }
    seen.add(flag);
    if (flag === '--json') continue;
    const value = commandArgs[index + 1];
    if (!value || value.startsWith('--')) {
      gatewayInvalid(commandName, `${flag} requires a value`, {
        argument: flag,
      });
    }
    values.set(flag as ChannelCliValueFlag, value);
    index += 1;
  }
  return values;
}

function requiredChannelCliString(
  commandName: RelayCliGatewayCommand,
  values: ReadonlyMap<ChannelCliValueFlag, string>,
  flag: '--channel-id' | '--thread-id' | '--run-id'
): string {
  const value = values.get(flag)?.trim() ?? '';
  if (!value) {
    gatewayInvalid(commandName, `${flag} is required`, {
      field:
        flag === '--channel-id'
          ? 'channelId'
          : flag === '--thread-id'
            ? 'threadId'
            : 'runId',
    });
  }
  return value;
}

function validateChannelCliPagination(
  commandName: 'channels.history' | 'channels.threads.history',
  values: ReadonlyMap<ChannelCliValueFlag, string>
): void {
  if (values.has('--before-seq') && values.has('--after-seq')) {
    gatewayInvalid(commandName, '--before-seq and --after-seq conflict', {
      fields: ['beforeSeq', 'afterSeq'],
    });
  }
  for (const flag of ['--limit', '--before-seq', '--after-seq'] as const) {
    const value = values.get(flag);
    if (value === undefined) continue;
    const numeric = Number(value);
    if (
      !value.trim() ||
      !Number.isSafeInteger(numeric) ||
      numeric < (flag === '--limit' ? 1 : 0) ||
      (flag === '--limit' && numeric > 200)
    ) {
      gatewayInvalid(commandName, `${flag} has an invalid value`, {
        field: flag.slice(2),
        value,
      });
    }
  }
}

function readChannelSubscriptionFilter(
  values: ReadonlyMap<ChannelCliValueFlag, string>
): ChannelSubscriptionFilter | undefined {
  const filter: ChannelSubscriptionFilter = {};
  const stringFlags = [
    ['--thread-id', 'threadId'],
    ['--message-id', 'messageId'],
    ['--sender-id', 'senderId'],
    ['--mention-target-id', 'mentionTargetId'],
    ['--status', 'status'],
    ['--run-id', 'runId'],
  ] as const;
  for (const [flag, key] of stringFlags) {
    const raw = values.get(flag);
    if (raw === undefined) continue;
    const value = raw.trim();
    if (!value) {
      gatewayInvalid('channels.subscribe', `${flag} must be non-empty`, {
        field: key,
      });
    }
    Object.assign(filter, { [key]: value });
  }
  for (const [flag, key] of [
    ['--terminal-only', 'terminalOnly'],
    ['--principal-only', 'principalOnly'],
  ] as const) {
    const value = values.get(flag);
    if (value === undefined) continue;
    if (value !== 'true' && value !== 'false') {
      gatewayInvalid('channels.subscribe', `${flag} must be true or false`, {
        field: key,
        value,
      });
    }
    Object.assign(filter, { [key]: value === 'true' });
  }
  if (Object.keys(filter).length === 0) return undefined;
  const validationError = channelSubscriptionFilterValidationError(filter);
  if (validationError) {
    gatewayInvalid('channels.subscribe', validationError, { field: 'filter' });
  }
  return normalizeChannelSubscriptionFilter(filter);
}

function validateChannelPostCliInput(input: Record<string, unknown>): void {
  const allowed = new Set([
    'channelId',
    'text',
    'format',
    'parentMessageId',
    'threadId',
    'clientMessageId',
  ]);
  const undeclared = Object.keys(input).find((key) => !allowed.has(key));
  if (undeclared) {
    gatewayInvalid('channels.post', `${undeclared} is not declared`, {
      field: undeclared,
    });
  }
  if (
    typeof input['channelId'] !== 'string' ||
    input['channelId'].trim().length === 0
  ) {
    gatewayInvalid(
      'channels.post',
      'channelId is required and must be a non-empty string',
      { field: 'channelId' }
    );
  }
  if (typeof input['text'] !== 'string' || input['text'].trim().length === 0) {
    gatewayInvalid('channels.post', 'text must be a non-empty string', {
      field: 'text',
    });
  }
  if (
    input['format'] !== undefined &&
    input['format'] !== 'text' &&
    input['format'] !== 'markdown'
  ) {
    gatewayInvalid('channels.post', 'format must be text or markdown', {
      field: 'format',
    });
  }
  for (const field of ['parentMessageId', 'clientMessageId'] as const) {
    if (
      input[field] !== undefined &&
      (typeof input[field] !== 'string' || input[field].length === 0)
    ) {
      gatewayInvalid('channels.post', `${field} must be a non-empty string`, {
        field,
      });
    }
  }
  if (
    input['threadId'] !== undefined &&
    input['threadId'] !== null &&
    (typeof input['threadId'] !== 'string' || input['threadId'].length === 0)
  ) {
    gatewayInvalid(
      'channels.post',
      'threadId must be a non-empty string or null',
      { field: 'threadId' }
    );
  }
}

async function runGatewayChannels(gatewayArgs: string[]): Promise<void> {
  const subcommand = gatewayArgs[1];
  const channelArgs = gatewayArgs.slice(2);

  if (subcommand === 'list') {
    parseChannelCliFlags('channels.list', channelArgs, []);
    const result = await gatewayHttpJson({
      commandName: 'channels.list',
      pathName: '/channels',
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('channels.list', result), 0);
  }

  if (subcommand === 'get') {
    const values = parseChannelCliFlags('channels.get', channelArgs, [
      '--channel-id',
    ]);
    const channelId = requiredChannelCliString(
      'channels.get',
      values,
      '--channel-id'
    );
    const result = await gatewayHttpJson({
      commandName: 'channels.get',
      pathName: `/channels/${encodeURIComponent(channelId)}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('channels.get', result), 0);
  }

  if (subcommand === 'run' && channelArgs[0] === 'get') {
    const values = parseChannelCliFlags(
      'channels.run.get',
      channelArgs.slice(1),
      ['--channel-id', '--run-id', '--thread-id']
    );
    const channelId = requiredChannelCliString(
      'channels.run.get',
      values,
      '--channel-id'
    );
    const runId = requiredChannelCliString(
      'channels.run.get',
      values,
      '--run-id'
    );
    const query = new URLSearchParams();
    const threadId = values.get('--thread-id');
    if (threadId !== undefined) {
      const trimmedThreadId = threadId.trim();
      if (!trimmedThreadId) {
        gatewayInvalid('channels.run.get', '--thread-id must be non-empty', {
          field: 'threadId',
        });
      }
      query.set('threadId', trimmedThreadId);
    }
    const result = await gatewayHttpJson({
      commandName: 'channels.run.get',
      pathName: `/channels/${encodeURIComponent(channelId)}/runs/${encodeURIComponent(runId)}${query.size ? `?${query}` : ''}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('channels.run.get', result), 0);
  }

  if (subcommand === 'history') {
    const values = parseChannelCliFlags('channels.history', channelArgs, [
      '--channel-id',
      '--limit',
      '--before-seq',
      '--after-seq',
    ]);
    const channelId = requiredChannelCliString(
      'channels.history',
      values,
      '--channel-id'
    );
    validateChannelCliPagination('channels.history', values);
    const query = new URLSearchParams();
    for (const [flag, key] of [
      ['--limit', 'limit'],
      ['--before-seq', 'beforeSeq'],
      ['--after-seq', 'afterSeq'],
    ] as const) {
      const value = values.get(flag);
      if (value !== undefined) query.set(key, value);
    }
    const search = query.toString();
    const result = await gatewayHttpJson({
      commandName: 'channels.history',
      pathName: `/channels/${encodeURIComponent(channelId)}/messages${search ? `?${search}` : ''}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('channels.history', result), 0);
  }

  if (subcommand === 'subscribe') {
    const values = parseChannelCliFlags('channels.subscribe', channelArgs, [
      '--channel-id',
      '--after-seq',
      '--max-events',
      '--idle-timeout-ms',
      '--thread-id',
      '--message-id',
      '--sender-id',
      '--mention-target-id',
      '--status',
      '--run-id',
      '--terminal-only',
      '--principal-only',
    ]);
    const channelId = requiredChannelCliString(
      'channels.subscribe',
      values,
      '--channel-id'
    );
    const readBoundedInt = (
      flag: '--after-seq' | '--max-events' | '--idle-timeout-ms',
      minimum: number,
      maximum: number
    ): number | undefined => {
      const value = values.get(flag);
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < minimum ||
        parsed > maximum
      ) {
        gatewayInvalid('channels.subscribe', `${flag} has an invalid value`, {
          field: flag.slice(2),
          value,
        });
      }
      return parsed;
    };
    const afterSeq = readBoundedInt('--after-seq', 0, Number.MAX_SAFE_INTEGER);
    const maxEvents = readBoundedInt('--max-events', 1, 10000);
    const idleTimeoutMs = readBoundedInt('--idle-timeout-ms', 1, 300000);
    const filter = readChannelSubscriptionFilter(values);
    return runGatewayChannelsSubscribe({
      channelId,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(maxEvents !== undefined ? { maxEvents } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(filter ? { filter } : {}),
    });
  }

  if (subcommand === 'threads' && channelArgs[0] === 'history') {
    const threadArgs = channelArgs.slice(1);
    const values = parseChannelCliFlags(
      'channels.threads.history',
      threadArgs,
      ['--channel-id', '--thread-id', '--limit', '--before-seq', '--after-seq']
    );
    const channelId = requiredChannelCliString(
      'channels.threads.history',
      values,
      '--channel-id'
    );
    const threadId = requiredChannelCliString(
      'channels.threads.history',
      values,
      '--thread-id'
    );
    validateChannelCliPagination('channels.threads.history', values);
    const query = new URLSearchParams();
    for (const [flag, key] of [
      ['--limit', 'limit'],
      ['--before-seq', 'beforeSeq'],
      ['--after-seq', 'afterSeq'],
    ] as const) {
      const value = values.get(flag);
      if (value !== undefined) query.set(key, value);
    }
    const search = query.toString();
    const result = await gatewayHttpJson({
      commandName: 'channels.threads.history',
      pathName: `/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}${search ? `?${search}` : ''}`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('channels.threads.history', result), 0);
  }

  if (subcommand === 'roster') {
    const values = parseChannelCliFlags('channels.roster', channelArgs, [
      '--channel-id',
    ]);
    const channelId = requiredChannelCliString(
      'channels.roster',
      values,
      '--channel-id'
    );
    const result = await gatewayHttpJson({
      commandName: 'channels.roster',
      pathName: `/channels/${encodeURIComponent(channelId)}/roster`,
      capabilities: ['context:read'],
    });
    printGatewayEnvelope(gatewayOk('channels.roster', result), 0);
  }

  if (subcommand === 'post') {
    const values = parseChannelCliFlags('channels.post', channelArgs, [
      '--input-json',
    ]);
    const inputJson = values.get('--input-json');
    if (inputJson === undefined) {
      gatewayInvalid('channels.post', '--input-json is required', {
        field: 'inputJson',
      });
    }
    const input = parseGatewayJson('channels.post', inputJson);
    validateChannelPostCliInput(input);
    const channelId = input['channelId'] as string;
    const body = { ...input };
    delete body['channelId'];
    const result = await gatewayHttpJson({
      commandName: 'channels.post',
      pathName: `/channels/${encodeURIComponent(channelId)}/messages`,
      method: 'POST',
      body,
      capabilities: ['context:write'],
    });
    printGatewayEnvelope(gatewayOk('channels.post', result), 0);
  }
  gatewayInvalid('channels.list', 'unknown channels command', {
    args: gatewayArgs,
  });
}

async function runGatewayChannelsSubscribe(input: {
  channelId: string;
  afterSeq?: number;
  maxEvents?: number;
  idleTimeoutMs?: number;
  filter?: ChannelSubscriptionFilter;
}): Promise<void> {
  const commandName = 'channels.subscribe' as const;
  const token = gatewayRequiredToken(commandName);
  const actorToken = gatewayActorToken();
  const query = new URLSearchParams();
  if (input.afterSeq !== undefined)
    query.set('afterSeq', String(input.afterSeq));
  if (input.filter) {
    for (const [key, value] of Object.entries(input.filter)) {
      query.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${gatewayWsPort()}/channels/${encodeURIComponent(input.channelId)}/subscribe${query.size ? `?${query}` : ''}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/x-ndjson',
          'x-relay-cli-gateway': 'v1',
          'x-relay-capabilities': 'context:read',
          ...(actorToken
            ? {
                'x-relay-cli-actor-token': 'v1',
                'x-relay-cli-command': commandName,
              }
            : {}),
          ...(gatewayCorrelationId()
            ? { 'x-relay-correlation-id': gatewayCorrelationId()! }
            : {}),
        },
        signal: controller.signal,
      }
    );
  } catch (error) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'SERVER_UNAVAILABLE',
        message: `could not connect to Relay hub: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        details: { channelId: input.channelId },
      }),
      1
    );
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let upstream: Record<string, unknown> | undefined;
    try {
      const parsed = raw ? JSON.parse(raw) : undefined;
      if (parsed && typeof parsed === 'object')
        upstream = parsed as Record<string, unknown>;
    } catch {
      upstream = raw ? { raw } : undefined;
    }
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: normalizeGatewayErrorCode(res.status, upstream),
        message: gatewayErrorMessage(res.status, upstream),
        retryable: gatewayErrorRetryable(res.status, upstream),
        details: {
          ...sanitizedGatewayErrorDetails(res.status, upstream),
          channelId: input.channelId,
        },
      }),
      1
    );
  }
  if (!res.body) {
    printGatewayEnvelope(
      gatewayError(commandName, {
        code: 'UPSTREAM_ERROR',
        message: 'hub channel subscription response had no body stream',
        retryable: true,
      }),
      1
    );
  }
  let buffer = '';
  let events = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let normalClose = false;
  let stdoutWriteError: Error | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelStream = (): void => {
    controller.abort();
    void reader?.cancel().catch(() => {
      /* AbortController already closes the fetch body; cancellation is best effort. */
    });
  };
  // `Writable` can emit EPIPE after its individual write callback ran. Keep a
  // subscription-scoped listener until teardown so an early downstream close
  // never becomes an unhandled process error between frames.
  const onStdoutError = (error: Error): void => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
      normalClose = true;
      cancelStream();
      return;
    }
    stdoutWriteError = error;
    cancelStream();
  };
  process.stdout.on('error', onStdoutError);
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (input.idleTimeoutMs !== undefined) {
      idleTimer = setTimeout(cancelStream, input.idleTimeoutMs);
      idleTimer.unref?.();
    }
  };
  const emit = async (line: string): Promise<boolean> => {
    if (!line) return true;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return true;
    }
    if (frame['frame'] === 'event') events += 1;
    if (frame['frame'] === 'closed') normalClose = frame['retryable'] !== true;
    const written = await writeGatewayNdjsonDrained(
      gatewayOk(commandName, frame)
    );
    if (!written) {
      normalClose = true;
      cancelStream();
      return false;
    }
    resetIdle();
    if (input.maxEvents !== undefined && events >= input.maxEvents) {
      normalClose = true;
      cancelStream();
      return false;
    }
    return true;
  };
  resetIdle();
  try {
    reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let keepReading = true;
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        keepReading = await emit(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        if (!keepReading) break;
        newline = buffer.indexOf('\n');
      }
    }
    if (keepReading) {
      buffer += decoder.decode();
      await emit(buffer.trim());
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      await writeGatewayNdjsonDrained(
        gatewayError(commandName, {
          code: 'UPSTREAM_ERROR',
          message: `channel subscription failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          details: { channelId: input.channelId, events },
        })
      );
      process.exitCode = 1;
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdout.removeListener('error', onStdoutError);
  }
  process.exitCode = stdoutWriteError
    ? 1
    : normalClose || controller.signal.aborted
      ? 0
      : 1;
}

async function readGatewayCockpitGroups(
  commandName: RelayCliGatewayCommand
): Promise<TerminalCockpitActiveGroupInput[]> {
  const active = (await gatewayHttpJson({
    commandName,
    pathName: '/work-contexts/active',
    capabilities: ['session:read', 'context:read'],
  })) as { groups?: TerminalCockpitActiveGroupInput[] };
  return Array.isArray(active.groups) ? active.groups : [];
}

async function readGatewayCockpitView(
  gatewayArgs: string[]
): Promise<TerminalCockpitView> {
  const cockpitArgs = gatewayArgs.slice(2);
  const limit = gatewayOptionalPositiveInt(
    'cockpit.list',
    cockpitArgs,
    '--limit',
    200
  );
  return buildTerminalCockpitView({
    groups: await readGatewayCockpitGroups('cockpit.list'),
    ...(limit !== undefined ? { limit } : {}),
  });
}

function validateGatewayCockpitGetArgs(cockpitArgs: string[]): void {
  for (let index = 0; index < cockpitArgs.length; index += 1) {
    const arg = cockpitArgs[index];
    if (arg === '--json') continue;
    if (arg === '--work-context-id') {
      const value = cockpitArgs[index + 1];
      if (!value || value.startsWith('--')) {
        gatewayInvalid('cockpit.get', '--work-context-id is required', {
          field: 'workContextId',
        });
      }
      index += 1;
      continue;
    }
    if (arg?.startsWith('--')) {
      gatewayInvalid('cockpit.get', 'unsupported cockpit.get argument', {
        argument: arg,
        allowed: ['--work-context-id', '--json'],
      });
    }
    gatewayInvalid(
      'cockpit.get',
      'unexpected cockpit.get positional argument',
      {
        argument: arg,
        expected: '--work-context-id',
      }
    );
  }
}

function gatewayCockpitWorkContextId(cockpitArgs: string[]): string {
  validateGatewayCockpitGetArgs(cockpitArgs);
  const id = gatewayArg(cockpitArgs, '--work-context-id');
  if (!id || id.startsWith('--')) {
    gatewayInvalid('cockpit.get', '--work-context-id is required', {
      field: 'workContextId',
    });
  }
  return id;
}

async function readGatewayCockpitDetail(
  gatewayArgs: string[]
): Promise<TerminalCockpitDetail> {
  const cockpitArgs = gatewayArgs.slice(2);
  const workContextId = gatewayCockpitWorkContextId(cockpitArgs);
  const detail = buildTerminalCockpitDetail({
    groups: await readGatewayCockpitGroups('cockpit.get'),
    workContextId,
  });
  if (!detail) {
    gatewayInvalid('cockpit.get', 'work context not found in active cockpit', {
      workContextId,
    });
  }
  return detail;
}

async function runGatewayCockpit(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  if (subcommand === 'list') {
    const view = await readGatewayCockpitView(gatewayArgs);
    printGatewayEnvelope(gatewayOk('cockpit.list', view), 0);
  }
  if (subcommand === 'get') {
    const detail = await readGatewayCockpitDetail(gatewayArgs);
    printGatewayEnvelope(gatewayOk('cockpit.get', detail), 0);
  }
  gatewayInvalid('cockpit.list', 'unknown cockpit command', {
    args: gatewayArgs,
  });
}

function eventsSubscribeCapabilities(topic: EventsSubscribeTopic): string {
  return EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES[topic].join(',');
}

async function runGatewayEvents(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  if (subcommand === 'subscribe')
    return runGatewayEventsSubscribe(gatewayArgs.slice(2));
  gatewayInvalid('events.subscribe', 'unknown events command', {
    args: gatewayArgs,
  });
}

function parseGatewaySettingsValue(
  commandName: RelayCliGatewayCommand,
  settingsArgs: string[]
): string | boolean {
  const jsonValue = gatewayArg(settingsArgs, '--value-json');
  if (jsonValue !== undefined) {
    try {
      const parsed = JSON.parse(jsonValue) as unknown;
      if (typeof parsed === 'string' || typeof parsed === 'boolean')
        return parsed;
      gatewayInvalid(
        commandName,
        '--value-json must decode to a string or boolean'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printGatewayEnvelope(
        gatewayError(
          commandName,
          gatewayCliInvalidJsonError(commandName, message)
        ),
        1
      );
    }
  }
  const value = gatewayArg(settingsArgs, '--value');
  if (value === undefined)
    gatewayInvalid(commandName, '--value or --value-json is required');
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseGatewaySettingsUpdateInput(
  settingsArgs: string[]
): Record<string, unknown> {
  const input = parseGatewayInputObject('settings.update', settingsArgs);
  if (Object.keys(input).length > 0) return input;
  const key = gatewayArg(settingsArgs, '--key');
  if (!key) gatewayInvalid('settings.update', '--key is required');
  return {
    key,
    value: parseGatewaySettingsValue('settings.update', settingsArgs),
    ...(settingsArgs.includes('--confirm-risky-write')
      ? { confirmRiskyWrite: true }
      : {}),
  };
}

async function runGatewaySettings(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  if (subcommand === 'get') {
    const data = await gatewayHttpJson({
      commandName: 'settings.get',
      pathName: '/cli-gateway/settings',
    });
    printGatewayEnvelope(gatewayOk('settings.get', data), 0);
  }
  if (subcommand === 'update') {
    const data = await gatewayHttpJson({
      commandName: 'settings.update',
      pathName: '/cli-gateway/settings',
      method: 'PATCH',
      body: parseGatewaySettingsUpdateInput(gatewayArgs.slice(2)),
    });
    printGatewayEnvelope(gatewayOk('settings.update', data), 0);
  }
  gatewayInvalid('settings.get', 'unknown settings command', {
    args: gatewayArgs,
  });
}

async function runGatewayWebhooks(gatewayArgs: string[]): Promise<never> {
  const subcommand = gatewayArgs[1];
  if (subcommand === 'status') {
    const data = await gatewayHttpJson({
      commandName: 'webhooks.status',
      pathName: '/cli-gateway/webhooks/status',
    });
    printGatewayEnvelope(gatewayOk('webhooks.status', data), 0);
  }
  if (subcommand === 'ping') {
    const data = await gatewayHttpJson({
      commandName: 'webhooks.ping',
      pathName: '/cli-gateway/webhooks/ping',
      method: 'POST',
    });
    printGatewayEnvelope(gatewayOk('webhooks.ping', data), 0);
  }
  gatewayInvalid('webhooks.status', 'unknown webhooks command', {
    args: gatewayArgs,
  });
}

async function runGatewayV1(): Promise<void> {
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
    printGatewayEnvelope(
      gatewayOk('contract.schema', RELAY_CLI_GATEWAY_CONTRACT),
      0
    );
  }
  if (!json) gatewayUsage();
  // Top-level group → handler. All handlers take the full gateway argv and never
  // return (each prints an envelope and exits). A table keeps this dispatch flat
  // instead of an ever-growing if-chain.
  const gatewayGroupHandlers: Record<string, (a: string[]) => Promise<void>> = {
    nodes: runGatewayNodes,
    repos: runGatewayRepos,
    workspaces: runGatewayWorkspaces,
    worktrees: runGatewayWorktrees,
    sessions: runGatewaySessions,
    tickets: runGatewayTickets,
    branches: runGatewayBranches,
    files: runGatewayFiles,
    'work-contexts': runGatewayWorkContexts,
    context: runGatewayContext,
    inbox: runGatewayInbox,
    handoffs: runGatewayHandoffs,
    'work-context-messages': runGatewayWorkContextMessages,
    'work-context-artifacts': runGatewayWorkContextArtifacts,
    'handoff-artifacts': runGatewayHandoffArtifacts,
    'workflow-runs': runGatewayWorkflowRuns,
    'automation-runs': runGatewayAutomationRuns,
    'pr-overseer': runGatewayPrOverseer,
    'workspace-surfaces': runGatewayWorkspaceSurfaces,
    'workspace-topics': runGatewayWorkspaceTopics,
    channels: runGatewayChannels,
    cockpit: runGatewayCockpit,
    artifacts: runGatewayArtifacts,
    supervisor: runGatewaySupervisor,
    events: runGatewayEvents,
    settings: runGatewaySettings,
    webhooks: runGatewayWebhooks,
  };
  const groupHandler = top ? gatewayGroupHandlers[top] : undefined;
  if (groupHandler) return groupHandler(gatewayArgs);
  gatewayInvalid('contract.list', 'unknown v1 gateway command', {
    args: gatewayArgs,
  });
}

if (command === 'v1') {
  await runGatewayV1();
}

if (command === 'cockpit') {
  const cockpitArgs = args.slice(1);
  const wantsDetail =
    cockpitArgs[0] === 'get' || cockpitArgs.includes('--work-context-id');
  if (wantsDetail) {
    const detailArgs = (() => {
      if (cockpitArgs[0] !== 'get') return ['cockpit', 'get', ...cockpitArgs];
      const getArgs = cockpitArgs.slice(1);
      const first = getArgs[0];
      if (first && !first.startsWith('--')) {
        return [
          'cockpit',
          'get',
          '--work-context-id',
          first,
          ...getArgs.slice(1),
        ];
      }
      return ['cockpit', 'get', ...getArgs];
    })();
    const detail = await readGatewayCockpitDetail(detailArgs);
    if (cockpitArgs.includes('--json')) {
      console.log(JSON.stringify(detail, null, 2));
    } else {
      console.log(renderTerminalCockpitDetail(detail));
    }
  } else {
    const view = await readGatewayCockpitView([
      'cockpit',
      'list',
      ...cockpitArgs,
    ]);
    if (cockpitArgs.includes('--json')) {
      console.log(JSON.stringify(view, null, 2));
    } else {
      console.log(renderTerminalCockpit(view));
    }
  }
  process.exit(0);
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

  const servicePaths = service.getServicePaths();
  const manifest = await getNodeManifest({
    ...(config ? { config } : {}),
    configDir: path.dirname(configPath),
    logDir: servicePaths.logDir,
  });
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
  const { verifySecurityAuditLog } =
    await import('../server/security-audit-log.js');
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

type HubDoctorStatus = 'pass' | 'fail' | 'warn' | 'skip';
type HubDoctorReason =
  | 'CONFIG_MISSING'
  | 'CONFIG_UNREADABLE'
  | 'CONFIG_INVALID'
  | 'AUTH_TOKEN_MISSING'
  | 'HUB_UNREACHABLE'
  | 'HUB_HTTP_ERROR'
  | 'PERSISTENCE_DEGRADED'
  | 'UNAUTHORIZED'
  | 'NODE_REGISTRY_INVALID'
  | 'NODE_OFFLINE'
  | 'NODE_STALE'
  | 'NODE_REVOKED'
  | 'VERSION_SKEW'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'MISSING_LOG_SUPPORT'
  | 'CHECK_SKIPPED';

interface HubDoctorCheck {
  name: string;
  status: HubDoctorStatus;
  message: string;
  reason?: HubDoctorReason;
  details?: Record<string, unknown>;
}

interface HubNodesPayload {
  generatedAt: string;
  hub: { url: string };
  count: number;
  nodes: HubNodeSummary[];
}

function hubCliPort(): string {
  return (
    getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port)
  );
}

function hubCliBaseUrl(): string {
  return `http://127.0.0.1:${hubCliPort()}`;
}

function redactForCli<T>(value: T): T {
  return JSON.parse(redactBootstrapSecrets(JSON.stringify(value))) as T;
}

function hubCliToken(): string {
  return process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';
}

const HUB_CLI_FETCH_TIMEOUT_MS = 2500;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

async function hubFetchJson(
  pathName: string,
  capabilities: readonly string[] = [],
  unauthenticated = false
): Promise<
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      status?: number;
      reason: HubDoctorReason;
      message: string;
      body?: unknown;
    }
> {
  const token = unauthenticated ? '' : hubCliToken();
  const headers: Record<string, string> = { 'x-relay-cli-gateway': 'v1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (capabilities.length)
    headers['x-relay-capabilities'] = capabilities.join(',');
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    HUB_CLI_FETCH_TIMEOUT_MS
  );
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${hubCliBaseUrl()}${pathName}`, {
      headers,
      signal: abortController.signal,
    });
    text = await res.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeoutMessage =
      isAbortError(error) || abortController.signal.aborted
        ? `timed out after ${HUB_CLI_FETCH_TIMEOUT_MS}ms`
        : message;
    return {
      ok: false,
      reason: 'HUB_UNREACHABLE',
      message: `could not reach Relay hub on port ${hubCliPort()}: ${timeoutMessage}`,
    };
  } finally {
    clearTimeout(timeout);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (res.ok) return { ok: true, status: res.status, body: redactForCli(body) };
  const upstream =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  const reason =
    normalizeGatewayErrorCode(res.status, upstream) === 'UNAUTHORIZED'
      ? 'UNAUTHORIZED'
      : 'HUB_HTTP_ERROR';
  return {
    ok: false,
    status: res.status,
    reason,
    message: gatewayErrorMessage(res.status, upstream),
    body: redactForCli(body),
  };
}

function hubConfigCheck(): HubDoctorCheck {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    return {
      name: 'config.read',
      status: 'fail',
      reason: 'CONFIG_MISSING',
      message: `config file is missing: ${configPath}`,
      details: { configPath },
    };
  }
  try {
    JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      name: 'config.read',
      status: 'pass',
      message: `config file is readable: ${configPath}`,
      details: { configPath },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: 'config.read',
      status: 'fail',
      reason: code ? 'CONFIG_UNREADABLE' : 'CONFIG_INVALID',
      message: `could not read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      details: { configPath },
    };
  }
}

function hubAuthCheck(): HubDoctorCheck {
  if (hubCliToken()) {
    return {
      name: 'auth.token',
      status: 'pass',
      message: 'RELAY_IDE_BROWSER_TOKEN is set for scoped hub API checks.',
    };
  }
  return {
    name: 'auth.token',
    status: 'fail',
    reason: 'AUTH_TOKEN_MISSING',
    message:
      'RELAY_IDE_BROWSER_TOKEN not set. Run from an authenticated Relay session or set a scoped API token.',
  };
}

function nodesFromBody(body: unknown): HubNodeSummary[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const nodes = (body as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? (nodes as HubNodeSummary[]) : undefined;
}

async function fetchHubNodes(): Promise<
  { ok: true; nodes: HubNodeSummary[] } | { ok: false; check: HubDoctorCheck }
> {
  const result = await hubFetchJson('/nodes', ['session:read']);
  if ('reason' in result) {
    return {
      ok: false,
      check: {
        name: 'nodes.registry',
        status: 'fail',
        reason: result.reason,
        message: result.message,
        details: { status: result.status, body: result.body },
      },
    };
  }
  const nodes = nodesFromBody(result.body);
  if (!nodes) {
    return {
      ok: false,
      check: {
        name: 'nodes.registry',
        status: 'fail',
        reason: 'NODE_REGISTRY_INVALID',
        message: 'hub /nodes did not return a nodes array',
      },
    };
  }
  return { ok: true, nodes };
}

function nodeCapabilityChecks(node: HubNodeSummary): HubDoctorCheck[] {
  const checks: HubDoctorCheck[] = [];
  const terminalBackends = nodeTerminalBackends(node);
  if (!nodeHasTerminalBackend(node)) {
    checks.push({
      name: `node.${node.nodeId}.capability.terminalBackend`,
      status: 'fail',
      reason: 'UNSUPPORTED_CAPABILITY',
      message: `${node.displayName} has no available terminal backend for routed PTY sessions.`,
      details: {
        nodeId: node.nodeId,
        capability: 'terminalBackend',
        terminalBackends,
      },
    });
  }
  if (node.version.state !== 'compatible') {
    checks.push({
      name: `node.${node.nodeId}.version`,
      status: 'fail',
      reason:
        node.version.state === 'version-skew'
          ? 'VERSION_SKEW'
          : 'PROTOCOL_INCOMPATIBLE',
      message: `${node.displayName} protocol ${node.version.nodeProtocolVersion} does not match hub ${node.version.hubProtocolVersion}.`,
      details: { nodeId: node.nodeId, version: node.version },
    });
  }
  return checks;
}

function nodeAvailabilityCheck(node: HubNodeSummary): HubDoctorCheck {
  if (node.status === 'online') {
    return {
      name: `node.${node.nodeId}.availability`,
      status: 'pass',
      message: `${node.displayName} is online via ${node.connection.route}.`,
      details: { nodeId: node.nodeId, lastSeenAt: node.lastSeenAt },
    };
  }
  const reason: HubDoctorReason =
    node.status === 'stale'
      ? 'NODE_STALE'
      : node.status === 'revoked'
        ? 'NODE_REVOKED'
        : 'NODE_OFFLINE';
  return {
    name: `node.${node.nodeId}.availability`,
    status: 'fail',
    reason,
    message: `${node.displayName} is ${node.status}; last seen ${node.lastSeenAt}.`,
    details: {
      nodeId: node.nodeId,
      status: node.status,
      lastSeenAt: node.lastSeenAt,
    },
  };
}

async function nodeLogSupportCheck(
  node: HubNodeSummary
): Promise<HubDoctorCheck> {
  if (node.status !== 'online' || node.version.state !== 'compatible') {
    return {
      name: `node.${node.nodeId}.logs`,
      status: 'skip',
      reason: 'CHECK_SKIPPED',
      message: `${node.displayName} log support check skipped because the node is not online and protocol-compatible.`,
      details: {
        nodeId: node.nodeId,
        status: node.status,
        version: node.version.state,
      },
    };
  }
  const result = await hubFetchJson(
    `/hub/nodes/${encodeURIComponent(node.nodeId)}/logs?lines=0`,
    ['session:read']
  );
  if (!('reason' in result)) {
    return {
      name: `node.${node.nodeId}.logs`,
      status: 'pass',
      message: `${node.displayName} supports hub node-log snapshots.`,
      details: { nodeId: node.nodeId },
    };
  }
  return {
    name: `node.${node.nodeId}.logs`,
    status: 'fail',
    reason:
      result.reason === 'HUB_HTTP_ERROR'
        ? 'MISSING_LOG_SUPPORT'
        : result.reason,
    message: `${node.displayName} node-log check failed: ${result.message}`,
    details: { nodeId: node.nodeId, status: result.status, body: result.body },
  };
}

function boundedNodeRow(value: string | undefined, max = 24): string {
  const text = value || '-';
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function formatNodeTable(nodes: HubNodeSummary[]): string[] {
  if (nodes.length === 0) return ['No paired Relay nodes.'];
  const rows = nodes
    .slice(0, 100)
    .map((node) => [
      node.status,
      boundedNodeRow(node.nodeId, 20),
      boundedNodeRow(node.displayName, 24),
      boundedNodeRow(`${node.hostname} ${node.platform}/${node.arch}`, 30),
      boundedNodeRow(node.relayVersion, 14),
      boundedNodeRow(node.version.state, 16),
      terminalBackendCell(node),
      node.lastSeenAt,
    ]);
  const header = [
    'STATUS',
    'NODE ID',
    'NAME',
    'HOST',
    'VERSION',
    'PROTO',
    'CAPS',
    'LAST SEEN',
  ];
  const widths = header.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0))
  );
  const render = (row: string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  const output = [
    render(header),
    render(widths.map((width) => '-'.repeat(width))),
    ...rows.map(render),
  ];
  if (nodes.length > rows.length)
    output.push(
      `… ${nodes.length - rows.length} more nodes omitted from human output; use --json for the full list.`
    );
  return output;
}

function terminalBackendCell(node: HubNodeSummary): string {
  const backends = nodeTerminalBackends(node);
  return `pty:${backends['relay-pty']}`;
}

async function printHubNodes(commandArgs: string[]): Promise<void> {
  const jsonOutput = commandArgs.includes('--json');
  const fetched = await fetchHubNodes();
  if ('check' in fetched) {
    if (jsonOutput)
      console.log(JSON.stringify(redactForCli(fetched.check), null, 2));
    else
      logger.error(
        redactBootstrapSecrets(
          `${fetched.check.reason}: ${fetched.check.message}`
        )
      );
    process.exit(1);
  }
  const payload = redactForCli<HubNodesPayload>({
    generatedAt: new Date().toISOString(),
    hub: { url: hubCliBaseUrl() },
    count: fetched.nodes.length,
    nodes: fetched.nodes,
  });
  if (jsonOutput) console.log(JSON.stringify(payload, null, 2));
  else
    for (const line of formatNodeTable(payload.nodes))
      logger.info(redactBootstrapSecrets(line));
}

async function runHubDoctor(commandArgs: string[]): Promise<void> {
  const jsonOutput = commandArgs.includes('--json');
  const checks: HubDoctorCheck[] = [hubConfigCheck(), hubAuthCheck()];
  const reachable = await hubFetchJson('/version');
  const hubReachable = !('reason' in reachable);
  checks.push(
    hubReachable
      ? {
          name: 'hub.reachable',
          status: 'pass',
          message: `hub answered /version at ${hubCliBaseUrl()}.`,
        }
      : {
          name: 'hub.reachable',
          status: 'fail',
          reason: reachable.reason,
          message: reachable.message,
        }
  );
  if (hubReachable) {
    const health = await hubFetchJson('/healthz', [], true);
    const body =
      typeof health.body === 'object' && health.body !== null
        ? (health.body as Record<string, unknown>)
        : {};
    const rawDisabledStores = body['disabledStores'];
    const disabledStores =
      Array.isArray(rawDisabledStores) &&
      rawDisabledStores.length > 0 &&
      rawDisabledStores.every(
        (store): store is string =>
          typeof store === 'string' && store.length > 0
      )
        ? rawDisabledStores
        : undefined;
    if (disabledStores) {
      checks.push({
        name: 'persistence.health',
        status: 'fail',
        reason: 'PERSISTENCE_DEGRADED',
        message: `hub persistence is degraded: ${disabledStores.join(', ')}.`,
        details: { status: body['status'], disabledStores },
      });
    } else if ('reason' in health) {
      checks.push({
        name: 'hub.health',
        status: 'fail',
        reason: health.reason,
        message: health.message,
        details: { status: health.status, body: health.body },
      });
    } else {
      checks.push({
        name: 'hub.health',
        status: 'pass',
        message: `hub /healthz reports ${typeof body['status'] === 'string' ? body['status'] : 'healthy'}.`,
      });
    }
  } else {
    checks.push({
      name: 'hub.health',
      status: 'skip',
      reason: 'CHECK_SKIPPED',
      message:
        'unauthenticated health check skipped because hub reachability failed.',
    });
  }
  let nodes: HubNodeSummary[] = [];
  if (hubCliToken() && hubReachable) {
    const fetched = await fetchHubNodes();
    if (!('check' in fetched)) {
      nodes = fetched.nodes;
      checks.push({
        name: 'nodes.registry',
        status: 'pass',
        message: `hub returned ${nodes.length} paired node(s).`,
        details: { count: nodes.length },
      });
      for (const node of nodes)
        checks.push(nodeAvailabilityCheck(node), ...nodeCapabilityChecks(node));
      for (const node of nodes) checks.push(await nodeLogSupportCheck(node));
    } else {
      checks.push(fetched.check);
    }
  } else {
    checks.push({
      name: 'nodes.registry',
      status: 'skip',
      reason: 'CHECK_SKIPPED',
      message:
        'authenticated node registry checks skipped because hub reachability or auth token failed.',
    });
  }
  const failed = checks.filter((check) => check.status === 'fail');
  const payload = redactForCli({
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    hub: {
      url: hubCliBaseUrl(),
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    },
    checks,
    nodes,
  });
  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    logger.info(
      `Hub doctor ${payload.ok ? 'OK' : 'FAILED'} (${failed.length} failure(s))`
    );
    for (const check of checks) {
      const label = check.status.toUpperCase().padEnd(4);
      const reason = check.reason ? ` ${check.reason}` : '';
      const line = `[${label}] ${check.name}${reason}: ${check.message}`;
      if (check.status === 'fail') logger.error(redactBootstrapSecrets(line));
      else logger.info(redactBootstrapSecrets(line));
    }
  }
  process.exit(payload.ok ? 0 : 1);
}

async function printRemoteNodeLogs(commandArgs: string[]): Promise<void> {
  const nodeId = commandArgs[0];
  if (!nodeId || nodeId.startsWith('-')) {
    logger.error(
      'Usage: relay-ide hub node-logs <nodeId> [--lines <n>] [--follow]'
    );
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
  const port =
    getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);
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
    const log =
      typeof body['log'] === 'object' && body['log'] !== null
        ? (body['log'] as Record<string, unknown>)
        : {};
    const output = log['output'];
    const message = log['message'];
    if (typeof output === 'string' && output) process.stdout.write(output);
    else if (typeof message === 'string') logger.info(message);
    return;
  }
  logger.info(
    `Following remote Relay node logs for ${nodeId}; press Ctrl-C to stop.`
  );
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
          if (value)
            process.stdout.write(decoder.decode(value, { stream: true }));
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

interface NodeDoctorResult {
  ok: boolean;
  hostname: string;
  platform: string;
  arch: string;
  helperVersion: string;
  serviceManager: {
    kind: string;
    supported: boolean;
    message: string;
  };
  degradedReasons: Array<{
    code: string;
    description: string;
    severity: string;
  }>;
  hubUrl?: string;
  hubReachable?: boolean;
  hubError?: string;
}

type NodeDoctorDegradedReason = {
  code: string;
  description: string;
  severity: 'info' | 'warn' | 'error';
};

/** Probe hub reachability at /version and return the result. */
async function probeHubReachability(
  hubUrl: string
): Promise<{ reachable: boolean; error?: string }> {
  try {
    const res = await fetch(new URL('/version', hubUrl));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { reachable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reachable: false, error: redactBootstrapSecrets(message) };
  }
}

/** Collect all degraded reasons: manifest reasons + service state + hub check. */
function collectNodeDoctorReasons(
  manifest: NodeManifest,
  st: ReturnType<typeof service.status>,
  hubUrl: string | undefined,
  hubCheck: { reachable?: boolean; error?: string }
): NodeDoctorDegradedReason[] {
  const all: NodeDoctorDegradedReason[] = [
    ...manifest.degradedReasons.map((r) => ({
      ...r,
      severity: r.severity as 'info' | 'warn' | 'error',
    })),
  ];
  if (!st.installed) {
    all.push({
      code: 'SERVICE_NOT_INSTALLED',
      description: 'No local relay-ide service is installed on this node.',
      severity: 'info',
    });
  } else if (!st.running) {
    all.push({
      code: 'SERVICE_NOT_RUNNING',
      description: 'The local relay-ide service is installed but not running.',
      severity: 'warn',
    });
  }
  if (hubUrl && hubCheck.reachable === false) {
    all.push({
      code: 'NODE_CONNECT_FAILED',
      description: `Cannot reach hub at ${redactBootstrapSecrets(hubUrl)}: ${hubCheck.error ?? 'unknown error'}`,
      severity: 'error',
    });
  }
  return all;
}

/** Print the human-readable doctor report. */
function printNodeDoctorHuman(
  manifest: NodeManifest,
  st: ReturnType<typeof service.status>,
  allDegraded: NodeDoctorDegradedReason[],
  hubUrl: string | undefined,
  hubCheck: { reachable?: boolean; error?: string }
): void {
  logger.info(
    `node doctor: ${manifest.hostname} (${manifest.platform}/${manifest.arch})`
  );
  logger.info(
    `relay version: ${manifest.helperVersion} | protocol: ${manifest.protocolVersion}`
  );
  logger.info(
    `service manager: ${manifest.serviceManager.kind} (supported: ${manifest.serviceManager.supported ? 'yes' : 'no'})`
  );
  logger.info(
    `service installed: ${st.installed ? 'yes' : 'no'} | running: ${st.running ? 'yes' : 'no'}`
  );
  for (const caveat of manifest.serviceManager.caveats) {
    logger.info(`  caveat: ${caveat}`);
  }
  if (allDegraded.length === 0) {
    logger.info('no degraded reasons detected.');
  } else {
    logger.info(`degraded reasons (${allDegraded.length}):`);
    for (const reason of allDegraded) {
      const prefix =
        reason.severity === 'error'
          ? '[error]'
          : reason.severity === 'warn'
            ? '[warn] '
            : '[info] ';
      logger.info(`  ${prefix} ${reason.code}: ${reason.description}`);
    }
  }
  if (!hubUrl) {
    logger.info('no --hub supplied; skipping hub reachability check.');
  } else if (hubCheck.reachable) {
    logger.info(`hub reachable: ${hubUrl}`);
  } else {
    logger.error(
      redactBootstrapSecrets(
        `NODE_CONNECT_FAILED: cannot reach hub (${hubCheck.error ?? 'unknown error'})`
      )
    );
  }
}

async function runNodeDoctor(
  hubUrl: string | undefined,
  outputJson: boolean
): Promise<void> {
  const manifest = await getNodeManifest();
  const st = service.status();

  const hubCheck =
    hubUrl !== undefined
      ? await probeHubReachability(hubUrl)
      : ({} as { reachable?: boolean; error?: string });

  const allDegraded = collectNodeDoctorReasons(manifest, st, hubUrl, hubCheck);

  const ok =
    allDegraded.filter((r) => r.severity === 'error' || r.severity === 'warn')
      .length === 0 &&
    (hubUrl === undefined || hubCheck.reachable === true);

  if (outputJson) {
    const result: NodeDoctorResult = {
      ok,
      hostname: manifest.hostname,
      platform: manifest.platform,
      arch: manifest.arch,
      helperVersion: manifest.helperVersion,
      serviceManager: {
        kind: manifest.serviceManager.kind,
        supported: manifest.serviceManager.supported,
        message: manifest.serviceManager.message,
      },
      degradedReasons: allDegraded,
      ...(hubUrl !== undefined ? { hubUrl } : {}),
      ...(hubCheck.reachable !== undefined
        ? { hubReachable: hubCheck.reachable }
        : {}),
      ...(hubCheck.error !== undefined ? { hubError: hubCheck.error } : {}),
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(ok ? 0 : 1);
  }

  printNodeDoctorHuman(manifest, st, allDegraded, hubUrl, hubCheck);
  process.exit(ok ? 0 : 1);
}

function nodeEndpoint(hubUrl: string, pathname: string): string {
  return new URL(pathname, hubUrl).toString();
}

const NODE_PAIR_FETCH_TIMEOUT_MS = 15_000;

const SENSITIVE_URL_QUERY_KEY =
  /(?:token|secret|credential|password|passwd|auth|authorization|key|code|grant|cookie|session|pin)/i;

function sanitizeHubUrlForDisplay(rawHubUrl: string): string {
  try {
    const url = new URL(rawHubUrl);
    url.username = '';
    url.password = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_URL_QUERY_KEY.test(key)) {
        url.searchParams.set(key, '…redacted');
      }
    }
    return url.toString();
  } catch {
    return '<invalid hub url>';
  }
}

function parseNodePairHubUrl(rawHubUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawHubUrl);
  } catch {
    logger.error('INVALID_HUB_URL: hub URL must be an absolute http(s) URL');
    process.exit(1);
  }
  if (url.username || url.password) {
    logger.error(
      `INVALID_HUB_URL: hub URL must not contain embedded credentials (${sanitizeHubUrlForDisplay(rawHubUrl)})`
    );
    process.exit(1);
  }
  return url.toString();
}

function sanitizeNodePairTextForDisplay(text: string): string {
  return redactNodeDiagnostics(text).replace(
    /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
    (url) => sanitizeHubUrlForDisplay(url)
  );
}

function abortError(): Error {
  return new Error('operation aborted');
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const abort = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
      cleanup();
      reject(abortError());
    };
    timerRef.current = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function nodePairFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const timeout = AbortSignal.timeout(NODE_PAIR_FETCH_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeout]);
  return fetch(url, { ...init, signal: combinedSignal });
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

/**
 * Install the relay-ide binary globally via npm and optionally set up the
 * local platform service (launchd / systemd). Does NOT pair the node with a
 * hub — run `relay-ide node pair` after install.
 *
 * This is the "install-only" path introduced in #652 Slice 2.
 * The legacy `relay-ide node install --hub <url> --pair-token <token>` path
 * (pair + optional service setup in one command) still works and is handled
 * below in the `connect|install` branch.
 */
async function runNodeInstallBinary(nodeArgs: string[]): Promise<void> {
  const hubUrl = getNodeArg(nodeArgs, '--hub');
  if (!hubUrl) {
    logger.error(
      'Usage: relay-ide node install --hub <url> [--service <mode>]'
    );
    process.exit(1);
  }

  const serviceMode = parseNodeServiceMode(
    getNodeArg(nodeArgs, '--service') ?? 'manual'
  );

  // Bootstrap installs the published binary; there is no before/after version
  // to verify (the caller may be running from npx or not be installed at all),
  // so only the package manager is detected here.
  const bootstrapInstall = detectRunningInstall([process.argv[1], __dirname]);
  const [bootstrapCommand, bootstrapArgs] = buildUpdateCommand(
    bootstrapInstall.kind,
    'latest',
    bootstrapInstall.installRoot
  );
  logger.info(`installing relay-ide globally via ${bootstrapCommand}...`);
  try {
    await execFileAsync(bootstrapCommand, bootstrapArgs, {
      env: process.env,
    });
    logger.info('relay-ide installed.');
  } catch (err) {
    logger.error(
      `BOOTSTRAP_INSTALL_FAILED: ${execErrorMessage(err, `${bootstrapCommand} ${bootstrapArgs.join(' ')} failed`)}`
    );
    process.exit(1);
  }

  if (serviceMode === 'manual' || serviceMode === 'wsl-manual') {
    logger.info(
      `service mode: ${serviceMode} — no service was installed. run 'relay-ide node pair --hub ${hubUrl} --pair-token <token>' to complete pairing.`
    );
    process.exit(0);
  }

  const manifest = await getNodeManifest();
  validateNodeServiceMode(manifest, serviceMode);

  logger.info(`installing platform service (${serviceMode})...`);
  runServiceCommand(() => {
    process.env['RELAY_IDE_BACKGROUND'] = '1';
    service.install({
      configPath: resolveConfigPath(),
      port: getArg('--port') ?? String(DEFAULTS.port),
      host: getArg('--host') ?? DEFAULTS.host,
      // A bun-global install has no npm-prefix copy for service.ts to find.
      scriptPath: resolveDetectedScriptPath(bootstrapInstall),
    });
  });
}

/**
 * Notify the hub that this node is entering the `updating` state so the hub
 * blocks new session-create requests while the binary is being replaced.
 * Best-effort: if the hub cannot be reached, the update proceeds anyway
 * (the 503 gate is a hub-side guard; the CLI does not block on hub ack).
 */
async function notifyHubNodeUpdating(
  hubUrl: string,
  nodeId: string,
  token: string,
  starting: boolean
): Promise<void> {
  const endpoint = `${hubUrl}/hub/nodes/${encodeURIComponent(nodeId)}/updating`;
  try {
    const res = await fetch(endpoint, {
      method: starting ? 'POST' : 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      logger.warn(
        `hub node-updating signal returned ${res.status}; proceeding with update.`
      );
    }
  } catch (err) {
    logger.warn(
      `could not signal hub (${starting ? 'updating-start' : 'updating-complete'}): ${err instanceof Error ? err.message : String(err)}. proceeding with update.`
    );
  }
}

/** Read the update channel from config. Defaults to 'stable'. */
function resolveUpdateChannel(): 'stable' | 'nightly' {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) return 'stable';
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      updateChannel?: string;
    };
    if (config.updateChannel === 'nightly') return 'nightly';
  } catch {
    // ignore
  }
  return 'stable';
}

/**
 * Read the version currently on disk for the running install. Prefers the
 * detected install root so a re-read after `npm install -g` reflects whichever
 * prefix the package manager actually wrote to (#1284).
 */
function readRunningVersion(installRoot: string | null): string | null {
  if (installRoot) return readInstallRootVersion(installRoot);
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
    ) as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}

/** Query npm for the latest published version of the given dist-tag. */
async function fetchLatestNpmVersion(tag: string): Promise<string> {
  try {
    const result = await execFileAsync('npm', [
      'view',
      `relay-ide@${tag}`,
      'version',
    ]);
    const v = result.stdout.trim();
    if (!v) {
      logger.error(
        `NODE_UPDATE_FAILED: npm view returned an empty version for relay-ide@${tag}`
      );
      process.exit(1);
    }
    return v;
  } catch (err) {
    logger.error(
      `NODE_UPDATE_FAILED: could not fetch latest version from npm: ${execErrorMessage(err, 'npm view failed')}`
    );
    process.exit(1);
  }
}

/** Restart the managed platform service after a binary update. Best-effort. */
function restartServiceAfterUpdate(scriptPath?: string | undefined): void {
  if (!service.isInstalled()) {
    logger.info(
      'no managed service detected. restart relay-ide node link manually to connect with the updated binary.'
    );
    return;
  }
  logger.info('platform service detected — restarting...');
  try {
    service.uninstall();
    service.install({
      configPath: resolveConfigPath(),
      port: getArg('--port') ?? String(DEFAULTS.port),
      host: getArg('--host') ?? DEFAULTS.host,
      // Without this, a bun-global install would uninstall the unit and then
      // fail to reinstall it (npm prefix probing cannot see the bun root).
      scriptPath,
    });
    logger.info('service restarted.');
  } catch (err) {
    logger.warn(
      `service restart failed (update succeeded): ${execErrorMessage(err, 'service restart failed')}. restart the service manually.`
    );
  }
}

/**
 * Update the relay-ide helper binary on this node.
 *
 * `relay-ide node update [--hub <url>]`        — install latest, signal hub, restart service if managed
 * `relay-ide node update --check [--hub <url>]` — report whether update is available (non-destructive)
 *
 * Idempotent: if already at the latest version, prints "already at latest" and exits 0.
 *
 * When `--hub <url>` is provided, the node signals the hub with `POST /hub/nodes/:nodeId/updating`
 * before installing and `DELETE /hub/nodes/:nodeId/updating` after completion, so the hub can
 * block new session-create requests for the duration of the update (#655, Slice 5 of epic #613).
 */
async function runNodeUpdate(nodeArgs: string[]): Promise<void> {
  const checkOnly = nodeArgs.includes('--check');
  const hubUrl = getNodeArg(nodeArgs, '--hub');
  const tag = resolveUpdateChannel() === 'nightly' ? 'nightly' : 'latest';
  const install = detectRunningInstall([process.argv[1], __dirname]);
  const currentVersion = readRunningVersion(install.installRoot);
  const latestVersion = await fetchLatestNpmVersion(tag);

  if (checkOnly) {
    if (currentVersion === latestVersion) {
      logger.info(
        `already at latest (${currentVersion} == relay-ide@${tag} ${latestVersion}).`
      );
    } else {
      logger.info(
        `update available: installed ${currentVersion ?? 'unknown'}, latest relay-ide@${tag} is ${latestVersion}. run 'relay-ide node update' to apply.`
      );
    }
    process.exit(0);
  }

  if (currentVersion === latestVersion) {
    logger.info(
      `already at latest (relay-ide@${tag} ${latestVersion}). nothing to do.`
    );
    process.exit(0);
  }

  // Load credential if hub signaling is requested.
  let credential: { nodeId: string; token: string } | undefined;
  if (hubUrl) {
    try {
      credential = loadNodeCredential();
    } catch {
      logger.warn(
        'could not load node credential; proceeding without hub signaling.'
      );
    }
  }

  // Signal hub: entering updating state (best-effort).
  if (hubUrl && credential) {
    await notifyHubNodeUpdating(
      hubUrl,
      credential.nodeId,
      credential.token,
      true
    );
  }

  const [updateCommand, updateArgs] = buildUpdateCommand(
    install.kind,
    tag,
    install.installRoot
  );
  const clearHubUpdatingFlag = async (): Promise<void> => {
    if (!hubUrl || !credential) return;
    await notifyHubNodeUpdating(
      hubUrl,
      credential.nodeId,
      credential.token,
      false
    );
  };

  logger.info(
    `updating relay-ide from ${currentVersion ?? 'unknown'} → ${latestVersion} (relay-ide@${tag} via ${updateCommand})...`
  );
  try {
    await execFileAsync(updateCommand, updateArgs, {
      env: process.env,
    });
  } catch (err) {
    await clearHubUpdatingFlag();
    logger.error(
      `NODE_UPDATE_FAILED: ${execErrorMessage(err, `${updateCommand} ${updateArgs.join(' ')} failed`)}`
    );
    process.exit(1);
  }

  // The package manager can report success while writing to a different global
  // prefix than the one this CLI runs from (#1284), so verify the running root.
  const installedVersion = readRunningVersion(install.installRoot);
  // Without an install root (dev checkout) a global install legitimately leaves
  // this process's version alone, so there is nothing to verify.
  const verification = install.installRoot
    ? verifyUpdateLanded({
        versionBefore: currentVersion,
        versionAfter: installedVersion,
        latest: latestVersion,
      })
    : 'unverifiable';
  if (
    verification === 'unchanged-stale' ||
    verification === 'no-change-detected'
  ) {
    await clearHubUpdatingFlag();
    const remedy = buildRemedyCommand(install.kind, install.installRoot, tag);
    logger.error(
      `NODE_UPDATE_FAILED: \`${updateCommand} ${updateArgs.join(' ')}\` reported success but ${install.installRoot ?? 'the running install'} is still ${installedVersion ?? 'unknown'} (expected ${latestVersion}). Run: ${remedy}`
    );
    process.exit(1);
  }

  logger.info(
    installedVersion !== null
      ? `relay-ide updated to ${installedVersion}.`
      : 'relay-ide updated.'
  );

  // Signal hub: update complete, clear the updating flag.
  await clearHubUpdatingFlag();

  restartServiceAfterUpdate(resolveDetectedScriptPath(install));
}

function optionalNodeJsonNumber(
  nodeArgs: string[],
  flag: string
): number | undefined {
  const value = getNodeArg(nodeArgs, flag);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.error(`${flag} must be a positive number`);
    process.exit(1);
  }
  return parsed;
}

function optionalNodeArgBody(
  body: Record<string, unknown>,
  key: string,
  value: string | undefined
): void {
  if (value && value.trim()) body[key] = value.trim();
}

async function runNodeMintPairToken(nodeArgs: string[]): Promise<void> {
  const hubUrl = getNodeArg(nodeArgs, '--hub');
  const operatorGrant =
    getNodeArg(nodeArgs, '--operator-grant') ??
    getNodeArg(nodeArgs, '--handshake-grant') ??
    process.env['RELAY_IDE_OPERATOR_GRANT'];
  if (!hubUrl || !operatorGrant) {
    logger.error(
      'Usage: relay-ide node mint-pair-token --hub <url> --operator-grant <handle> [--display-name <name>] [--platform <name>] [--task-ref <ref>] [--json]'
    );
    logger.error(
      `Requires a previously approved ${NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE} grant with ${NODE_PAIR_TOKEN_CREATE_CAPABILITY}; browser cookies/PIN and node credentials are not accepted for this automation lane.`
    );
    process.exit(1);
  }
  try {
    new URL(hubUrl);
  } catch {
    logger.error(`invalid --hub url: ${hubUrl}`);
    process.exit(1);
  }
  const actorType = getNodeArg(nodeArgs, '--actor-type') ?? 'cli';
  const actorId =
    getNodeArg(nodeArgs, '--actor-id') ??
    process.env['RELAY_IDE_ACTOR_ID'] ??
    process.env['USER'] ??
    process.env['USERNAME'] ??
    'relay-ide-cli';
  const body: Record<string, unknown> = {};
  optionalNodeArgBody(
    body,
    'displayName',
    getNodeArg(nodeArgs, '--display-name')
  );
  optionalNodeArgBody(body, 'platform', getNodeArg(nodeArgs, '--platform'));
  optionalNodeArgBody(body, 'taskRef', getNodeArg(nodeArgs, '--task-ref'));
  optionalNodeArgBody(
    body,
    'correlationId',
    getNodeArg(nodeArgs, '--correlation-id')
  );
  optionalNodeArgBody(body, 'trustTier', getNodeArg(nodeArgs, '--trust-tier'));
  const ttlSeconds = optionalNodeJsonNumber(nodeArgs, '--ttl-seconds');
  if (ttlSeconds !== undefined) body['ttlSeconds'] = ttlSeconds;
  body['actor'] = {
    type: actorType,
    id: actorId,
    ...(getNodeArg(nodeArgs, '--actor-display-name')
      ? { displayName: getNodeArg(nodeArgs, '--actor-display-name') }
      : {}),
  };
  const res = await fetch(nodeEndpoint(hubUrl, '/hub/pair-tokens'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-operator-grant': operatorGrant,
      'x-relay-actor-type': actorType,
      'x-relay-actor-id': actorId,
      ...(getNodeArg(nodeArgs, '--correlation-id')
        ? {
            'x-relay-correlation-id': getNodeArg(nodeArgs, '--correlation-id')!,
          }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const responseText = await res.text();
  let response: unknown;
  try {
    response = responseText ? JSON.parse(responseText) : {};
  } catch {
    response = { raw: responseText };
  }
  if (!res.ok) {
    const message =
      typeof response === 'object' && response !== null
        ? ((response as { error?: { code?: string; message?: string } }).error
            ?.message ?? responseText)
        : responseText;
    logger.error(redactBootstrapSecrets(`PAIR_TOKEN_MINT_FAILED: ${message}`));
    process.exit(1);
  }
  if (nodeArgs.includes('--json')) {
    console.log(redactBootstrapSecrets(JSON.stringify(response, null, 2)));
    return;
  }
  const record = response as {
    pairToken?: string;
    tokenId?: string;
    expiresAt?: string;
  };
  if (!record.pairToken) {
    logger.error(
      'PAIR_TOKEN_MINT_FAILED: hub response did not include pairToken'
    );
    process.exit(1);
  }
  console.log(record.pairToken);
  if (record.expiresAt) {
    logger.info(
      `pair token expires at ${record.expiresAt} and is one-time use`
    );
  }
}

/**
 * Generate and print a paste-able bash script that installs relay-ide and
 * pairs the node with the given hub on a remote machine reached via SSH.
 *
 * This is a generation utility — no SSH exec is performed here. The user
 * copies the output and runs it on the target host.
 */
async function runNodeSshBootstrap(nodeArgs: string[]): Promise<void> {
  const target = getNodeArg(nodeArgs, '--target');
  const hubUrl = getNodeArg(nodeArgs, '--hub');

  if (!target || !hubUrl) {
    logger.error(
      'Usage: relay-ide node ssh-bootstrap --target <host> --hub <url>'
    );
    process.exit(1);
  }

  // Validate that hubUrl is a valid URL before embedding in the script.
  try {
    new URL(hubUrl);
  } catch {
    logger.error(`invalid --hub url: ${hubUrl}`);
    process.exit(1);
  }

  const { generateBootstrapCommands } =
    await import('../shared/bootstrap-diagnostics.js');

  const commands = generateBootstrapCommands({
    hubUrl,
    pairToken: 'PAIR_TOKEN_PLACEHOLDER',
    sshTarget: target,
  });

  const sshCmd = commands.find((c) => c.id === 'ssh-auto');
  if (!sshCmd) {
    logger.error('could not generate ssh bootstrap script');
    process.exit(1);
  }

  // Replace the placeholder pair token with a shell variable so the output is
  // reproducible for the same hub URL + target combination and does not embed
  // a real token in the script. The operator fills in PAIR_TOKEN at runtime.
  const scriptWithVar = sshCmd.command.replace(
    /--pair-token\s+'PAIR_TOKEN_PLACEHOLDER'/,
    '--pair-token "${PAIR_TOKEN:?\'set PAIR_TOKEN to a valid pair token from the hub\'}"'
  );

  console.log(`# relay-ide ssh bootstrap — generated for ${target}`);
  console.log(`# hub: ${hubUrl}`);
  console.log(`#`);
  console.log(
    `# 1. get a pair token from your hub with an approved operator grant:`
  );
  console.log(
    `#    relay-ide node mint-pair-token --hub ${hubUrl} --operator-grant <relay-ohg-v1...> --display-name <name> --ttl-seconds 600`
  );
  console.log(`# 2. set PAIR_TOKEN and run the command below:`);
  console.log(`#    PAIR_TOKEN=pair_... ${scriptWithVar}`);
  console.log();
  for (const caveat of sshCmd.caveats) {
    console.log(`# note: ${caveat}`);
  }
  console.log();
  console.log(scriptWithVar);
}

// #981: node pairing/link diagnostics run next to identity key material, so
// layer the identity-key redactor (PEM key blocks, secret_ fragments) over the
// bootstrap-secret redactor. Defense-in-depth: today no path formats a private
// key or proof into an error, and this keeps it that way if one ever does.
function redactNodeDiagnostics(text: string): string {
  return redactNodeIdentityMaterial(redactBootstrapSecrets(text));
}

function nodeCredentialPath(): string {
  return path.join(service.CONFIG_DIR, 'node-credential.json');
}

function writeNodeCredential(credential: unknown): void {
  writeNodeCredentialFile(nodeCredentialPath(), credential);
}

// #981: stable node identity key. The private key never leaves the node; only
// the public key is sent to the hub at pairing. Persisted separately from the
// (replaceable) credential so the identity key is REUSED across re-pairs and
// rotations. Stored 0600 via the same atomic writer as the credential file.
function nodeIdentityKeyPath(): string {
  return path.join(service.CONFIG_DIR, 'node-identity-key.json');
}

function loadNodeIdentityKey(): NodeIdentityKeyPair | undefined {
  const keyPath = nodeIdentityKeyPath();
  if (!fs.existsSync(keyPath)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as unknown;
    // parseStoredNodeIdentityKey rejects corrupt/mismatched/non-ed25519 keys
    // (it derives the public key from the private key and compares), so a bad
    // file is treated as absent and regenerated before the next pair instead
    // of binding a public key the node could never prove possession of.
    return parseStoredNodeIdentityKey(raw) ?? undefined;
  } catch {
    // Malformed JSON is regenerated on the next pair.
    return undefined;
  }
}

function loadOrCreateNodeIdentityKey(): NodeIdentityKeyPair {
  const existing = loadNodeIdentityKey();
  if (existing) return existing;
  const keys = generateNodeIdentityKeyPair();
  // Atomic temp+rename overwrites any corrupt prior file at the destination.
  writeNodeCredentialFile(nodeIdentityKeyPath(), keys);
  return keys;
}

// Build a fresh-per-call proof of private-key possession for the node lane.
// Returns undefined (legacy bearer-only) when no identity key or credentialId
// is available, so unpaired/legacy nodes keep working.
function nodeLinkProofFactory(
  nodeId: string,
  credentialId: string | undefined,
  audience: NodeLinkProofAudience
): () => string | undefined {
  const identity = loadNodeIdentityKey();
  if (!identity || !credentialId) return () => undefined;
  return () =>
    createNodeLinkProof({
      privateKeyPem: identity.privateKeyPem,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      nodeId,
      credentialId,
      audience,
      nowMs: Date.now(),
    });
}

function loadNodeCredential(): {
  nodeId: string;
  token: string;
  credentialId?: string;
} {
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
    const parsed = raw as {
      nodeId?: unknown;
      token?: unknown;
      credentialId?: unknown;
    };
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
    logger.error(redactNodeDiagnostics(`NODE_LINK_FAILED: ${message}`));
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
  const localRelayNode = createLocalRelayNode({ nodeId: credential.nodeId });
  // #467: ask the manifest probe which resume mode this host supports
  // so the pty host can pick tmux vs raw without re-probing. The host also
  // gets the local session boundary so routed browser attaches bind to the
  // already-created native PTY session instead of spawning a fallback shell.
  const initialManifest = await getNodeManifest();
  const sessionResume = initialManifest.capabilities.sessionResume ?? 'none';
  const ptyHost = createNodeLinkPtyHost({
    nodeId: credential.nodeId,
    sessionResume,
    localRelayNode,
  });
  const nodeLinkClient: { current?: ReturnType<typeof createNodeLinkClient> } =
    {};
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
    // #981: sign a fresh node-link proof on each (re)connect when this node has
    // a bound identity key. Legacy nodes return undefined and stay bearer-only.
    buildNodeLinkProof: nodeLinkProofFactory(
      credential.nodeId,
      credential.credentialId,
      'relay:node-link:v1'
    ),
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

type NodeCredentialForPairing = {
  token: string;
  nodeId: string;
  credentialId?: string;
  publicKeyFingerprint?: string;
};

type PendingPairingSubmitResponse = {
  request?: NodePairingRequestSummary;
  statusToken?: string;
  error?: { code?: string; message?: string };
};

type PendingPairingPollResponse = {
  request?: NodePairingRequestSummary;
  credential?: NodeCredentialForPairing;
  node?: { displayName?: string };
  error?: { code?: string; message?: string; reasonCode?: string };
};

function nodePairHubUrl(nodeArgs: string[]): string | undefined {
  const explicit = getNodeArg(nodeArgs, '--hub');
  if (explicit) return explicit;
  const pairIndex = nodeArgs.indexOf('pair');
  const candidate = pairIndex >= 0 ? nodeArgs[pairIndex + 1] : undefined;
  return candidate && !candidate.startsWith('-') ? candidate : undefined;
}

function nodePairDisplayName(
  nodeArgs: string[],
  manifest: NodeManifest
): string {
  return (
    getNodeArg(nodeArgs, '--display-name') ??
    process.env['RELAY_IDE_NODE_DISPLAY_NAME'] ??
    manifest.hostname ??
    'relay-node'
  ).trim();
}

function nodePairRequestedProfile(nodeArgs: string[]): NodePairingTrustProfile {
  const raw =
    getNodeArg(nodeArgs, '--profile') ??
    getNodeArg(nodeArgs, '--trust-profile');
  if (!raw) return DEFAULT_NODE_PAIRING_TRUST_PROFILE;
  if (isNodePairingTrustProfile(raw)) return raw;
  logger.error(
    `Invalid --profile ${raw}. Expected one of: dev-workstation, sandbox-runner, automation-runner, infra-prod-host`
  );
  process.exit(1);
}

function repeatedNodeArg(nodeArgs: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < nodeArgs.length; i += 1) {
    if (nodeArgs[i] !== flag) continue;
    const value = nodeArgs[i + 1];
    if (value && !value.startsWith('-')) values.push(value);
  }
  return values;
}

function nodePairRequestedRoots(nodeArgs: string[]): string[] | undefined {
  const raw = [
    ...repeatedNodeArg(nodeArgs, '--root'),
    ...repeatedNodeArg(nodeArgs, '--requested-root'),
  ];
  const roots = raw
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return roots.length ? roots : undefined;
}

function nodePairPollIntervalMs(nodeArgs: string[]): number {
  const raw =
    getNodeArg(nodeArgs, '--poll-interval-ms') ??
    process.env['RELAY_IDE_NODE_PAIR_POLL_INTERVAL_MS'];
  if (!raw) return 2_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 100) return 2_000;
  return Math.min(parsed, 30_000);
}

function redactHostHint(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const suffix = trimmed.slice(-16);
  return suffix.length < trimmed.length ? `…${suffix}` : suffix;
}

function secondsUntil(iso: string, now = Date.now()): number {
  const ms = Date.parse(iso) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function safeJsonLine(value: unknown): void {
  console.log(redactNodeDiagnostics(JSON.stringify(value)));
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: { code: 'MALFORMED_RESPONSE', message: text } } as T;
  }
}

function validateNodeCredentialForPairing(
  credential: unknown
): NodeCredentialForPairing | null {
  if (typeof credential !== 'object' || credential === null) return null;
  const record = credential as Record<string, unknown>;
  if (typeof record['token'] !== 'string' || !record['token']) return null;
  if (typeof record['nodeId'] !== 'string' || !record['nodeId']) return null;
  return {
    token: record['token'],
    nodeId: record['nodeId'],
    ...(typeof record['credentialId'] === 'string' && record['credentialId']
      ? { credentialId: record['credentialId'] }
      : {}),
    ...(typeof record['publicKeyFingerprint'] === 'string' &&
    record['publicKeyFingerprint']
      ? { publicKeyFingerprint: record['publicKeyFingerprint'] }
      : {}),
  };
}

async function sendInitialNodeHeartbeat(
  hubUrl: string,
  credential: NodeCredentialForPairing,
  manifest: NodeManifest
): Promise<void> {
  const bootstrapProof = credential.publicKeyFingerprint
    ? nodeLinkProofFactory(
        credential.nodeId,
        credential.credentialId,
        'relay:node-heartbeat:v1'
      )()
    : undefined;
  const heartbeatRes = await fetch(
    nodeEndpoint(hubUrl, '/hub/node-heartbeat'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential.token}`,
        ...(bootstrapProof ? { 'x-relay-node-proof': bootstrapProof } : {}),
      },
      body: JSON.stringify({
        nodeId: credential.nodeId,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        manifest,
      }),
    }
  );
  if (!heartbeatRes.ok) {
    const body = await heartbeatRes.text();
    throw new Error(`heartbeat rejected: ${body}`);
  }
}

function renderNodePairRequest(input: {
  request: NodePairingRequestSummary;
  hubUrl: string;
  manifest: NodeManifest;
  outputJson: boolean;
}): void {
  const { request, hubUrl, manifest, outputJson } = input;
  const pairUrl = new URL(
    `/pair/${encodeURIComponent(request.deviceCode)}`,
    hubUrl
  ).toString();
  const expiresSeconds = secondsUntil(request.expiresAt);
  if (outputJson) {
    safeJsonLine({
      ok: true,
      event: 'pairing-requested',
      requestId: request.requestId,
      deviceCode: request.deviceCode,
      pairUrl,
      expiresAt: request.expiresAt,
      requestedProfile: request.requestedProfile,
      publicKeyFingerprint: request.publicKeyFingerprint,
    });
    return;
  }
  logger.info('relay node pairing');
  logger.info('');
  logger.info(`device: ${request.displayName}`);
  const hostHint = redactHostHint(manifest.hostname);
  if (hostHint) logger.info(`host hint: ${hostHint}`);
  logger.info(`platform: ${manifest.platform} ${manifest.arch}`);
  logger.info(`relay: ${manifest.relayVersion ?? manifest.helperVersion}`);
  logger.info('');
  logger.info('open this URL on a signed-in device:');
  logger.info(pairUrl);
  logger.info('');
  logger.info('or enter code:');
  logger.info(request.deviceCode);
  logger.info('');
  logger.info(
    `waiting for approval... expires in ${formatCountdown(expiresSeconds)}`
  );
}

function exitNodePairError(input: {
  code: string;
  message: string;
  outputJson: boolean;
  retryable?: boolean;
}): never {
  const { code, message, outputJson, retryable } = input;
  const safeMessage = sanitizeNodePairTextForDisplay(message);
  if (outputJson)
    safeJsonLine({ ok: false, code, message: safeMessage, retryable });
  else logger.error(sanitizeNodePairTextForDisplay(`${code}: ${message}`));
  process.exit(1);
}

function exitNodePairDenied(hubUrl: string, outputJson: boolean): never {
  if (outputJson) safeJsonLine({ ok: false, code: 'PAIRING_DENIED' });
  else {
    logger.error('pairing denied by operator');
    logger.error('no credential was issued');
    logger.error(
      `run \`relay-ide node pair ${sanitizeHubUrlForDisplay(hubUrl)}\` again to request a new code`
    );
  }
  process.exit(1);
}

function exitNodePairExpired(outputJson: boolean): never {
  if (outputJson) safeJsonLine({ ok: false, code: 'PAIRING_EXPIRED' });
  else {
    logger.error('pairing request expired (no approval within 10:00)');
    logger.error('run `relay-ide node pair <hub>` again to get a fresh code');
  }
  process.exit(1);
}

async function finishApprovedDevicePairing(input: {
  hubUrl: string;
  displayHubUrl: string;
  manifest: NodeManifest;
  poll: PendingPairingPollResponse;
  outputJson: boolean;
}): Promise<void> {
  const { hubUrl, displayHubUrl, manifest, poll, outputJson } = input;
  const credential = validateNodeCredentialForPairing(poll.credential);
  if (!credential || !poll.request) {
    exitNodePairError({
      code: 'PAIRING_PROTOCOL_ERROR',
      message: 'hub approved pairing without a valid node credential',
      outputJson,
      retryable: false,
    });
  }
  writeNodeCredential(credential);
  await sendInitialNodeHeartbeat(hubUrl, credential, manifest);
  const approvedName = poll.node?.displayName ?? poll.request.displayName;
  if (outputJson) {
    safeJsonLine({
      ok: true,
      event: 'paired',
      nodeId: credential.nodeId,
      credentialId: credential.credentialId,
      displayName: approvedName,
      linkCommand: `relay-ide node link --hub ${displayHubUrl}`,
    });
    return;
  }
  logger.info(`approved as ${approvedName}`);
  logger.info('credential stored');
  logger.info('node is paired but the link is not running');
  logger.info(`start it with: relay-ide node link --hub ${displayHubUrl}`);
}

function isRetryableNodePairStatusResponse(response: Response): boolean {
  return (
    response.status === 408 || response.status === 429 || response.status >= 500
  );
}

async function requestNodeDevicePairingStatus(input: {
  hubUrl: string;
  requestId: string;
  statusToken: string;
  signal: AbortSignal;
}): Promise<{ response: Response; poll: PendingPairingPollResponse } | null> {
  const { hubUrl, requestId, statusToken, signal } = input;
  try {
    const response = await nodePairFetch(
      nodeEndpoint(hubUrl, `/hub/pairing/requests/${requestId}/status`),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-relay-pairing-status-token': statusToken,
        },
        body: JSON.stringify({}),
      },
      signal
    );
    return {
      response,
      poll: await readJsonResponse<PendingPairingPollResponse>(response),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function handleNodeDevicePairingStatus(input: {
  hubUrl: string;
  displayHubUrl: string;
  manifest: NodeManifest;
  response: Response;
  poll: PendingPairingPollResponse;
  outputJson: boolean;
}): Promise<'pending' | 'done'> {
  const { hubUrl, displayHubUrl, manifest, response, poll, outputJson } = input;
  if (!response.ok) {
    if (isRetryableNodePairStatusResponse(response)) return 'pending';
    exitNodePairError({
      code: poll.error?.code ?? 'PAIRING_STATUS_FAILED',
      message: poll.error?.message ?? 'hub status poll failed',
      outputJson,
      retryable: true,
    });
  }
  if (!poll.request) {
    exitNodePairError({
      code: poll.error?.code ?? 'PAIRING_PROTOCOL_ERROR',
      message: poll.error?.message ?? 'hub returned malformed pairing status',
      outputJson,
      retryable: false,
    });
  }
  if (poll.request.state === 'pending') return 'pending';
  if (poll.request.state === 'denied')
    exitNodePairDenied(displayHubUrl, outputJson);
  if (poll.request.state === 'expired') exitNodePairExpired(outputJson);
  if (poll.request.state === 'approved') {
    await finishApprovedDevicePairing({
      hubUrl,
      displayHubUrl,
      manifest,
      poll,
      outputJson,
    });
    return 'done';
  }
  exitNodePairError({
    code: 'PAIRING_PROTOCOL_ERROR',
    message: 'hub returned unknown pairing status state',
    outputJson,
    retryable: false,
  });
}

async function runNodeDeviceCodePair(nodeArgs: string[]): Promise<void> {
  const rawHubUrl = nodePairHubUrl(nodeArgs);
  const outputJson = nodeArgs.includes('--json');
  if (!rawHubUrl) {
    logger.error('Usage: relay-ide node pair <hub> [--json]');
    logger.error(
      'Legacy automation path: relay-ide node pair --hub <url> --pair-token <token>'
    );
    process.exit(1);
  }
  const hubUrl = parseNodePairHubUrl(rawHubUrl);
  const displayHubUrl = sanitizeHubUrlForDisplay(hubUrl);
  const abortController = new AbortController();
  const markInterrupted = (): void => abortController.abort();
  process.once('SIGINT', markInterrupted);
  process.once('SIGTERM', markInterrupted);

  try {
    const manifest = await getNodeManifest();
    const identityKey = loadOrCreateNodeIdentityKey();
    const displayName = nodePairDisplayName(nodeArgs, manifest);
    const requestedProfile = nodePairRequestedProfile(nodeArgs);
    const requestedRoots = nodePairRequestedRoots(nodeArgs);
    const submitRes = await nodePairFetch(
      nodeEndpoint(hubUrl, '/hub/pairing/requests'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest,
          publicKey: identityKey.publicKeyPem,
          protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
          displayName,
          requestedProfile,
          ...(requestedRoots ? { requestedRoots } : {}),
        }),
      },
      abortController.signal
    );
    const submit =
      await readJsonResponse<PendingPairingSubmitResponse>(submitRes);
    if (!submitRes.ok || !submit.request || !submit.statusToken) {
      exitNodePairError({
        code: submit.error?.code ?? 'PAIRING_REQUEST_FAILED',
        message: submit.error?.message ?? 'hub did not accept pairing request',
        outputJson,
        retryable: true,
      });
    }

    const request = submit.request;
    renderNodePairRequest({
      request,
      hubUrl: displayHubUrl,
      manifest,
      outputJson,
    });

    const pollIntervalMs = nodePairPollIntervalMs(nodeArgs);
    while (true) {
      await abortableDelay(pollIntervalMs, abortController.signal);
      const status = await requestNodeDevicePairingStatus({
        hubUrl,
        requestId: request.requestId,
        statusToken: submit.statusToken,
        signal: abortController.signal,
      });
      if (!status) continue;
      const result = await handleNodeDevicePairingStatus({
        hubUrl,
        displayHubUrl,
        manifest,
        response: status.response,
        poll: status.poll,
        outputJson,
      });
      if (result === 'done') return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (abortController.signal.aborted) {
      if (outputJson) safeJsonLine({ ok: false, code: 'INTERRUPTED' });
      else logger.error('pairing interrupted; no credential was issued');
      process.exit(130);
    }
    const safeMessage = sanitizeNodePairTextForDisplay(message);
    if (outputJson)
      safeJsonLine({
        ok: false,
        code: 'NODE_PAIR_FAILED',
        message: safeMessage,
      });
    else
      logger.error(
        sanitizeNodePairTextForDisplay(`NODE_PAIR_FAILED: ${message}`)
      );
    process.exit(1);
  } finally {
    process.off('SIGINT', markInterrupted);
    process.off('SIGTERM', markInterrupted);
  }
}

async function pairNode(
  nodeArgs: string[],
  lifecycle: NodePairLifecycle = 'connect'
): Promise<void> {
  const rawHubUrl = getNodeArg(nodeArgs, '--hub');
  const pairToken = getNodeArg(nodeArgs, '--pair-token');
  if (!rawHubUrl || !pairToken) {
    logger.error(
      'Usage: relay-ide node connect --hub <url> --pair-token <token>'
    );
    process.exit(1);
  }
  const hubUrl = parseNodePairHubUrl(rawHubUrl);

  try {
    const manifest = await getNodeManifest();
    // #981: create/reuse the local identity key and send only its public half.
    const identityKey = loadOrCreateNodeIdentityKey();
    const exchangeRes = await fetch(
      nodeEndpoint(hubUrl, '/hub/pairing/exchange'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairToken,
          manifest,
          protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
          publicKey: identityKey.publicKeyPem,
        }),
      }
    );
    const exchange = (await exchangeRes.json()) as {
      credential?: {
        token: string;
        nodeId: string;
        credentialId?: string;
        publicKeyFingerprint?: string;
      };
      node?: { displayName: string };
      error?: { code: string; message: string };
    };
    if (!exchangeRes.ok || !exchange.credential) {
      const code =
        exchange.error?.code === 'TOKEN_EXPIRED'
          ? 'PAIR_TOKEN_EXPIRED'
          : 'PAIR_TOKEN_INVALID';
      logger.error(
        redactNodeDiagnostics(
          `${code}: ${exchange.error?.message ?? 'pairing failed'}`
        )
      );
      process.exit(1);
    }

    writeNodeCredential(exchange.credential);

    // #981: prove possession on the bootstrap heartbeat when the hub bound our
    // key. Omitted for legacy hubs that return no fingerprint (bearer-only).
    const bootstrapProof = exchange.credential.publicKeyFingerprint
      ? nodeLinkProofFactory(
          exchange.credential.nodeId,
          exchange.credential.credentialId,
          'relay:node-heartbeat:v1'
        )()
      : undefined;
    const heartbeatRes = await fetch(
      nodeEndpoint(hubUrl, '/hub/node-heartbeat'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${exchange.credential.token}`,
          ...(bootstrapProof ? { 'x-relay-node-proof': bootstrapProof } : {}),
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
        redactNodeDiagnostics(
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
    logger.error(redactNodeDiagnostics(`NODE_CONNECT_FAILED: ${message}`));
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
  } else if (subCommand === 'nodes') {
    await runAsyncCommand(() => printHubNodes(hubArgs.slice(1)));
  } else if (subCommand === 'doctor') {
    await runHubDoctor(hubArgs.slice(1));
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
      'Usage: relay-ide hub [install|uninstall|status|logs|nodes|doctor|node-logs] [--allow-degraded] [--port <port>] [--host <host>] [--config <path>]'
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
    const outputJson = nodeArgs.includes('--json');
    await runNodeDoctor(getNodeArg(nodeArgs, '--hub'), outputJson);
    process.exit(0);
  }
  if (subCommand === 'link') {
    await runNodeLink(nodeArgs);
    process.exit(0);
  }
  // relay-ide node update [--check]
  // Update the helper binary on this node (Slice 5, #655).
  if (subCommand === 'update') {
    await runNodeUpdate(nodeArgs.slice(1));
    process.exit(0);
  }
  // relay-ide node pair --hub <url> --pair-token <token>
  // Productized pair-only command. The 'connect' subcommand is an alias for
  // the same token-based pairing path; both call pairNode() under the hood.
  if (subCommand === 'mint-pair-token') {
    await runNodeMintPairToken(nodeArgs);
    process.exit(0);
  }
  if (subCommand === 'pair') {
    const pairToken = getNodeArg(nodeArgs, '--pair-token');
    if (pairToken) {
      await pairNode(nodeArgs, 'connect');
    } else {
      await runNodeDeviceCodePair(nodeArgs);
    }
    process.exit(0);
  }
  // relay-ide node ssh-bootstrap --target <host> --hub <url>
  if (subCommand === 'ssh-bootstrap') {
    await runNodeSshBootstrap(nodeArgs);
    process.exit(0);
  }
  // relay-ide node install --hub <url> [--service <mode>]
  //   NEW (Slice 2): install binary only, no pair-token required.
  //   When --pair-token IS present, falls through to legacy connect+service path.
  // relay-ide node connect --hub <url> --pair-token <token>
  //   Back-compat pair-only alias.
  if (subCommand === 'connect' || subCommand === 'install') {
    if (subCommand === 'install') {
      const pairToken = getNodeArg(nodeArgs, '--pair-token');
      if (!pairToken) {
        // New Slice 2 path: install-only (no pairing).
        await runNodeInstallBinary(nodeArgs);
        process.exit(0);
      }
      // Legacy path: pair + optional service setup in one command.
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
    'Usage: relay-ide node <status|logs|doctor|pair|mint-pair-token|install|ssh-bootstrap|connect|link|update>'
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

  // Handle 'add': determine a default path when omitted, then forward to git.
  const gitWtArgs = [...wtArgs];
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
  process.exit(0);
}

if (command === 'sessions') {
  const sessionArgs = args.slice(1);
  const subCommand = sessionArgs[0];
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';
  const port =
    getArg('--port') ?? process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);

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
  };

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
        logger.error(
          'Usage: relay-ide sessions interventions <session-id> [--limit <n>]'
        );
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

    if (subCommand === 'scoped' && sessionArgs[1] === 'list') {
      const includeRevoked = sessionArgs.includes('--include-revoked')
        ? '1'
        : '0';
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
        logger.error(
          'Usage: relay-ide sessions scoped revoke <session-id> [--node-id <nodeId>] [--reason <reason>]'
        );
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
if (args.includes('--allow-degraded')) {
  process.env['RELAY_IDE_ALLOW_DEGRADED'] = '1';
}

if (command !== 'v1') await import('../server/index.js');
