import * as path from 'node:path';
import {
  CLI_GATEWAY_ACTOR_GRANT_CAPABILITIES,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  DEFAULT_CLI_LOGIN_ACTOR_TTL_MS,
  issueLocalHubCliActorCredential,
} from './cli-gateway-actor-auth.js';
import {
  E2E_FIXTURE_ENV_VAR,
  sharedConfigRoots,
} from './runtime-state-paths.js';
import {
  LOCAL_HUB_ACTOR_TOKEN_SOURCE,
  deleteLocalHubActorTokenFile,
  isLoopbackHost,
  writeLocalHubActorTokenFile,
  type LocalHubActorTokenFile,
} from '../shared/local-hub-actor-token.js';
import type { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';

/**
 * #1467: at boot the hub mints one scoped actor credential carrying the full
 * CLI-gateway verb surface and writes it, mode 0600, to a port-keyed file in
 * the shared standard config root. The `relay-ide v1 …` CLI discovers it and
 * needs no `relay-ide login` on the hub host.
 *
 * Trust boundary (ratified in `docs/SECURITY_POLICY.md`): reading that file
 * requires filesystem access as the hub's own uid, and a process with that
 * access already owns the hub. The PIN keeps gating the browser/remote UI.
 *
 * The registry is memory-only, so a restart rotates the credential and any
 * stale copy of the file is dead material — no persistence, no revocation
 * list, no new HTTP route.
 */

/** Env var that suppresses the boot mint entirely (opt-out for hardened hosts). */
export const LOCAL_HUB_ACTOR_TOKEN_DISABLE_ENV =
  'RELAY_IDE_DISABLE_LOCAL_ACTOR_TOKEN';

/** Actor identity stamped on the boot-minted credential — server-derived, never caller-supplied. */
export const LOCAL_HUB_ACTOR_ID = 'local-cli';
export const LOCAL_HUB_ACTOR_DISPLAY_NAME = 'relay-ide local CLI';
export const LOCAL_HUB_ACTOR_TOKEN_REASON = 'hub-local-cli';

/**
 * TTL for the on-disk credential, deliberately far below the registry ceiling.
 *
 * The file is the whole credential, and `~/.config` is a directory people back
 * up and sync. A short life means a copied file is dead within a day even if
 * the hub never restarts; the hub refreshes it in place well before expiry.
 */
export const LOCAL_HUB_ACTOR_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Hosts a hub may bind while still publishing a loopback-reachable token. */
function hostServesLoopback(host: string | undefined): boolean {
  if (host === undefined) return true;
  const trimmed = host.trim().toLowerCase();
  if (trimmed === '' || trimmed === '0.0.0.0' || trimmed === '::') return true;
  return isLoopbackHost(trimmed);
}

export interface PublishLocalHubActorTokenInput {
  registry: ScopedActorCredentialRegistry;
  port: number;
  /**
   * The hub's own config directory. The token is published only when this is a
   * shared config root (or lives inside one) — see `configDirIsShared`.
   */
  configDir: string;
  /**
   * The address the hub bound. A hub reachable only on a LAN address would
   * publish a token the loopback-only CLI can never use, so it publishes none.
   */
  host?: string;
  /** Registry TTL ceiling; the credential's own TTL is capped by it. */
  maxTtlMs?: number;
  env?: Record<string, string | undefined>;
  homedir?: string;
  now?: () => number;
}

/** Public, token-free result — safe to log. */
export interface PublishedLocalHubActorToken {
  path: string;
  credentialId: string;
  actorId: string;
  expiresAt: string;
  /** How long the credential is actually good for, after the registry cap. */
  ttlMs: number;
  /** When the hub should rewrite the file — always strictly before expiry. */
  refreshAfterMs: number;
}

export function localHubActorTokenRoot(
  env: Record<string, string | undefined> = process.env,
  homedir?: string
): string {
  const roots =
    homedir === undefined
      ? sharedConfigRoots(env)
      : sharedConfigRoots(env, homedir);
  // `sharedConfigRoots()` puts the XDG-honoring app-data root first; that is
  // the deterministic location both the hub and the CLI compute from the same
  // environment.
  return roots[0] as string;
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Publish only for a hub actually deployed on this machine — i.e. one whose
 * config directory is (or sits under) a shared config root.
 *
 * A hub booted with an explicit `RELAY_IDE_CONFIG` pointing somewhere else is
 * a fixture, a test child process, or a deliberately isolated instance. Writing
 * its token into the shared root would litter the operator's real config
 * directory and, on a port collision, replace a live hub's token with one that
 * is already dead. Every real launch mode — the installed CLI
 * (`~/.config/relay-ide`), `dev:backend`, and from-source `#961` defaults — all
 * resolve under a shared root, so this costs nothing they rely on.
 */
export function configDirIsShared(
  configDir: string,
  env: Record<string, string | undefined> = process.env,
  homedir?: string
): boolean {
  const roots =
    homedir === undefined
      ? sharedConfigRoots(env)
      : sharedConfigRoots(env, homedir);
  return roots.some((root) => isInside(root, configDir));
}

export function localHubActorTokenDisabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  // e2e fixture boots are deliberately isolated from every shared config root
  // (#1214); minting there would write a real hub's directory and could
  // collide with a live hub's port key.
  if ((env[E2E_FIXTURE_ENV_VAR] ?? '').trim()) return true;
  const raw = (env[LOCAL_HUB_ACTOR_TOKEN_DISABLE_ENV] ?? '')
    .trim()
    .toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false';
}

/**
 * Mint + publish. Returns null when disabled; throws nothing on write failure
 * (callers log and continue — a hub that cannot write the file must still
 * serve, the CLI just falls back to today's 401).
 */
export function publishLocalHubActorToken(
  input: PublishLocalHubActorTokenInput
): PublishedLocalHubActorToken | null {
  const env = input.env ?? process.env;
  if (localHubActorTokenDisabled(env)) return null;
  if (!configDirIsShared(input.configDir, env, input.homedir)) return null;
  if (!hostServesLoopback(input.host)) return null;
  const now = input.now?.() ?? Date.now();
  const ceiling =
    typeof input.maxTtlMs === 'number' &&
    Number.isFinite(input.maxTtlMs) &&
    input.maxTtlMs > 0
      ? input.maxTtlMs
      : DEFAULT_CLI_LOGIN_ACTOR_TTL_MS;
  // Never exceed the registry ceiling (it throws), and never outlive a day.
  const ttlMs = Math.min(ceiling, LOCAL_HUB_ACTOR_TOKEN_TTL_MS);

  const issued = issueLocalHubCliActorCredential(input.registry, {
    actor: {
      type: 'cli',
      id: LOCAL_HUB_ACTOR_ID,
      displayName: LOCAL_HUB_ACTOR_DISPLAY_NAME,
    },
    issuer: { id: 'hub-local-boot', displayName: 'relay-ide hub' },
    capabilities: [...CLI_GATEWAY_ACTOR_GRANT_CAPABILITIES],
    scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
    ttlMs,
  });

  const file: LocalHubActorTokenFile = {
    version: 1,
    token: issued.token,
    credentialId: issued.credential.id,
    hubUrl: `http://127.0.0.1:${input.port}`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: issued.credential.expiresAt,
    actorId: issued.credential.actor.id,
    capabilities: [...issued.credential.capabilities],
    source: LOCAL_HUB_ACTOR_TOKEN_SOURCE,
    port: input.port,
    pid: process.pid,
  };
  const root = localHubActorTokenRoot(env, input.homedir);
  const filePath = writeLocalHubActorTokenFile(root, file);
  return {
    path: filePath,
    credentialId: issued.credential.id,
    actorId: issued.credential.actor.id,
    expiresAt: issued.credential.expiresAt,
    ttlMs,
    // Always strictly inside the TTL — a refresh that fires at or after expiry
    // would leave the local CLI 401ing for the rest of the cycle. The 60s floor
    // keeps a pathologically small configured ceiling from becoming a hot loop,
    // but never at the cost of overshooting the expiry.
    refreshAfterMs: Math.max(
      1_000,
      Math.min(Math.max(60_000, Math.floor(ttlMs / 2)), ttlMs - 1_000)
    ),
  };
}

/**
 * Drop any token file left behind for a port this process just bound.
 *
 * Binding the port proves the previous publisher is gone, and its credential
 * lived only in that process's memory — so the file is dead material whatever
 * its recorded TTL says. Runs even when the mint is disabled, so turning the
 * feature off actually removes the token instead of leaving it to age out.
 */
export function clearStaleLocalHubActorTokenFile(
  port: number,
  env: Record<string, string | undefined> = process.env,
  homedir?: string
): boolean {
  return deleteLocalHubActorTokenFile(
    localHubActorTokenRoot(env, homedir),
    port
  );
}

/**
 * Best-effort cleanup on graceful shutdown so no dead file is left behind.
 * Deletes only the file this process published (`credentialId`), so a hub that
 * shares a port on another address cannot remove a peer's live token.
 */
export function retireLocalHubActorToken(
  port: number,
  credentialId: string,
  env: Record<string, string | undefined> = process.env,
  homedir?: string
): boolean {
  // Deliberately NOT gated on the disable env: a hub restarted with the opt-out
  // set must still clear a file an earlier run left behind, or that stale token
  // lingers until its TTL runs out.
  return deleteLocalHubActorTokenFile(
    localHubActorTokenRoot(env, homedir),
    port,
    credentialId
  );
}
