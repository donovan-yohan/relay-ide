import fs from 'node:fs';
import path from 'node:path';

/**
 * #1435: local storage for the `relay-ide login` actor credential.
 *
 * The file is an explicit opt-in — it only exists because the operator ran
 * `relay-ide login`. Precedence everywhere is env/flag > file. Token material
 * lives at chmod 600; readers fail closed on loose permissions rather than
 * silently using a credential any local user could read.
 */

export interface StoredActorCredential {
  /** Schema version for forward-compatible migrations. */
  version: 1;
  token: string;
  credentialId: string;
  hubUrl: string;
  issuedAt: string;
  expiresAt: string;
  actorId: string;
  capabilities: string[];
}

export const ACTOR_TOKEN_FILE_MODE = 0o600;

export function actorTokenFilePath(configDir: string): string {
  return path.join(configDir, 'actor-token.json');
}

export function loadStoredActorCredential(
  configDir: string,
  options: { now?: () => number } = {}
): StoredActorCredential | null {
  void options;
  const filePath = actorTokenFilePath(configDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStoredCredential(parsed)) return null;
  // Fail closed: a readable-by-others token file is treated as compromised.
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) return null;
  } catch {
    return null;
  }
  return parsed;
}

export function saveStoredActorCredential(
  configDir: string,
  credential: StoredActorCredential
): void {
  const filePath = actorTokenFilePath(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  // Atomic rewrite: temp file in the same directory, chmod 600 before rename.
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(credential, null, 2)}\n`, {
      encoding: 'utf8',
      mode: ACTOR_TOKEN_FILE_MODE,
    });
    fs.chmodSync(tempPath, ACTOR_TOKEN_FILE_MODE);
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* already renamed */
    }
  }
}

export function deleteStoredActorCredential(configDir: string): boolean {
  const filePath = actorTokenFilePath(configDir);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** True when the stored token expires within `marginMs` of `nowMs`. */
export function expiresWithinMargin(
  credential: StoredActorCredential,
  marginMs: number,
  nowMs: number
): boolean {
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - nowMs <= marginMs;
}

export function isStoredCredential(
  value: unknown
): value is StoredActorCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    typeof record['token'] === 'string' &&
    record['token'].startsWith('relay-sac-v1.') &&
    typeof record['credentialId'] === 'string' &&
    typeof record['hubUrl'] === 'string' &&
    typeof record['issuedAt'] === 'string' &&
    typeof record['expiresAt'] === 'string' &&
    typeof record['actorId'] === 'string' &&
    Array.isArray(record['capabilities'])
  );
}
