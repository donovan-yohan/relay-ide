import {
  AGENT_ROLES,
  deriveRosterAttention,
  roleForAgent,
  type AgentRole,
  type RosterAttention,
  type RosterEntry,
  type SelfDeclaredPresence,
} from './agent-roster.js';

// Explicit active-agent presence overlay (#964, child of #953). A presence
// record is SELF-DECLARED, redaction-safe metadata an agent registers about
// itself for the session / repo / WorkContext it is working in. It is MERGED
// into the derived roster (`agent-roster.ts`) so non-Relay-launched agents and
// richer role/status/use-case surface for cross-agent discovery — without the
// roster trusting any user-supplied payload.
//
// Hard rules (same boundary as `RosterEntry`):
//   - NEVER carries secrets, tokens, env, transcript text, prompts, raw PTY
//     bytes, provider-private state, or arbitrary payloads. Every field is
//     sanitized + length-bounded by {@link sanitizePresenceInput}.
//   - DERIVED session fields always WIN on merge for identity / control /
//     security (sessionId, globalSessionId, nodeId, provider, controlMode,
//     status, agentState, activeActors). Self-declaration only overlays the
//     soft collaboration subset (role, displayName, use-case, status text,
//     attention hint, capability hints).
//   - Presence is non-authoritative discovery metadata, never an authorization
//     input. The real audit trail is the CLI-gateway actor credential.
//
// Keep this module free of `server/` imports so the contract/tests can reuse it
// without pulling the runtime (mirrors `agent-roster.ts`).

/** Default heartbeat TTL (seconds) before an unrefreshed presence goes stale. */
export const PRESENCE_DEFAULT_TTL_SECONDS = 120;
/** Clamp bounds for a caller-supplied `ttlSeconds`. */
export const PRESENCE_MIN_TTL_SECONDS = 10;
export const PRESENCE_MAX_TTL_SECONDS = 3600;

export const PRESENCE_MAX_DISPLAY_NAME_LEN = 120;
export const PRESENCE_MAX_USE_CASE_LEN = 200;
export const PRESENCE_MAX_STATUS_TEXT_LEN = 200;
export const PRESENCE_MAX_CAPABILITY_HINTS = 16;
export const PRESENCE_MAX_CAPABILITY_HINT_LEN = 40;

/**
 * Keys an agent must never be able to smuggle into presence metadata. Presence
 * is broadcast for discovery, so anything resembling a secret / raw transcript /
 * provider-private payload is hard-rejected rather than silently dropped, so the
 * caller learns its request was unsafe.
 */
export const PRESENCE_UNSAFE_KEYS: readonly string[] = [
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passphrase',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'env',
  'environment',
  'transcript',
  'prompt',
  'systemprompt',
  'payload',
  'raw',
  'bytes',
  'cookie',
  'privatekey',
];

const PRESENCE_SAFE_KEYS: readonly string[] = [
  'id',
  'sessionId',
  'globalSessionId',
  'workContextId',
  'repoPath',
  'nodeId',
  'provider',
  'role',
  'displayName',
  'useCase',
  'statusText',
  'needsAttention',
  'capabilityHints',
  'ttlSeconds',
  'createdBy',
  'registeredBy',
];

/**
 * Stored, self-declared presence record. Addressing fields (`sessionId`, …) are
 * self-claimed and used only to JOIN against the derived roster — they are NOT
 * trusted for any security decision.
 */
export interface AgentPresence {
  /** Server-minted (or stably-derived) presence id, `pres:<hex>`. */
  id: string;
  sessionId?: string;
  globalSessionId?: string;
  workContextId?: string;
  repoPath?: string;
  nodeId?: string;
  /** Self-claimed agent kind/framework id (drives role for self-declared-only entries). */
  provider?: string;
  role?: AgentRole;
  displayName?: string;
  /** Free-text role/use-case hint (e.g. "implementing #964"). */
  useCase?: string;
  /** Self-declared coarse status (e.g. "running tests"). */
  statusText?: string;
  /** Self-declared "I need attention" hint (additive to derived attention). */
  needsAttention?: boolean;
  /** Sanitized capability hint tokens, merged (union) into derived capabilities. */
  capabilityHints?: string[];
  /** Actor that registered/updated this presence (audit attribution). */
  registeredBy: string;
  createdAt: string;
  updatedAt: string;
  /** Heartbeat expiry; the store + merge drop records past this instant. */
  expiresAt: string;
}

/** Sanitized, store-ready presence fields (no id/timestamps/registeredBy). */
export interface SanitizedPresenceFields {
  sessionId?: string;
  globalSessionId?: string;
  workContextId?: string;
  repoPath?: string;
  nodeId?: string;
  provider?: string;
  role?: AgentRole;
  displayName?: string;
  useCase?: string;
  statusText?: string;
  needsAttention?: boolean;
  capabilityHints?: string[];
  ttlSeconds?: number;
}

export class PresenceValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PresenceValidationError';
    this.code = code;
  }
}

// C0 + C1 control chars (incl. NUL/DEL). Built via RegExp() so no literal
// control bytes live in source (keeps the file ASCII-clean). Stripping control
// chars is the whole point here, so the no-control-regex rule is intentional.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

/** Strip C0/C1 control chars (incl. NUL), collapse runs of whitespace, trim. */
function redactText(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = redactText(value).slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Identifier-ish addressing field: trimmed, ctrl-stripped, length-bounded. */
function sanitizeIdentifier(value: unknown, maxLen = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = redactText(value).slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeCapabilityHints(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const token = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]/g, '')
      .slice(0, PRESENCE_MAX_CAPABILITY_HINT_LEN);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= PRESENCE_MAX_CAPABILITY_HINTS) break;
  }
  return out.length > 0 ? out : [];
}

export function isAgentRole(value: unknown): value is AgentRole {
  return (
    typeof value === 'string' &&
    (AGENT_ROLES as readonly string[]).includes(value)
  );
}

function clampTtlSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PresenceValidationError(
      'presence_invalid_ttl',
      'ttlSeconds must be a finite number'
    );
  }
  return Math.min(
    PRESENCE_MAX_TTL_SECONDS,
    Math.max(PRESENCE_MIN_TTL_SECONDS, Math.trunc(value))
  );
}

/**
 * Validate + sanitize a raw register/update-self body into store-ready fields.
 *
 * Security boundary (defense in depth alongside the contract's
 * `additionalProperties: false` schema):
 *   - Any key matching {@link PRESENCE_UNSAFE_KEYS} → hard reject (the caller
 *     learns it tried to broadcast a secret-shaped field).
 *   - Any other unknown key → dropped (forward-compatible), surfaced in
 *     `droppedKeys` for observability.
 *   - `role` present but not a known {@link AgentRole} → hard reject.
 *   - Text fields are ctrl-stripped + length-bounded (redaction, never reject).
 *   - `capabilityHints` normalized to a bounded set of safe tokens.
 */
export function sanitizePresenceInput(raw: unknown): {
  fields: SanitizedPresenceFields;
  droppedKeys: string[];
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PresenceValidationError(
      'presence_invalid_body',
      'presence input must be an object'
    );
  }
  const input = raw as Record<string, unknown>;
  const droppedKeys: string[] = [];
  const unsafeLower = new Set(PRESENCE_UNSAFE_KEYS.map((k) => k.toLowerCase()));
  const safeLower = new Set(PRESENCE_SAFE_KEYS.map((k) => k.toLowerCase()));

  for (const key of Object.keys(input)) {
    const lower = key.toLowerCase();
    if (unsafeLower.has(lower)) {
      throw new PresenceValidationError(
        'presence_unsafe_field',
        `presence metadata may not include the field "${key}"`
      );
    }
    if (!safeLower.has(lower)) droppedKeys.push(key);
  }

  if (input['role'] !== undefined && !isAgentRole(input['role'])) {
    throw new PresenceValidationError(
      'presence_invalid_role',
      `role must be one of: ${AGENT_ROLES.join(', ')}`
    );
  }

  const fields: SanitizedPresenceFields = {};
  const sessionId = sanitizeIdentifier(input['sessionId']);
  if (sessionId) fields.sessionId = sessionId;
  const globalSessionId = sanitizeIdentifier(input['globalSessionId']);
  if (globalSessionId) fields.globalSessionId = globalSessionId;
  const workContextId = sanitizeIdentifier(input['workContextId']);
  if (workContextId) fields.workContextId = workContextId;
  const repoPath = sanitizeIdentifier(input['repoPath'], 1024);
  if (repoPath) fields.repoPath = repoPath;
  const nodeId = sanitizeIdentifier(input['nodeId']);
  if (nodeId) fields.nodeId = nodeId;
  const provider = sanitizeIdentifier(input['provider'], 80);
  if (provider) fields.provider = provider;
  if (isAgentRole(input['role'])) fields.role = input['role'];
  const displayName = sanitizeText(
    input['displayName'],
    PRESENCE_MAX_DISPLAY_NAME_LEN
  );
  if (displayName) fields.displayName = displayName;
  const useCase = sanitizeText(input['useCase'], PRESENCE_MAX_USE_CASE_LEN);
  if (useCase) fields.useCase = useCase;
  const statusText = sanitizeText(
    input['statusText'],
    PRESENCE_MAX_STATUS_TEXT_LEN
  );
  if (statusText) fields.statusText = statusText;
  if (typeof input['needsAttention'] === 'boolean') {
    fields.needsAttention = input['needsAttention'];
  }
  const capabilityHints = sanitizeCapabilityHints(input['capabilityHints']);
  if (capabilityHints) fields.capabilityHints = capabilityHints;
  const ttlSeconds = clampTtlSeconds(input['ttlSeconds']);
  if (ttlSeconds !== undefined) fields.ttlSeconds = ttlSeconds;

  return { fields, droppedKeys };
}

/** True when `presence.expiresAt` is at or before `now` (stale, drop it). */
export function isPresenceExpired(presence: AgentPresence, now: Date): boolean {
  const expires = Date.parse(presence.expiresAt);
  if (!Number.isFinite(expires)) return true;
  return expires <= now.getTime();
}

function selfDeclaredOf(presence: AgentPresence): SelfDeclaredPresence {
  return {
    presenceId: presence.id,
    ...(presence.registeredBy ? { registeredBy: presence.registeredBy } : {}),
    ...(presence.role ? { role: presence.role } : {}),
    ...(presence.displayName ? { displayName: presence.displayName } : {}),
    ...(presence.useCase ? { useCase: presence.useCase } : {}),
    ...(presence.statusText ? { statusText: presence.statusText } : {}),
    ...(presence.needsAttention !== undefined
      ? { needsAttention: presence.needsAttention }
      : {}),
    ...(presence.capabilityHints && presence.capabilityHints.length > 0
      ? { capabilityHints: [...presence.capabilityHints] }
      : {}),
    updatedAt: presence.updatedAt,
    expiresAt: presence.expiresAt,
  };
}

function unionCapabilities(
  base: readonly string[],
  hints: readonly string[] | undefined
): string[] {
  if (!hints || hints.length === 0) return [...base];
  const seen = new Set(base);
  const out = [...base];
  for (const hint of hints) {
    if (!seen.has(hint)) {
      seen.add(hint);
      out.push(hint);
    }
  }
  return out;
}

/**
 * Fold an explicit self-declared attention hint into a derived attention shape.
 * Additive: a derived `needsAttention` can NEVER be cleared by self-declaration,
 * and the synthetic `self-declared` reason keeps `reasons.length > 0` whenever
 * `needsAttention` is true (the {@link deriveRosterAttention} invariant).
 */
function withSelfDeclaredAttention(
  derived: RosterAttention,
  selfNeedsAttention: boolean | undefined
): RosterAttention {
  if (!selfNeedsAttention) return derived;
  const reasons = derived.reasons.includes('self-declared')
    ? derived.reasons
    : [...derived.reasons, 'self-declared' as const];
  return {
    needsAttention: true,
    reasons,
    pendingInboxCount: derived.pendingInboxCount,
  };
}

/**
 * Merge the derived roster with explicit presence records. Pure + deterministic
 * (caller injects `now`). Precedence:
 *   - A presence record matching a derived session (by globalSessionId, else
 *     sessionId) OVERLAYS only soft fields (role, displayName, capability hints,
 *     attention hint) and attaches `selfDeclared`; `origin: 'merged'`. All
 *     identity/control/security fields stay derived.
 *   - A presence record with no matching session is SYNTHESIZED as an
 *     `origin: 'self-declared'` entry so external/non-Relay agents appear.
 *   - Expired presence records are dropped.
 */
export function mergeRosterWithPresence(
  derived: readonly RosterEntry[],
  presence: readonly AgentPresence[],
  opts: { now: Date; roleOverrides?: Readonly<Record<string, AgentRole>> }
): RosterEntry[] {
  const live = presence.filter((p) => !isPresenceExpired(p, opts.now));

  // Index live presence by both session keys for the join. Most-recently
  // updated wins when two records collide on a key.
  const byKey = new Map<string, AgentPresence>();
  const ranked = [...live].sort((a, b) =>
    (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '')
  );
  for (const p of ranked) {
    if (p.globalSessionId) byKey.set(`g:${p.globalSessionId}`, p);
    if (p.sessionId) byKey.set(`s:${p.sessionId}`, p);
  }

  const consumed = new Set<string>();
  const merged: RosterEntry[] = derived.map((entry) => {
    const match =
      (entry.globalSessionId && byKey.get(`g:${entry.globalSessionId}`)) ||
      byKey.get(`s:${entry.sessionId}`) ||
      undefined;
    if (!match) return entry;
    consumed.add(match.id);
    return {
      ...entry,
      role: match.role ?? entry.role,
      displayName: match.displayName ?? entry.displayName,
      capabilities: unionCapabilities(
        entry.capabilities,
        match.capabilityHints
      ),
      attention: withSelfDeclaredAttention(
        entry.attention,
        match.needsAttention
      ),
      origin: 'merged',
      selfDeclared: selfDeclaredOf(match),
    };
  });

  for (const p of live) {
    if (consumed.has(p.id)) continue;
    const provider = (p.provider ?? '').trim();
    const sessionId = p.sessionId ?? p.globalSessionId ?? p.id;
    const baseAttention = deriveRosterAttention({ pendingInboxCount: 0 });
    const entry: RosterEntry = {
      sessionId,
      ...(p.globalSessionId ? { globalSessionId: p.globalSessionId } : {}),
      ...(p.nodeId ? { nodeId: p.nodeId } : {}),
      provider,
      sessionType: 'agent',
      role: p.role ?? roleForAgent(provider, opts.roleOverrides),
      displayName: p.displayName ?? sessionId,
      ...(p.repoPath ? { repoPath: p.repoPath } : {}),
      ...(p.workContextId ? { workContextId: p.workContextId } : {}),
      attention: withSelfDeclaredAttention(baseAttention, p.needsAttention),
      capabilities: [...(p.capabilityHints ?? [])],
      lastActivity: p.updatedAt,
      origin: 'self-declared',
      selfDeclared: selfDeclaredOf(p),
    };
    merged.push(entry);
  }

  return merged;
}
