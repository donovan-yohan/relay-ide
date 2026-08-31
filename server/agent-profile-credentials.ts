// Durable per-profile actor credential lifecycle (#1455 slice 3).
//
// This module is the ONE place that knows both halves of a profile credential:
// the in-memory `ScopedActorCredentialRegistry` that authenticates requests,
// and the SQLite rows in `agent-profiles.db` that let the credential outlive
// the process. Keeping the coordination here is what stops the two views from
// drifting — a token that validates but has no row, or a row an operator
// revoked that still authenticates.
//
// WHAT IS PERSISTED: the credential's metadata plus `sha256(secret)`. Never the
// token, never anything replayable. See `AgentProfileStore.recordCredential`.
//
// SCOPE VS MEMBERSHIP: the credential is minted with NO `channelIds`; its
// channel reach is decided by hub-owned membership (#1455 slices 1-2). The
// reasoning lives on `issueAgentProfileCliGatewayActorCredential`.

import {
  AGENT_PROFILE_CREDENTIAL_CAPABILITIES,
  AGENT_PROFILE_CREDENTIAL_LAST_USED_GRANULARITY_MS,
  agentProfileCredentialState,
  type AgentProfileCredentialMintResult,
  type AgentProfileCredentialStatus,
} from '../shared/agent-profile-credential.js';
import {
  scopedActorCredentialSecretHash,
  type ScopedActorCredentialRegistry,
} from '../shared/scoped-actor-credentials.js';
import {
  AGENT_PROFILE_CREDENTIAL_REASON,
  CLI_GATEWAY_ACTOR_AUDIENCE,
  agentProfileCredentialScope,
  issueAgentProfileCliGatewayActorCredential,
} from './cli-gateway-actor-auth.js';
import type {
  AgentProfileCredentialRow,
  AgentProfileStore,
} from './agent-profile-store.js';
import { createLogger } from './logger.js';

const logger = createLogger('agent-profile-credential');

/** Cap on the in-memory last-used debounce map. See `noteUsed`. */
const LAST_USED_DEBOUNCE_MAX_ENTRIES = 1000;

export class AgentProfileCredentialError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentProfileCredentialError';
  }
}

export interface AgentProfileCredentialMintInput {
  profileId: string;
  /** Display name stamped on the credential's actor, for roster readability. */
  displayName?: string | undefined;
  /** Server-derived id of the operator performing the mint. */
  issuerId: string;
  /** Requested lifetime; silently capped at the hub's configured ceiling. */
  ttlMs?: number | undefined;
}

export interface AgentProfileCredentialService {
  mint(
    input: AgentProfileCredentialMintInput
  ): AgentProfileCredentialMintResult;
  revoke(input: {
    profileId: string;
    revokedBy: string;
    reason?: string | undefined;
  }): AgentProfileCredentialStatus;
  status(profileId: string): AgentProfileCredentialStatus | null;
  /**
   * Revoke everything a profile holds because the profile itself is going away.
   * Best-effort and never throws: a delete must not be blocked by credential
   * bookkeeping, and the durable row is the authority the next boot reads.
   */
  revokeForDeletedProfile(profileId: string): void;
  /** Coarse last-used stamp; debounced, safe to call on every request. */
  noteUsed(credentialId: string): void;
  /**
   * Restore persisted credentials into the registry. Returns a token-free
   * summary for the boot log. Idempotent enough to be safe on a re-run: a
   * credential already present in the registry is skipped, not duplicated.
   */
  rehydrate(): { restored: number; revoked: number; pruned: number };
}

export interface AgentProfileCredentialServiceDeps {
  /**
   * Getter, not a value: `applyCliGatewayActorMaxTtl` REPLACES the registry
   * when the configured ceiling is applied, and a captured reference would
   * quietly keep minting into a registry no request ever consults.
   */
  registry: () => ScopedActorCredentialRegistry;
  store: () => AgentProfileStore | null;
  /** The hub's configured actor-credential TTL ceiling. */
  maxTtlMs: () => number;
  now?: () => Date;
}

export function createAgentProfileCredentialService(
  deps: AgentProfileCredentialServiceDeps
): AgentProfileCredentialService {
  const now = deps.now ?? (() => new Date());
  /** credentialId -> epoch ms of the last durable `last_used_at` write. */
  const lastUsedWrites = new Map<string, number>();

  function requireStore(): AgentProfileStore {
    const store = deps.store();
    if (!store) {
      throw new AgentProfileCredentialError(
        503,
        'AGENT_PROFILE_STORE_UNAVAILABLE',
        'agent profile store is unavailable'
      );
    }
    return store;
  }

  function toStatus(
    row: AgentProfileCredentialRow
  ): AgentProfileCredentialStatus {
    return {
      profileId: row.profileId,
      credentialId: row.credentialId,
      actorId: row.actorId,
      capabilities: [...row.capabilities],
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      revokedBy: row.revokedBy,
      lastUsedAt: row.lastUsedAt,
      state: agentProfileCredentialState(row, now().getTime()),
    };
  }

  /** Revoke in the registry, tolerating an id the registry never held. */
  function revokeInRegistry(
    credentialId: string,
    revokedBy: string,
    reason: string
  ): void {
    try {
      deps.registry().revoke(credentialId, { revokedBy, reason });
    } catch (error) {
      logger.warn(
        'could not revoke credential %s in the registry: %s',
        credentialId,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return {
    mint(input): AgentProfileCredentialMintResult {
      const store = requireStore();
      const ceiling = deps.maxTtlMs();
      const requested =
        typeof input.ttlMs === 'number' &&
        Number.isFinite(input.ttlMs) &&
        input.ttlMs > 0
          ? Math.min(input.ttlMs, ceiling)
          : ceiling;
      // The actor id is the PROFILE id — the same spelling `deriveSender`
      // stamps on a durable channel row and the membership fold canonicalizes.
      // It is read from the stored profile by the caller and never taken from
      // a request body, which is what makes attribution server-derived.
      const issued = issueAgentProfileCliGatewayActorCredential(
        deps.registry(),
        {
          actor: {
            type: 'agent',
            id: input.profileId,
            ...(input.displayName ? { displayName: input.displayName } : {}),
          },
          issuer: { id: input.issuerId },
          capabilities: [...AGENT_PROFILE_CREDENTIAL_CAPABILITIES],
          // No `channelIds`: reach is membership, not scope. The read task-ref
          // marker `defaultCliGatewayActorScope` stamps for `session:read` is
          // what satisfies the registry's "at least one scope dimension" rule.
          scope: {},
          ttlMs: requested,
        }
      );
      const secretHash = scopedActorCredentialSecretHash(issued.token);
      if (!secretHash) {
        // Unreachable via `issue()`, which builds the token itself. Fail loudly
        // rather than persist a row whose hash can never match.
        revokeInRegistry(
          issued.credential.id,
          input.issuerId,
          'unhashable-token'
        );
        throw new AgentProfileCredentialError(
          500,
          'AGENT_PROFILE_CREDENTIAL_MINT_FAILED',
          'minted credential token could not be hashed'
        );
      }
      let stored;
      try {
        stored = store.recordCredential({
          credentialId: issued.credential.id,
          profileId: input.profileId,
          actorId: issued.credential.actor.id,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          issuerId: input.issuerId,
          secretHash,
          capabilities: issued.credential.capabilities,
          issuedAt: issued.credential.issuedAt,
          expiresAt: issued.credential.expiresAt,
        });
      } catch (error) {
        // Persistence is the whole point of this credential. A token that
        // authenticates today and vanishes at the next restart is worse than
        // no token, so an unpersistable mint is revoked and reported failed.
        revokeInRegistry(
          issued.credential.id,
          input.issuerId,
          'persist-failed'
        );
        throw error;
      }
      // The rows the store tombstoned on the way in are revoked in the registry
      // too, so rotation cuts the OLD token off in the same operation that
      // issues the new one rather than at the next restart.
      for (const previous of stored.revoked) {
        revokeInRegistry(previous.credentialId, input.issuerId, 'rotated');
      }
      return { credential: toStatus(stored.stored), token: issued.token };
    },

    revoke({ profileId, revokedBy, reason }): AgentProfileCredentialStatus {
      const store = requireStore();
      // Sweeps EVERY live row, like `mint`'s rotation does. The partial unique
      // index means there is one today, but revoking only the first would leave
      // any second row authenticating from memory until the next restart — an
      // access control that reports success while one token keeps working.
      const revoked = store.revokeCredentialsForProfile(profileId, revokedBy);
      const first = revoked[0];
      if (!first) {
        throw new AgentProfileCredentialError(
          404,
          'AGENT_PROFILE_CREDENTIAL_NOT_FOUND',
          'this profile has no live credential to revoke'
        );
      }
      for (const row of revoked) {
        revokeInRegistry(
          row.credentialId,
          revokedBy,
          reason ?? 'operator-revoked'
        );
      }
      return toStatus(first);
    },

    status(profileId): AgentProfileCredentialStatus | null {
      const row = requireStore().getCredentialStatus(profileId);
      return row ? toStatus(row) : null;
    },

    revokeForDeletedProfile(profileId): void {
      try {
        const store = deps.store();
        if (!store) return;
        // The store already tombstoned these rows inside `delete()`; this cuts
        // the same ids off in the live registry. It sweeps EVERY still-valid
        // row for the profile rather than the newest one: the unique index
        // means there is at most one live row today, and a sweep is what keeps
        // that an optimization rather than a load-bearing assumption.
        for (const row of store.listRestorableCredentials()) {
          if (row.profileId !== profileId) continue;
          revokeInRegistry(
            row.credentialId,
            row.revokedBy ?? 'agent-profile-deleted',
            'agent-profile-deleted'
          );
        }
      } catch (error) {
        logger.warn(
          'could not revoke credentials for deleted profile %s: %s',
          profileId,
          error instanceof Error ? error.message : String(error)
        );
      }
    },

    noteUsed(credentialId): void {
      const at = now().getTime();
      const previous = lastUsedWrites.get(credentialId);
      if (
        previous !== undefined &&
        at - previous < AGENT_PROFILE_CREDENTIAL_LAST_USED_GRANULARITY_MS
      ) {
        return;
      }
      // Bounded: the map is keyed by credential id, so it grows by one per
      // rotation for the life of the process. Operator-paced and tiny, but an
      // unbounded retained Map on a request path is the #1249 shape, so it is
      // capped rather than trusted. Dropping the whole map costs at most one
      // extra durable write per credential.
      if (lastUsedWrites.size >= LAST_USED_DEBOUNCE_MAX_ENTRIES) {
        lastUsedWrites.clear();
      }
      lastUsedWrites.set(credentialId, at);
      try {
        deps.store()?.touchCredential(credentialId, new Date(at).toISOString());
      } catch (error) {
        // A last-used stamp is diagnostics. It must never fail a request.
        logger.debug(
          'could not stamp last-used for credential %s: %s',
          credentialId,
          error instanceof Error ? error.message : String(error)
        );
      }
    },

    rehydrate(): { restored: number; revoked: number; pruned: number } {
      const store = deps.store();
      if (!store) return { restored: 0, revoked: 0, pruned: 0 };
      const at = now();
      let pruned = 0;
      try {
        // An expired row authenticates nothing and can never be revived, so it
        // is dead material rather than history worth keeping in a file that
        // also holds a real secret.
        pruned = store.pruneExpiredCredentials(at);
      } catch (error) {
        logger.warn(
          'could not prune expired agent profile credentials: %s',
          error instanceof Error ? error.message : String(error)
        );
      }
      let restored = 0;
      let revoked = 0;
      const registry = deps.registry();
      for (const row of store.listRestorableCredentials(at)) {
        if (registry.getCredential(row.credentialId)) continue;
        try {
          registry.importCredential({
            id: row.credentialId,
            actor: {
              type: 'agent',
              id: row.actorId,
              ...(row.displayName ? { displayName: row.displayName } : {}),
            },
            issuer: { id: row.issuerId },
            audience: CLI_GATEWAY_ACTOR_AUDIENCE,
            capabilities: [...row.capabilities],
            // Rebuilt from the SAME helper the mint uses, not stored: the scope
            // a profile credential carries is a constant of the design (no
            // channels, the read task-ref marker), so persisting it would only
            // create a way for the two to disagree — and a restored credential
            // whose scope no request satisfies is a fleet-wide outage that
            // appears only after a restart.
            scope: agentProfileCredentialScope(),
            metadata: { reason: AGENT_PROFILE_CREDENTIAL_REASON },
            issuedAt: row.issuedAt,
            expiresAt: row.expiresAt,
            ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
            ...(row.revokedBy ? { revokedBy: row.revokedBy } : {}),
            secretHash: row.secretHash,
          });
          restored += 1;
          if (row.revokedAt) revoked += 1;
        } catch (error) {
          // One unreadable row must not cost every other profile its
          // credential. Skipping fails CLOSED: that token stops working.
          logger.warn(
            'could not restore agent profile credential %s: %s',
            row.credentialId,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      return { restored, revoked, pruned };
    },
  };
}
