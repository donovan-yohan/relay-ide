import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import {
  EVENTS_SUBSCRIBE_TOPICS,
  EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES,
  type EventsSubscribeTopic,
} from '../shared/cli-gateway-contract.js';
import type { TabControlEvent } from '../shared/control-state.js';
import type { HubNodeStatusEvent } from './hub-node-registry.js';
import {
  authenticatedCliGatewayActorCredential,
  isCliGatewayActorTokenRequest,
} from './cli-gateway-actor-auth.js';
import {
  eventMatchesFilter,
  type CliGatewayEventBus,
  type CliGatewayEventFilter,
  type CliGatewayMetadataEvent,
  type CliGatewayMetadataTopic,
} from './cli-gateway-event-bus.js';

const ALLOWED_TOPICS: readonly EventsSubscribeTopic[] = EVENTS_SUBSCRIBE_TOPICS;

function isAllowedTopic(value: string | undefined): value is EventsSubscribeTopic {
  return typeof value === 'string' && (ALLOWED_TOPICS as readonly string[]).includes(value);
}

function parseCapabilityHeader(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function validatedRequestCapabilities(req: Request): Set<string> {
  const actorCredential = authenticatedCliGatewayActorCredential(req);
  if (actorCredential) return new Set(actorCredential.capabilities);
  if (isCliGatewayActorTokenRequest(req)) return new Set();
  return parseCapabilityHeader(req.header('x-relay-capabilities'));
}

export interface CliGatewayEventsHooks {
  /** Subscribe to session lifecycle (create/end). Return an unsubscribe fn. */
  onSessionCreate: (
    cb: (sessionId: string, cwd: string, branchName?: string) => void
  ) => () => void;
  onSessionEnd: (
    cb: (sessionId: string, cwd: string, branchName?: string) => void
  ) => () => void;
  /** Subscribe to control-mode and intervention envelopes. Return an unsubscribe fn. */
  onControlEvent: (cb: (event: TabControlEvent) => void) => () => void;
  /** Subscribe to hub-managed node link status transitions. Return an unsubscribe fn. */
  onNodeStatus: (cb: (event: HubNodeStatusEvent) => void) => () => void;
}

export interface CliGatewayEventsRouterOptions {
  cliGatewayAuth: RequestHandler;
  hooks: CliGatewayEventsHooks;
  eventBus?: CliGatewayEventBus;
  /** Optional now() override for deterministic tests. */
  now?: () => Date;
}

function isMetadataTopic(topic: EventsSubscribeTopic): topic is CliGatewayMetadataTopic {
  return (
    topic === 'context' ||
    topic === 'inbox' ||
    topic === 'attention' ||
    topic === 'work-context-artifacts' ||
    topic === 'handoff-artifacts' ||
    topic === 'workflow-runs' ||
    topic === 'automation-runs' ||
    topic === 'pr-overseer'
  );
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface SubscriberHandle {
  res: Response;
  topic: EventsSubscribeTopic;
  unsubscribe: () => void;
}

function writeNdjson(res: Response, frame: Record<string, unknown>): boolean {
  return res.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Redacted event envelope for the `audit` topic. We surface ids, types, timing,
 * and actor identity but never raw intervention payloads or raw bytes.
 * Hash-chained audit storage lives in #470/#499; the streaming surface here is
 * a non-destructive read view, not a hash-chain replay channel.
 */
function redactedAuditPayload(event: TabControlEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: event.type,
    eventId: event.eventId,
    sessionId: event.identity.sessionId,
    nodeId: event.identity.nodeId,
    actor: { kind: event.actor.kind, ...(event.actor.id ? { id: event.actor.id } : {}) },
  };
  if (event.type === 'tab.mode-changed') {
    base['previousControlMode'] = event.previousControlMode;
    base['controlMode'] = event.controlMode;
  } else {
    base['controlMode'] = event.controlMode;
    base['interventionKind'] = event.intervention.kind;
    base['source'] = event.intervention.source;
    // Bounded redaction metadata only; never raw payload bytes.
    base['redaction'] = {
      redacted: event.intervention.redaction.redacted,
      byteCount: event.intervention.redaction.byteCount,
      charCount: event.intervention.redaction.charCount,
      lineCount: event.intervention.redaction.lineCount,
      classes: event.intervention.redaction.classes,
    };
  }
  return base;
}

function sessionsPayload(
  kind: 'session.started' | 'session.ended' | 'tab.mode-changed' | 'tab.intervention',
  data: Record<string, unknown>
): Record<string, unknown> {
  return { type: kind, ...data };
}

function nodePayload(event: HubNodeStatusEvent): Record<string, unknown> {
  return {
    type: `node.${event.status}`,
    nodeId: event.nodeId,
    status: event.status,
    lastSeenAt: event.lastSeenAt,
  };
}

function metadataEventFrame(
  topic: CliGatewayMetadataTopic,
  sequence: number,
  event: CliGatewayMetadataEvent,
  replay?: true
): Record<string, unknown> {
  return {
    event: 'event',
    topic,
    sequence,
    occurredAt: event.occurredAt,
    cursor: event.cursor,
    ...(replay ? { replay } : {}),
    payload: {
      type: event.type,
      ...event.payload,
      redaction: event.redaction,
    },
  };
}

export function createCliGatewayEventsRouter(
  expressInstance: typeof express,
  options: CliGatewayEventsRouterOptions
): express.Router {
  const router = expressInstance.Router();
  const now = options.now ?? (() => new Date());

  router.get('/events', options.cliGatewayAuth, (req: Request, res: Response) => {
    if (req.header('x-relay-cli-gateway') !== 'v1') {
      // Reserved for v1 gateway clients; browsers use the WebSocket bus.
      res.status(400).json({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'events stream requires x-relay-cli-gateway: v1',
          retryable: false,
        },
      });
      return;
    }

    const topicParam = typeof req.query['topic'] === 'string' ? req.query['topic'] : undefined;
    if (!isAllowedTopic(topicParam)) {
      res.status(400).json({
        error: {
          code: 'INVALID_ARGUMENT',
          message: `unknown topic; allowed: ${ALLOWED_TOPICS.join(', ')}`,
          retryable: false,
          details: {
            field: 'topic',
            ...(topicParam !== undefined ? { value: topicParam } : {}),
            allowed: [...ALLOWED_TOPICS],
          },
        },
      });
      return;
    }
    const topic: EventsSubscribeTopic = topicParam;

    const capabilities = validatedRequestCapabilities(req);
    const required = EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES[topic];
    const missing = required.filter((cap) => !capabilities.has(cap));
    if (missing.length > 0) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `missing required capability: ${missing.join(', ')}`,
          retryable: false,
          details: { capability: missing[0], topic },
        },
      });
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    let sequence = 0;
    writeNdjson(res, {
      event: 'open',
      topic,
      sequence: sequence++,
      occurredAt: now().toISOString(),
    });

    // Subscriber bookkeeping is declared before `emit` so the backpressure
    // path doesn't depend on the `handle` binding (which is initialized
    // further down). A hook that fires synchronously on registration would
    // otherwise hit a TDZ ReferenceError.
    const subs: Array<() => void> = [];
    const unsubscribeAll = (): void => {
      while (subs.length) {
        const fn = subs.pop();
        try {
          fn?.();
        } catch {
          /* swallow individual listener cleanup errors */
        }
      }
    };

    const emit = (payload: Record<string, unknown>): void => {
      const ok = writeNdjson(res, {
        event: 'event',
        topic,
        sequence: sequence++,
        occurredAt: now().toISOString(),
        payload,
      });
      if (!ok) {
        // Backpressure — drop subscriber.
        try {
          unsubscribeAll();
        } catch {
          /* unsubscribing */
        }
        try {
          res.end();
        } catch {
          /* ending */
        }
      }
    };

    if (isMetadataTopic(topic)) {
      if (!options.eventBus) {
        res.statusCode = 503;
        writeNdjson(res, {
          event: 'error',
          topic,
          sequence: sequence++,
          occurredAt: now().toISOString(),
          payload: { code: 'SERVER_UNAVAILABLE', message: 'metadata event bus is unavailable' },
        });
        res.end();
        return;
      }
      const filter: CliGatewayEventFilter = {};
      const workContextId = queryString(req, 'workContextId');
      const sessionId = queryString(req, 'sessionId');
      const globalSessionId = queryString(req, 'globalSessionId');
      const repoPath = queryString(req, 'repoPath');
      if (workContextId) filter.workContextId = workContextId;
      if (sessionId) filter.sessionId = sessionId;
      if (globalSessionId) filter.globalSessionId = globalSessionId;
      if (repoPath) filter.repoPath = repoPath;
      const replay = options.eventBus.replay(topic, queryString(req, 'cursor'));
      if (replay.replayDropped) {
        // Gap/drop signal: the requested cursor fell out of the bounded replay
        // buffer. The consumer must treat its local view as stale and may have
        // missed frames between its cursor and the oldest buffered event.
        writeNdjson(res, {
          event: 'open',
          topic,
          sequence: sequence++,
          occurredAt: now().toISOString(),
          replayDropped: true,
        });
      }
      for (const event of replay.events) {
        if (!eventMatchesFilter(event, filter)) continue;
        writeNdjson(res, metadataEventFrame(topic, sequence++, event, true));
      }
      subs.push(
        options.eventBus.subscribe(topic, (event) => {
          if (!eventMatchesFilter(event, filter)) return;
          const ok = writeNdjson(res, metadataEventFrame(topic, sequence++, event));
          if (!ok) {
            // Backpressure — the socket buffer is full. Drop the subscriber
            // rather than grow memory unbounded; the consumer resumes from its
            // last seen cursor on reconnect.
            unsubscribeAll();
            try {
              res.end();
            } catch {
              /* ending */
            }
          }
        })
      );
    } else if (topic === 'sessions') {
      subs.push(
        options.hooks.onSessionCreate((sessionId, cwd, branchName) => {
          emit(
            sessionsPayload('session.started', {
              sessionId,
              cwd,
              ...(branchName ? { branchName } : {}),
            })
          );
        })
      );
      subs.push(
        options.hooks.onSessionEnd((sessionId, cwd, branchName) => {
          emit(
            sessionsPayload('session.ended', {
              sessionId,
              cwd,
              ...(branchName ? { branchName } : {}),
            })
          );
        })
      );
      subs.push(
        options.hooks.onControlEvent((event) => {
          if (event.type === 'tab.mode-changed') {
            emit(
              sessionsPayload('tab.mode-changed', {
                sessionId: event.identity.sessionId,
                nodeId: event.identity.nodeId,
                previousControlMode: event.previousControlMode,
                controlMode: event.controlMode,
              })
            );
          }
        })
      );
    } else if (topic === 'nodes') {
      subs.push(
        options.hooks.onNodeStatus((event) => {
          emit(nodePayload(event));
        })
      );
    } else if (topic === 'audit') {
      subs.push(
        options.hooks.onControlEvent((event) => {
          emit(redactedAuditPayload(event));
        })
      );
    }

    const handle: SubscriberHandle = {
      res,
      topic,
      unsubscribe: unsubscribeAll,
    };

    req.on('close', () => {
      handle.unsubscribe();
      try {
        res.end();
      } catch {
        /* already ended */
      }
    });
  });

  return router;
}
