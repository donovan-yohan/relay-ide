import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createNodeLinkProof,
  generateNodeIdentityKeyPair,
  nodePublicKeyFingerprint,
  NODE_PUBLIC_KEY_FINGERPRINT_PREFIX,
  redactNodeIdentityMaterial,
  safeNodePublicKeyFingerprint,
  verifyNodeLinkProof,
  type CreateNodeLinkProofInput,
} from '../shared/node-identity-keys.js';

const NOW = Date.parse('2026-06-18T12:00:00.000Z');

function proofInput(
  overrides: Partial<CreateNodeLinkProofInput> = {}
): CreateNodeLinkProofInput {
  const keys = overrides.privateKeyPem
    ? undefined
    : generateNodeIdentityKeyPair();
  return {
    privateKeyPem: keys?.privateKeyPem ?? overrides.privateKeyPem!,
    publicKeyFingerprint:
      keys?.publicKeyFingerprint ?? overrides.publicKeyFingerprint!,
    nodeId: 'node_alpha',
    credentialId: 'cred_alpha',
    audience: 'relay:node-link:v1',
    nowMs: NOW,
    jti: 'jti-fixed',
    ...overrides,
  };
}

describe('node identity keys', () => {
  it('generates an ed25519 key pair with a stable nkey_ fingerprint', () => {
    const keys = generateNodeIdentityKeyPair();
    expect(keys.algorithm).toBe('ed25519');
    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(keys.publicKeyFingerprint.startsWith(NODE_PUBLIC_KEY_FINGERPRINT_PREFIX)).toBe(
      true
    );
    // Fingerprint is canonical over the DER bytes: recomputing matches.
    expect(nodePublicKeyFingerprint(keys.publicKeyPem)).toBe(
      keys.publicKeyFingerprint
    );
    // Distinct keys → distinct fingerprints.
    expect(generateNodeIdentityKeyPair().publicKeyFingerprint).not.toBe(
      keys.publicKeyFingerprint
    );
  });

  it('safeNodePublicKeyFingerprint returns null for malformed input', () => {
    expect(safeNodePublicKeyFingerprint('not-a-pem')).toBeNull();
    expect(safeNodePublicKeyFingerprint('')).toBeNull();
    expect(safeNodePublicKeyFingerprint(undefined)).toBeNull();
    const keys = generateNodeIdentityKeyPair();
    expect(safeNodePublicKeyFingerprint(keys.publicKeyPem)).toBe(
      keys.publicKeyFingerprint
    );
  });

  it('rejects non-ed25519 public keys (fails closed at bind time)', () => {
    // A structurally valid RSA SPKI key can never produce an ed25519 proof, so
    // it must NOT be bound as a key-bound credential — it fingerprints to null.
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(safeNodePublicKeyFingerprint(rsaPem)).toBeNull();
    expect(() => nodePublicKeyFingerprint(rsaPem)).toThrow(/unsupported/);

    const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecPem = p256.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(safeNodePublicKeyFingerprint(ecPem)).toBeNull();
  });

  it('verifies a fresh proof of private-key possession', () => {
    const keys = generateNodeIdentityKeyPair();
    const proof = createNodeLinkProof(
      proofInput({
        privateKeyPem: keys.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
      })
    );
    const result = verifyNodeLinkProof({
      proof,
      publicKeyPem: keys.publicKeyPem,
      expected: {
        nodeId: 'node_alpha',
        credentialId: 'cred_alpha',
        audience: 'relay:node-link:v1',
        publicKeyFingerprint: keys.publicKeyFingerprint,
      },
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: true, jti: 'jti-fixed', issuedAtMs: NOW });
  });

  it('rejects a proof signed by a different key (wrong key)', () => {
    const signer = generateNodeIdentityKeyPair();
    const bound = generateNodeIdentityKeyPair();
    // Node claims the bound fingerprint but signs with a different private key.
    const proof = createNodeLinkProof(
      proofInput({
        privateKeyPem: signer.privateKeyPem,
        publicKeyFingerprint: bound.publicKeyFingerprint,
      })
    );
    const result = verifyNodeLinkProof({
      proof,
      publicKeyPem: bound.publicKeyPem,
      expected: {
        nodeId: 'node_alpha',
        credentialId: 'cred_alpha',
        audience: 'relay:node-link:v1',
        publicKeyFingerprint: bound.publicKeyFingerprint,
      },
      nowMs: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'NODE_LINK_PROOF_SIGNATURE_INVALID',
    });
  });

  it('rejects a fingerprint mismatch before signature work', () => {
    const keys = generateNodeIdentityKeyPair();
    const proof = createNodeLinkProof(
      proofInput({
        privateKeyPem: keys.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
      })
    );
    const result = verifyNodeLinkProof({
      proof,
      publicKeyPem: keys.publicKeyPem,
      expected: {
        nodeId: 'node_alpha',
        credentialId: 'cred_alpha',
        audience: 'relay:node-link:v1',
        publicKeyFingerprint: 'nkey_someoneelse',
      },
      nowMs: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'NODE_LINK_PROOF_FINGERPRINT_MISMATCH',
    });
  });

  it('rejects node / credential / audience binding mismatches', () => {
    const keys = generateNodeIdentityKeyPair();
    const base = {
      publicKeyPem: keys.publicKeyPem,
      nowMs: NOW,
    };
    const proof = createNodeLinkProof(
      proofInput({
        privateKeyPem: keys.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
      })
    );
    const expected = {
      nodeId: 'node_alpha',
      credentialId: 'cred_alpha',
      audience: 'relay:node-link:v1' as const,
      publicKeyFingerprint: keys.publicKeyFingerprint,
    };
    expect(
      verifyNodeLinkProof({
        ...base,
        proof,
        expected: { ...expected, nodeId: 'node_other' },
      })
    ).toEqual({ ok: false, reason: 'NODE_LINK_PROOF_NODE_MISMATCH' });
    expect(
      verifyNodeLinkProof({
        ...base,
        proof,
        expected: { ...expected, credentialId: 'cred_other' },
      })
    ).toEqual({ ok: false, reason: 'NODE_LINK_PROOF_CREDENTIAL_MISMATCH' });
    expect(
      verifyNodeLinkProof({
        ...base,
        proof,
        expected: { ...expected, audience: 'relay:node-heartbeat:v1' },
      })
    ).toEqual({ ok: false, reason: 'NODE_LINK_PROOF_AUDIENCE_MISMATCH' });
  });

  it('rejects a stale proof outside the freshness window', () => {
    const keys = generateNodeIdentityKeyPair();
    const proof = createNodeLinkProof(
      proofInput({
        privateKeyPem: keys.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
        nowMs: NOW - 10 * 60 * 1000,
      })
    );
    const result = verifyNodeLinkProof({
      proof,
      publicKeyPem: keys.publicKeyPem,
      expected: {
        nodeId: 'node_alpha',
        credentialId: 'cred_alpha',
        audience: 'relay:node-link:v1',
        publicKeyFingerprint: keys.publicKeyFingerprint,
      },
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'NODE_LINK_PROOF_STALE' });
  });

  it('rejects malformed and tampered proofs', () => {
    const keys = generateNodeIdentityKeyPair();
    const expected = {
      nodeId: 'node_alpha',
      credentialId: 'cred_alpha',
      audience: 'relay:node-link:v1' as const,
      publicKeyFingerprint: keys.publicKeyFingerprint,
    };
    for (const proof of ['', 'a.b', 'a.b.c.d', 'not-base64.@@.$$']) {
      expect(
        verifyNodeLinkProof({
          proof,
          publicKeyPem: keys.publicKeyPem,
          expected,
          nowMs: NOW,
        }).ok
      ).toBe(false);
    }
    // Tamper the payload of a valid proof → signature no longer verifies.
    const proof = createNodeLinkProof(
      proofInput({
        privateKeyPem: keys.privateKeyPem,
        publicKeyFingerprint: keys.publicKeyFingerprint,
      })
    );
    const [h, , s] = proof.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        nodeId: 'node_alpha',
        credentialId: 'cred_alpha',
        aud: 'relay:node-link:v1',
        iat: Math.floor(NOW / 1000),
        jti: 'forged',
      })
    ).toString('base64url');
    const tampered = `${h}.${forgedPayload}.${s}`;
    expect(
      verifyNodeLinkProof({
        proof: tampered,
        publicKeyPem: keys.publicKeyPem,
        expected,
        nowMs: NOW,
      })
    ).toEqual({ ok: false, reason: 'NODE_LINK_PROOF_SIGNATURE_INVALID' });
  });

  it('rejects an unsupported algorithm header', () => {
    const keys = generateNodeIdentityKeyPair();
    const header = Buffer.from(
      JSON.stringify({ typ: 'relay-node-proof+v1', alg: 'rs256', fpr: keys.publicKeyFingerprint })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        nodeId: 'node_alpha',
        credentialId: 'cred_alpha',
        aud: 'relay:node-link:v1',
        iat: Math.floor(NOW / 1000),
        jti: 'x',
      })
    ).toString('base64url');
    const sig = crypto
      .sign(null, Buffer.from(`${header}.${payload}`), crypto.createPrivateKey(keys.privateKeyPem))
      .toString('base64url');
    expect(
      verifyNodeLinkProof({
        proof: `${header}.${payload}.${sig}`,
        publicKeyPem: keys.publicKeyPem,
        expected: {
          nodeId: 'node_alpha',
          credentialId: 'cred_alpha',
          audience: 'relay:node-link:v1',
          publicKeyFingerprint: keys.publicKeyFingerprint,
        },
        nowMs: NOW,
      })
    ).toEqual({ ok: false, reason: 'NODE_LINK_PROOF_UNSUPPORTED_ALG' });
  });

  it('redacts private-key and secret material but keeps public fingerprints', () => {
    const keys = generateNodeIdentityKeyPair();
    const text = `link failed for nkey_abc using ${keys.privateKeyPem} token node_x.secret_supersecretvalue`;
    const redacted = redactNodeIdentityMaterial(text);
    expect(redacted).toContain('nkey_abc');
    expect(redacted).toContain('[redacted-key]');
    expect(redacted).not.toContain('BEGIN PRIVATE KEY');
    expect(redacted).not.toContain('supersecretvalue');
    expect(redacted).toContain('secret_…redacted');
  });
});
