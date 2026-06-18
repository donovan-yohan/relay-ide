import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHubNodeRegistry,
  type NodeLinkProofContext,
} from '../server/hub-node-registry.js';
import { authenticateHubNodeLink } from '../server/hub-node-link.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import {
  createNodeLinkProof,
  generateNodeIdentityKeyPair,
  type NodeIdentityKeyPair,
} from '../shared/node-identity-keys.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';

const NOW_MS = Date.parse('2026-06-18T12:00:00.000Z');

function manifest() {
  return buildManifestWithAgents({
    agents: [{ id: 'claude', label: 'Claude', status: 'available' as const }],
  });
}

interface Harness {
  registry: ReturnType<typeof createHubNodeRegistry>;
  storagePath: string;
  audit: SecurityAuditEntryInput[];
  now: { ms: number };
}

function withHarness<T>(fn: (h: Harness) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-proof-'));
  const storagePath = path.join(tmpDir, 'nodes.json');
  const audit: SecurityAuditEntryInput[] = [];
  const now = { ms: NOW_MS };
  try {
    const registry = createHubNodeRegistry({
      storagePath,
      now: () => new Date(now.ms),
      auditSink: { append: (entry) => audit.push(entry) },
    });
    return fn({ registry, storagePath, audit, now });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Pair a node, optionally binding a freshly generated identity key. */
function pair(
  registry: ReturnType<typeof createHubNodeRegistry>,
  keys?: NodeIdentityKeyPair
) {
  const pairToken = registry.createPairToken({ displayName: 'work-mac' });
  const exchanged = registry.exchangePairToken({
    pairToken: pairToken.pairToken,
    manifest: manifest(),
    ...(keys ? { publicKey: keys.publicKeyPem } : {}),
  });
  return exchanged;
}

function proofCtx(
  proof: string | undefined,
  extra: Partial<NodeLinkProofContext> = {}
): NodeLinkProofContext {
  return {
    audience: 'relay:node-link:v1',
    ...(proof ? { proof } : {}),
    ...extra,
  };
}

function freshProof(
  keys: NodeIdentityKeyPair,
  nodeId: string,
  credentialId: string,
  overrides: Partial<Parameters<typeof createNodeLinkProof>[0]> = {}
): string {
  return createNodeLinkProof({
    privateKeyPem: keys.privateKeyPem,
    publicKeyFingerprint: keys.publicKeyFingerprint,
    nodeId,
    credentialId,
    audience: 'relay:node-link:v1',
    nowMs: NOW_MS,
    ...overrides,
  });
}

describe('key-bound node-link proof', () => {
  it('binds the public-key fingerprint on key-bound pairing only', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const bound = pair(registry, keys);
      expect(bound.credential.publicKeyFingerprint).toBe(
        keys.publicKeyFingerprint
      );
      expect(bound.node.credential.keyBound).toBe(true);
      expect(bound.node.credential.publicKeyFingerprint).toBe(
        keys.publicKeyFingerprint
      );

      const legacy = pair(registry);
      expect(legacy.credential.publicKeyFingerprint).toBeUndefined();
      expect(legacy.node.credential.keyBound).toBe(false);
      expect(legacy.node.credential.publicKeyFingerprint).toBeUndefined();
    });
  });

  it('falls back to bearer-only when paired with a non-ed25519 key', () => {
    withHarness(({ registry }) => {
      const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const rsaPem = rsa.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString();
      const pairToken = registry.createPairToken({ displayName: 'work-mac' });
      const exchanged = registry.exchangePairToken({
        pairToken: pairToken.pairToken,
        manifest: manifest(),
        publicKey: rsaPem,
      });
      // Unsupported key type is not bound — credential stays bearer-only and a
      // bearer connect still works (no permanent lock-out).
      expect(exchanged.credential.publicKeyFingerprint).toBeUndefined();
      expect(exchanged.node.credential.keyBound).toBe(false);
      const result = registry.authenticateNodeLinkWithProof(
        exchanged.credential.token,
        proofCtx(undefined)
      );
      expect(result.ok).toBe(true);
    });
  });

  it('accepts a valid proof of private-key possession', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      const proof = freshProof(
        keys,
        credential.nodeId,
        credential.credentialId
      );
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(proof)
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.keyBound).toBe(true);
        expect(result.credentialId).toBe(credential.credentialId);
      }
    });
  });

  it('requires a proof for key-bound credentials (bearer alone fails closed)', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(undefined)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NODE_PROOF_REQUIRED');
        expect(result.error.details?.['reasonCode']).toBe(
          'NODE_LINK_PROOF_MISSING'
        );
      }
    });
  });

  it('keeps legacy bearer-only credentials working without a proof', () => {
    withHarness(({ registry }) => {
      const { credential } = pair(registry);
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(undefined)
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.keyBound).toBe(false);
    });
  });

  it('rejects a proof signed by the wrong private key', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const attacker = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      // Attacker claims the bound fingerprint but signs with their own key.
      const forged = createNodeLinkProof({
        privateKeyPem: attacker.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
        nodeId: credential.nodeId,
        credentialId: credential.credentialId,
        audience: 'relay:node-link:v1',
        nowMs: NOW_MS,
      });
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(forged)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NODE_PROOF_INVALID');
        expect(result.error.details?.['reasonCode']).toBe(
          'NODE_LINK_PROOF_SIGNATURE_INVALID'
        );
      }
    });
  });

  it('rejects a proof bound to a different credential id (mismatch)', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      const proof = freshProof(keys, credential.nodeId, 'cred_someone_else');
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(proof)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NODE_PROOF_INVALID');
        expect(result.error.details?.['reasonCode']).toBe(
          'NODE_LINK_PROOF_CREDENTIAL_MISMATCH'
        );
      }
    });
  });

  it('rejects a proof minted for the wrong audience', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      const heartbeatProof = createNodeLinkProof({
        privateKeyPem: keys.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
        nodeId: credential.nodeId,
        credentialId: credential.credentialId,
        audience: 'relay:node-heartbeat:v1',
        nowMs: NOW_MS,
      });
      // Presented on the node-link audience → mismatch.
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(heartbeatProof)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.details?.['reasonCode']).toBe(
          'NODE_LINK_PROOF_AUDIENCE_MISMATCH'
        );
      }
    });
  });

  it('rejects a stale proof outside the freshness window', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      const stale = freshProof(keys, credential.nodeId, credential.credentialId, {
        nowMs: NOW_MS - 10 * 60 * 1000,
      });
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(stale)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.details?.['reasonCode']).toBe(
          'NODE_LINK_PROOF_STALE'
        );
      }
    });
  });

  it('rejects a replayed proof (single use)', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      const proof = freshProof(keys, credential.nodeId, credential.credentialId, {
        jti: 'replay-jti',
      });
      const first = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(proof)
      );
      expect(first.ok).toBe(true);
      const second = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(proof)
      );
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.details?.['reasonCode']).toBe(
          'NODE_LINK_PROOF_REPLAYED'
        );
      }
    });
  });

  it('rejects proof + heartbeat once the node is revoked', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      registry.revokeNode(credential.nodeId);
      const proof = freshProof(keys, credential.nodeId, credential.credentialId);
      const result = registry.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(proof)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NODE_REVOKED');
    });
  });

  it('rejects a valid-looking proof against an expired credential', () => {
    withHarness(({ registry, storagePath, now }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      // Force credential expiry in stored state, then reload the registry.
      const stored = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      stored.nodes[0].activeCredential.expiresAt =
        '2026-06-18T11:00:00.000Z';
      fs.writeFileSync(storagePath, JSON.stringify(stored));
      const reloaded = createHubNodeRegistry({
        storagePath,
        now: () => new Date(now.ms),
      });
      const proof = freshProof(keys, credential.nodeId, credential.credentialId);
      const result = reloaded.authenticateNodeLinkWithProof(
        credential.token,
        proofCtx(proof)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NODE_CREDENTIAL_EXPIRED');
    });
  });

  it('preserves the key binding and node identity across rotation', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential, node } = pair(registry, keys);

      const rotation = registry.beginCredentialRotation(credential.nodeId);
      expect(rotation.credential.nodeId).toBe(credential.nodeId);
      expect(rotation.credential.credentialId).not.toBe(
        credential.credentialId
      );
      // The rotated credential carries the SAME identity-key fingerprint.
      expect(rotation.credential.publicKeyFingerprint).toBe(
        keys.publicKeyFingerprint
      );

      // Node proves the next credential (heartbeat carries the new id).
      registry.recordHeartbeat({
        nodeId: credential.nodeId,
        protocolVersion: '1.0',
        credentialId: rotation.credential.credentialId,
      });

      // Proof with the SAME key now authenticates the new credential id, and
      // the stable node identity is unchanged.
      const proof = freshProof(
        keys,
        credential.nodeId,
        rotation.credential.credentialId
      );
      const result = registry.authenticateNodeLinkWithProof(
        credential.token === rotation.credential.token
          ? credential.token
          : rotation.credential.token,
        proofCtx(proof)
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.node.nodeId).toBe(node.nodeId);
        expect(result.node.credential.keyBound).toBe(true);
        expect(result.node.credential.publicKeyFingerprint).toBe(
          keys.publicKeyFingerprint
        );
        expect(result.credentialId).toBe(rotation.credential.credentialId);
      }
    });
  });

  it('enforces the proof at the /hub/node-link upgrade seam with typed status', () => {
    withHarness(({ registry }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential } = pair(registry, keys);
      const request = (headers: Record<string, string>): http.IncomingMessage =>
        ({ headers } as unknown as http.IncomingMessage);

      // Bearer alone on a key-bound credential → 401 NODE_PROOF_REQUIRED.
      const missing = authenticateHubNodeLink(
        request({ authorization: `Bearer ${credential.token}` }),
        registry
      );
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.status).toBe(401);
        expect(missing.error?.code).toBe('NODE_PROOF_REQUIRED');
      }

      // Valid proof header → authenticated.
      const good = authenticateHubNodeLink(
        request({
          authorization: `Bearer ${credential.token}`,
          'x-relay-node-proof': freshProof(
            keys,
            credential.nodeId,
            credential.credentialId
          ),
        }),
        registry
      );
      expect(good.ok).toBe(true);

      // Wrong-key proof → 403 NODE_PROOF_INVALID.
      const attacker = generateNodeIdentityKeyPair();
      const forged = createNodeLinkProof({
        privateKeyPem: attacker.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
        nodeId: credential.nodeId,
        credentialId: credential.credentialId,
        audience: 'relay:node-link:v1',
        nowMs: NOW_MS,
        jti: 'forged-seam',
      });
      const bad = authenticateHubNodeLink(
        request({
          authorization: `Bearer ${credential.token}`,
          'x-relay-node-proof': forged,
        }),
        registry
      );
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.status).toBe(403);
        expect(bad.error?.code).toBe('NODE_PROOF_INVALID');
      }
    });
  });

  it('never leaks private key / token / hash material in audit or summaries', () => {
    withHarness(({ registry, audit }) => {
      const keys = generateNodeIdentityKeyPair();
      const { credential, node } = pair(registry, keys);
      const proof = freshProof(keys, credential.nodeId, credential.credentialId);
      registry.authenticateNodeLinkWithProof(credential.token, proofCtx(proof));

      const auditBlob = JSON.stringify(audit);
      // No secret-bearing material anywhere in the audit trail.
      expect(auditBlob).not.toContain('BEGIN PRIVATE KEY');
      expect(auditBlob).not.toContain('BEGIN PUBLIC KEY');
      expect(auditBlob).not.toContain(keys.privateKeyPem.slice(20, 60));
      expect(auditBlob).not.toContain(credential.token);

      // The public node summary exposes only the fingerprint, never the PEM.
      const summaryBlob = JSON.stringify(node);
      expect(summaryBlob).toContain(keys.publicKeyFingerprint);
      expect(summaryBlob).not.toContain('BEGIN PUBLIC KEY');
      expect(summaryBlob).not.toContain(credential.token);
    });
  });
});
