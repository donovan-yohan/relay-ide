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

function normalizeSessionsBody(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    const sessions = (body as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) return sessions as Record<string, unknown>[];
  }
  return [];
}

// ── subcommand: whoami ─────────────────────────────────────────────────────

async function cmdWhoami(whoamiArgs: string[] = []): Promise<void> {
  const nodeId = requireEnv('RELAY_NODE_ID');
  const sessionId = requireEnv('RELAY_SESSION_ID');
  const json = whoamiArgs.includes('--json');
  const hubUrl = RELAY_HUB_URL;

  if (json) {
    let session: Record<string, unknown> | undefined;
    if (hubUrl) {
      try {
        const body = await fetchGatewayJson<unknown>(
          `${hubUrl}/sessions`,
          gatewayHeaders('sessions.list'),
          {
            reachabilityMessage: `failed to reach hub at ${hubUrl}`,
            forbiddenMessage:
              'relayctl: capability denied: session lacks session:read',
          }
        );
        session = normalizeSessionsBody(body).find(
          (candidate) => candidate.id === sessionId
        );
      } catch {
        session = undefined;
      }
    }
    console.log(
      JSON.stringify(
        {
          nodeId,
          sessionId,
          ...(RELAY_WORK_CONTEXT_ID
            ? { workContextId: RELAY_WORK_CONTEXT_ID }
            : {}),
          ...(hubUrl
            ? { hubUrl, relaySocket: process.env.RELAY_SOCKET ?? hubUrl }
            : {}),
          cwd: typeof session?.cwd === 'string' ? session.cwd : process.cwd(),
          ...(typeof session?.displayName === 'string'
            ? { displayName: session.displayName }
            : {}),
          ...(typeof session?.type === 'string' ? { type: session.type } : {}),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`node_id:      ${nodeId}`);
  console.log(`session_id:   ${sessionId}`);
  if (RELAY_WORK_CONTEXT_ID) {
    console.log(`work_context: ${RELAY_WORK_CONTEXT_ID}`);
  }
  if (hubUrl) {
    console.log(`hub_url:      ${hubUrl}`);
    console.log(`relay_socket: ${process.env.RELAY_SOCKET ?? hubUrl}`);
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

const MAILROOM_CAPABILITIES =
  'session:read,inbox:read,inbox:write,context:read,context:write';

/**
 * Build the gateway headers a relayctl read uses against the hub. The hub
 * `requireCliGatewayAuth` middleware accepts the v1 header + a scoped bearer
 * token (when `RELAY_IDE_BROWSER_TOKEN` is present), or falls through to
 * browser-session auth. The capability header is always
 * required by the context/inbox router itself, independent of the auth path.
 */
function gatewayHeaders(commandName?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-relay-cli-gateway': 'v1',
    'x-relay-capabilities': MAILROOM_CAPABILITIES,
  };
  const actorToken = commandName
    ? process.env.RELAY_IDE_ACTOR_TOKEN
    : undefined;
  if (actorToken) {
    headers['Authorization'] = `Bearer ${actorToken}`;
    headers['x-relay-cli-actor-token'] = 'v1';
    if (commandName) headers['x-relay-cli-command'] = commandName;
    const correlationId = process.env.RELAY_IDE_CORRELATION_ID;
    if (correlationId) headers['x-relay-correlation-id'] = correlationId;
    return headers;
  }
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
function renderInboxMessageMarkdown(
  message: PreturnMessage,
  index: number,
  packetsById: Map<string, PreturnPacket>
): string[] {
  const lines: string[] = [`## ${index + 1}. ${message.id} (${message.state})`];
  if (message.createdBy) lines.push(`- from: ${message.createdBy}`);
  if (message.text) lines.push(`- message: ${message.text}`);
  if (message.contextPacketIds.length === 0) return [...lines, ''];

  lines.push('- context:');
  for (const packetId of message.contextPacketIds) {
    const packet = packetsById.get(packetId);
    lines.push(
      packet
        ? renderPacketMarkdown(packet)
        : `  - (packet ${packetId} unavailable)`
    );
  }
  lines.push('');
  return lines;
}

function renderPinnedContextMarkdown(
  pinnedContextPackets: PreturnPacket[],
  workContextId?: string
): string[] {
  if (pinnedContextPackets.length === 0) return [];
  const lines = [
    `## Pinned WorkContext context${workContextId ? ` — ${workContextId}` : ''}`,
    `${pinnedContextPackets.length} pinned packet${pinnedContextPackets.length === 1 ? '' : 's'} from the WorkContext artifact pool.`,
    '',
  ];
  for (const packet of pinnedContextPackets) {
    lines.push(renderPacketMarkdown(packet));
  }
  return lines;
}

/** Render the full preturn payload as model-friendly markdown. */
function renderPreturnMarkdown(
  sessionId: string,
  messages: PreturnMessage[],
  packetsById: Map<string, PreturnPacket>,
  pinnedContextPackets: PreturnPacket[],
  workContextId?: string
): string {
  const lines: string[] = [
    `# Relay pending context — session ${sessionId}`,
    '',
  ];

  if (messages.length === 0 && pinnedContextPackets.length === 0) {
    lines.push('No pending inbox messages.');
    return lines.join('\n');
  }

  if (messages.length > 0) {
    lines.push(
      `${messages.length} pending message${messages.length === 1 ? '' : 's'}. ` +
        'Read this context before responding. Rendering does not acknowledge or ' +
        'resolve a message — use the inbox ack/resolve verbs for that.',
      ''
    );
    for (const [index, message] of messages.entries()) {
      lines.push(...renderInboxMessageMarkdown(message, index, packetsById));
    }
  } else {
    lines.push('No pending inbox messages.', '');
  }

  lines.push(
    ...renderPinnedContextMarkdown(pinnedContextPackets, workContextId)
  );
  return lines.join('\n').trimEnd();
}

async function responseErrorDetail(res: Response): Promise<string> {
  try {
    const errBody = (await res.json()) as {
      error?: { message?: string } | string;
    };
    return typeof errBody.error === 'string'
      ? errBody.error
      : (errBody.error?.message ?? '');
  } catch {
    return '';
  }
}

async function fetchGatewayJson<T>(
  endpoint: string,
  headers: Record<string, string>,
  options: {
    reachabilityMessage: string;
    forbiddenMessage: string;
    failureSuffix?: string;
  }
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint, { headers });
  } catch (err) {
    die(
      `${options.reachabilityMessage}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (res.status === 403) {
    console.error(options.forbiddenMessage);
    process.exit(2);
  }
  if (!res.ok) {
    const detail = await responseErrorDetail(res);
    die(
      `hub returned ${res.status} ${res.statusText}${options.failureSuffix ?? ''}${detail ? `: ${detail}` : ''}`
    );
  }
  return (await res.json()) as T;
}

async function postGatewayJson<T>(
  endpoint: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: {
    reachabilityMessage: string;
    forbiddenMessage: string;
    failureSuffix?: string;
  }
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(
      `${options.reachabilityMessage}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (res.status === 403) {
    console.error(options.forbiddenMessage);
    process.exit(2);
  }
  if (!res.ok) {
    const detail = await responseErrorDetail(res);
    die(
      `hub returned ${res.status} ${res.statusText}${options.failureSuffix ?? ''}${detail ? `: ${detail}` : ''}`
    );
  }
  return (await res.json()) as T;
}

async function fetchInboxMessages(
  hubUrl: string,
  headers: Record<string, string>,
  sessionId: string
): Promise<PreturnMessage[]> {
  const inboxBody = await fetchGatewayJson<{ messages?: PreturnMessage[] }>(
    `${hubUrl}/inbox?targetSessionId=${encodeURIComponent(sessionId)}`,
    headers,
    {
      reachabilityMessage: `failed to reach hub at ${hubUrl}`,
      forbiddenMessage: 'relayctl: capability denied: session lacks inbox:read',
    }
  );
  return Array.isArray(inboxBody.messages) ? inboxBody.messages : [];
}

async function fetchPinnedContextPackets(
  hubUrl: string,
  headers: Record<string, string>,
  workContextId?: string
): Promise<PreturnPacket[]> {
  if (!workContextId) return [];
  const pinnedBody = await fetchGatewayJson<{
    contextPackets?: PreturnPacket[];
  }>(
    `${hubUrl}/context?workContextId=${encodeURIComponent(workContextId)}`,
    headers,
    {
      reachabilityMessage: `failed to read WorkContext pinned context from hub at ${hubUrl}`,
      forbiddenMessage:
        'relayctl: capability denied: session lacks context:read',
      failureSuffix: ' while reading WorkContext pinned context',
    }
  );
  return Array.isArray(pinnedBody.contextPackets)
    ? pinnedBody.contextPackets
    : [];
}

function inboxPacketIds(messages: PreturnMessage[]): Set<string> {
  const uniquePacketIds = new Set<string>();
  for (const message of messages) {
    for (const packetId of message.contextPacketIds)
      uniquePacketIds.add(packetId);
  }
  return uniquePacketIds;
}

async function resolveInboxPackets(
  hubUrl: string,
  headers: Record<string, string>,
  messages: PreturnMessage[],
  packetsById: Map<string, PreturnPacket>
): Promise<void> {
  for (const packetId of inboxPacketIds(messages)) {
    if (packetsById.has(packetId)) continue;
    const packetEndpoint = `${hubUrl}/context/${encodeURIComponent(packetId)}`;
    try {
      const packetRes = await fetch(packetEndpoint, { headers });
      const packetBody = packetRes.ok
        ? ((await packetRes.json()) as { contextPacket?: PreturnPacket })
        : {};
      if (packetBody.contextPacket)
        packetsById.set(packetId, packetBody.contextPacket);
    } catch {
      // Leave unresolved; renderer notes it as unavailable.
    }
  }
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
  const workContextId = RELAY_WORK_CONTEXT_ID;

  // 1. PULL the inbox for this session. The hub flips queued → delivered here.
  const messages = await fetchInboxMessages(hubUrl, headers, sessionId);

  // 2. Discover WorkContext-pinned packets. These are source-of-truth refs from
  //    the WorkContext artifact pool and are agent-facing preturn context even
  //    when no inbox message targets the current session.
  const pinnedContextPackets = await fetchPinnedContextPackets(
    hubUrl,
    headers,
    workContextId
  );
  const packetsById = new Map<string, PreturnPacket>();
  for (const packet of pinnedContextPackets) packetsById.set(packet.id, packet);

  // 3. Resolve inbox-referenced packet bodies (deduped). A missing/denied packet
  //    is rendered as unavailable rather than tearing down the whole preturn.
  await resolveInboxPackets(hubUrl, headers, messages, packetsById);

  // 4. Render.
  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          sessionId,
          ...(workContextId ? { workContextId } : {}),
          pendingCount: messages.length,
          pinnedContextCount: pinnedContextPackets.length,
          messages,
          contextPackets: [...packetsById.values()],
          pinnedContextPackets,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(
    renderPreturnMarkdown(
      sessionId,
      messages,
      packetsById,
      pinnedContextPackets,
      workContextId
    )
  );
}

/** Dispatch the `agent` subcommand group. */
async function cmdAgent(agentArgs: string[]): Promise<void> {
  const sub = agentArgs[0];
  if (sub !== 'preturn') {
    die(`unknown agent subcommand: ${sub ?? '(none)'}. supported: preturn`);
  }
  await cmdAgentPreturn(agentArgs.slice(1));
}

function parseFlagValue(input: string[], name: string): string | undefined {
  const index = input.indexOf(name);
  if (index === -1) return undefined;
  const value = input[index + 1];
  if (!value || value.startsWith('--')) die(`${name} requires a value`);
  return value;
}

type ParsedRelayctlFlagArgs = {
  values: Map<string, string>;
  rest: string[];
};

function parseFlagsBeforePayload(
  input: string[],
  names: string[]
): ParsedRelayctlFlagArgs {
  const values = new Map<string, string>();
  const rest: string[] = [];
  let payloadStarted = false;

  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];
    if (arg === undefined) continue;
    if (!payloadStarted && arg === '--') {
      payloadStarted = true;
      continue;
    }
    if (!payloadStarted && names.includes(arg)) {
      const value = input[i + 1];
      if (!value || value.startsWith('--')) die(`${arg} requires a value`);
      if (!values.has(arg)) values.set(arg, value);
      i += 1;
      continue;
    }
    payloadStarted = true;
    rest.push(arg);
  }

  return { values, rest };
}

type ArtifactPublishArgs = {
  path?: string;
  kind?: string;
  title?: string;
};

function parseArtifactPublishArgs(input: string[]): ArtifactPublishArgs {
  const parsed: ArtifactPublishArgs = {};
  let literal = false;

  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];
    if (arg === undefined) continue;
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    if (!literal && (arg === '--kind' || arg === '--title')) {
      const value = input[i + 1];
      if (!value || value.startsWith('--')) die(`${arg} requires a value`);
      if (arg === '--kind' && parsed.kind === undefined) parsed.kind = value;
      if (arg === '--title' && parsed.title === undefined) parsed.title = value;
      i += 1;
      continue;
    }
    if (parsed.path === undefined) parsed.path = arg;
  }

  return parsed;
}

async function cmdMsg(msgArgs: string[]): Promise<void> {
  const sub = msgArgs[0];
  const hubUrl = requireEnv('RELAY_HUB_URL');
  const headers = gatewayHeaders();
  if (sub === 'send') {
    const parsedArgs = parseFlagsBeforePayload(msgArgs.slice(1), [
      '--to',
      '--session',
    ]);
    const to =
      parsedArgs.values.get('--to') ?? parsedArgs.values.get('--session');
    if (!to) die('usage: relayctl msg send --to <session-id> <text>');
    const text = parsedArgs.rest.join(' ').trim();
    if (!text) die('usage: relayctl msg send --to <session-id> <text>');
    const body = await postGatewayJson<{ message?: PreturnMessage }>(
      `${hubUrl}/inbox`,
      headers,
      {
        targetSessionId: to,
        text,
        createdBy: requireEnv('RELAY_SESSION_ID'),
      },
      {
        reachabilityMessage: `failed to reach hub at ${hubUrl}`,
        forbiddenMessage:
          'relayctl: capability denied: session lacks inbox:write',
      }
    );
    console.log(JSON.stringify(body.message ?? body, null, 2));
    return;
  }
  if (sub === 'read' || sub === 'watch') {
    const sessionId =
      parseFlagValue(msgArgs, '--session') ?? requireEnv('RELAY_SESSION_ID');
    const once = sub === 'read' || msgArgs.includes('--once');
    const seen = new Set<string>();
    for (;;) {
      const messages = await fetchInboxMessages(hubUrl, headers, sessionId);
      const fresh = messages.filter((message) => !seen.has(message.id));
      for (const message of fresh) {
        seen.add(message.id);
        console.log(`${message.id}\t${message.state}\t${message.text ?? ''}`);
      }
      if (once) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  die(
    `unknown msg subcommand: ${sub ?? '(none)'}. supported: send, read, watch`
  );
}

async function publishContextArtifact(
  hubUrl: string,
  headers: Record<string, string>,
  packet: Record<string, unknown>,
  pin = true
): Promise<Record<string, unknown>> {
  const packetBody = await postGatewayJson<{
    contextPacket?: Record<string, unknown>;
  }>(`${hubUrl}/context`, headers, packet, {
    reachabilityMessage: `failed to reach hub at ${hubUrl}`,
    forbiddenMessage:
      'relayctl: capability denied: session lacks context:write',
  });
  const contextPacket = (packetBody.contextPacket ?? packetBody) as Record<
    string,
    unknown
  >;
  const packetId =
    typeof contextPacket.id === 'string' ? contextPacket.id : undefined;
  if (pin && packetId && RELAY_WORK_CONTEXT_ID) {
    await postGatewayJson(
      `${hubUrl}/context/${encodeURIComponent(packetId)}/pin`,
      headers,
      { workContextId: RELAY_WORK_CONTEXT_ID },
      {
        reachabilityMessage: `failed to pin context packet in WorkContext ${RELAY_WORK_CONTEXT_ID}`,
        forbiddenMessage:
          'relayctl: capability denied: session lacks context:write',
      }
    );
  }
  return contextPacket;
}

async function cmdNotify(notifyArgs: string[]): Promise<void> {
  const parsedArgs = parseFlagsBeforePayload(notifyArgs, ['--kind']);
  const kind = parsedArgs.values.get('--kind') ?? 'info';
  const text = parsedArgs.rest.join(' ').trim();
  if (!text)
    die('usage: relayctl notify [--kind needs_input|warning|info] <text>');
  const hubUrl = requireEnv('RELAY_HUB_URL');
  const packet = await publishContextArtifact(hubUrl, gatewayHeaders(), {
    kind: 'note',
    note: `[attention:${kind}] ${text}`,
    createdBy: requireEnv('RELAY_SESSION_ID'),
  });
  console.log(
    JSON.stringify(
      { attentionEvent: { kind, text, contextPacket: packet } },
      null,
      2
    )
  );
}

async function cmdDecision(decisionArgs: string[]): Promise<void> {
  const text = decisionArgs.join(' ').trim();
  if (!text) die('usage: relayctl decision <question>');
  const hubUrl = requireEnv('RELAY_HUB_URL');
  const packet = await publishContextArtifact(hubUrl, gatewayHeaders(), {
    kind: 'note',
    note: `[decision:pending] ${text}`,
    createdBy: requireEnv('RELAY_SESSION_ID'),
  });
  console.log(
    JSON.stringify(
      { decision: { state: 'pending', question: text, contextPacket: packet } },
      null,
      2
    )
  );
}

async function cmdArtifact(artifactArgs: string[]): Promise<void> {
  const sub = artifactArgs[0];
  if (sub !== 'publish') {
    die(`unknown artifact subcommand: ${sub ?? '(none)'}. supported: publish`);
  }
  const parsedArgs = parseArtifactPublishArgs(artifactArgs.slice(1));
  const kind = parsedArgs.kind ?? 'report';
  const title = parsedArgs.title;
  const artifactPath = parsedArgs.path;
  if (!artifactPath)
    die(
      'usage: relayctl artifact publish <path> --kind <kind> [--title <title>]'
    );
  const absolutePath = artifactPath.startsWith('/')
    ? artifactPath
    : `${process.cwd()}/${artifactPath}`;
  const hubUrl = requireEnv('RELAY_HUB_URL');
  const packet = await publishContextArtifact(hubUrl, gatewayHeaders(), {
    kind: 'log-ref',
    note: title ?? `artifact ${kind}: ${absolutePath}`,
    fileRef: { path: absolutePath, nodeId: RELAY_NODE_ID },
    createdBy: requireEnv('RELAY_SESSION_ID'),
  });
  console.log(
    JSON.stringify(
      { artifact: { kind, path: absolutePath, title, contextPacket: packet } },
      null,
      2
    )
  );
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
        '  whoami [--json]                 print session identity',
        '  msg send --to <session> <text>  send an inbox message',
        '  msg read [--session <id>]       read this session inbox once',
        '  msg watch [--session <id>]      watch this session inbox',
        '  notify [--kind <kind>] <text>   publish an attention event',
        '  decision <question>             publish a pending decision request',
        '  artifact publish <path> --kind <kind> [--title <title>]',
        '                                 publish and pin an artifact ref',
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
      await cmdWhoami(args.slice(1));
      break;
    case 'msg':
      await cmdMsg(args.slice(1));
      break;
    case 'notify':
      await cmdNotify(args.slice(1));
      break;
    case 'decision':
      await cmdDecision(args.slice(1));
      break;
    case 'artifact':
      await cmdArtifact(args.slice(1));
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
