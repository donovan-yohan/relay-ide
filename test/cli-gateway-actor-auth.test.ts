import { expect, test } from 'vitest';
import type { Request } from 'express';
import {
  CLI_GATEWAY_ACTOR_AUDIENCE,
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  cliGatewayActorFailure,
  classifyCliGatewayCredentialLane,
  issueCliGatewayActorCredential,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';

const NOW = new Date('2026-05-29T00:00:00.000Z');

function registry(): ScopedActorCredentialRegistry {
  return new ScopedActorCredentialRegistry({
    now: () => NOW,
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
  });
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
