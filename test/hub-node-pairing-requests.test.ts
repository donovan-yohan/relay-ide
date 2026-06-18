import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHubNodeRegistry,
  DEFAULT_PENDING_PAIRING_TTL_MS,
  MAX_PENDING_PAIRING_TTL_MS,
} from '../server/hub-node-registry.js';
import {
  createNodeLinkProof,
  generateNodeIdentityKeyPair,
  type NodeIdentityKeyPair,
} from '../shared/node-identity-keys.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';

const NOW_MS = Date.parse('2026-06-18T12:00:00.000Z');
const SECRET_HOSTNAME = 'donovans-secret-macbook.tailnet.ts.net';

interface Harness {
  registry: ReturnType<typeof createHubNodeRegistry>;
  storagePath: string;
  audit: SecurityAuditEntryInput[];
  now: { ms: number };
}

function withHarness<T>(fn: (h: Harness) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pending-pairing-'));
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

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return buildManifestWithAgents({
    agents: [{ id: 'claude' }],
    overrides: { hostname: SECRET_HOSTNAME, ...overrides },
  });
}

function submit(
  h: Harness,
  input: Partial<Parameters<Harness['registry']['submitPendingPairingRequest']>[0]> = {},
  keys?: NodeIdentityKeyPair
) {
  return h.registry.submitPendingPairingRequest({
    manifest: manifest(),
    displayName: 'work-mac',
    ...(keys ? { publicKey: keys.publicKeyPem } : {}),
    ...input,
  });
}

describe('hub node pending pairing request lifecycle (#982)', () => {
  it('creates a pending request with a device code and one-time status token', () => {
    withHarness((h) => {
      const keys = generateNodeIdentityKeyPair();
      const { request, statusToken } = submit(h, {}, keys);

      expect(request.state).toBe('pending');
      expect(request.reasonCode).toBe('PENDING_PAIRING_REQUESTED');
      expect(request.displayName).toBe('work-mac');
      expect(request.requestedProfile).toBe('dev-workstation');
      expect(request.requestedTrustTier).toBe('dev');
      expect(request.requiresExactOperationApproval).toBe(false);
      expect(request.publicKeyFingerprint).toBe(keys.publicKeyFingerprint);
      expect(request.deviceCode).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
      expect(request.expiresAt).toBe(
        new Date(NOW_MS + DEFAULT_PENDING_PAIRING_TTL_MS).toISOString()
      );
      expect(statusToken).toMatch(/^pstat_/);
      // Posture is product language, never raw capability bits.
      expect(request.requestedCapabilities).toContain('launch terminal sessions');
      expect(request.requestedCapabilities).not.toContain('rpc:fs:read');
    });
  });

  it('never persists or surfaces the status token, raw hostname, or secrets', () => {
    withHarness((h) => {
      const keys = generateNodeIdentityKeyPair();
      const { request, statusToken } = submit(h, {}, keys);

      const persisted = fs.readFileSync(h.storagePath, 'utf8');
      expect(persisted).not.toContain(statusToken);
      // sha256 of the token is what is stored.
      expect(persisted).toContain('statusTokenHash');

      const summaryJson = JSON.stringify(request);
      expect(summaryJson).not.toContain(statusToken);
      expect(summaryJson).not.toContain(SECRET_HOSTNAME);
      expect(summaryJson).not.toContain('tailnet.ts.net');
      expect(summaryJson).not.toContain('BEGIN PRIVATE KEY');
      expect(summaryJson).not.toContain('BEGIN PUBLIC KEY');

      const auditJson = JSON.stringify(h.audit);
      expect(auditJson).not.toContain(statusToken);
      expect(auditJson).not.toContain(SECRET_HOSTNAME);
      expect(auditJson).not.toContain('BEGIN PRIVATE KEY');
      // The safe public fingerprint is allowed to appear.
      expect(auditJson).toContain(keys.publicKeyFingerprint);
    });
  });

  it('locates a request by device code case-insensitively and dash-tolerantly', () => {
    withHarness((h) => {
      const { request } = submit(h);
      const code = request.deviceCode; // e.g. "7KQ-M2P"
      const scrambled = code.replace('-', '').toLowerCase();
      const found = h.registry.findPendingPairingRequestByDeviceCode(scrambled);
      expect(found?.requestId).toBe(request.requestId);
      expect(
        h.registry.findPendingPairingRequestByDeviceCode('zzz-zzz')
      ).toBeNull();
    });
  });

  it('approves a request, then issues a key-bound credential only on the node claim', () => {
    withHarness((h) => {
      const keys = generateNodeIdentityKeyPair();
      const { request, statusToken } = submit(h, {}, keys);

      const approved = h.registry.approvePendingPairingRequest(
        request.requestId
      );
      expect(approved.state).toBe('approved');
      expect(approved.reasonCode).toBe('PENDING_PAIRING_APPROVED');
      // No node exists yet — issuance is deferred to the authenticated claim.
      expect(h.registry.listNodes()).toHaveLength(0);

      const claim = h.registry.pollPendingPairingRequest(
        request.requestId,
        statusToken
      );
      expect(claim.credential).toBeDefined();
      expect(claim.node).toBeDefined();
      expect(claim.credential!.token).toMatch(
        new RegExp(`^${claim.node!.nodeId}\\.`)
      );
      expect(claim.credential!.publicKeyFingerprint).toBe(
        keys.publicKeyFingerprint
      );
      expect(h.registry.listNodes()).toHaveLength(1);

      // The issued credential is key-bound: a fresh proof authenticates.
      const proof = createNodeLinkProof({
        privateKeyPem: keys.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
        nodeId: claim.node!.nodeId,
        credentialId: claim.credential!.credentialId,
        audience: 'relay:node-link:v1',
        nowMs: NOW_MS,
      });
      const auth = h.registry.authenticateNodeLinkWithProof(
        claim.credential!.token,
        { audience: 'relay:node-link:v1', proof }
      );
      expect(auth.ok).toBe(true);

      // A bearer-only attempt (no proof) on the key-bound credential fails closed.
      const noProof = h.registry.authenticateNodeLinkWithProof(
        claim.credential!.token,
        { audience: 'relay:node-link:v1' }
      );
      expect(noProof.ok).toBe(false);
      if (!noProof.ok) expect(noProof.error.code).toBe('NODE_PROOF_REQUIRED');

      // Raw credential token never lands in the persisted file.
      const persisted = fs.readFileSync(h.storagePath, 'utf8');
      expect(persisted).not.toContain(claim.credential!.token);
    });
  });

  it('delivers the issued credential exactly once', () => {
    withHarness((h) => {
      const keys = generateNodeIdentityKeyPair();
      const { request, statusToken } = submit(h, {}, keys);
      h.registry.approvePendingPairingRequest(request.requestId);

      const first = h.registry.pollPendingPairingRequest(
        request.requestId,
        statusToken
      );
      expect(first.credential).toBeDefined();

      const second = h.registry.pollPendingPairingRequest(
        request.requestId,
        statusToken
      );
      expect(second.credential).toBeUndefined();
      expect(second.node).toBeUndefined();
      expect(second.request.state).toBe('approved');
      // No duplicate node record created on re-claim.
      expect(h.registry.listNodes()).toHaveLength(1);
    });
  });

  it('rejects a status poll with an invalid token', () => {
    withHarness((h) => {
      const { request } = submit(h);
      expect(() =>
        h.registry.pollPendingPairingRequest(request.requestId, 'pstat_wrong')
      ).toThrow(/UNAUTHORIZED/);
    });
  });

  it('denies a request and cannot replay a denial into an approval or credential', () => {
    withHarness((h) => {
      const { request, statusToken } = submit(h);
      const denied = h.registry.denyPendingPairingRequest(request.requestId, {
        reason: 'unrecognized device',
      });
      expect(denied.state).toBe('denied');
      expect(denied.reasonCode).toBe('PENDING_PAIRING_DENIED');

      // The waiting node sees the denial, never a credential.
      const poll = h.registry.pollPendingPairingRequest(
        request.requestId,
        statusToken
      );
      expect(poll.credential).toBeUndefined();
      expect(poll.request.state).toBe('denied');

      // A denied request cannot be replayed into approval.
      expect(() =>
        h.registry.approvePendingPairingRequest(request.requestId)
      ).toThrow(/INVALID_REQUEST/);
      expect(h.registry.listNodes()).toHaveLength(0);
    });
  });

  it('redacts secret-shaped material from a denial reason before storing or auditing', () => {
    withHarness((h) => {
      const { request } = submit(h);
      h.registry.denyPendingPairingRequest(request.requestId, {
        reason: 'rejected; saw leaked pair_ABC123secret and secret_XYZ789tok',
      });

      const persisted = fs.readFileSync(h.storagePath, 'utf8');
      const auditJson = JSON.stringify(h.audit);
      for (const blob of [persisted, auditJson]) {
        expect(blob).not.toContain('pair_ABC123secret');
        expect(blob).not.toContain('secret_XYZ789tok');
        expect(blob).not.toContain('ABC123');
        expect(blob).not.toContain('XYZ789');
      }
    });
  });

  it('expires a request and refuses approval/issuance after expiry', () => {
    withHarness((h) => {
      const { request, statusToken } = submit(h, { ttlMs: 1000 });
      h.now.ms = NOW_MS + 2000;

      const listed = h.registry.listPendingPairingRequests({
        includeResolved: true,
      });
      expect(listed[0]?.state).toBe('expired');
      expect(listed[0]?.reasonCode).toBe('PENDING_PAIRING_EXPIRED');

      // An expired request cannot be replayed into an approval.
      expect(() =>
        h.registry.approvePendingPairingRequest(request.requestId)
      ).toThrow(/TOKEN_EXPIRED/);

      // The node poll surfaces the expiry, never a credential.
      const poll = h.registry.pollPendingPairingRequest(
        request.requestId,
        statusToken
      );
      expect(poll.credential).toBeUndefined();
      expect(poll.request.state).toBe('expired');
    });
  });

  it('marks prod-profile and high-risk-capability requests as requiring exact-operation approval', () => {
    withHarness((h) => {
      const prod = submit(h, { requestedProfile: 'infra-prod-host' });
      expect(prod.request.requestedTrustTier).toBe('prod');
      expect(prod.request.requiresExactOperationApproval).toBe(true);

      const devHighRisk = submit(h, {
        requestedCapabilities: ['rpc:fs:write'],
      });
      expect(devHighRisk.request.requestedTrustTier).toBe('dev');
      expect(devHighRisk.request.requiresExactOperationApproval).toBe(true);
      expect(devHighRisk.request.requestedCapabilities).toContain(
        'write approved repo roots'
      );
      // Raw bits never appear in the customer-facing posture.
      expect(JSON.stringify(devHighRisk.request)).not.toContain('rpc:fs:write');
    });
  });

  it('edits requested access before approval but not after a decision', () => {
    withHarness((h) => {
      const { request } = submit(h);
      const edited = h.registry.editPendingPairingAccess(request.requestId, {
        displayName: 'work-mac (prod)',
        requestedProfile: 'infra-prod-host',
        requestedRoots: ['~/code', '~/work'],
      });
      expect(edited.displayName).toBe('work-mac (prod)');
      expect(edited.requestedProfile).toBe('infra-prod-host');
      expect(edited.requestedTrustTier).toBe('prod');
      expect(edited.requiresExactOperationApproval).toBe(true);
      expect(edited.requestedRoots).toEqual(['~/code', '~/work']);
      expect(edited.reasonCode).toBe('PENDING_PAIRING_ACCESS_EDITED');

      h.registry.approvePendingPairingRequest(request.requestId);
      expect(() =>
        h.registry.editPendingPairingAccess(request.requestId, {
          displayName: 'too late',
        })
      ).toThrow(/INVALID_REQUEST/);
    });
  });

  it('clamps or rejects invalid ttlMs values to a valid expiry window', () => {
    withHarness((h) => {
      const min = NOW_MS + 1;
      const maxBound = NOW_MS + MAX_PENDING_PAIRING_TTL_MS;
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
        const { request } = submit(h, { ttlMs: bad });
        // Invalid → default window; expiresAt is always a valid ISO instant.
        expect(request.expiresAt).toBe(
          new Date(NOW_MS + DEFAULT_PENDING_PAIRING_TTL_MS).toISOString()
        );
        expect(Number.isNaN(Date.parse(request.expiresAt))).toBe(false);
      }
      // Absurdly large finite ttl clamps to the hard maximum, never overflows.
      const huge = submit(h, { ttlMs: 1e15 });
      const hugeMs = Date.parse(huge.request.expiresAt);
      expect(Number.isNaN(hugeMs)).toBe(false);
      expect(hugeMs).toBe(maxBound);
      expect(hugeMs).toBeGreaterThanOrEqual(min);
    });
  });

  it('keeps an approved-but-unclaimed request locatable by its device code and claimable', () => {
    withHarness((h) => {
      const keys = generateNodeIdentityKeyPair();
      const { request, statusToken } = submit(h, {}, keys);
      h.registry.approvePendingPairingRequest(request.requestId);

      // Approved-but-unclaimed: still the active match for its device code.
      const located = h.registry.findPendingPairingRequestByDeviceCode(
        request.deviceCode
      );
      expect(located?.requestId).toBe(request.requestId);
      expect(located?.state).toBe('approved');

      // The original status token still claims the credential — not displaced.
      const claim = h.registry.pollPendingPairingRequest(
        request.requestId,
        statusToken
      );
      expect(claim.credential).toBeDefined();
      expect(claim.credential!.publicKeyFingerprint).toBe(
        keys.publicKeyFingerprint
      );
    });
  });

  it('throws NOT_FOUND for an unknown request id', () => {
    withHarness((h) => {
      expect(() =>
        h.registry.approvePendingPairingRequest('ppreq_missing')
      ).toThrow(/NOT_FOUND/);
      expect(h.registry.getPendingPairingRequest('ppreq_missing')).toBeNull();
    });
  });

  it('survives a registry reload (durable storage)', () => {
    withHarness((h) => {
      const { request } = submit(h);
      h.registry.approvePendingPairingRequest(request.requestId);

      const reloaded = createHubNodeRegistry({
        storagePath: h.storagePath,
        now: () => new Date(h.now.ms),
      });
      const found = reloaded.getPendingPairingRequest(request.requestId);
      expect(found?.state).toBe('approved');
    });
  });
});
