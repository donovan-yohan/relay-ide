#!/usr/bin/env node
/* eslint-disable no-console -- CLI entry point, user-facing stdout/stderr output */

/**
 * relayctl — per-session Relay companion CLI.
 *
 * Available only inside Relay-managed PTY sessions (added to PATH via a
 * per-session bin shim written by pty-handler.ts). Not intended for general
 * use outside Relay sessions.
 *
 * subcommands:
 *   whoami                          — print session identity from env
 *   status                          — fetch node manifest summary from hub
 *   files read <path> [--cwd <d>]  — read a file via hub file RPC
 *   files list <path> [--cwd <d>]  — list a directory via hub file RPC
 *   logs tail                       — stub (slice 5 will wire #597)
 *
 * exit codes:
 *   0  — success
 *   1  — general error / stub
 *   2  — capability missing (file:read not granted)
 */

const args = process.argv.slice(2);

const RELAY_HUB_URL = process.env.RELAY_HUB_URL;
const RELAY_NODE_ID = process.env.RELAY_NODE_ID;
const RELAY_WORK_CONTEXT_ID = process.env.RELAY_WORK_CONTEXT_ID;

function die(message: string, code = 1): never {
  console.error(`relayctl: ${message}`);
  process.exit(code);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    die(
      `not running inside a relay session (${name} is not set). ` +
        'relayctl is only available inside relay-managed pty sessions.'
    );
  }
  return val;
}

// ── subcommand: whoami ─────────────────────────────────────────────────────

function cmdWhoami(): void {
  const nodeId = requireEnv('RELAY_NODE_ID');
  const sessionId = requireEnv('RELAY_SESSION_ID');

  console.log(`node_id:      ${nodeId}`);
  console.log(`session_id:   ${sessionId}`);
  if (RELAY_WORK_CONTEXT_ID) {
    console.log(`work_context: ${RELAY_WORK_CONTEXT_ID}`);
  }
  if (RELAY_HUB_URL) {
    console.log(`hub_url:      ${RELAY_HUB_URL}`);
  }
}

// ── subcommand: status ─────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const hubUrl = requireEnv('RELAY_HUB_URL');

  let res: Response;
  try {
    res = await fetch(`${hubUrl}/api/node/manifest`);
  } catch (err) {
    die(
      `failed to reach hub at ${hubUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    die(`hub returned ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { manifest?: Record<string, unknown> };
  const manifest = body.manifest ?? {};

  // Print a compact summary — full manifest is available via relay-ide manifest
  const platform = manifest['platform'] ?? 'unknown';
  const version = manifest['version'] ?? 'unknown';
  const nodeId = manifest['nodeId'] ?? RELAY_NODE_ID ?? 'unknown';
  const capabilities = Array.isArray(manifest['capabilities'])
    ? (manifest['capabilities'] as string[])
    : [];

  console.log(`node_id:      ${nodeId}`);
  console.log(`version:      ${version}`);
  console.log(`platform:     ${platform}`);
  if (capabilities.length > 0) {
    console.log(`capabilities: ${capabilities.join(', ')}`);
  }
}

// ── subcommand: files ──────────────────────────────────────────────────────

/**
 * Perform a file RPC call (read or list) via the hub.
 * Exits with code 2 if the session lacks the file:read capability.
 */
async function cmdFiles(fileArgs: string[]): Promise<void> {
  const op = fileArgs[0];

  if (op !== 'read' && op !== 'list') {
    if (!op) {
      die('usage: relayctl files <read|list> <path> [--cwd <dir>]');
    }
    if (op === 'write' || op === 'delete') {
      die(
        `files ${op} is not available via relayctl (capability-gated, write operations excluded)`
      );
    }
    die(`unknown files operation: ${op}. supported: read, list`);
  }

  const filePath = fileArgs[1];
  if (!filePath) {
    die(`usage: relayctl files ${op} <path> [--cwd <dir>]`);
  }

  // Parse optional --cwd flag
  let cwd: string | undefined;
  const cwdIdx = fileArgs.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = fileArgs[cwdIdx + 1];
    if (!cwd) {
      die('--cwd requires a directory argument');
    }
  }

  const hubUrl = requireEnv('RELAY_HUB_URL');
  const sessionId = requireEnv('RELAY_SESSION_ID');
  const nodeId = requireEnv('RELAY_NODE_ID');

  const body: Record<string, unknown> = { path: filePath };
  if (cwd) body['cwd'] = cwd;

  const endpoint = `${hubUrl}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/${encodeURIComponent(sessionId)}/files/${op}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(
      `failed to reach hub at ${hubUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 403 or specific capability-missing responses → exit 2
  if (res.status === 403) {
    let detail = '';
    try {
      const errBody = (await res.json()) as { error?: string; code?: string };
      detail = errBody.error ?? errBody.code ?? '';
    } catch {
      // ignore parse error
    }
    const msg = detail
      ? `capability denied: ${detail}`
      : 'capability denied: session lacks file:read capability (rpc:fs:read / rpc:fs:list)';
    console.error(`relayctl: ${msg}`);
    process.exit(2);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const errBody = (await res.json()) as { error?: string };
      detail = errBody.error ?? '';
    } catch {
      // ignore
    }
    die(
      `hub returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`
    );
  }

  const result = await res.json();
  console.log(JSON.stringify(result, null, 2));
}

// ── subcommand: logs ───────────────────────────────────────────────────────

function cmdLogs(logsArgs: string[]): void {
  const sub = logsArgs[0];
  if (sub !== 'tail') {
    die(`unknown logs subcommand: ${sub ?? '(none)'}. supported: tail`);
  }
  // Slice 5 will wire this when #597 lands.
  console.error('relayctl: logs.tail rpc not yet available');
  process.exit(1);
}

// ── dispatch ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(
      [
        'usage: relayctl <subcommand> [args]',
        '',
        'subcommands:',
        '  whoami                         print session identity',
        '  status                         show node manifest summary',
        '  files read <path> [--cwd <d>]  read a file',
        '  files list <path> [--cwd <d>]  list a directory',
        '  logs tail                       (not yet available)',
        '',
        'relayctl is only available inside relay-managed pty sessions.',
      ].join('\n')
    );
    process.exit(0);
  }

  switch (subcommand) {
    case 'whoami':
      cmdWhoami();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'files':
      await cmdFiles(args.slice(1));
      break;
    case 'logs':
      cmdLogs(args.slice(1));
      break;
    default:
      die(
        `unknown subcommand: ${subcommand}. run "relayctl --help" for usage.`
      );
  }
}

main().catch((err: unknown) => {
  console.error(
    'relayctl: unexpected error:',
    err instanceof Error ? err.message : String(err)
  );
  process.exitCode = 1;
});
