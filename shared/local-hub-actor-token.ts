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

export type LocalHubActorTokenWriteRefusal =
  | 'writable_parent'
  | 'parent_not_directory';

/** Thrown instead of publishing when the destination directory is unsafe. */
export class LocalHubActorTokenWriteError extends Error {
  constructor(
    public readonly reason: LocalHubActorTokenWriteRefusal,
    message: string
  ) {
    super(message);
    this.name = 'LocalHubActorTokenWriteError';
  }
}

/**
 * Atomic 0600 write, reusing the node-credential writer (temp + `wx` + rename).
 *
 * The destination directory is never re-permissioned: silently stripping bits
 * from a directory an operator deliberately shared would break whoever else
 * uses it, and would do so invisibly. A pre-existing group/world-writable
 * directory is refused instead, since another uid could swap the file there.
 */
export function writeLocalHubActorTokenFile(
  root: string,
  file: LocalHubActorTokenFile
): string {
  const filePath = localHubActorTokenPath(root, file.port);
  let stat: fs.Stats | null;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (stat === null) {
    // Create only the final directory owner-only; parents keep their own
    // default mode so we never re-permission `~/.config` as a side effect.
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.mkdirSync(root, { mode: 0o700 });
  } else {
    if (!stat.isDirectory()) {
      throw new LocalHubActorTokenWriteError(
        'parent_not_directory',
        `${root} is not a directory`
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new LocalHubActorTokenWriteError(
        'writable_parent',
        `${root} is group/world-writable, so another user could replace the token file; run \`chmod go-w ${root}\` to enable the host-local CLI token`
      );
    }
  }
  // `writeNodeCredentialFile` never opens the final path with O_TRUNC: it
  // writes a uniquely named temp with flag 'wx' and renames over the target,
  // so a pre-planted file or symlink at the destination cannot be written
  // through.
  writeNodeCredentialFile(filePath, file);
  return filePath;
}

/**
 * Remove the port-keyed file, but only when it is the one `credentialId`
 * minted. Two hubs can bind the same port on different addresses, and a
 * blind unlink-by-port would let one delete the other's live token.
 */
export function deleteLocalHubActorTokenFile(
  root: string,
  port: number,
  credentialId?: string
): boolean {
  const filePath = localHubActorTokenPath(root, port);
  if (credentialId !== undefined) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        credentialId?: unknown;
      };
      if (parsed.credentialId !== credentialId) return false;
    } catch {
      return false;
    }
  }
  try {
    fs.unlinkSync(filePath);
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
  | 'foreign_owner_parent'
  | 'writable_parent'
  | 'parent_not_directory'
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
  const reject = (
    reason: LocalHubActorTokenRejection
  ): LocalHubActorTokenReadResult => ({ ok: false, reason, path: filePath });

  // Open with O_NOFOLLOW and validate the *handle*, so nothing can be swapped
  // between the check and the read.
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // O_NOFOLLOW on a symlink reports ELOOP (or EMLINK on some platforms).
    if (code === 'ELOOP' || code === 'EMLINK') return reject('symlink');
    return reject('missing');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return reject('not_regular_file');
    if ((stat.mode & 0o077) !== 0) return reject('loose_mode');
    if (uid !== undefined && stat.uid !== uid) return reject('foreign_owner');

    // The containing directory matters too: if another uid can write it, they
    // can put their own file at this path before we ever open it.
    let parentStat: fs.Stats;
    try {
      parentStat = fs.statSync(path.dirname(filePath));
    } catch {
      return reject('missing');
    }
    if (!parentStat.isDirectory()) return reject('parent_not_directory');
    if ((parentStat.mode & 0o022) !== 0) return reject('writable_parent');
    if (uid !== undefined && parentStat.uid !== uid) {
      // Distinct from the file-level rejection so a test can prove which of
      // the two ownership guards actually fired.
      return reject('foreign_owner_parent');
    }

    let raw: string;
    try {
      raw = fs.readFileSync(fd, 'utf8');
    } catch {
      return reject('unreadable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return reject('malformed');
    }
    if (!isStoredCredential(parsed)) return reject('malformed');
    const record = parsed as unknown as Record<string, unknown>;
    if (record['source'] !== LOCAL_HUB_ACTOR_TOKEN_SOURCE) {
      return reject('wrong_source');
    }
    if (record['port'] !== port) return reject('port_mismatch');
    const credential = parsed as LocalHubActorTokenFile;

    // The local token is proof of *local* access; it must never leave loopback.
    let hubUrl: URL;
    try {
      hubUrl = new URL(credential.hubUrl);
    } catch {
      return reject('non_loopback_hub');
    }
    if (!isLoopbackHost(hubUrl.hostname) || Number(hubUrl.port) !== port) {
      return reject('non_loopback_hub');
    }

    const now = options.now ?? Date.now();
    const expiresAt = Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return reject('expired');
    }

    return { ok: true, credential, path: filePath };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
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
