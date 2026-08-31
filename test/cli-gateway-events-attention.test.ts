import express, { type RequestHandler } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachAuthenticatedCliGatewayActorCredential,
  bearerActorToken,
  classifyCliGatewayCredentialLane,
  cliGatewayActorFailure,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  issueCliGatewayActorCredential,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import { createCliGatewayEventsRouter } from '../server/cli-gateway-events.js';
import {
  createCliGatewayEventBus,
  type CliGatewayEventBus,
} from '../server/cli-gateway-event-bus.js';
import {
  EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES,
  type EventsSubscribeTopic,
} from '../shared/cli-gateway-contract.js';
import { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';

// #963: server-side proof that the `attention` topic emits derived
// session-state frames over the events router with cursor/resume, scope
// filtering, capability gating, and gap/drop behavior.

let server: http.Server | undefined;
let baseUrl = '';

function noopHooks() {
  const unsub = () => {};
  return {
    onSessionCreate: () => unsub,
    onSessionEnd: () => unsub,
    onControlEvent: () => unsub,
    onNodeStatus: () => unsub,
  };
}

async function mount(
  bus: CliGatewayEventBus,
  cliGatewayAuth: RequestHandler = (_req, _res, next) => next()
): Promise<void> {
  const app = express();
  app.use(
    createCliGatewayEventsRouter(express, {
      cliGatewayAuth,
      eventBus: bus,
      hooks: noopHooks(),
    })
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server?.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function eventScopeFromRequest(req: Parameters<RequestHandler>[0]): {
  taskRefs: string[];
  workContextIds?: string[];
  sessionIds?: string[];
  globalSessionIds?: string[];
} {
  const workContextId = typeof req.query['workContextId'] === 'string' ? req.query['workContextId'].trim() : '';
  const sessionId = typeof req.query['sessionId'] === 'string' ? req.query['sessionId'].trim() : '';
  const globalSessionId = typeof req.query['globalSessionId'] === 'string' ? req.query['globalSessionId'].trim() : '';
  return {
    taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
    ...(workContextId ? { workContextIds: [workContextId] } : {}),
    ...(sessionId ? { sessionIds: [sessionId] } : {}),
    ...(globalSessionId ? { globalSessionIds: [globalSessionId] } : {}),
  };
}

function actorTokenAuth(registry: ScopedActorCredentialRegistry): RequestHandler {
  return (req, res, next) => {
    if (req.header('x-relay-cli-actor-token') !== 'v1') {
      next();
      return;
    }
    const topic = typeof req.query['topic'] === 'string' ? req.query['topic'] : undefined;
    const capabilities =
      topic && Object.prototype.hasOwnProperty.call(EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES, topic)
        ? EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES[topic as EventsSubscribeTopic]
        : (['session:read'] as const);
    const validation = validateCliGatewayActorCredential(registry, {
      token: bearerActorToken(req),
      capabilities,
      scope: eventScopeFromRequest(req),
    });
    if ('reason' in validation) {
      const forbidden =
        validation.reason === 'insufficient_capability' ||
        validation.reason === 'missing_scope' ||
        validation.reason.startsWith('wrong_');
      res.status(forbidden ? 403 : 401).json({
        error: cliGatewayActorFailure({
          reason: validation.reason,
          ...(validation.credentialId !== undefined
            ? { credentialId: validation.credentialId }
            : {}),
          deniedBits: validation.deniedBits,
        }),
      });
      return;
    }
    attachAuthenticatedCliGatewayActorCredential(req, validation.credential);
    next();
  };
}

const actorRegistrySecret = (): Buffer => Buffer.from('0123456789abcdef0123456789abcdef');

interface Frame {
  event: string;
  topic?: string;
  sequence?: number;
  cursor?: string;
  replay?: boolean;
  replayDropped?: boolean;
  payload?: Record<string, unknown>;
}

interface OpenStream {
  frames: Frame[];
  status: number;
  /** Resolves once `frames` satisfies the predicate. */
  waitFor: (predicate: (frames: Frame[]) => boolean, label?: string) => Promise<void>;
  close: () => void;
}

function openStream(
  query: string,
  capabilities = 'session:read',
  extraHeaders: Record<string, string> = {}
): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/events?${query}`);
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: {
          'x-relay-cli-gateway': 'v1',
          'x-relay-capabilities': capabilities,
          accept: 'application/x-ndjson',
          ...extraHeaders,
        },
      },
      (res) => {
        const frames: Frame[] = [];
        const waiters: Array<{ predicate: (f: Frame[]) => boolean; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>= [];
        let buffer = '';

        const checkWaiters = (): void => {
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i];
            if (w && w.predicate(frames)) {
              clearTimeout(w.timer);
              waiters.splice(i, 1);
              w.resolve();
            }
          }
        };

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx = buffer.indexOf('\n');
          while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) {
              try {
                frames.push(JSON.parse(line) as Frame);
              } catch {
                /* ignore partial/non-json */
              }
            }
            idx = buffer.indexOf('\n');
          }
          checkWaiters();
        });

        const handle: OpenStream = {
          frames,
          status: res.statusCode ?? 0,
          waitFor: (predicate, label) =>
            new Promise<void>((res2, rej2) => {
              if (predicate(frames)) {
                res2();
                return;
              }
              const timer = setTimeout(() => {
                const index = waiters.findIndex((w) => w.timer === timer);
                if (index >= 0) {
                  waiters.splice(index, 1);
                }
                rej2(
                  new Error(
                    `timeout waiting for ${label ?? 'frames'}; got ${JSON.stringify(frames)}`
                  )
                );
              }, 4000);
              timer.unref?.();
              waiters.push({ predicate, resolve: res2, reject: rej2, timer });
            }),
          close: () => {
            req.destroy();
          },
        };
        resolve(handle);
      }
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function publishAttention(
  bus: CliGatewayEventBus,
  overrides: { sessionId: string; globalSessionId?: string; workContextId?: string; repoPath?: string; needsAttention?: boolean }
) {
  return bus.publish({
    topic: 'attention',
    type: 'attention.state-changed',
    sessionId: overrides.sessionId,
    ...(overrides.globalSessionId ? { globalSessionId: overrides.globalSessionId } : {}),
    ...(overrides.workContextId ? { workContextId: overrides.workContextId } : {}),
    ...(overrides.repoPath ? { repoPath: overrides.repoPath } : {}),
    payload: {
      sessionId: overrides.sessionId,
      backendState: 'permission',
      needsAttention: overrides.needsAttention ?? true,
      reasons: ['permission-prompt'],
    },
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

function issueActorHeaders(
  registry: ScopedActorCredentialRegistry,
  capabilities: readonly RelayCapabilityBit[],
  scope?: Record<string, string[]>
): Record<string, string> {
  const issued = issueCliGatewayActorCredential(registry, {
    capabilities,
    ...(scope ? { scope } : {}),
  });
  return {
    'x-relay-cli-actor-token': 'v1',
    authorization: `Bearer ${issued.token}`,
  };
}

describe('events.subscribe actor capability gating', () => {
  it('denies pr-overseer when a session-read actor self-asserts context:read', async () => {
    const bus = createCliGatewayEventBus();
    const registry = new ScopedActorCredentialRegistry({ secretBytes: actorRegistrySecret });
    await mount(bus, actorTokenAuth(registry));

    const stream = await openStream(
      'topic=pr-overseer',
      'context:read',
      issueActorHeaders(registry, ['session:read'])
    );

    expect(stream.status).toBe(403);
    stream.close();
  });

  it('allows pr-overseer when the authenticated actor actually has context:read', async () => {
    const bus = createCliGatewayEventBus();
    const registry = new ScopedActorCredentialRegistry({ secretBytes: actorRegistrySecret });
    await mount(bus, actorTokenAuth(registry));

    const stream = await openStream(
      'topic=pr-overseer',
      'context:read',
      issueActorHeaders(registry, ['context:read'], {
        taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
      })
    );

    expect(stream.status).toBe(200);
    expect(stream.frames[0]).toMatchObject({ event: 'open', topic: 'pr-overseer' });
    stream.close();
  });

  // #1428 regression: the CLI (runGatewayEventsSubscribe) always sends
  // `x-relay-cli-command: events.subscribe`, including for the
  // `native-sessions` topic. The hub gate must classify that exact header into
  // the actor lane — a remap to `sessions.native.watch` here would 401 every
  // legitimate CLI subscription. Scoping for native-sessions is enforced by
  // the sessionId grant check, not the command header.
  it('classifies the CLI events.subscribe header into the actor lane for native-sessions', () => {
    const cliRequest = {
      method: 'GET',
      header: (name: string) =>
        ({
          authorization: `Bearer relay-sac-v1.credential.token`,
          'x-relay-cli-actor-token': 'v1',
          'x-relay-cli-command': 'events.subscribe',
        })[name.toLowerCase()],
    } as unknown as Parameters<typeof classifyCliGatewayCredentialLane>[0];

    expect(classifyCliGatewayCredentialLane(cliRequest, 'events.subscribe')).toBe(
      'scoped-actor-credential'
    );
  });

  it('streams native-sessions to a scoped actor credential using CLI subscribe headers', async () => {
    const bus = createCliGatewayEventBus();
    const registry = new ScopedActorCredentialRegistry({ secretBytes: actorRegistrySecret });
    await mount(bus, actorTokenAuth(registry));

    const issued = issueCliGatewayActorCredential(registry, {
      capabilities: ['session:read'],
      scope: {
        sessionIds: ['native-fix-1'],
        taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
      },
    });
    const stream = await openStream(
      'topic=native-sessions&sessionId=native-fix-1',
      'session:read',
      {
        // Exact headers sent by runGatewayEventsSubscribe on the actor lane.
        authorization: `Bearer ${issued.token}`,
        'x-relay-cli-actor-token': 'v1',
        'x-relay-cli-command': 'events.subscribe',
      }
    );

    expect(stream.status).toBe(200);
    await stream.waitFor((f) => f.some((x) => x.event === 'open'), 'open');

    bus.publish({
      topic: 'native-sessions',
      type: 'native-session.text',
      sessionId: 'native-fix-1',
      payload: { provider: 'claude', nativeId: 'native-fix-1', kind: 'text', text: 'live tail' },
    });
    await stream.waitFor(
      (f) => f.filter((x) => x.event === 'event').length >= 1,
      'one native-sessions event'
    );
    const event = stream.frames.find((x) => x.event === 'event');
    expect(event?.topic).toBe('native-sessions');
    expect(event?.payload?.['nativeId']).toBe('native-fix-1');
    stream.close();
  });
});

describe('events.subscribe attention topic', () => {
  it('streams an open frame then live attention events', async () => {
    const bus = createCliGatewayEventBus();
    await mount(bus);
    const stream = await openStream('topic=attention');
    await stream.waitFor((f) => f.some((x) => x.event === 'open'), 'open');

    publishAttention(bus, { sessionId: 's1', globalSessionId: 'local:s1', repoPath: '/repo/a' });
    publishAttention(bus, { sessionId: 's1', globalSessionId: 'local:s1', repoPath: '/repo/a', needsAttention: false });

    await stream.waitFor(
      (f) => f.filter((x) => x.event === 'event').length >= 2,
      'two attention events'
    );
    const events = stream.frames.filter((x) => x.event === 'event');
    expect(events[0]?.topic).toBe('attention');
    expect(events[0]?.payload?.['backendState']).toBe('permission');
    // Every live attention frame carries a cursor for resume.
    expect(typeof events[0]?.cursor).toBe('string');
    expect(events[0]?.cursor).not.toEqual(events[1]?.cursor);
    stream.close();
  });

  it('applies session scope filters', async () => {
    const bus = createCliGatewayEventBus();
    await mount(bus);
    const stream = await openStream('topic=attention&sessionId=s1');
    await stream.waitFor((f) => f.some((x) => x.event === 'open'), 'open');

    publishAttention(bus, { sessionId: 's2' });
    publishAttention(bus, { sessionId: 's1' });
    publishAttention(bus, { sessionId: 's2' });

    await stream.waitFor(
      (f) => f.some((x) => x.event === 'event'),
      'an s1 event'
    );
    // Give any erroneous s2 frames a tick to (not) arrive.
    await new Promise((r) => setTimeout(r, 50));
    const events = stream.frames.filter((x) => x.event === 'event');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.['sessionId']).toBe('s1');
    stream.close();
  });

  it('filters by exact repoPath', async () => {
    const bus = createCliGatewayEventBus();
    await mount(bus);
    const stream = await openStream('topic=attention&repoPath=' + encodeURIComponent('/repo/a'));
    await stream.waitFor((f) => f.some((x) => x.event === 'open'), 'open');

    publishAttention(bus, { sessionId: 'x', repoPath: '/repo/b' });
    publishAttention(bus, { sessionId: 'y', repoPath: '/repo/a' });

    await stream.waitFor((f) => f.some((x) => x.event === 'event'), 'repo/a event');
    await new Promise((r) => setTimeout(r, 50));
    const events = stream.frames.filter((x) => x.event === 'event');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.['sessionId']).toBe('y');
    stream.close();
  });

  it('denies subscription without session:read capability', async () => {
    const bus = createCliGatewayEventBus();
    await mount(bus);
    const stream = await openStream('topic=attention', 'inbox:read');
    expect(stream.status).toBe(403);
    stream.close();
  });

  it('replays buffered events after a cursor', async () => {
    const bus = createCliGatewayEventBus();
    await mount(bus);
    const first = publishAttention(bus, { sessionId: 's1' });
    const second = publishAttention(bus, { sessionId: 's1' });

    const stream = await openStream(
      'topic=attention&cursor=' + encodeURIComponent(first.cursor)
    );
    await stream.waitFor(
      (f) => f.some((x) => x.event === 'event'),
      'replay frame'
    );
    const replayed = stream.frames.filter((x) => x.event === 'event');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.cursor).toBe(second.cursor);
    expect(replayed[0]?.replay).toBe(true);
    stream.close();
  });

  it('signals a gap (replayDropped) for an aged-out cursor', async () => {
    const bus = createCliGatewayEventBus({ maxEventsPerTopic: 1 });
    await mount(bus);
    publishAttention(bus, { sessionId: 's1' });
    publishAttention(bus, { sessionId: 's1' });

    const stream = await openStream('topic=attention&cursor=cg:0:0');
    await stream.waitFor(
      (f) => f.some((x) => x.replayDropped === true),
      'replayDropped frame'
    );
    const dropped = stream.frames.find((x) => x.replayDropped === true);
    expect(dropped?.event).toBe('open');
    stream.close();
  });
});
