import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

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

export function generateCookieToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function isLegacyHash(hash: string): boolean {
  return !!hash && !hash.startsWith('scrypt:');
}

export function _resetForTesting(): void {
  attemptMap.clear();
}
