/**
 * Key-bound node identity primitives for issue #981.
 *
 * A Relay node owns a local ed25519 key pair. Only PUBLIC material
 * (the SPKI public key and a derived fingerprint) ever leaves the node;
 * the private key stays on the node's disk. The hub binds the public-key
 * fingerprint to the issued node credential record, and `/hub/node-link`
 * (plus the HTTP heartbeat) require a freshness-bound, replay-protected
 * proof of private-key possession on top of the existing bearer locator.
 *
 * The proof shape is deliberately DPoP-like: the node signs a compact
 * `header.payload.signature` assertion that binds the connection target
 * (nodeId + credentialId + audience) and carries an `iat`/`jti` so the
 * verifier can enforce freshness and single-use. The challenge is the
 * verifier-validated freshness window + per-jti replay cache (owned by the
 * hub registry), not a server-issued nonce; a server-issued-nonce variant
 * is a compatible future hardening behind this same contract.
 *
 * Nothing in this module logs or throws with raw private-key or signature
 * bytes; `redactNodeIdentityMaterial` scrubs PEM/secret-looking fragments
 * before any diagnostic emission.
 */
import * as crypto from 'node:crypto';

export const NODE_IDENTITY_KEY_ALGORITHM = 'ed25519' as const;
export type NodeIdentityKeyAlgorithm = typeof NODE_IDENTITY_KEY_ALGORITHM;

/** Compact proof token type tag (header.typ). */
export const NODE_LINK_PROOF_TYP = 'relay-node-proof+v1' as const;

/** Stable fingerprint prefix, mirrors the `src_`/`cred_` redacted-handle convention. */
export const NODE_PUBLIC_KEY_FINGERPRINT_PREFIX = 'nkey_' as const;

/**
 * Audiences a node-link proof can be minted for. Binding the audience stops a
 * proof captured on one surface (e.g. the WebSocket upgrade) from being
 * replayed against another (e.g. the HTTP heartbeat).
 */
export const NODE_LINK_PROOF_AUDIENCES = [
  'relay:node-link:v1',
  'relay:node-heartbeat:v1',
] as const;
export type NodeLinkProofAudience = (typeof NODE_LINK_PROOF_AUDIENCES)[number];

/**
 * Default proof freshness window. A proof's `iat` must be within ±window of
 * the verifier clock. Wide enough to tolerate modest clock skew, narrow
 * enough to bound the replay-cache memory and the capture-replay surface.
 */
export const DEFAULT_NODE_LINK_PROOF_FRESHNESS_MS = 5 * 60 * 1000;

export interface NodeIdentityKeyPair {
  algorithm: NodeIdentityKeyAlgorithm;
  /** SPKI PEM. Safe to send to the hub. */
  publicKeyPem: string;
  /** PKCS8 PEM. Stays on the node (file mode 0600); never sent or logged. */
  privateKeyPem: string;
  /** `nkey_<base64url(sha256(DER SPKI))>`. Stable, public, log-safe. */
  publicKeyFingerprint: string;
}

export interface NodeLinkProofHeader {
  typ: typeof NODE_LINK_PROOF_TYP;
  alg: NodeIdentityKeyAlgorithm;
  /** Public-key fingerprint the node claims to be proving possession of. */
  fpr: string;
}

export interface NodeLinkProofPayload {
  nodeId: string;
  credentialId: string;
  aud: NodeLinkProofAudience;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Single-use nonce; the verifier rejects a repeated jti within the window. */
  jti: string;
}

export type NodeLinkProofFailureReason =
  | 'NODE_LINK_PROOF_MALFORMED'
  | 'NODE_LINK_PROOF_UNSUPPORTED_ALG'
  | 'NODE_LINK_PROOF_FINGERPRINT_MISMATCH'
  | 'NODE_LINK_PROOF_NODE_MISMATCH'
  | 'NODE_LINK_PROOF_CREDENTIAL_MISMATCH'
  | 'NODE_LINK_PROOF_AUDIENCE_MISMATCH'
  | 'NODE_LINK_PROOF_STALE'
  | 'NODE_LINK_PROOF_SIGNATURE_INVALID';

export interface CreateNodeLinkProofInput {
  privateKeyPem: string;
  publicKeyFingerprint: string;
  nodeId: string;
  credentialId: string;
  audience: NodeLinkProofAudience;
  /** Injected for determinism in tests; production passes `Date.now()`. */
  nowMs: number;
  /** Injected for determinism in tests; production omits to get a random jti. */
  jti?: string;
}

export interface VerifyNodeLinkProofInput {
  proof: string;
  /** The credential-bound public key (SPKI PEM) to verify the signature against. */
  publicKeyPem: string;
  expected: {
    nodeId: string;
    credentialId: string;
    audience: NodeLinkProofAudience;
    publicKeyFingerprint: string;
  };
  nowMs: number;
  freshnessMs?: number;
}

export type VerifyNodeLinkProofResult =
  | { ok: true; jti: string; issuedAtMs: number }
  | { ok: false; reason: NodeLinkProofFailureReason };

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function spkiDerFromPem(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  // Only ed25519 keys can ever produce a verifiable proof (the proof signs and
  // verifies with `crypto.sign/verify(null, …)`, ed25519/ed448 only). Reject
  // any other key type here so a non-ed25519 key fails CLOSED to bearer-only at
  // pairing/rotation rather than being bound with a mislabeled algorithm and
  // then locked out of every future handshake.
  if (key.asymmetricKeyType !== NODE_IDENTITY_KEY_ALGORITHM) {
    throw new Error(
      `unsupported node identity key type: ${key.asymmetricKeyType ?? 'unknown'}`
    );
  }
  return key.export({ type: 'spki', format: 'der' });
}

/**
 * Stable, public fingerprint of an SPKI public key. Independent of PEM
 * whitespace/encoding because it hashes the canonical DER bytes.
 * Throws if the PEM is not a usable public key.
 */
export function nodePublicKeyFingerprint(publicKeyPem: string): string {
  const der = spkiDerFromPem(publicKeyPem);
  const digest = crypto.createHash('sha256').update(der).digest('base64url');
  return `${NODE_PUBLIC_KEY_FINGERPRINT_PREFIX}${digest}`;
}

/** Validate a PEM and return its canonical fingerprint, or null if unusable. */
export function safeNodePublicKeyFingerprint(
  publicKeyPem: unknown
): string | null {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) {
    return null;
  }
  try {
    return nodePublicKeyFingerprint(publicKeyPem);
  } catch {
    return null;
  }
}

export function generateNodeIdentityKeyPair(): NodeIdentityKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const privateKeyPem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  return {
    algorithm: NODE_IDENTITY_KEY_ALGORITHM,
    publicKeyPem,
    privateKeyPem,
    publicKeyFingerprint: nodePublicKeyFingerprint(publicKeyPem),
  };
}

/**
 * #981: confirm a private key parses as ed25519 AND corresponds to the given
 * public key, by deriving the public key from the private key and comparing the
 * canonical SPKI DER. Returns false on any error (corrupt key, wrong type,
 * mismatched pair). Used before reusing a persisted identity key so a
 * corrupt/mismatched key regenerates instead of binding a public key the node
 * cannot prove possession of.
 */
export function nodeIdentityKeyPairMatches(
  privateKeyPem: string,
  publicKeyPem: string
): boolean {
  try {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== NODE_IDENTITY_KEY_ALGORITHM) {
      return false;
    }
    const derived = crypto
      .createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' });
    const declared = spkiDerFromPem(publicKeyPem);
    return (
      derived.length === declared.length &&
      crypto.timingSafeEqual(derived, declared)
    );
  } catch {
    return false;
  }
}

/**
 * #981: validate persisted node identity key material into a usable key pair, or
 * null if anything is wrong (missing/typed fields, non-ed25519, unusable public
 * key, or a private key that does not match the public key). Pure — the disk
 * read lives in the caller so this is unit-testable.
 */
export function parseStoredNodeIdentityKey(
  raw: unknown
): NodeIdentityKeyPair | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const { privateKeyPem, publicKeyPem } = record;
  if (typeof privateKeyPem !== 'string' || typeof publicKeyPem !== 'string') {
    return null;
  }
  const fingerprint = safeNodePublicKeyFingerprint(publicKeyPem);
  if (!fingerprint) return null;
  if (!nodeIdentityKeyPairMatches(privateKeyPem, publicKeyPem)) return null;
  return {
    algorithm: NODE_IDENTITY_KEY_ALGORITHM,
    privateKeyPem,
    publicKeyPem,
    publicKeyFingerprint: fingerprint,
  };
}

function isNodeLinkProofAudience(value: unknown): value is NodeLinkProofAudience {
  return (
    typeof value === 'string' &&
    (NODE_LINK_PROOF_AUDIENCES as readonly string[]).includes(value)
  );
}

export function createNodeLinkProof(input: CreateNodeLinkProofInput): string {
  if (!isNodeLinkProofAudience(input.audience)) {
    throw new Error(`unsupported node-link proof audience: ${input.audience}`);
  }
  const header: NodeLinkProofHeader = {
    typ: NODE_LINK_PROOF_TYP,
    alg: NODE_IDENTITY_KEY_ALGORITHM,
    fpr: input.publicKeyFingerprint,
  };
  const payload: NodeLinkProofPayload = {
    nodeId: input.nodeId,
    credentialId: input.credentialId,
    aud: input.audience,
    iat: Math.floor(input.nowMs / 1000),
    jti: input.jti ?? crypto.randomBytes(16).toString('base64url'),
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload)
  )}`;
  const signature = crypto.sign(
    null,
    Buffer.from(signingInput),
    crypto.createPrivateKey(input.privateKeyPem)
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function parseProofSegment(segment: string | undefined): unknown {
  if (!segment) return undefined;
  try {
    return JSON.parse(base64UrlDecode(segment).toString('utf8'));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Verify a node-link proof against a bound public key and the expected
 * connection target. Fails closed with a typed reason for every failure
 * mode. Signature verification is the security gate; the structural and
 * binding checks short-circuit before it to produce precise reasons.
 *
 * Replay (single-use jti) is NOT enforced here — the caller owns the
 * per-credential jti cache so it can scope replay state to the registry
 * lifecycle. On success this returns the verified `jti` and `issuedAtMs`
 * for that caller to record.
 */
export function verifyNodeLinkProof(
  input: VerifyNodeLinkProofInput
): VerifyNodeLinkProofResult {
  const freshnessMs = input.freshnessMs ?? DEFAULT_NODE_LINK_PROOF_FRESHNESS_MS;
  const parts = input.proof.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: 'NODE_LINK_PROOF_MALFORMED' };
  }
  const header = asRecord(parseProofSegment(parts[0]));
  const payload = asRecord(parseProofSegment(parts[1]));
  if (!header || !payload) {
    return { ok: false, reason: 'NODE_LINK_PROOF_MALFORMED' };
  }
  if (header['typ'] !== NODE_LINK_PROOF_TYP) {
    return { ok: false, reason: 'NODE_LINK_PROOF_MALFORMED' };
  }
  if (header['alg'] !== NODE_IDENTITY_KEY_ALGORITHM) {
    return { ok: false, reason: 'NODE_LINK_PROOF_UNSUPPORTED_ALG' };
  }
  if (
    typeof header['fpr'] !== 'string' ||
    header['fpr'] !== input.expected.publicKeyFingerprint
  ) {
    return { ok: false, reason: 'NODE_LINK_PROOF_FINGERPRINT_MISMATCH' };
  }
  if (payload['nodeId'] !== input.expected.nodeId) {
    return { ok: false, reason: 'NODE_LINK_PROOF_NODE_MISMATCH' };
  }
  if (payload['credentialId'] !== input.expected.credentialId) {
    return { ok: false, reason: 'NODE_LINK_PROOF_CREDENTIAL_MISMATCH' };
  }
  if (
    !isNodeLinkProofAudience(payload['aud']) ||
    payload['aud'] !== input.expected.audience
  ) {
    return { ok: false, reason: 'NODE_LINK_PROOF_AUDIENCE_MISMATCH' };
  }
  const iat = payload['iat'];
  const jti = payload['jti'];
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    return { ok: false, reason: 'NODE_LINK_PROOF_MALFORMED' };
  }
  if (typeof jti !== 'string' || jti.length === 0) {
    return { ok: false, reason: 'NODE_LINK_PROOF_MALFORMED' };
  }
  const issuedAtMs = iat * 1000;
  if (Math.abs(input.nowMs - issuedAtMs) > freshnessMs) {
    return { ok: false, reason: 'NODE_LINK_PROOF_STALE' };
  }
  // The bound public key must actually match the claimed fingerprint, and the
  // detached signature must verify over the exact signing input. Either failing
  // (or any malformed-key throw) is an unforgeable-possession failure.
  try {
    const boundFingerprint = nodePublicKeyFingerprint(input.publicKeyPem);
    if (boundFingerprint !== input.expected.publicKeyFingerprint) {
      return { ok: false, reason: 'NODE_LINK_PROOF_FINGERPRINT_MISMATCH' };
    }
    const signatureValid = crypto.verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey(input.publicKeyPem),
      base64UrlDecode(parts[2]!)
    );
    if (!signatureValid) {
      return { ok: false, reason: 'NODE_LINK_PROOF_SIGNATURE_INVALID' };
    }
  } catch {
    return { ok: false, reason: 'NODE_LINK_PROOF_SIGNATURE_INVALID' };
  }
  return { ok: true, jti, issuedAtMs };
}

const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*?(?:PRIVATE|PUBLIC) KEY-----[\s\S]*?-----END [A-Z0-9 ]*?(?:PRIVATE|PUBLIC) KEY-----/g;
const SECRET_FRAGMENT_RE = /\bsecret_[A-Za-z0-9_-]+/g;

/**
 * Scrub node identity key material from a string before it reaches a log,
 * diagnostic, audit payload, or error message. Removes PEM key blocks and
 * `secret_…` credential fragments. Public fingerprints (`nkey_…`) are left
 * intact — they are stable, public correlation handles by design.
 */
export function redactNodeIdentityMaterial(text: string): string {
  return text
    .replace(PEM_BLOCK_RE, '[redacted-key]')
    .replace(SECRET_FRAGMENT_RE, 'secret_…redacted');
}
