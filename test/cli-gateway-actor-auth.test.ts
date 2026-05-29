import { expect, test } from 'vitest';
import type { Request } from 'express';
import {
  CLI_GATEWAY_ACTOR_AUDIENCE,
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  CliGatewayActorGrantError,
  cliGatewayActorFailure,
  classifyCliGatewayCredentialLane,
  issueCliGatewayActorCredential,
  issueCliGatewayActorCredentialWithGrant,
  listCliGatewayActorCredentialsWithGrant,
  revokeCliGatewayActorCredentialWithGrant,
  rotateCliGatewayActorCredentialWithGrant,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import { HandshakeGrantRegistry } from '../shared/operator-handshake-grants.js';
import { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';

const NOW = new Date('2026-05-29T00:00:00.000Z');

function registry(): ScopedActorCredentialRegistry {
  return new ScopedActorCredentialRegistry({
    now: () => NOW,
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
  });
}

function grantRegistry(): HandshakeGrantRegistry {
  return new HandshakeGrantRegistry({
    now: () => NOW,
    secretBytes: () => Buffer.from('abcdef0123456789abcdef0123456789'),
  });
}

const GRANT_ACTOR = { type: 'cli', id: 'relay-cli-test' } as const;
const GRANT_SCOPE = {
  sessionIds: ['session-1'],
  taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
};

function approveGrant(
  grants: HandshakeGrantRegistry,
  id: string,
  options: {
    actor?: { type: string; id: string; displayName?: string };
    scope?: typeof GRANT_SCOPE | Record<string, string[]>;
  } = {}
): string {
  const grant = grants.request({
    id,
    actor: options.actor ?? GRANT_ACTOR,
    issuer: { id: 'browser-operator-test' },
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    capabilities: ['session:read'],
    scope: options.scope ?? GRANT_SCOPE,
    ttlMs: 60_000,
    correlationId: `${id}-request`,
  });
  return grants.approve(grant.id, {
    approvedBy: { id: 'browser-operator-test' },
    correlationId: `${id}-approve`,
  }).handle;
}

function grantLifecycleInput(handle: string, id: string) {
  return {
    grantHandle: handle,
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    actor: GRANT_ACTOR,
    capabilities: ['session:read'],
    scope: { sessionIds: ['session-1'] },
    ttlMs: 60_000,
    correlationId: `${id}-lifecycle`,
  };
}

function req(input: {
  method?: string;
  authorization?: string;
  actorMarker?: string;
  command?: string;
  cookie?: string;
  nodeId?: string;
}): Request {
  const headers = new Map<string, string>();
  if (input.authorization) headers.set('authorization', input.authorization);
  if (input.actorMarker) headers.set('x-relay-cli-actor-token', input.actorMarker);
  if (input.command) headers.set('x-relay-cli-command', input.command);
  if (input.cookie) headers.set('cookie', input.cookie);
  if (input.nodeId) headers.set('x-relay-node-id', input.nodeId);
  return {
    method: input.method ?? 'GET',
    header: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as Request;
}

test('issues and validates bounded read-only CLI gateway actor credentials', () => {
  const scopedRegistry = registry();
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    actor: { type: 'cli', id: 'relay-cli-test' },
    issuer: { id: 'browser-operator-test' },
    correlationId: 'corr-cli-1',
  });

  expect(issued.credential).toMatchObject({
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    capabilities: ['session:read'],
    scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
    actor: { type: 'cli', id: 'relay-cli-test' },
    issuer: { id: 'browser-operator-test' },
  });
  expect(JSON.stringify(issued.credential)).not.toContain(issued.token);

  const validation = validateCliGatewayActorCredential(scopedRegistry, {
    token: issued.token,
    capabilities: ['session:read'],
    correlationId: 'corr-cli-1',
  });
  expect(validation).toMatchObject({ ok: true, grantedBits: ['session:read'] });
});

test('classifies only server-bound read-only CLI gateway actor routes into the actor lane', () => {
  const token = 'relay-sac-v1.credential-id.[REDACTED]';
  expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toEqual([
    'nodes.list',
    'sessions.list',
    'sessions.get',
    'work-contexts.get',
  ]);
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'nodes.list',
      }),
      'nodes.list'
    )
  ).toBe('scoped-actor-credential');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'nodes.list',
      })
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'nodes.list',
      }),
      'sessions.list'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'sessions.create',
      }),
      'sessions.list'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(req({ authorization: `Bearer ${token}`, actorMarker: 'v1' }), 'nodes.list')
  ).toBe('unsupported-route');
  expect(classifyCliGatewayCredentialLane(req({ cookie: 'token=browser' }))).toBe(
    'browser-cookie-lane'
  );
  expect(classifyCliGatewayCredentialLane(req({ authorization: 'Bearer node-secret', nodeId: 'n1' }))).toBe(
    'node-credential-lane'
  );
});

test('denies spoofed actor command headers on non-MVP route identities', () => {
  const token = 'relay-sac-v1.credential-id.[REDACTED]';
  const spoofedRequests = [
    { route: '/hub/audit/entries', command: 'nodes.list' },
    { route: '/hub/nodes/node-1/logs', command: 'nodes.list' },
    { route: '/sessions/session-1/replay', command: 'sessions.get' },
    { route: '/supervisor/sessions', command: 'sessions.get' },
  ];

  for (const { route, command } of spoofedRequests) {
    expect(
      classifyCliGatewayCredentialLane(
        req({
          authorization: `Bearer ${token}`,
          actorMarker: 'v1',
          command,
        })
      ),
      route
    ).toBe('unsupported-route');
  }
});

test('allows only the MVP actor command and route identity pairs', () => {
  const token = 'relay-sac-v1.credential-id.[REDACTED]';
  const allowed = [
    { command: 'nodes.list', expected: 'nodes.list' },
    { command: 'sessions.list', expected: 'sessions.list' },
    { command: 'sessions.get', expected: 'sessions.get' },
    { command: 'work-contexts.get', expected: 'work-contexts.get' },
  ] as const;

  for (const { command, expected } of allowed) {
    expect(
      classifyCliGatewayCredentialLane(
        req({
          authorization: `Bearer ${token}`,
          actorMarker: 'v1',
          command,
        }),
        expected
      )
    ).toBe('scoped-actor-credential');
  }
});

test('returns stable typed denials without token material', () => {
  const failure = cliGatewayActorFailure({
    lane: 'unsupported-route',
    correlationId: 'corr-cli-deny',
  });

  expect(failure).toMatchObject({
    code: 'UNAUTHORIZED',
    reasonCode: 'CLI_ACTOR_ROUTE_UNSUPPORTED',
    retryable: false,
    lane: 'denied',
    acceptedLanes: ['scoped-actor-credential'],
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    correlationId: 'corr-cli-deny',
  });
  expect(JSON.stringify(failure)).not.toContain('relay-sac-v1');
});

test('mints lists rotates and revokes CLI actor credentials with grant-backed lifecycle handles', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();

  const mintHandle = approveGrant(grants, 'grant-mint');
  const issued = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    grantLifecycleInput(mintHandle, 'mint')
  );
  expect(() =>
    issueCliGatewayActorCredentialWithGrant(
      scopedRegistry,
      grants,
      grantLifecycleInput(mintHandle, 'mint-replay')
    )
  ).toThrow(CliGatewayActorGrantError);
  expect(scopedRegistry.listCredentials()).toHaveLength(1);

  expect(issued.credential).toMatchObject({
    grantId: 'grant-mint',
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    capabilities: ['session:read'],
    scope: {
      sessionIds: ['session-1'],
      taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
    },
    actor: GRANT_ACTOR,
  });
  expect(JSON.stringify(issued)).not.toContain('abcdef0123456789abcdef0123456789');

  const validation = validateCliGatewayActorCredential(scopedRegistry, {
    token: issued.token,
    capabilities: ['session:read'],
    scope: { sessionIds: ['session-1'] },
    correlationId: 'mint-validate',
  });
  expect(validation).toMatchObject({ ok: true, grantedBits: ['session:read'] });
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${issued.token}`,
        actorMarker: 'v1',
        command: 'sessions.list',
        cookie: 'connect.sid=[REDACTED]',
      }),
      'sessions.list'
    )
  ).toBe('scoped-actor-credential');

  const otherActor = { type: 'cli', id: 'other-cli' };
  const otherScope = {
    sessionIds: ['session-2'],
    taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
  };
  const otherIssued = issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
    ...grantLifecycleInput(
      approveGrant(grants, 'grant-mint-other', {
        actor: otherActor,
        scope: otherScope,
      }),
      'mint-other'
    ),
    actor: otherActor,
    scope: otherScope,
  });

  const listed = listCliGatewayActorCredentialsWithGrant(
    scopedRegistry,
    grants,
    grantLifecycleInput(approveGrant(grants, 'grant-list'), 'list')
  );
  expect(listed.credentials.map((credential) => credential.id)).toEqual([
    issued.credential.id,
  ]);
  expect(listed.credentials.map((credential) => credential.id)).not.toContain(
    otherIssued.credential.id
  );

  const rotated = rotateCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    issued.credential.id,
    grantLifecycleInput(approveGrant(grants, 'grant-rotate'), 'rotate')
  );
  expect(rotated.credential.id).not.toBe(issued.credential.id);
  expect(rotated.credential.grantId).toBe('grant-rotate');
  expect(rotated.revoked).toMatchObject({
    id: issued.credential.id,
    revokedBy: 'grant:grant-rotate',
  });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['session:read'],
      scope: { sessionIds: ['session-1'] },
    })
  ).toMatchObject({ ok: false, reason: 'revoked' });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: rotated.token,
      capabilities: ['session:read'],
      scope: { sessionIds: ['session-1'] },
    })
  ).toMatchObject({ ok: true });

  const revoked = revokeCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    rotated.credential.id,
    {
      ...grantLifecycleInput(approveGrant(grants, 'grant-revoke'), 'revoke'),
      metadata: { reason: 'rotating bearer relay-sac-v1.supersecretcredentialmaterial' },
    }
  );
  expect(revoked).toMatchObject({
    id: rotated.credential.id,
    revokedBy: 'grant:grant-revoke',
  });
  expect(revoked.revocationReason).toContain('[REDACTED]');
  expect(revoked.revocationReason).not.toContain('supersecretcredentialmaterial');
});

test('denies grant-backed CLI actor lifecycle expansion and lane-mixing attempts', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const handle = approveGrant(grants, 'grant-deny');

  expect(() =>
    issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
      ...grantLifecycleInput(handle, 'deny'),
      grantHandle: 'relay-sac-v1.credential-id.secret',
    })
  ).toThrow(CliGatewayActorGrantError);

  const denialCases = [
    [{ audience: 'relay:operator-handshake:v1' }, 'audience_expansion'],
    [{ capabilities: ['session:create:agent'] }, 'capability_expansion'],
    [{ capabilities: ['definitely:not-a-capability'] }, 'unknown_capability'],
    [{ capabilities: ['*'] }, 'capability_expansion'],
    [{ scope: {} }, 'scope_required'],
    [{ actor: { type: 'cli', id: 'other-cli' } }, 'actor_mismatch'],
  ] as const;
  for (let index = 0; index < denialCases.length; index += 1) {
    const [override, reason] = denialCases[index];
    const freshHandle = approveGrant(grants, `grant-deny-${index}-${reason}`);
    try {
      issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
        ...grantLifecycleInput(freshHandle, `deny-${reason}`),
        ...override,
      });
      throw new Error(`expected ${reason} denial`);
    } catch (error) {
      expect(error).toBeInstanceOf(CliGatewayActorGrantError);
      expect((error as CliGatewayActorGrantError).reason).toBe(reason);
    }
  }
});

test('rejects grant-backed lifecycle requests that expand multi-value scope dimensions', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();

  const scopeExpansionCases = [
    { key: 'nodeIds', allowed: 'node-1', denied: 'node-2', reason: 'wrong_node_scope' },
    { key: 'sessionIds', allowed: 'session-1', denied: 'session-2', reason: 'wrong_session_scope' },
    {
      key: 'globalSessionIds',
      allowed: 'global-session-1',
      denied: 'global-session-2',
      reason: 'wrong_global_session_scope',
    },
    {
      key: 'workContextIds',
      allowed: 'work-context-1',
      denied: 'work-context-2',
      reason: 'wrong_work_context_scope',
    },
    { key: 'repoIds', allowed: 'repo-1', denied: 'repo-2', reason: 'wrong_repo_scope' },
    { key: 'pathPrefixes', allowed: '/allowed', denied: '/blocked', reason: 'wrong_path_scope' },
    { key: 'taskRefs', allowed: CLI_GATEWAY_READ_SCOPE_TASK_REF, denied: 'task-other', reason: 'wrong_task_scope' },
  ] as const;

  for (const { key, allowed, denied, reason } of scopeExpansionCases) {
    const handle = approveGrant(grants, `grant-expand-${key}`, {
      scope: { [key]: [allowed], taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
    });

    try {
      issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
        ...grantLifecycleInput(handle, `expand-${key}`),
        scope: { [key]: [allowed, denied] },
      });
      throw new Error(`expected ${reason} for ${key}`);
    } catch (error) {
      expect(error).toBeInstanceOf(CliGatewayActorGrantError);
      expect((error as CliGatewayActorGrantError).reason).toBe(reason);
    }
  }

  expect(scopedRegistry.listCredentials()).toHaveLength(0);
});

test('denies mixed allowed and disallowed list scopes before exposing credentials', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const sessionOne = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    grantLifecycleInput(approveGrant(grants, 'grant-list-seed-session-1'), 'list-seed-session-1')
  );
  const sessionTwo = issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
    ...grantLifecycleInput(
      approveGrant(grants, 'grant-list-seed-session-2', {
        scope: {
          sessionIds: ['session-2'],
          taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
        },
      }),
      'list-seed-session-2'
    ),
    scope: { sessionIds: ['session-2'] },
  });

  const mixedHandle = approveGrant(grants, 'grant-list-mixed-session');
  try {
    listCliGatewayActorCredentialsWithGrant(scopedRegistry, grants, {
      ...grantLifecycleInput(mixedHandle, 'list-mixed-session'),
      scope: { sessionIds: ['session-1', 'session-2'] },
    });
    throw new Error('expected wrong_session_scope for mixed list scope');
  } catch (error) {
    expect(error).toBeInstanceOf(CliGatewayActorGrantError);
    expect((error as CliGatewayActorGrantError).reason).toBe('wrong_session_scope');
  }

  const listed = listCliGatewayActorCredentialsWithGrant(
    scopedRegistry,
    grants,
    grantLifecycleInput(mixedHandle, 'list-mixed-session-retry')
  );
  expect(listed.credentials.map((credential) => credential.id)).toEqual([
    sessionOne.credential.id,
  ]);
  expect(listed.credentials.map((credential) => credential.id)).not.toContain(
    sessionTwo.credential.id
  );
});

test('denies revoked grant handles before minting actor credentials', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const grant = grants.request({
    id: 'grant-revoked-before-mint',
    actor: GRANT_ACTOR,
    issuer: { id: 'browser-operator-test' },
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    capabilities: ['session:read'],
    scope: GRANT_SCOPE,
    ttlMs: 60_000,
  });
  const handle = grants.approve(grant.id, {
    approvedBy: { id: 'browser-operator-test' },
  }).handle;
  grants.revoke(grant.id, {
    revokedBy: { id: 'browser-operator-test' },
    reason: 'operator cancelled bearer relay-ohg-v1.secretmaterial',
  });

  expect(() =>
    issueCliGatewayActorCredentialWithGrant(
      scopedRegistry,
      grants,
      grantLifecycleInput(handle, 'revoked')
    )
  ).toThrow(CliGatewayActorGrantError);
  expect(scopedRegistry.listCredentials()).toHaveLength(0);
});
