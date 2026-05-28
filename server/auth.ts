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
    surface: 'browser app APIs',
    routes: [
      '/auth/check',
      '/workspaces/*',
      '/git/*',
      '/gh/*',
      '/sessions/:id/image',
      '/config/*',
    ],
    acceptedLanes: ['browser-session'],
    middleware: 'requireAuth',
    notes:
      'Interactive browser surfaces require the browser session established by PIN login or no-PIN local development.',
  },
  {
    surface: 'CLI gateway APIs',
    routes: ['/sessions', '/sessions (POST)', '/context/*', '/inbox/*'],
    acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    middleware: 'requireCliGatewayAuth',
    notes:
      'CLI gateway calls prefer a scoped actor credential and retain browser-session compatibility for local/dev callers.',
  },
  {
    surface: 'scoped session APIs',
    routes: [
      '/sessions/:id',
      '/sessions/:id/replay',
      '/sessions/:id/input',
      '/supervisor/sessions',
    ],
    acceptedLanes: ['scoped-actor-credential', 'browser-session'],
    middleware: 'requireScopedSessionAuth',
    notes:
      'Scoped actor credentials can operate on their session envelope; browser sessions remain valid for the local UI.',
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
      'Pair tokens are one-time bootstrap credentials for issuing a node credential and are not accepted by browser or node runtime routes.',
  },
  {
    surface: 'public local setup APIs',
    routes: ['/health', '/auth/status', 'POST /auth/setup', 'POST /auth'],
    acceptedLanes: ['public-local-only'],
    middleware: 'public setup/login',
    notes:
      'Setup and login endpoints are intentionally outside authenticated lanes and must not expose private state.',
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
