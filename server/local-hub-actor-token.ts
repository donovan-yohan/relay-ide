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

export interface PublishLocalHubActorTokenInput {
  registry: ScopedActorCredentialRegistry;
  port: number;
  /** Registry TTL ceiling; the credential asks for exactly this. */
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
  const now = input.now?.() ?? Date.now();
  const ttlMs =
    typeof input.maxTtlMs === 'number' &&
    Number.isFinite(input.maxTtlMs) &&
    input.maxTtlMs > 0
      ? input.maxTtlMs
      : DEFAULT_CLI_LOGIN_ACTOR_TTL_MS;

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
  };
}

/** Best-effort cleanup on graceful shutdown so no dead file is left behind. */
export function retireLocalHubActorToken(
  port: number,
  env: Record<string, string | undefined> = process.env,
  homedir?: string
): boolean {
  if (localHubActorTokenDisabled(env)) return false;
  return deleteLocalHubActorTokenFile(
    localHubActorTokenRoot(env, homedir),
    port
  );
}
