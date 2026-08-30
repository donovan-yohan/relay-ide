import fs from 'node:fs';
import path from 'node:path';
import {
  isStoredCredential,
  type StoredActorCredential,
} from './cli-actor-token-store.js';
import { writeNodeCredentialFile } from './node-credential-file.js';

/**
 * #1467: host-local CLI trust.
 *
 * The hub mints one scoped actor credential at boot and drops it in a
 * port-keyed file inside the shared standard config root. Possession of that
 * file — i.e. filesystem access as the hub's own uid — IS the authorization:
 * the ratified boundary is that a process already running as the hub's user
 * can read local config, invoke local CLIs, and attach to local sockets
 * anyway, so demanding a PIN ceremony from it buys nothing. The PIN still
 * gates the browser/remote UI, which is the surface a remote client reaches.
 *
 * Everything here therefore fails CLOSED. A token file that is a symlink,
 * group/other readable, owned by another uid, or sitting in a directory
 * another uid can write is treated as hostile and ignored — the CLI then
 * behaves exactly as it did before this file existed (401).
 *
 * The credential itself lives only in the hub's in-memory registry, so a hub
 * restart rotates it and any copy of the old file is inert.
 */

export const LOCAL_HUB_ACTOR_TOKEN_FILE_MODE = 0o600;
export const LOCAL_HUB_ACTOR_TOKEN_SOURCE = 'hub-local' as const;

/** Loopback hostnames the local token may ever be sent to. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface LocalHubActorTokenFile extends StoredActorCredential {
  /** Discriminator separating this from a `relay-ide login` credential file. */
  source: typeof LOCAL_HUB_ACTOR_TOKEN_SOURCE;
  /** Hub port this credential is bound to; the file name is keyed by it too. */
  port: number;
  /** Hub pid at mint time — diagnostics only, never an authorization input. */
  pid: number;
}

export function localHubActorTokenFileName(port: number): string {
  return `local-actor-token-${port}.json`;
}

export function localHubActorTokenPath(root: string, port: number): string {
  return path.join(root, localHubActorTokenFileName(port));
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Atomic 0600 write, reusing the node-credential writer (temp + `wx` + rename). */
export function writeLocalHubActorTokenFile(
  root: string,
  file: LocalHubActorTokenFile
): string {
  const filePath = localHubActorTokenPath(root, file.port);
  // The reader refuses a group/world-writable parent (another uid could swap
  // the file), so make sure our own directory can never trip that. New
  // directories are created 0700; an existing one only loses its group/other
  // *write* bits, so a config dir something else reads keeps working.
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const mode = fs.statSync(root).mode & 0o777;
    if ((mode & 0o022) !== 0) fs.chmodSync(root, mode & ~0o022);
  } catch {
    /* not our directory to tighten; the reader will fail closed */
  }
  // `writeNodeCredentialFile` never opens the final path with O_TRUNC: it
  // writes a uniquely named temp with flag 'wx' and renames over the target,
  // so a pre-planted file or symlink at the destination cannot be written
  // through.
  writeNodeCredentialFile(filePath, file);
  return filePath;
}

export function deleteLocalHubActorTokenFile(
  root: string,
  port: number
): boolean {
  try {
    fs.unlinkSync(localHubActorTokenPath(root, port));
    return true;
  } catch {
    return false;
  }
}

export type LocalHubActorTokenRejection =
  | 'missing'
  | 'symlink'
  | 'not_regular_file'
  | 'loose_mode'
  | 'foreign_owner'
  | 'writable_parent'
  | 'unreadable'
  | 'malformed'
  | 'wrong_source'
  | 'port_mismatch'
  | 'non_loopback_hub'
  | 'expired';

export interface LocalHubActorTokenReadOptions {
  /** Injectable for tests; defaults to `process.getuid?.()`. */
  uid?: number | undefined;
  now?: number;
}

export type LocalHubActorTokenReadResult =
  | { ok: true; credential: LocalHubActorTokenFile; path: string }
  | { ok: false; reason: LocalHubActorTokenRejection; path: string };

function currentUid(
  options: LocalHubActorTokenReadOptions
): number | undefined {
  if (options.uid !== undefined) return options.uid;
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Read and validate the port-keyed local token file under `root`.
 *
 * Every rejection is typed rather than thrown so callers can log a reason
 * without ever touching the token value.
 */
export function readLocalHubActorTokenFile(
  root: string,
  port: number,
  options: LocalHubActorTokenReadOptions = {}
): LocalHubActorTokenReadResult {
  const filePath = localHubActorTokenPath(root, port);
  const uid = currentUid(options);

  // Parent directory first: if another uid can write it, they can swap the
  // file between our checks and our read (TOCTOU) — refuse before opening.
  let parentStat: fs.Stats;
  try {
    parentStat = fs.statSync(path.dirname(filePath));
  } catch {
    return { ok: false, reason: 'missing', path: filePath };
  }
  if (!parentStat.isDirectory()) {
    return { ok: false, reason: 'writable_parent', path: filePath };
  }
  if ((parentStat.mode & 0o022) !== 0) {
    return { ok: false, reason: 'writable_parent', path: filePath };
  }
  if (uid !== undefined && parentStat.uid !== uid) {
    return { ok: false, reason: 'foreign_owner', path: filePath };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { ok: false, reason: 'missing', path: filePath };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, reason: 'symlink', path: filePath };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'not_regular_file', path: filePath };
  }
  if ((stat.mode & 0o077) !== 0) {
    return { ok: false, reason: 'loose_mode', path: filePath };
  }
  if (uid !== undefined && stat.uid !== uid) {
    return { ok: false, reason: 'foreign_owner', path: filePath };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable', path: filePath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed', path: filePath };
  }
  if (!isStoredCredential(parsed)) {
    return { ok: false, reason: 'malformed', path: filePath };
  }
  const record = parsed as unknown as Record<string, unknown>;
  if (record['source'] !== LOCAL_HUB_ACTOR_TOKEN_SOURCE) {
    return { ok: false, reason: 'wrong_source', path: filePath };
  }
  if (record['port'] !== port) {
    return { ok: false, reason: 'port_mismatch', path: filePath };
  }
  const credential = parsed as LocalHubActorTokenFile;

  // The local token is proof of *local* access; it must never leave loopback.
  let hubUrl: URL;
  try {
    hubUrl = new URL(credential.hubUrl);
  } catch {
    return { ok: false, reason: 'non_loopback_hub', path: filePath };
  }
  if (!isLoopbackHost(hubUrl.hostname) || Number(hubUrl.port) !== port) {
    return { ok: false, reason: 'non_loopback_hub', path: filePath };
  }

  const now = options.now ?? Date.now();
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { ok: false, reason: 'expired', path: filePath };
  }

  return { ok: true, credential, path: filePath };
}

/**
 * First valid local token across `roots`, or null. Roots are searched in the
 * caller's precedence order and deduped.
 */
export function discoverLocalHubActorToken(
  roots: readonly string[],
  port: number,
  options: LocalHubActorTokenReadOptions = {}
): LocalHubActorTokenFile | null {
  for (const root of new Set(
    roots.filter((entry) => entry.trim().length > 0)
  )) {
    const result = readLocalHubActorTokenFile(root, port, options);
    if (result.ok) return result.credential;
  }
  return null;
}
