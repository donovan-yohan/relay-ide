import { describe, expect, it, test } from 'vitest';
import type { Request } from 'express';
import {
  isSupportedCliGatewayActorReadRequest,
  CLI_GATEWAY_ACTOR_AUDIENCE,
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_ACTOR_WRITE_COMMANDS,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  CliGatewayActorGrantError,
  cliGatewayActorCommandCapabilities,
  cliGatewayActorFailure,
  classifyCliGatewayCredentialLane,
  issueChannelRuntimeReadCliGatewayActorCredential,
  issueCliGatewayActorCredential,
  issueCliGatewayActorCredentialWithGrant,
  issuePersistentOrchestratorCliGatewayActorCredential,
  listCliGatewayActorCredentialsWithGrant,
  revokeCliGatewayActorCredentialWithGrant,
  isLocalHubCliActorCredential,
  issueLocalHubCliActorCredential,
  renewCliGatewayActorCredential,
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
    expiresAt?: Date | string;
  } = {}
): string {
  const grant = grants.request({
    id,
    actor: options.actor ?? GRANT_ACTOR,
    issuer: { id: 'browser-operator-test' },
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    capabilities: ['session:read'],
    scope: options.scope ?? GRANT_SCOPE,
    ...(options.expiresAt
      ? { expiresAt: options.expiresAt }
      : { ttlMs: 60_000 }),
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

function expectGrantError(
  run: () => unknown,
  reason: CliGatewayActorGrantError['reason']
): void {
  try {
    run();
    throw new Error(`expected ${reason} denial`);
  } catch (error) {
    expect(error).toBeInstanceOf(CliGatewayActorGrantError);
    expect((error as CliGatewayActorGrantError).reason).toBe(reason);
  }
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
  if (input.actorMarker)
    headers.set('x-relay-cli-actor-token', input.actorMarker);
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

test('reserves the persistent-orchestrator reason for the internal lease issuer', () => {
  const scopedRegistry = registry();
  const ordinary = issueCliGatewayActorCredential(scopedRegistry, {
    metadata: {
      reason: 'persistent-orchestrator',
      trace: 'ordinary',
    },
  });
  expect(ordinary.credential.metadata?.reason).toBeUndefined();

  const grants = grantRegistry();
  const grantBacked = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-reserved-reason'),
        'reserved-reason'
      ),
      metadata: {
        reason: 'persistent-orchestrator',
        trace: 'grant',
      },
    }
  );
  expect(grantBacked.credential.metadata?.reason).toBeUndefined();

  const internal = issuePersistentOrchestratorCliGatewayActorCredential(
    scopedRegistry,
    {
      actor: { type: 'agent', id: 'orchestrator-session' },
      issuer: { id: 'relay-ide' },
      capabilities: ['session:read'],
    }
  );
  expect(internal.credential.metadata).toEqual({
    reason: 'persistent-orchestrator',
  });
});

test('reserves the hub-local-cli reason for the internal host-local issuer (#1467)', () => {
  const scopedRegistry = registry();
  // Plain issue — the surface behind POST /cli-gateway/actor-credentials.
  const ordinary = issueCliGatewayActorCredential(scopedRegistry, {
    metadata: { reason: 'hub-local-cli', trace: 'ordinary' },
  });
  expect(ordinary.credential.metadata?.reason).toBeUndefined();
  expect(isLocalHubCliActorCredential(ordinary.credential)).toBe(false);

  // Grant-backed issue.
  const grants = grantRegistry();
  const grantBacked = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-hub-local-issue'),
        'hub-local-issue'
      ),
      metadata: { reason: 'hub-local-cli', trace: 'grant' },
    }
  );
  expect(grantBacked.credential.metadata?.reason).toBeUndefined();
  expect(isLocalHubCliActorCredential(grantBacked.credential)).toBe(false);

  // Grant-backed rotate must not smuggle the marker in either.
  const rotated = rotateCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    grantBacked.credential.id,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-hub-local-rotate'),
        'hub-local-rotate'
      ),
      metadata: { reason: 'hub-local-cli', trace: 'rotate' },
    }
  );
  expect(rotated.credential.metadata?.reason).toBeUndefined();
  expect(isLocalHubCliActorCredential(rotated.credential)).toBe(false);

  // Only the trusted in-process issuer stamps it.
  const internal = issueLocalHubCliActorCredential(scopedRegistry, {
    actor: { type: 'cli', id: 'local-cli' },
    issuer: { id: 'hub-local-boot' },
    capabilities: ['session:read'],
    ttlMs: 60_000,
  });
  expect(internal.credential.metadata).toEqual({ reason: 'hub-local-cli' });
  expect(isLocalHubCliActorCredential(internal.credential)).toBe(true);

  // ...and its successor cannot be minted through the renew surface, which
  // would drop the marker and silently downgrade the credential.
  expect(() =>
    renewCliGatewayActorCredential(scopedRegistry, internal.credential)
  ).toThrow(/cannot be renewed/);
});

test('reserves the channel-runtime-read reason for the internal read-lease issuer', () => {
  const scopedRegistry = registry();
  const ordinary = issueCliGatewayActorCredential(scopedRegistry, {
    metadata: {
      reason: 'channel-runtime-read',
      trace: 'ordinary',
    },
  });
  expect(ordinary.credential.metadata?.reason).toBeUndefined();

  const grants = grantRegistry();
  const grantBacked = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-runtime-read-reason'),
        'runtime-read-reason'
      ),
      metadata: {
        reason: 'channel-runtime-read',
        trace: 'grant',
      },
    }
  );
  expect(grantBacked.credential.metadata?.reason).toBeUndefined();

  const internal = issueChannelRuntimeReadCliGatewayActorCredential(
    scopedRegistry,
    {
      actor: { type: 'agent', id: 'collaborator-runtime' },
      issuer: { id: 'relay-ide' },
      capabilities: ['session:read', 'context:read'],
      scope: {
        sessionIds: ['collaborator-runtime'],
        channelIds: ['channel-A'],
      },
    }
  );
  // The marker is an audit breadcrumb only: it must never buy the
  // orchestrator's verbatim-sender / agent-brake-bypass identity.
  expect(internal.credential.metadata).toEqual({
    reason: 'channel-runtime-read',
  });
  expect(internal.credential.capabilities).toEqual([
    'session:read',
    'context:read',
  ]);
});

test('resolves channel read verbs to context:read for a read-lease credential', () => {
  for (const command of [
    'channels.list',
    'channels.get',
    'channels.history',
    'channels.receipts',
    'channels.threads.history',
    'channels.run.get',
    'channels.roster',
    'channels.subscribe',
    'channels.search',
  ]) {
    expect(cliGatewayActorCommandCapabilities(command)).toEqual([
      'context:read',
    ]);
  }
  // The standing lease carries no write bit, so this verb can never authorize.
  expect(cliGatewayActorCommandCapabilities('channels.post')).toEqual([
    'context:write',
  ]);
});

test('a read-only channel-scoped credential can search its own channel and can never post', () => {
  const scopedRegistry = registry();
  // The scope shape the channel routes actually validate against: the
  // middleware derives `channelIds` from the request, and nothing else — a
  // channel request names no session, repo, or WorkContext.
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['session:read', 'context:read'],
    scope: { channelIds: ['A'] },
  });

  // (a) search inside the credential's own channel authorizes.
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: cliGatewayActorCommandCapabilities('channels.search'),
      scope: { channelIds: ['A'] },
    })
  ).toMatchObject({ ok: true, grantedBits: ['context:read'] });

  // (b) search aimed at another channel fails closed on scope.
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: cliGatewayActorCommandCapabilities('channels.search'),
      scope: { channelIds: ['B'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });

  // (c) the write verb is unreachable: the credential holds no context:write
  // bit, so opening search never buys a post.
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: cliGatewayActorCommandCapabilities('channels.post'),
      scope: { channelIds: ['A'] },
    })
  ).toMatchObject({
    ok: false,
    reason: 'insufficient_capability',
    deniedBits: ['context:write'],
  });

  // (d) a credential with no channel dimension at all cannot search: the
  // channel rule is `requiredWhenRequested`, so absence denies rather than
  // skips.
  const unscoped = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['session:read', 'context:read'],
    scope: { workContextIds: ['wc:allowed'] },
  });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: unscoped.token,
      capabilities: cliGatewayActorCommandCapabilities('channels.search'),
      scope: { channelIds: ['A'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });
});

test('search is a named actor read verb, not a POST or an unnamed request', () => {
  const token = 'relay-sac-v1.credential-id.[REDACTED]';
  // The actor lane authorizes by the command header. A search request that
  // names no command, or names a different verb, is not on the lane at all.
  expect(
    classifyCliGatewayCredentialLane(
      req({ authorization: `Bearer ${token}`, actorMarker: 'v1' }),
      'channels.search'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'channels.history',
      }),
      'channels.search'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'channels.search',
      }),
      'channels.search'
    )
  ).toBe('unsupported-route');
});

test('validates WorkContext-scoped actor credentials against exact artifact read scopes', () => {
  const scopedRegistry = registry();
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    scope: { workContextIds: ['wc:allowed'] },
  });

  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['session:read'],
    })
  ).toMatchObject({ ok: false, reason: 'missing_scope' });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['session:read'],
      scope: { workContextIds: ['wc:allowed'] },
    })
  ).toMatchObject({ ok: true, grantedBits: ['session:read'] });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['session:read'],
      scope: { workContextIds: ['wc:other'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_work_context_scope' });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['session:read'],
      deferWorkContextScope: true,
    })
  ).toMatchObject({ ok: true, grantedBits: ['session:read'] });
});

test('accepts and enforces a channelIds scope dimension on actor credentials', () => {
  const scopedRegistry = registry();
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['context:read'],
    scope: { channelIds: ['A'] },
  });
  expect(issued.credential.scope?.channelIds).toEqual(['A']);

  // In-scope channel A validates.
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:read'],
      scope: { channelIds: ['A'] },
    })
  ).toMatchObject({ ok: true, grantedBits: ['context:read'] });

  // Out-of-scope channel B is denied with wrong_channel_scope.
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:read'],
      scope: { channelIds: ['B'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });

  // A request naming no channel is missing_scope (list requires an explicit
  // channel scope from a scoped actor).
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:read'],
    })
  ).toMatchObject({ ok: false, reason: 'missing_scope' });
});

test('denies a channel request when the credential has NO channel scope (fail-closed)', () => {
  const scopedRegistry = registry();
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['context:read'],
    scope: { workContextIds: ['wc:allowed'] }, // no channelIds dimension
  });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:read'],
      scope: { channelIds: ['B'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });
});

test('requires scoped actor credentials to cover every requested WorkContext id', () => {
  const scopedRegistry = registry();
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['context:write'],
    scope: { workContextIds: ['wc:allowed'] },
  });

  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:write'],
      scope: { workContextIds: ['wc:allowed', 'wc:denied'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_work_context_scope' });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:write'],
      scope: { workContextIds: ['wc:denied', 'wc:allowed'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_work_context_scope' });
});

test('validates scoped actor write credentials without forcing the read task sentinel', () => {
  const scopedRegistry = registry();
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['context:write', 'inbox:write', 'artifact:write'],
    scope: {
      workContextIds: ['wc:allowed'],
      repoIds: ['repo-1'],
      taskRefs: ['task-1'],
    },
  });

  expect(issued.credential).toMatchObject({
    capabilities: ['context:write', 'inbox:write', 'artifact:write'],
    scope: {
      workContextIds: ['wc:allowed'],
      repoIds: ['repo-1'],
      taskRefs: ['task-1'],
    },
  });
  expect(issued.credential.scope.taskRefs).not.toContain(
    CLI_GATEWAY_READ_SCOPE_TASK_REF
  );
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:write'],
      scope: {
        workContextIds: ['wc:allowed'],
        repoIds: ['repo-1'],
        taskRefs: ['task-1'],
      },
    })
  ).toMatchObject({ ok: true, grantedBits: ['context:write'] });
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['context:write'],
      scope: {
        workContextIds: ['wc:allowed'],
        taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
      },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_task_scope' });
});

test('mints and validates actor credentials carrying the inbox/context read bits', () => {
  const scopedRegistry = registry();
  // inbox:read is now part of the actor grant allowlist so a scoped credential
  // can satisfy the inbox.list/get route gate; context:read was already allowed.
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['context:read', 'inbox:read'],
    scope: { workContextIds: ['wc:allowed'] },
  });
  expect(issued.credential.capabilities).toEqual([
    'context:read',
    'inbox:read',
  ]);

  for (const command of ['inbox.list', 'inbox.get', 'context.list'] as const) {
    expect(
      validateCliGatewayActorCredential(scopedRegistry, {
        token: issued.token,
        capabilities: cliGatewayActorCommandCapabilities(command),
        scope: { workContextIds: ['wc:allowed'] },
      }),
      command
    ).toMatchObject({ ok: true });
  }
  // Wrong WorkContext scope still fails closed on a read.
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: cliGatewayActorCommandCapabilities('inbox.list'),
      scope: { workContextIds: ['wc:other'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_work_context_scope' });
});

test('lets a single session:read mail-loop credential run both read and write verbs', () => {
  const scopedRegistry = registry();
  // The natural single credential for the agent mail loop: session:read for
  // sessions.list, context/inbox read to read mail, inbox:write to send/ack.
  // session:read stamps the read task-ref into the STORED scope; that marker
  // must not block the non-session:read verbs (regression: those verbs 403'd
  // with missing_scope for exactly this credential shape).
  const issued = issueCliGatewayActorCredential(scopedRegistry, {
    capabilities: ['session:read', 'context:read', 'inbox:read', 'inbox:write'],
    scope: { workContextIds: ['wc:allowed'] },
  });
  expect(issued.credential.scope.taskRefs).toEqual([
    CLI_GATEWAY_READ_SCOPE_TASK_REF,
  ]);

  for (const command of [
    'sessions.list',
    'inbox.list',
    'inbox.get',
    'context.list',
    'inbox.ack',
  ] as const) {
    expect(
      validateCliGatewayActorCredential(scopedRegistry, {
        token: issued.token,
        capabilities: cliGatewayActorCommandCapabilities(command),
        scope: { workContextIds: ['wc:allowed'] },
      }),
      command
    ).toMatchObject({ ok: true });
  }

  // Scope enforcement is intact — the fix neutralizes the read-marker task-ref,
  // it does not widen WorkContext scoping.
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: cliGatewayActorCommandCapabilities('inbox.get'),
      scope: { workContextIds: ['wc:other'] },
    })
  ).toMatchObject({ ok: false, reason: 'wrong_work_context_scope' });
});

test('classifies only server-bound read-only CLI gateway actor routes into the actor lane', () => {
  const token = 'relay-sac-v1.credential-id.[REDACTED]';
  expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toEqual([
    'nodes.list',
    'sessions.list',
    'sessions.get',
    'sessions.screen',
    'sessions.native.list',
    'sessions.native.get',
    'sessions.native.import',
    'sessions.native.watch',
    'work-contexts.get',
    'work-contexts.resume',
    'work-context-artifacts.list',
    'work-context-artifacts.show',
    'work-context-artifacts.export',
    'work-context-artifacts.doctor',
    'handoff-artifacts.list',
    'handoff-artifacts.show',
    'handoff-artifacts.copy',
    'workflow-runs.list',
    'workflow-runs.get',
    'automation-runs.list',
    'automation-runs.get',
    'pr-overseer.list',
    'pr-overseer.get',
    'events.subscribe',
    'work-context-messages.list',
    'work-context-messages.show',
    'work-context-messages.query',
    'work-context-messages.templates.list',
    'work-context-messages.templates.show',
    'work-context-messages.templates.render',
    'workspace-surfaces.list',
    'workspace-topics.list',
    'workspace-topics.search',
    'workspace-topics.get',
    'channels.list',
    'channels.get',
    'channels.run.get',
    'channels.history',
    'channels.receipts',
    'channels.subscribe',
    'channels.threads.history',
    'channels.roster',
    'channels.search',
    'context.get',
    'context.list',
    'inbox.list',
    'inbox.get',
    'agent-profiles.list',
    'agent-profiles.get',
  ]);
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        command: 'nodes.list',
      }),
      'nodes.list'
    )
  ).toBe('scoped-actor-credential');
  // context/inbox reads (mail loop) classify into the actor lane on GET.
  for (const command of [
    'context.get',
    'context.list',
    'inbox.list',
    'inbox.get',
  ] as const) {
    expect(
      classifyCliGatewayCredentialLane(
        req({
          authorization: `Bearer ${token}`,
          actorMarker: 'v1',
          command,
        }),
        command
      ),
      command
    ).toBe('scoped-actor-credential');
  }
  // Channel read verbs classify into the scoped-actor-credential read
  // lane (GET), and a read verb on POST is not an actor read route.
  for (const command of [
    'channels.list',
    'channels.get',
    'channels.history',
    'channels.subscribe',
    'channels.threads.history',
    'channels.roster',
    'channels.search',
  ] as const) {
    expect(
      classifyCliGatewayCredentialLane(
        req({
          authorization: `Bearer ${token}`,
          actorMarker: 'v1',
          command,
        }),
        command
      ),
      command
    ).toBe('scoped-actor-credential');
    expect(
      classifyCliGatewayCredentialLane(
        req({
          method: 'POST',
          authorization: `Bearer ${token}`,
          actorMarker: 'v1',
          command,
        }),
        command
      ),
      command
    ).toBe('unsupported-route');
  }

  // A read verb presented on POST (a write method) is not an actor read route.
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'inbox.list',
      }),
      'inbox.list'
    )
  ).toBe('unsupported-route');
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
    classifyCliGatewayCredentialLane(
      req({ authorization: `Bearer ${token}`, actorMarker: 'v1' }),
      'nodes.list'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'events.subscribe',
      }),
      'events.subscribe'
    )
  ).toBe('scoped-actor-credential');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'nodes.list',
      }),
      'events.subscribe'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'events.subscribe',
      }),
      'events.subscribe'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'work-context-messages.query',
      }),
      'work-context-messages.query'
    )
  ).toBe('scoped-actor-credential');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'work-context-messages.templates.list',
      }),
      'work-context-messages.templates.list'
    )
  ).toBe('scoped-actor-credential');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'work-context-messages.templates.show',
      }),
      'work-context-messages.templates.show'
    )
  ).toBe('scoped-actor-credential');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'work-context-messages.templates.render',
      }),
      'work-context-messages.templates.render'
    )
  ).toBe('scoped-actor-credential');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'nodes.list',
      }),
      'nodes.list'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(req({ cookie: 'token=browser' }))
  ).toBe('browser-cookie-lane');
  expect(
    classifyCliGatewayCredentialLane(
      req({ authorization: 'Bearer node-secret', nodeId: 'n1' })
    )
  ).toBe('node-credential-lane');
});

test('classifies explicitly scoped CLI gateway actor write routes into the actor lane', () => {
  const token = 'relay-sac-v1.credential-id.[REDACTED]';
  expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toEqual([
    'sessions.create',
    'context.create',
    'context.pin',
    'context.unpin',
    'inbox.send',
    'inbox.ack',
    'inbox.resolve',
    'inbox.ignore',
    'work-context-artifacts.publish',
    'work-context-artifacts.pin',
    'work-context-artifacts.unpin',
    'handoff-artifacts.attach',
    'workflow-runs.publish',
    'workflow-runs.update',
    'automation-runs.register',
    'automation-runs.observe',
    'automation-runs.retire',
    'pr-overseer.register',
    'pr-overseer.observe',
    'pr-overseer.retire',
    'work-context-messages.append',
    'workspace-surfaces.publish',
    'workspace-topics.create',
    'workspace-topics.update',
    'workspace-topics.archive',
    'workspace-topics.restore',
    'channels.post',
    'agent-profiles.create',
    'agent-profiles.update',
  ]);

  for (const command of CLI_GATEWAY_ACTOR_WRITE_COMMANDS) {
    expect(
      classifyCliGatewayCredentialLane(
        req({
          method: 'POST',
          authorization: `Bearer ${token}`,
          actorMarker: 'v1',
          command,
        }),
        command
      ),
      command
    ).toBe('scoped-actor-credential');
  }

  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
      }),
      'context.create'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'GET',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'context.create',
      }),
      'context.create'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'PUT',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'context.create',
      }),
      'context.create'
    )
  ).toBe('unsupported-route');
  expect(
    classifyCliGatewayCredentialLane(
      req({
        method: 'POST',
        authorization: `Bearer ${token}`,
        actorMarker: 'v1',
        command: 'context.pin',
      }),
      'context.create'
    )
  ).toBe('unsupported-route');
});

test('maps write actor commands to required Relay capability bits', () => {
  expect(cliGatewayActorCommandCapabilities('nodes.list')).toEqual([
    'session:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('sessions.create')).toEqual([
    'session:create:terminal',
  ]);
  expect(cliGatewayActorCommandCapabilities('context.create')).toEqual([
    'context:write',
  ]);
  // context/inbox reads resolve to their READ bit (matching the router gate),
  // NOT the session:read fallback or the context.*/inbox.* write default.
  expect(cliGatewayActorCommandCapabilities('context.get')).toEqual([
    'context:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('context.list')).toEqual([
    'context:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('inbox.list')).toEqual([
    'inbox:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('inbox.get')).toEqual([
    'inbox:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('inbox.send')).toEqual([
    'inbox:write',
  ]);
  expect(cliGatewayActorCommandCapabilities('inbox.ack')).toEqual([
    'inbox:write',
  ]);
  expect(
    cliGatewayActorCommandCapabilities('work-context-artifacts.publish')
  ).toEqual(['artifact:write']);
  expect(
    cliGatewayActorCommandCapabilities('handoff-artifacts.attach')
  ).toEqual(['artifact:write']);
  expect(cliGatewayActorCommandCapabilities('workflow-runs.list')).toEqual([
    'context:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('workflow-runs.get')).toEqual([
    'context:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('events.subscribe')).toEqual([
    'context:read',
  ]);
  expect(cliGatewayActorCommandCapabilities('workflow-runs.publish')).toEqual([
    'context:write',
  ]);
  expect(cliGatewayActorCommandCapabilities('workflow-runs.update')).toEqual([
    'context:write',
  ]);
  expect(
    cliGatewayActorCommandCapabilities('work-context-messages.list')
  ).toEqual(['context:read']);
  expect(
    cliGatewayActorCommandCapabilities('work-context-messages.append')
  ).toEqual(['context:write']);
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
    { command: 'sessions.screen', expected: 'sessions.screen' },
    { command: 'work-contexts.get', expected: 'work-contexts.get' },
    { command: 'work-contexts.resume', expected: 'work-contexts.resume' },
    {
      command: 'work-context-artifacts.list',
      expected: 'work-context-artifacts.list',
    },
    {
      command: 'work-context-artifacts.show',
      expected: 'work-context-artifacts.show',
    },
    {
      command: 'work-context-artifacts.export',
      expected: 'work-context-artifacts.export',
    },
    {
      command: 'work-context-artifacts.doctor',
      expected: 'work-context-artifacts.doctor',
    },
    { command: 'handoff-artifacts.list', expected: 'handoff-artifacts.list' },
    { command: 'handoff-artifacts.show', expected: 'handoff-artifacts.show' },
    { command: 'handoff-artifacts.copy', expected: 'handoff-artifacts.copy' },
    { command: 'workflow-runs.list', expected: 'workflow-runs.list' },
    { command: 'workflow-runs.get', expected: 'workflow-runs.get' },
    { command: 'automation-runs.list', expected: 'automation-runs.list' },
    { command: 'automation-runs.get', expected: 'automation-runs.get' },
    { command: 'pr-overseer.list', expected: 'pr-overseer.list' },
    { command: 'pr-overseer.get', expected: 'pr-overseer.get' },
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
    message:
      'scoped CLI actor credentials are limited to supported CLI gateway route and command pairs',
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
  expect(JSON.stringify(issued)).not.toContain(
    'abcdef0123456789abcdef0123456789'
  );

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
  const otherIssued = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-mint-other', {
          actor: otherActor,
          scope: otherScope,
        }),
        'mint-other'
      ),
      actor: otherActor,
      scope: otherScope,
    }
  );

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
      metadata: {
        reason: 'rotating bearer relay-sac-v1.supersecretcredentialmaterial',
      },
    }
  );
  expect(revoked).toMatchObject({
    id: rotated.credential.id,
    revokedBy: 'grant:grant-revoke',
  });
  expect(revoked.revocationReason).toContain('[REDACTED]');
  expect(revoked.revocationReason).not.toContain(
    'supersecretcredentialmaterial'
  );
});

test('caps grant-backed credential expiry and cascades grant revocation', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const ttlIssued = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(approveGrant(grants, 'grant-expiry-ttl'), 'ttl'),
      ttlMs: 120_000,
    }
  );
  expect(ttlIssued.credential.expiresAt).toBe('2026-05-29T00:01:00.000Z');
  const explicitIssued = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-expiry-explicit'),
        'explicit'
      ),
      ttlMs: undefined,
      expiresAt: '2026-05-29T00:10:00.000Z',
    }
  );
  expect(explicitIssued.credential.expiresAt).toBe('2026-05-29T00:01:00.000Z');
  expect(
    scopedRegistry.revokeByGrantId('grant-expiry-ttl', {
      revokedBy: 'grant:grant-expiry-ttl',
    })
  ).toHaveLength(1);
  expect(scopedRegistry.getCredential(ttlIssued.credential.id)).toHaveProperty(
    'revokedAt'
  );
  expect(
    scopedRegistry.getCredential(explicitIssued.credential.id)
  ).not.toHaveProperty('revokedAt');
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: ttlIssued.token,
      capabilities: ['session:read'],
      scope: { sessionIds: ['session-1'] },
    })
  ).toMatchObject({ ok: false, reason: 'revoked' });
});

test('does not consume issue or rotation grants before deterministic lease validation', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const invalidInputs = [
    { ttlMs: 0 },
    { ttlMs: 15 * 60 * 1000 + 1 },
    { ttlMs: undefined, expiresAt: 'not-a-date' },
    { ttlMs: undefined, expiresAt: '2026-05-29T00:00:00.000Z' },
  ];

  for (const [index, invalid] of invalidInputs.entries()) {
    const handle = approveGrant(grants, `grant-invalid-issue-${index}`);
    const beforeCredentials = scopedRegistry.listCredentials();
    const beforeAudit = scopedRegistry.listAuditEvents();
    expect(() =>
      issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
        ...grantLifecycleInput(handle, `invalid-issue-${index}`),
        ...invalid,
      })
    ).toThrow();
    expect(scopedRegistry.listCredentials()).toEqual(beforeCredentials);
    expect(scopedRegistry.listAuditEvents()).toEqual(beforeAudit);
    // The same one-use handle remains redeemable after a local validation
    // error; a valid retry is the proof that it was not consumed.
    expect(
      issueCliGatewayActorCredentialWithGrant(
        scopedRegistry,
        grants,
        grantLifecycleInput(handle, `valid-issue-${index}`)
      ).credential.grantId
    ).toBe(`grant-invalid-issue-${index}`);
  }

  const existing = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    grantLifecycleInput(
      approveGrant(grants, 'grant-rotate-existing'),
      'rotate-existing'
    )
  );
  const rotateHandle = approveGrant(grants, 'grant-invalid-rotate');
  const beforeRotateAudit = scopedRegistry.listAuditEvents();
  expect(() =>
    rotateCliGatewayActorCredentialWithGrant(
      scopedRegistry,
      grants,
      existing.credential.id,
      {
        ...grantLifecycleInput(rotateHandle, 'invalid-rotate'),
        ttlMs: 0,
      }
    )
  ).toThrow();
  expect(
    scopedRegistry.getCredential(existing.credential.id)
  ).not.toHaveProperty('revokedAt');
  expect(scopedRegistry.listAuditEvents()).toEqual(beforeRotateAudit);
  const rotated = rotateCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    existing.credential.id,
    grantLifecycleInput(rotateHandle, 'valid-rotate')
  );
  expect(rotated.revoked.id).toBe(existing.credential.id);
  expect(rotated.credential.grantId).toBe('grant-invalid-rotate');
});

test('shares the grant issuance instant across consume and registry persistence', () => {
  const beforeNotAfter = new Date('2026-05-29T00:00:00.000Z');
  const notAfter = new Date('2026-05-29T00:00:00.001Z');
  const afterNotAfter = new Date('2026-05-29T00:00:00.002Z');
  const advancingRegistry = (initialNowReads: number) => {
    let nowReads = 0;
    const scopedRegistry = new ScopedActorCredentialRegistry({
      now: () => {
        nowReads += 1;
        return nowReads <= initialNowReads ? beforeNotAfter : afterNotAfter;
      },
      secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    });
    return { scopedRegistry, nowReads: () => nowReads };
  };
  const grants = new HandshakeGrantRegistry({
    now: () => beforeNotAfter,
    secretBytes: () => Buffer.from('abcdef0123456789abcdef0123456789'),
  });

  const issuing = advancingRegistry(1);
  const issued = issueCliGatewayActorCredentialWithGrant(
    issuing.scopedRegistry,
    grants,
    grantLifecycleInput(
      approveGrant(grants, 'grant-advancing-issue', { expiresAt: notAfter }),
      'advancing-issue'
    )
  );
  expect(issued.credential.expiresAt).toBe(notAfter.toISOString());
  // A second registry clock read would be after the grant ceiling. The issue
  // therefore proves persistence reused the preflight issuance instant.
  expect(issuing.nowReads()).toBe(1);

  const rotating = advancingRegistry(2);
  const existing = issueCliGatewayActorCredential(rotating.scopedRegistry, {
    actor: GRANT_ACTOR,
    issuer: { id: 'browser-operator-test' },
    capabilities: ['session:read'],
    scope: { sessionIds: ['session-1'] },
    ttlMs: 60_000,
  });
  const rotated = rotateCliGatewayActorCredentialWithGrant(
    rotating.scopedRegistry,
    grants,
    existing.credential.id,
    grantLifecycleInput(
      approveGrant(grants, 'grant-advancing-rotate', { expiresAt: notAfter }),
      'advancing-rotate'
    )
  );
  expect(rotated.credential.expiresAt).toBe(notAfter.toISOString());
  expect(rotated.revoked.id).toBe(existing.credential.id);
  // The later clock sample belongs to recording the revocation; issuing the
  // replacement at that instant would have rejected against `notAfter`.
  expect(rotating.nowReads()).toBe(3);

  const expiredGrants = new HandshakeGrantRegistry({
    now: () => afterNotAfter,
    secretBytes: () => Buffer.from('abcdef0123456789abcdef0123456789'),
  });
  const expiredHandle = approveGrant(
    expiredGrants,
    'grant-expired-before-use',
    {
      expiresAt: notAfter,
    }
  );
  const beforeExpiredAttempt = issuing.scopedRegistry.listCredentials();
  expectGrantError(
    () =>
      issueCliGatewayActorCredentialWithGrant(
        issuing.scopedRegistry,
        expiredGrants,
        grantLifecycleInput(expiredHandle, 'expired-before-use')
      ),
    'expired'
  );
  expect(issuing.scopedRegistry.listCredentials()).toEqual(
    beforeExpiredAttempt
  );
  expect(expiredGrants.getGrant('grant-expired-before-use')).toMatchObject({
    status: 'expired',
  });
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
    [{ capabilities: ['settings:write'] }, 'capability_expansion'],
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
    {
      key: 'nodeIds',
      allowed: 'node-1',
      denied: 'node-2',
      reason: 'wrong_node_scope',
    },
    {
      key: 'sessionIds',
      allowed: 'session-1',
      denied: 'session-2',
      reason: 'wrong_session_scope',
    },
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
    {
      key: 'channelIds',
      allowed: 'channel-1',
      denied: 'channel-2',
      reason: 'wrong_channel_scope',
    },
    {
      key: 'repoIds',
      allowed: 'repo-1',
      denied: 'repo-2',
      reason: 'wrong_repo_scope',
    },
    {
      key: 'pathPrefixes',
      allowed: '/allowed',
      denied: '/blocked',
      reason: 'wrong_path_scope',
    },
    {
      key: 'taskRefs',
      allowed: CLI_GATEWAY_READ_SCOPE_TASK_REF,
      denied: 'task-other',
      reason: 'wrong_task_scope',
    },
  ] as const;

  for (const { key, allowed, denied, reason } of scopeExpansionCases) {
    const handle = approveGrant(grants, `grant-expand-${key}`, {
      scope: { [key]: [allowed], taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
    });

    expectGrantError(
      () =>
        issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
          ...grantLifecycleInput(handle, `expand-${key}`),
          scope: { [key]: [allowed, denied] },
        }),
      reason
    );
  }

  expect(scopedRegistry.listCredentials()).toHaveLength(0);
});

test('rejects request-only lifecycle scope dimensions absent from the approved grant', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const requestOnlyNodeScope = {
    sessionIds: ['session-1'],
    nodeIds: ['node-evil'],
  };

  expectGrantError(
    () =>
      issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
        ...grantLifecycleInput(
          approveGrant(grants, 'grant-mint-request-only-node'),
          'mint-request-only-node'
        ),
        scope: requestOnlyNodeScope,
      }),
    'wrong_node_scope'
  );
  expect(scopedRegistry.listCredentials()).toHaveLength(0);

  const allowedCredential = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-mint-node-bound', {
          scope: {
            sessionIds: ['session-1'],
            nodeIds: ['node-allowed'],
            taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
          },
        }),
        'mint-node-bound'
      ),
      scope: { sessionIds: ['session-1'], nodeIds: ['node-allowed'] },
    }
  );

  expectGrantError(
    () =>
      listCliGatewayActorCredentialsWithGrant(scopedRegistry, grants, {
        ...grantLifecycleInput(
          approveGrant(grants, 'grant-list-request-only-node'),
          'list-request-only-node'
        ),
        scope: requestOnlyNodeScope,
      }),
    'wrong_node_scope'
  );

  expectGrantError(
    () =>
      rotateCliGatewayActorCredentialWithGrant(
        scopedRegistry,
        grants,
        allowedCredential.credential.id,
        grantLifecycleInput(
          approveGrant(grants, 'grant-rotate-request-only-node'),
          'rotate-request-only-node'
        )
      ),
    'wrong_node_scope'
  );

  expectGrantError(
    () =>
      revokeCliGatewayActorCredentialWithGrant(
        scopedRegistry,
        grants,
        allowedCredential.credential.id,
        grantLifecycleInput(
          approveGrant(grants, 'grant-revoke-request-only-node'),
          'revoke-request-only-node'
        )
      ),
    'wrong_node_scope'
  );

  expect(
    scopedRegistry.getCredential(allowedCredential.credential.id)
  ).not.toHaveProperty('revokedAt');
});

test('allows only the default CLI gateway taskRef when the grant omits task scope', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();

  const issued = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(
        approveGrant(grants, 'grant-default-taskref', {
          scope: { sessionIds: ['session-1'] },
        }),
        'default-taskref'
      ),
      scope: { sessionIds: ['session-1'] },
    }
  );
  expect(issued.credential.scope.taskRefs).toEqual([
    CLI_GATEWAY_READ_SCOPE_TASK_REF,
  ]);

  expectGrantError(
    () =>
      issueCliGatewayActorCredentialWithGrant(scopedRegistry, grants, {
        ...grantLifecycleInput(
          approveGrant(grants, 'grant-request-only-taskref', {
            scope: { sessionIds: ['session-1'] },
          }),
          'request-only-taskref'
        ),
        scope: { sessionIds: ['session-1'], taskRefs: ['relay:other-task'] },
      }),
    'wrong_task_scope'
  );
});

test('keeps grant-specific task scope while preserving the read gateway marker', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const dogfoodTaskRef = 'bootstrap-work-mac';
  const handle = approveGrant(grants, 'grant-dogfood-taskref', {
    scope: { taskRefs: [dogfoodTaskRef] },
  });

  const issued = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
      ...grantLifecycleInput(handle, 'dogfood-taskref'),
      scope: { taskRefs: [dogfoodTaskRef] },
    }
  );

  expect(issued.credential.scope.taskRefs).toEqual([
    CLI_GATEWAY_READ_SCOPE_TASK_REF,
    dogfoodTaskRef,
  ]);
  expect(
    validateCliGatewayActorCredential(scopedRegistry, {
      token: issued.token,
      capabilities: ['session:read'],
      correlationId: 'dogfood-nodes-list',
    })
  ).toMatchObject({ ok: true, grantedBits: ['session:read'] });
});

test('denies mixed allowed and disallowed list scopes before exposing credentials', () => {
  const scopedRegistry = registry();
  const grants = grantRegistry();
  const sessionOne = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    grantLifecycleInput(
      approveGrant(grants, 'grant-list-seed-session-1'),
      'list-seed-session-1'
    )
  );
  const sessionTwo = issueCliGatewayActorCredentialWithGrant(
    scopedRegistry,
    grants,
    {
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
    }
  );

  const mixedHandle = approveGrant(grants, 'grant-list-mixed-session');
  try {
    listCliGatewayActorCredentialsWithGrant(scopedRegistry, grants, {
      ...grantLifecycleInput(mixedHandle, 'list-mixed-session'),
      scope: { sessionIds: ['session-1', 'session-2'] },
    });
    throw new Error('expected wrong_session_scope for mixed list scope');
  } catch (error) {
    expect(error).toBeInstanceOf(CliGatewayActorGrantError);
    expect((error as CliGatewayActorGrantError).reason).toBe(
      'wrong_session_scope'
    );
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

describe('read-POST command allowlist (#1426 follow-up)', () => {
  it('accepts sessions.native.import and sessions.native.watch as actor-lane POST reads', () => {
    const makeReq = (commandName: string) =>
      ({
        method: 'POST',
        header: (name: string) =>
          name === 'x-relay-cli-command' ? commandName : undefined,
      }) as unknown as Parameters<
        typeof isSupportedCliGatewayActorReadRequest
      >[0];

    // Both native-session verbs are POST-shaped but strictly read-only.
    expect(
      isSupportedCliGatewayActorReadRequest(
        makeReq('sessions.native.import'),
        'sessions.native.import'
      )
    ).toBe(true);
    expect(
      isSupportedCliGatewayActorReadRequest(
        makeReq('sessions.native.watch'),
        'sessions.native.watch'
      )
    ).toBe(true);
    // A genuinely write-shaped command stays rejected on the read lane.
    expect(
      isSupportedCliGatewayActorReadRequest(
        makeReq('channels.post'),
        'sessions.native.import'
      )
    ).toBe(false);
  });
});
