// Durable scoped actor credential lifecycle (#1546).
//
// Coordinates in-memory ScopedActorCredentialRegistry with SQLite storage
// (scoped-actor-credentials.db) so operator-minted, login-minted, and renewed
// credentials survive hub restart within their TTL.

import type { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';
import { scopedActorCredentialSecretHash } from '../shared/scoped-actor-credentials.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';
import type { ScopedActorCredentialStore } from './scoped-actor-credential-store.js';
import { createLogger } from './logger.js';

const logger = createLogger('scoped-actor-credentials');

export interface ScopedActorCredentialServiceDeps {
  registry: () => ScopedActorCredentialRegistry;
  store: () => ScopedActorCredentialStore | null;
  now?: () => Date;
}

export interface ScopedActorCredentialService {
  recordIssued(issued: {
    token: string;
    credential: ScopedActorCredentialRecord;
  }): ScopedActorCredentialRecord;
  revoke(
    credentialId: string,
    input: { revokedBy: string; reason?: string; correlationId?: string }
  ): ScopedActorCredentialRecord | null;
  revokeByGrantId(
    grantId: string,
    input: { revokedBy: string; reason?: string; correlationId?: string }
  ): ScopedActorCredentialRecord[];
  rehydrate(): { restored: number; revoked: number; pruned: number };
}

export function createScopedActorCredentialService(
  deps: ScopedActorCredentialServiceDeps
): ScopedActorCredentialService {
  const now = deps.now ?? (() => new Date());

  return {
    recordIssued(issued: {
      token: string;
      credential: ScopedActorCredentialRecord;
    }): ScopedActorCredentialRecord {
      const store = deps.store();
      if (!store) return issued.credential;
      const secretHash = scopedActorCredentialSecretHash(issued.token);
      if (!secretHash) {
        throw new Error(
          'failed to compute secretHash for issued scoped actor credential'
        );
      }
      return store.recordCredential({
        credentialId: issued.credential.id,
        actor: issued.credential.actor,
        issuer: issued.credential.issuer,
        ...(issued.credential.grantId
          ? { grantId: issued.credential.grantId }
          : {}),
        audience: issued.credential.audience,
        secretHash,
        capabilities: issued.credential.capabilities,
        scope: issued.credential.scope,
        ...(issued.credential.metadata
          ? { metadata: issued.credential.metadata }
          : {}),
        issuedAt: issued.credential.issuedAt,
        expiresAt: issued.credential.expiresAt,
        correlationId: issued.credential.correlationId,
      });
    },

    revoke(
      credentialId: string,
      input: { revokedBy: string; reason?: string; correlationId?: string }
    ): ScopedActorCredentialRecord | null {
      const store = deps.store();
      if (store) {
        store.revokeCredential(credentialId, { ...input, now: now() });
      }
      return deps.registry().revoke(credentialId, input);
    },

    revokeByGrantId(
      grantId: string,
      input: { revokedBy: string; reason?: string; correlationId?: string }
    ): ScopedActorCredentialRecord[] {
      const store = deps.store();
      if (store) {
        store.revokeCredentialsByGrantId(grantId, { ...input, now: now() });
      }
      return deps.registry().revokeByGrantId(grantId, input);
    },

    rehydrate(): { restored: number; revoked: number; pruned: number } {
      const store = deps.store();
      if (!store) return { restored: 0, revoked: 0, pruned: 0 };
      const at = now();
      let pruned = 0;
      try {
        pruned = store.pruneExpiredCredentials(at);
      } catch (error) {
        logger.warn('Failed to prune expired scoped actor credentials:', error);
      }
      let restored = 0;
      let revoked = 0;
      const registry = deps.registry();
      try {
        for (const row of store.listRestorableCredentials(at)) {
          if (registry.getCredential(row.id)) continue;
          try {
            registry.importCredential({
              id: row.id,
              actor: row.actor,
              issuer: row.issuer,
              ...(row.grantId ? { grantId: row.grantId } : {}),
              audience: row.audience,
              capabilities: row.capabilities,
              scope: row.scope,
              ...(row.metadata ? { metadata: row.metadata } : {}),
              issuedAt: row.issuedAt,
              expiresAt: row.expiresAt,
              ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
              ...(row.revokedBy ? { revokedBy: row.revokedBy } : {}),
              ...(row.revocationReason
                ? { revocationReason: row.revocationReason }
                : {}),
              correlationId: row.correlationId,
              secretHash: row.secretHash,
            });
            restored += 1;
            if (row.revokedAt) revoked += 1;
          } catch (error) {
            logger.warn(
              'Failed to restore scoped actor credential %s: %s',
              row.id,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      } catch (error) {
        logger.warn(
          'Failed to list restorable scoped actor credentials:',
          error
        );
      }
      return { restored, revoked, pruned };
    },
  };
}
