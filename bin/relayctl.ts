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
 *   agent preturn [--session <id>] [--format markdown|json]
 *                                   — read this session's pending inbox (PULL)
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

// ── subcommand: agent preturn ────────────────────────────────────────────────

// Minimal shapes mirroring shared/context-packet.ts. relayctl is a tiny
// standalone shim with no shared-module imports, so we type only the fields we
// render and treat the rest defensively.
interface PreturnPacket {
  id: string;
  kind: string;
  note?: string;
  anchor?: {
    ref?: { path?: string; nodeId?: string };
    lineRange?: { startLine: number; endLine: number };
    byteRange?: { startByte: number; endByte: number };
    quote?: string;
  };
  fileRef?: { path?: string; nodeId?: string };
  createdBy?: string;
  createdAt?: string;
}

interface PreturnMessage {
  id: string;
  targetSessionId?: string;
  targetWorkContextId?: string;
  contextPacketIds: string[];
  text?: string;
  state: string;
  createdBy?: string;
  createdAt?: string;
  deliveredAt?: string;
}

const PRETURN_CAPABILITIES = 'inbox:read,context:read';

/**
 * Build the gateway headers a relayctl read uses against the hub. The hub
 * `requireCliGatewayAuth` middleware accepts the v1 header + a scoped bearer
 * token (when `RELAY_IDE_BROWSER_TOKEN` is present), or falls through to
 * NO_PIN/cookie auth (the dev/in-PTY default). The capability header is always
 * required by the context/inbox router itself, independent of the auth path.
 */
function gatewayHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'x-relay-cli-gateway': 'v1',
    'x-relay-capabilities': PRETURN_CAPABILITIES,
  };
  const token = process.env.RELAY_IDE_BROWSER_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** Parse `--session <id>` / `--format <markdown|json>` from preturn args. */
function parsePreturnArgs(preturnArgs: string[]): {
  sessionId: string | undefined;
  format: 'markdown' | 'json';
} {
  let sessionId: string | undefined;
  let format: 'markdown' | 'json' = 'markdown';
  for (let i = 0; i < preturnArgs.length; i += 1) {
    const arg = preturnArgs[i];
    if (arg === '--session') {
      sessionId = preturnArgs[i + 1];
      if (!sessionId) die('--session requires a session id argument');
      i += 1;
    } else if (arg === '--format') {
      const value = preturnArgs[i + 1];
      if (value !== 'markdown' && value !== 'json') {
        die(`--format must be 'markdown' or 'json' (got ${value ?? '(none)'})`);
      }
      format = value;
      i += 1;
    } else {
      die(
        `unknown preturn argument: ${arg}. ` +
          'usage: relayctl agent preturn [--session <id>] [--format markdown|json]'
      );
    }
  }
  return { sessionId, format };
}

/** One-line label for a packet's location (anchor range / file ref). */
function packetLocation(packet: PreturnPacket): string | undefined {
  const anchor = packet.anchor;
  if (anchor?.ref?.path) {
    let label = anchor.ref.path;
    if (anchor.lineRange) {
      const { startLine, endLine } = anchor.lineRange;
      label +=
        startLine === endLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`;
    } else if (anchor.byteRange) {
      label += `@${anchor.byteRange.startByte}-${anchor.byteRange.endByte}`;
    }
    return label;
  }
  if (packet.fileRef?.path) return packet.fileRef.path;
  return undefined;
}

/** Render a single packet as a markdown bullet block. */
function renderPacketMarkdown(packet: PreturnPacket): string {
  const lines: string[] = [];
  const location = packetLocation(packet);
  lines.push(`  - **${packet.kind}**${location ? ` — \`${location}\`` : ''}`);
  if (packet.note) lines.push(`    - note: ${packet.note}`);
  const quote = packet.anchor?.quote;
  if (quote) {
    lines.push('    - quote:');
    lines.push('      ```');
    for (const q of quote.split('\n')) lines.push(`      ${q}`);
    lines.push('      ```');
  }
  return lines.join('\n');
}

/** Render the full preturn payload as model-friendly markdown. */
function renderPreturnMarkdown(
  sessionId: string,
  messages: PreturnMessage[],
  packetsById: Map<string, PreturnPacket>
): string {
  const lines: string[] = [];
  lines.push(`# Relay pending context — session ${sessionId}`);
  lines.push('');
  if (messages.length === 0) {
    lines.push('No pending inbox messages.');
    return lines.join('\n');
  }
  lines.push(
    `${messages.length} pending message${messages.length === 1 ? '' : 's'}. ` +
      'Read this context before responding. Rendering does not acknowledge or ' +
      'resolve a message — use the inbox ack/resolve verbs for that.'
  );
  lines.push('');
  for (const [index, message] of messages.entries()) {
    lines.push(`## ${index + 1}. ${message.id} (${message.state})`);
    if (message.createdBy) lines.push(`- from: ${message.createdBy}`);
    if (message.text) lines.push(`- message: ${message.text}`);
    if (message.contextPacketIds.length > 0) {
      lines.push('- context:');
      for (const packetId of message.contextPacketIds) {
        const packet = packetsById.get(packetId);
        if (packet) {
          lines.push(renderPacketMarkdown(packet));
        } else {
          lines.push(`  - (packet ${packetId} unavailable)`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * `agent preturn` — fetch the pending inbox for the current (or `--session`)
 * session and render it. Fetching is the PULL step: the hub inbox API flips
 * each `queued` message to `delivered` as a read side effect. preturn READS
 * context — it never acks/resolves (that is a separate explicit action).
 */
async function cmdAgentPreturn(preturnArgs: string[]): Promise<void> {
  const { sessionId: overrideSessionId, format } =
    parsePreturnArgs(preturnArgs);

  const hubUrl = requireEnv('RELAY_HUB_URL');
  // Allow an explicit `--session` so this works via the gateway outside the
  // injected PTY env; otherwise fall back to the env-injected session id.
  const sessionId = overrideSessionId ?? requireEnv('RELAY_SESSION_ID');

  const headers = gatewayHeaders();

  // 1. PULL the inbox for this session. The hub flips queued → delivered here.
  const inboxEndpoint = `${hubUrl}/inbox?targetSessionId=${encodeURIComponent(sessionId)}`;
  let inboxRes: Response;
  try {
    inboxRes = await fetch(inboxEndpoint, { headers });
  } catch (err) {
    die(
      `failed to reach hub at ${hubUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (inboxRes.status === 403) {
    console.error('relayctl: capability denied: session lacks inbox:read');
    process.exit(2);
  }
  if (!inboxRes.ok) {
    let detail = '';
    try {
      const errBody = (await inboxRes.json()) as {
        error?: { message?: string } | string;
      };
      detail =
        typeof errBody.error === 'string'
          ? errBody.error
          : (errBody.error?.message ?? '');
    } catch {
      // ignore parse error
    }
    die(
      `hub returned ${inboxRes.status} ${inboxRes.statusText}${detail ? `: ${detail}` : ''}`
    );
  }
  const inboxBody = (await inboxRes.json()) as { messages?: PreturnMessage[] };
  const messages = Array.isArray(inboxBody.messages) ? inboxBody.messages : [];

  // 2. Resolve referenced packet bodies (deduped). A missing/denied packet is
  //    rendered as unavailable rather than tearing down the whole preturn.
  const packetsById = new Map<string, PreturnPacket>();
  const uniquePacketIds = new Set<string>();
  for (const message of messages) {
    for (const packetId of message.contextPacketIds) uniquePacketIds.add(packetId);
  }
  for (const packetId of uniquePacketIds) {
    const packetEndpoint = `${hubUrl}/context/${encodeURIComponent(packetId)}`;
    try {
      const packetRes = await fetch(packetEndpoint, { headers });
      if (packetRes.ok) {
        const packetBody = (await packetRes.json()) as {
          contextPacket?: PreturnPacket;
        };
        if (packetBody.contextPacket) {
          packetsById.set(packetId, packetBody.contextPacket);
        }
      }
    } catch {
      // Leave unresolved; renderer notes it as unavailable.
    }
  }

  // 3. Render.
  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          sessionId,
          pendingCount: messages.length,
          messages,
          contextPackets: [...packetsById.values()],
        },
        null,
        2
      )
    );
    return;
  }
  console.log(renderPreturnMarkdown(sessionId, messages, packetsById));
}

/** Dispatch the `agent` subcommand group. */
async function cmdAgent(agentArgs: string[]): Promise<void> {
  const sub = agentArgs[0];
  if (sub !== 'preturn') {
    die(`unknown agent subcommand: ${sub ?? '(none)'}. supported: preturn`);
  }
  await cmdAgentPreturn(agentArgs.slice(1));
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
        '  agent preturn [--session <id>] [--format markdown|json]',
        '                                 read pending inbox context (PULL)',
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
    case 'agent':
      await cmdAgent(args.slice(1));
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
