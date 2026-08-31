import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type {
  AgentProfileAvatarRef,
  AgentProfileRespondTo,
} from '../shared/agent-profile.js';
import {
  isValidHermesApiKey,
  isValidHermesProfile,
} from '../shared/agent-profile.js';
import { providerDescriptor } from './protocol-adapters/index.js';
import {
  authenticatedCliGatewayActorCredential,
  isLocalHubCliActorCredential,
  type CliGatewayActorCommand,
} from './cli-gateway-actor-auth.js';
import {
  AgentProfileStoreError,
  type AgentProfileCreateInput,
  type AgentProfileStore,
  type AgentProfileUpdateInput,
  type SeedFramework,
} from './agent-profile-store.js';

/**
 * Builds the auth middleware for one gateway verb. `server/index.ts` passes
 * `requireCliGatewayAuthForActorCommand`, which admits a scoped actor token
 * carrying the verb's capability bit and otherwise falls back to the
 * browser/operator lane.
 */
export type AgentProfileActorAuthFactory = (
  command: CliGatewayActorCommand
) => RequestHandler;

/** Browser/operator CRUD for the local AgentProfile overlay (#1232 slice 7). */
export interface AgentProfileRouterDeps {
  store: AgentProfileStore | null;
  /** The live framework catalog, already resolved from the current config. */
  listConfiguredFrameworks: () => readonly SeedFramework[];
  requireAuth?: RequestHandler;
  /**
   * #1473: CLI-gateway lane for the four `agent-profiles.*` verbs. Omitted in
   * unit fixtures, where the routes fall back to `requireAuth`.
   */
  requireGatewayAuthForCommand?: AgentProfileActorAuthFactory;
}

const RESPOND_TO_VALUES: readonly AgentProfileRespondTo[] = [
  'owner-only',
  'allowlist',
  'anyone',
];
const PATCH_FIELDS = new Set([
  'providerId',
  'displayName',
  'avatar',
  'systemPrompt',
  'model',
  'provider',
  'effort',
  'envVars',
  'hermesProfile',
  'hermesApiKey',
  'namePool',
  'respondTo',
  'respondToAllowlist',
  'isDefault',
]);

function bodyRecord(req: Request): Record<string, unknown> | null {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : null;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sendError(
  res: Response,
  status: number,
  reasonCode: string,
  message: string,
  details?: Record<string, unknown>
): void {
  res.status(status).json({
    error: {
      code:
        status === 403
          ? 'FORBIDDEN'
          : status === 404
            ? 'NOT_FOUND'
            : status === 409
              ? 'SESSION_CONFLICT'
              : status >= 500
                ? 'SERVER_UNAVAILABLE'
                : 'INVALID_ARGUMENT',
      message,
      retryable: status >= 500,
      details: { reasonCode, ...(details ?? {}) },
    },
  });
}

function storeOr503(
  res: Response,
  store: AgentProfileStore | null
): AgentProfileStore | null {
  if (store) return store;
  sendError(
    res,
    503,
    'AGENT_PROFILE_STORE_UNAVAILABLE',
    'agent profile store is unavailable'
  );
  return null;
}

function configuredFrameworksOr503(
  res: Response,
  listConfiguredFrameworks: () => readonly SeedFramework[]
): readonly SeedFramework[] | null {
  try {
    return listConfiguredFrameworks();
  } catch {
    // Custom framework resolution can throw for hand-edited, malformed config.
    // Keep that startup/catalog failure out of Express's generic error path.
    sendError(
      res,
      503,
      'AGENT_PROFILE_FRAMEWORK_CATALOG_UNAVAILABLE',
      'configured framework catalog is unavailable'
    );
    return null;
  }
}

/**
 * A framework can be added to live config after the store's boot seed. Before
 * exposing or accepting that framework, repair its required built-in default
 * so no browser operation can introduce a zero-default provider.
 */
function configuredAndSeededFrameworksOr503(
  res: Response,
  store: AgentProfileStore,
  listConfiguredFrameworks: () => readonly SeedFramework[]
): readonly SeedFramework[] | null {
  const frameworks = configuredFrameworksOr503(res, listConfiguredFrameworks);
  if (!frameworks) return null;
  try {
    store.seedBuiltIns(frameworks);
    return frameworks;
  } catch {
    sendError(
      res,
      503,
      'AGENT_PROFILE_BUILT_IN_SEED_FAILED',
      'agent profile built-in defaults could not be initialized'
    );
    return null;
  }
}

function requireConfiguredProvider(
  res: Response,
  providerId: unknown,
  frameworks: readonly SeedFramework[]
): string | null {
  const value = trimString(providerId);
  if (!value) {
    sendError(
      res,
      400,
      'AGENT_PROFILE_PROVIDER_ID_REQUIRED',
      'providerId is required',
      { field: 'providerId' }
    );
    return null;
  }
  if (!frameworks.some((framework) => framework.id === value)) {
    sendError(
      res,
      400,
      'AGENT_PROFILE_PROVIDER_NOT_CONFIGURED',
      'providerId must name a configured framework',
      { field: 'providerId' }
    );
    return null;
  }
  return value;
}

function validateAvatar(
  value: unknown
): AgentProfileAvatarRef | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const id = trimString(record['id']);
  if (!id) return undefined;
  const avatar: AgentProfileAvatarRef = { id };
  if (typeof record['sha256'] === 'string') avatar.sha256 = record['sha256'];
  if (typeof record['mediaType'] === 'string')
    avatar.mediaType = record['mediaType'];
  if (typeof record['byteCount'] === 'number')
    avatar.byteCount = record['byteCount'];
  return avatar;
}

function validateStringRecord(
  value: unknown
): Record<string, string> | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') return undefined;
    result[key] = entry;
  }
  return result;
}

function validateStringList(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => !trimString(entry))) {
    return undefined;
  }
  return value.map((entry) => (entry as string).trim());
}

function validateOptionalString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function invalidField(
  res: Response,
  field: string,
  message = 'invalid agent profile field'
): null {
  sendError(res, 400, 'AGENT_PROFILE_INVALID_FIELD', message, { field });
  return null;
}

/**
 * Converts a browser PATCH body into a typed store patch. Explicit `null`
 * clears optional overlays; an empty `displayName` restores the catalog-label
 * inheritance sentinel; omitted fields are never inspected or changed.
 */
function parsePatch(
  res: Response,
  body: Record<string, unknown>,
  frameworks: readonly SeedFramework[]
): AgentProfileUpdateInput | null {
  for (const field of Object.keys(body)) {
    if (field === 'isBuiltIn') {
      sendError(
        res,
        400,
        'AGENT_PROFILE_IS_BUILT_IN_MANAGED',
        'isBuiltIn is managed by the server',
        { field }
      );
      return null;
    }
    if (!PATCH_FIELDS.has(field)) {
      sendError(
        res,
        400,
        'AGENT_PROFILE_PATCH_FIELD_UNSUPPORTED',
        'unsupported agent profile patch field',
        { field }
      );
      return null;
    }
  }
  if (Object.keys(body).length === 0) {
    sendError(res, 400, 'AGENT_PROFILE_PATCH_EMPTY', 'patch body is empty');
    return null;
  }
  const patch: AgentProfileUpdateInput = {};
  if (hasOwn(body, 'providerId')) {
    const providerId = requireConfiguredProvider(
      res,
      body['providerId'],
      frameworks
    );
    if (!providerId) return null;
    patch.providerId = providerId;
  }
  if (hasOwn(body, 'displayName')) {
    if (typeof body['displayName'] !== 'string') {
      return invalidField(res, 'displayName');
    }
    patch.displayName = body['displayName'].trim();
  }
  if (hasOwn(body, 'avatar')) {
    const avatar = validateAvatar(body['avatar']);
    if (avatar === undefined) return invalidField(res, 'avatar');
    patch.avatar = avatar;
  }
  for (const field of [
    'systemPrompt',
    'model',
    'provider',
    'effort',
  ] as const) {
    if (!hasOwn(body, field)) continue;
    const value = validateOptionalString(body[field]);
    if (value === undefined) return invalidField(res, field);
    patch[field] = value;
  }
  if (hasOwn(body, 'envVars')) {
    const envVars = validateStringRecord(body['envVars']);
    if (envVars === undefined) return invalidField(res, 'envVars');
    patch.envVars = envVars;
  }
  if (hasOwn(body, 'hermesProfile')) {
    // Free-form operator-typed id (Relay does not know the Hermes roster), but
    // it lands in a URL path segment, so the shape is validated here as well as
    // in the store guard. `null` clears the binding.
    const hermesProfile = body['hermesProfile'];
    if (hermesProfile !== null && !isValidHermesProfile(hermesProfile)) {
      return invalidField(res, 'hermesProfile');
    }
    patch.hermesProfile = hermesProfile as string | null;
  }
  if (hasOwn(body, 'hermesApiKey')) {
    // WRITE-ONLY. The key is stored in its own column and never comes back on
    // any response; `null` clears it and an omitted field leaves it untouched.
    // The rejection names the FIELD only — echoing the rejected value would put
    // a secret in an HTTP body and in whatever logs that body.
    const hermesApiKey = body['hermesApiKey'];
    if (hermesApiKey !== null && !isValidHermesApiKey(hermesApiKey)) {
      return invalidField(res, 'hermesApiKey', 'invalid agent profile field');
    }
    patch.hermesApiKey = hermesApiKey as string | null;
  }
  if (hasOwn(body, 'namePool')) {
    const namePool = validateStringList(body['namePool']);
    if (namePool === undefined) return invalidField(res, 'namePool');
    patch.namePool = namePool;
  }
  if (hasOwn(body, 'respondTo')) {
    const respondTo = body['respondTo'];
    if (
      respondTo !== null &&
      (typeof respondTo !== 'string' ||
        !RESPOND_TO_VALUES.includes(respondTo as AgentProfileRespondTo))
    ) {
      return invalidField(res, 'respondTo');
    }
    patch.respondTo = respondTo as AgentProfileRespondTo | null;
  }
  if (hasOwn(body, 'respondToAllowlist')) {
    const allowlist = validateStringList(body['respondToAllowlist']);
    if (allowlist === undefined) return invalidField(res, 'respondToAllowlist');
    patch.respondToAllowlist = allowlist;
  }
  if (hasOwn(body, 'isDefault')) {
    if (typeof body['isDefault'] !== 'boolean')
      return invalidField(res, 'isDefault');
    patch.isDefault = body['isDefault'];
  }
  return patch;
}

/**
 * A gateway secret is only meaningful for a provider whose descriptor declares
 * one (`agentProfileGatewaySecretKey`). Storing it anywhere else would leave
 * bearer material on a row that never forwards it AND that the editor cannot
 * show or clear — the key field renders only on the branch of the provider that
 * owns it. Clearing (`null`) stays allowed everywhere so an already-orphaned
 * row can still be emptied.
 *
 * Returns `false` when it has already answered with a 400.
 */
function gatewaySecretAllowedForProvider(
  res: Response,
  providerId: string,
  patch: AgentProfileUpdateInput
): boolean {
  if (typeof patch.hermesApiKey !== 'string') return true;
  if (providerDescriptor(providerId)?.agentProfileGatewaySecretKey) return true;
  sendError(
    res,
    400,
    'AGENT_PROFILE_GATEWAY_SECRET_UNSUPPORTED',
    'this provider does not use a gateway API key',
    { field: 'hermesApiKey' }
  );
  return false;
}

function mapStoreError(res: Response, error: unknown): void {
  if (error instanceof AgentProfileStoreError) {
    sendError(res, error.status, error.code.toUpperCase(), error.message);
    return;
  }
  sendError(
    res,
    500,
    'AGENT_PROFILE_OPERATION_FAILED',
    'agent profile operation failed'
  );
}

function createInputFromPatch(
  providerId: string,
  displayName: string,
  patch: AgentProfileUpdateInput
): AgentProfileCreateInput {
  const input: AgentProfileCreateInput = {
    providerId,
    displayName,
    isDefault: patch.isDefault ?? false,
  };
  if (patch.avatar !== undefined) input.avatar = patch.avatar;
  if (typeof patch.systemPrompt === 'string')
    input.systemPrompt = patch.systemPrompt;
  if (typeof patch.model === 'string') input.model = patch.model;
  if (typeof patch.provider === 'string') input.provider = patch.provider;
  if (typeof patch.effort === 'string') input.effort = patch.effort;
  if (patch.envVars) input.envVars = patch.envVars;
  if (typeof patch.hermesProfile === 'string')
    input.hermesProfile = patch.hermesProfile;
  if (typeof patch.hermesApiKey === 'string')
    input.hermesApiKey = patch.hermesApiKey;
  if (patch.namePool) input.namePool = patch.namePool;
  if (patch.respondTo) input.respondTo = patch.respondTo;
  if (patch.respondToAllowlist)
    input.respondToAllowlist = patch.respondToAllowlist;
  return input;
}

/**
 * #1473 privilege boundary for the gateway lane.
 *
 * Agent-profile writes mint identities and store a provider gateway credential,
 * so they are operator-grade: only the hub's OWN host-local trust token (#1467,
 * whose 0600 config-dir file already implies filesystem access as the hub uid)
 * and the browser/operator lane may run them. A DELEGATED scoped actor
 * credential — the kind handed to a bound agent runtime, which routinely
 * carries `context:write` for channel posts — is refused here, so widening the
 * capability map can never widen who may create or rebind a profile.
 *
 * Returns `true` when it has already answered with a 403.
 */
function denyDelegatedActorWrite(req: Request, res: Response): boolean {
  const credential = authenticatedCliGatewayActorCredential(req);
  // No actor credential attached means the browser/operator lane authenticated
  // this request; it keeps the authority it always had.
  if (!credential) return false;
  if (isLocalHubCliActorCredential(credential)) return false;
  sendError(
    res,
    403,
    'AGENT_PROFILE_HOST_LOCAL_REQUIRED',
    'agent profile writes require host-local operator authority'
  );
  return true;
}

export function createAgentProfileRouter(deps: AgentProfileRouterDeps): Router {
  const router = Router();
  const auth =
    deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const gatewayAuth = (command: CliGatewayActorCommand): RequestHandler =>
    deps.requireGatewayAuthForCommand?.(command) ?? auth;

  router.get(
    '/agent-profiles',
    gatewayAuth('agent-profiles.list'),
    (_req, res) => {
      const store = storeOr503(res, deps.store);
      if (!store) return;
      if (
        !configuredAndSeededFrameworksOr503(
          res,
          store,
          deps.listConfiguredFrameworks
        )
      )
        return;
      res.json({ profiles: store.list() });
    }
  );

  // #1473: `agent-profiles.get`. The list route already existed; a single-row
  // read did not, and the gateway verb needs one it can address by id.
  router.get(
    '/agent-profiles/:id',
    gatewayAuth('agent-profiles.get'),
    (req, res) => {
      const store = storeOr503(res, deps.store);
      if (!store) return;
      // Deliberately NOT `configuredAndSeededFrameworksOr503`: a single-row read
      // is a read. The list route heals a missing built-in default; making a
      // by-id GET write rows on behalf of a read-only caller would not.
      const profile = store.get(req.params['id'] ?? '');
      if (!profile) {
        return void sendError(
          res,
          404,
          'AGENT_PROFILE_NOT_FOUND',
          'agent profile not found'
        );
      }
      res.json({ profile });
    }
  );

  router.post(
    '/agent-profiles',
    gatewayAuth('agent-profiles.create'),
    (req, res) => {
      if (denyDelegatedActorWrite(req, res)) return;
      const store = storeOr503(res, deps.store);
      if (!store) return;
      const body = bodyRecord(req);
      if (!body)
        return void sendError(
          res,
          400,
          'AGENT_PROFILE_BODY_REQUIRED',
          'request body must be an object'
        );
      if (hasOwn(body, 'isBuiltIn')) {
        return void sendError(
          res,
          400,
          'AGENT_PROFILE_IS_BUILT_IN_MANAGED',
          'isBuiltIn is managed by the server',
          { field: 'isBuiltIn' }
        );
      }
      const frameworks = configuredAndSeededFrameworksOr503(
        res,
        store,
        deps.listConfiguredFrameworks
      );
      if (!frameworks) return;
      const providerId = requireConfiguredProvider(
        res,
        body['providerId'],
        frameworks
      );
      if (!providerId) return;
      const displayName = trimString(body['displayName']);
      if (!displayName) {
        return void sendError(
          res,
          400,
          'AGENT_PROFILE_DISPLAY_NAME_REQUIRED',
          'displayName is required',
          { field: 'displayName' }
        );
      }
      const patch = parsePatch(res, body, frameworks);
      if (!patch) return;
      if (!gatewaySecretAllowedForProvider(res, providerId, patch)) return;
      try {
        const profile = store.create(
          createInputFromPatch(providerId, displayName, patch)
        );
        res.status(201).json({ profile });
      } catch (error) {
        mapStoreError(res, error);
      }
    }
  );

  router.patch(
    '/agent-profiles/:id',
    gatewayAuth('agent-profiles.update'),
    (req, res) => {
      if (denyDelegatedActorWrite(req, res)) return;
      const store = storeOr503(res, deps.store);
      if (!store) return;
      const body = bodyRecord(req);
      if (!body)
        return void sendError(
          res,
          400,
          'AGENT_PROFILE_BODY_REQUIRED',
          'request body must be an object'
        );
      const existing = store.get(req.params['id'] ?? '');
      if (!existing)
        return void sendError(
          res,
          404,
          'AGENT_PROFILE_NOT_FOUND',
          'agent profile not found'
        );
      const frameworks = configuredAndSeededFrameworksOr503(
        res,
        store,
        deps.listConfiguredFrameworks
      );
      if (!frameworks) return;
      const patch = parsePatch(res, body, frameworks);
      if (!patch) return;
      if (
        !gatewaySecretAllowedForProvider(
          res,
          patch.providerId ?? existing.providerId,
          patch
        )
      ) {
        return;
      }
      if (
        existing.isBuiltIn &&
        hasOwn(patch, 'providerId') &&
        patch.providerId !== existing.providerId
      ) {
        return void sendError(
          res,
          400,
          'AGENT_PROFILE_BUILT_IN_PROVIDER_CHANGE_FORBIDDEN',
          'built-in profiles cannot change providerId',
          { field: 'providerId' }
        );
      }
      if (existing.isDefault && patch.isDefault === false) {
        return void sendError(
          res,
          409,
          'AGENT_PROFILE_LAST_DEFAULT',
          'a provider must retain a default profile',
          { field: 'isDefault' }
        );
      }
      if (
        existing.isDefault &&
        patch.providerId &&
        patch.providerId !== existing.providerId
      ) {
        return void sendError(
          res,
          409,
          'AGENT_PROFILE_DEFAULT_PROVIDER_CHANGE_FORBIDDEN',
          'move a non-default profile, or set another default first.',
          { field: 'providerId' }
        );
      }
      if (patch.providerId && patch.providerId !== existing.providerId) {
        // Model and effort semantics belong to the selected vendor. Never carry
        // those vendor-dependent overrides across a provider change.
        //
        // The gateway binding and its secret are cleared by the STORE on the same
        // condition (`agent-profile-store.ts` `update`/`applyProfilePatch`), so
        // the invariant sits beside the column it protects and holds for
        // non-HTTP callers too. Clearing them here as well would also clobber a
        // key supplied in this very patch — "move to hermes and set its key"
        // must be one save, not two.
        patch.model = null;
        patch.effort = null;
      }
      try {
        res.json({ profile: store.update(existing.id, patch) });
      } catch (error) {
        mapStoreError(res, error);
      }
    }
  );

  router.delete('/agent-profiles/:id', auth, (req, res) => {
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const profile = store.get(req.params['id'] ?? '');
    if (!profile)
      return void sendError(
        res,
        404,
        'AGENT_PROFILE_NOT_FOUND',
        'agent profile not found'
      );
    if (profile.isBuiltIn && profile.isDefault) {
      return void sendError(
        res,
        409,
        'AGENT_PROFILE_BUILT_IN_DEFAULT_DELETE_FORBIDDEN',
        'the built-in default profile cannot be deleted'
      );
    }
    if (profile.isDefault) {
      return void sendError(
        res,
        409,
        'AGENT_PROFILE_LAST_DEFAULT_DELETE_FORBIDDEN',
        'a provider must retain a default profile'
      );
    }
    store.delete(profile.id);
    res.status(204).end();
  });

  router.post('/agent-profiles/:id/default', auth, (req, res) => {
    const store = storeOr503(res, deps.store);
    if (!store) return;
    try {
      res.json({ profile: store.setDefault(req.params['id'] ?? '') });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  return router;
}
