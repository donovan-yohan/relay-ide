import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export const AUTH_LANES = [
  'browser-session',
  'scoped-actor-credential',
  'node-credential',
  'pair-token',
  'public-local-only',
  'denied',
] as const;

export type AuthLane = (typeof AUTH_LANES)[number];

export type LaneDenialCode =
  | 'BROWSER_SESSION_REQUIRED'
  | 'CLI_GATEWAY_OR_BROWSER_AUTH_REQUIRED'
  | 'SCOPED_SESSION_OR_BROWSER_AUTH_REQUIRED';

export interface AuthLaneChallenge {
  error: {
    code: LaneDenialCode;
    message: string;
    retryable: false;
    lane: 'denied';
    acceptedLanes: AuthLane[];
    migrationTarget?: AuthLane;
  };
}

export interface AuthRouteLaneInventoryEntry {
  surface: string;
  routes: string[];
  acceptedLanes: AuthLane[];
  middleware: string;
  notes: string;
}

export const AUTH_ROUTE_LANE_INVENTORY: AuthRouteLaneInventoryEntry[] = [
  {
    surface: 'browser UI and authenticated local app APIs',
    routes: [
      '/auth/check',
      '/workspaces/*',
      '/workspace-groups/*',
      '/workbench/*',
      '/git/*',
      '/gh/*',
      '/integration-github/*',
      '/integration-jira/*',
      '/auth/github/*',
      '/branch-linker/*',
      '/ticket-transitions/*',
      '/org-dashboard/*',
      '/analytics/*',
      '/api/analytics/*',
      '/telemetry/*',
      '/work-contexts/*',
    ],
    acceptedLanes: ['browser-session'],
    middleware: 'requireAuth',
    notes:
      'Interactive browser surfaces require the browser session established by PIN login or first-run PIN setup; these cookies are not node, pair, or scoped actor credentials.',
  },
  {
    surface: 'browser diagnostics, config, and lifecycle APIs',
    routes: [
      '/api/frontend-log',
      '/api/frameworks',
      '/api/node/manifest',
      '/config/*',
      '/presets/*',
      '/repos',
      '/worktrees/status',
      '/worktrees',
      '/push/*',
      '/version',
      '/update',
      '/update-channel',
      '/sessions/:id (DELETE/PATCH)',
      '/sessions/:id/image',
    ],
    acceptedLanes: ['browser-session'],
    middleware: 'requireAuth',
    notes:
      'Operator diagnostics/configuration and browser lifecycle endpoints stay on the browser-session lane for wave 1.',
  },
  {
    surface: 'browser webhook management APIs',
    routes: [
      'POST /webhooks/manage/setup',
      'DELETE /webhooks/manage/setup',
      'GET /webhooks/manage/status',
      'POST /webhooks/manage/reload',
      'POST /webhooks/manage/ping',
      'POST /webhooks/manage/repos',
      'POST /webhooks/manage/repos/remove',
      'POST /webhooks/manage/backfill',
    ],
    acceptedLanes: ['browser-session'],
    middleware: 'requireAuth via createWebhookManagerRouter mounted at /webhooks/manage',
    notes:
      'Webhook management is a browser/operator surface mounted with requireAuth; it is distinct from the secret-protected webhook receiver.',
  },
  {
    surface: 'browser event and PTY WebSocket APIs',
    routes: [
      'WS /ws/events',
      'WS /ws/:sessionId',
      'WS /nodes/:nodeId/ws/sessions/:sessionId',
    ],
    acceptedLanes: ['browser-session'],
    middleware: 'setupWebSocket authenticated browser cookie',
    notes:
      'Browser WebSockets require the same browser-session cookie before event subscription, local PTY attach, or routed PTY attach. Routed PTY then additionally validates the session envelope and hub policy.',
  },
  {
    surface: 'CLI gateway APIs',
    routes: [
      '/sessions (GET/POST)',
      '/context/*',
      '/inbox/*',
      '/events/*',
      '/handoffs/*',
      '/nodes',
      '/hub/audit/*',
      '/hub/nodes/:nodeId/logs',
      '/hub/nodes/:nodeId/sessions',
    ],
    acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    middleware: 'requireCliGatewayAuth',
    notes:
      'CLI gateway calls prefer a scoped actor credential and retain browser-session compatibility for local/dev callers; this does not make browser cookies node credentials.',
  },
  {
    surface: 'scoped session APIs',
    routes: [
      '/sessions/:id',
      '/sessions/:id/replay',
      '/sessions/:id/interventions',
      '/sessions/:id/control/hand-back',
      '/sessions/:id/input',
      '/supervisor/sessions',
      '/supervisor/actions/:action',
      '/hub/scoped-sessions',
      '/hub/scoped-sessions/:sessionId/renew',
      '/hub/scoped-sessions/:sessionId/revoke',
      '/hub/scoped-sessions/:sessionId (DELETE)',
    ],
    acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    middleware: 'requireScopedSessionAuth',
    notes:
      'Scoped actor credentials can operate on their session envelope; browser sessions remain valid for the local UI until the scoped actor registry lands.',
  },
  {
    surface: 'hub operator node and repo APIs',
    routes: [
      '/hub/confirmations/*',
      '/hub/pair-tokens',
      '/hub/nodes/:nodeId/credential-rotation/*',
      '/hub/nodes/:nodeId/updating',
      '/hub/nodes/:nodeId/cwd/:operation',
      '/hub/nodes/:nodeId/sessions/:sessionId/files/:operation',
      '/hub/nodes/:nodeId/sessions/:sessionId (DELETE)',
      '/nodes/:nodeId (DELETE)',
      '/hub/repo-inventory',
      '/hub/repo-groups',
      '/hub/ia/tree',
      '/hub/ia/benches/*',
      '/hub/ia/workspaces/*',
      '/hub/nodes/:nodeId/sessions/reopen',
    ],
    acceptedLanes: ['browser-session'],
    middleware: 'requireAuth',
    notes:
      'Human/operator hub APIs and routed repo/session/file RPC entrypoints are browser-session protected in wave 1; downstream node-link RPC still uses node credentials and policy checks.',
  },
  {
    surface: 'node credential APIs',
    routes: ['POST /hub/node-heartbeat', 'WS /hub/node-link'],
    acceptedLanes: ['node-credential'],
    middleware: 'bearer node credential',
    notes:
      'Relay nodes authenticate with their issued node credential only; browser sessions and pair tokens are not node credentials.',
  },
  {
    surface: 'pairing exchange APIs',
    routes: ['POST /hub/pairing/exchange'],
    acceptedLanes: ['pair-token'],
    middleware: 'pair token exchange',
    notes:
      'Pair tokens are one-time bootstrap credentials for issuing a node credential and are not accepted by browser, CLI, or steady-state node routes.',
  },
  {
    surface: 'public local setup and callbacks',
    routes: [
      '/health',
      '/auth/status',
      'POST /auth/setup',
      'POST /auth',
      '/hooks/*',
      'POST /webhooks',
      '/static frontend assets',
    ],
    acceptedLanes: ['public-local-only'],
    middleware: 'public setup/login, localhost hook callback, webhook secret, or static file serving',
    notes:
      'Setup/login/readiness/local hook/static surfaces intentionally sit outside browser-session auth and must not expose private session, repo, node, or credential state; the webhook receiver relies on GitHub signature validation and is separate from authenticated /webhooks/manage routes.',
  },
  {
    surface: 'intentionally denied or no-route surfaces',
    routes: [
      'browser cookie as node credential',
      'pair token as browser/CLI/node runtime credential',
      'scoped actor credential as node credential',
      'unauthenticated /sessions/*',
      'unknown WebSocket paths',
      'unknown API routes',
    ],
    acceptedLanes: ['denied'],
    middleware: 'challenge payload or 404/no route',
    notes:
      'Denied/no-route entries document negative boundaries so future scoped actor, node PoP, or MFA work does not blur credential classes.',
  },
];

export function authLaneChallenge(
  code: LaneDenialCode,
  message: string,
  acceptedLanes: AuthLane[],
  migrationTarget?: AuthLane
): AuthLaneChallenge {
  return {
    error: {
      code,
      message,
      retryable: false,
      lane: 'denied',
      acceptedLanes,
      ...(migrationTarget ? { migrationTarget } : {}),
    },
  };
}

export function browserSessionRequiredChallenge(): AuthLaneChallenge {
  return authLaneChallenge(
    'BROWSER_SESSION_REQUIRED',
    'Browser session authentication required',
    ['browser-session'],
    'scoped-actor-credential'
  );
}

export function cliGatewayOrBrowserAuthRequiredChallenge(): AuthLaneChallenge {
  return authLaneChallenge(
    'CLI_GATEWAY_OR_BROWSER_AUTH_REQUIRED',
    'CLI gateway scoped actor credential or browser session authentication required',
    ['scoped-actor-credential', 'browser-session']
  );
}

export function scopedSessionOrBrowserAuthRequiredChallenge(): AuthLaneChallenge {
  return authLaneChallenge(
    'SCOPED_SESSION_OR_BROWSER_AUTH_REQUIRED',
    'Scoped session credential or browser session authentication required',
    ['scoped-actor-credential', 'browser-session']
  );
}

interface AttemptEntry {
  count: number;
  lockedUntil: number | null;
}

const attemptMap = new Map<string, AttemptEntry>();

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scrypt(pin, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPin(
  pin: string,
  hash: string | null | undefined
): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith('scrypt:')) {
    const [, salt, storedHashHex] = hash.split(':');
    if (!salt || !storedHashHex) return false;
    try {
      const storedBuf = Buffer.from(storedHashHex, 'hex');
      if (storedBuf.length !== SCRYPT_KEYLEN) return false;
      const derived = (await scrypt(pin, salt, SCRYPT_KEYLEN)) as Buffer;
      return crypto.timingSafeEqual(storedBuf, derived);
    } catch {
      return false;
    }
  }
  // Legacy bcrypt hashes are migrated at startup; if one reaches here, reject it
  return false;
}

export function isRateLimited(ip: string): boolean {
  const entry = attemptMap.get(ip);
  if (!entry) return false;

  if (entry.lockedUntil) {
    if (Date.now() < entry.lockedUntil) {
      return true;
    }
    attemptMap.delete(ip);
  }

  return false;
}

export function recordFailedAttempt(ip: string): void {
  const entry = attemptMap.get(ip) ?? { count: 0, lockedUntil: null };
  entry.count += 1;

  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }

  attemptMap.set(ip, entry);
}

export function clearRateLimit(ip: string): void {
  attemptMap.delete(ip);
}

export interface SignedCookieTokenOptions {
  pinHash: string;
  ttlMs: number;
  now?: number;
}

function signCookieToken(
  expiresAt: number,
  nonce: string,
  pinHash: string
): string {
  return crypto
    .createHmac('sha256', pinHash)
    .update(`${expiresAt}.${nonce}`)
    .digest('base64url');
}

export function generateCookieToken(
  options?: SignedCookieTokenOptions
): string {
  if (!options) return crypto.randomBytes(32).toString('hex');
  const now = options.now ?? Date.now();
  const expiresAt = now + options.ttlMs;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const signature = signCookieToken(expiresAt, nonce, options.pinHash);
  return `v1.${expiresAt}.${nonce}.${signature}`;
}

export function verifyCookieToken(
  token: string | null | undefined,
  pinHash: string | null | undefined,
  now = Date.now()
): boolean {
  if (!token || !pinHash || !token.startsWith('v1.')) return false;
  const [, expiresAtRaw, nonce, signature] = token.split('.');
  if (!expiresAtRaw || !nonce || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = signCookieToken(expiresAt, nonce, pinHash);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isLegacyHash(hash: string): boolean {
  return !!hash && !hash.startsWith('scrypt:');
}

export function _resetForTesting(): void {
  attemptMap.clear();
}
