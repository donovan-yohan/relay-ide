import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import {
  channelAsyncRunMatchesSubscriptionFilter,
  channelMessageMatchesSubscriptionFilter,
  channelSubscriptionFilterValidationError,
  normalizeChannelSubscriptionFilter,
  type ChannelEventV1,
  type ChannelSubscriptionFilter,
} from '../shared/channel-chat-protocol.js';
import { projectRelayChannelPublicValue } from '../shared/channel-client.js';
import { authenticatedCliGatewayActorCredential } from './cli-gateway-actor-auth.js';
import { authenticatedOperatorClientCredential } from './operator-client-auth.js';
import type {
  ChannelEventSink,
  ChannelHub,
  ChannelSubscriptionCloseReason,
} from './channel-hub.js';

const CONTEXT_READ = 'context:read';
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_WRITABLE_HARD_LIMIT_BYTES = 4 * 1024 * 1024;

export interface ChannelSubscriptionRouterDeps {
  hub: ChannelHub;
  /**
   * The index-owned v1 actor-auth gate. It must bind this route to the
   * `channels.subscribe` command before this handler runs.
   */
  requireSubscribeAuth: RequestHandler;
  now?: () => Date;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  writableHardLimitBytes?: number;
  /** Deterministic test seam; production uses ServerResponse.write directly. */
  writeResponse?: (res: Response, data: string) => boolean;
  /** Rechecked immediately before every streamed frame (including heartbeats). */
  isStillAuthorized?: (req: Request, channelId: string) => boolean;
}

export interface ChannelSubscriptionFrame {
  schemaVersion: 1;
  frame: 'open' | 'event' | 'closed';
  channelId: string;
  sequence: number;
  occurredAt: string;
  /**
   * Exclusive durable cursor safe to supply as `afterSeq` on reconnect. It is
   * present on every frame and only advances from a committed row/safe replay;
   * streaming deltas and heartbeats repeat the last value unchanged.
   */
  durableSeq: number;
  /** Channel event payloads are authoritative rows; heartbeat is explicitly ephemeral. */
  payload?: ChannelEventV1 | { type: 'channel-heartbeat-v1' };
  reason?:
    | 'not-found'
    | 'backpressure'
    | 'transport-closed'
    | 'authorization-revoked';
  retryable?: boolean;
  latestSeq?: number;
}

function queryAfterSeq(req: Request): number | null | 'invalid' {
  const value = req.query['afterSeq'];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return 'invalid';
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

const SUBSCRIPTION_QUERY_KEYS = new Set([
  'afterSeq',
  'threadId',
  'messageId',
  'senderId',
  'mentionTargetId',
  'status',
  'runId',
  'terminalOnly',
  'principalOnly',
]);

/** Decode the authenticated boundary once; duplicate/unknown keys fail closed. */
function querySubscriptionFilter(
  req: Request
): ChannelSubscriptionFilter | 'invalid' {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (!SUBSCRIPTION_QUERY_KEYS.has(key) || Array.isArray(value))
      return 'invalid';
    if (key === 'afterSeq') continue;
    if (typeof value !== 'string') return 'invalid';
    if (key === 'terminalOnly' || key === 'principalOnly') {
      if (value === 'true') raw[key] = true;
      else if (value === 'false') raw[key] = false;
      else return 'invalid';
    } else {
      raw[key] = value;
    }
  }
  return channelSubscriptionFilterValidationError(raw) === undefined
    ? normalizeChannelSubscriptionFilter(raw as ChannelSubscriptionFilter)
    : 'invalid';
}

function filterIsEmpty(filter: ChannelSubscriptionFilter): boolean {
  return Object.keys(filter).length === 0;
}

/**
 * Preserve hub control and snapshot metadata while removing only row payloads.
 * Cursor advancement happens before this function, from the original event.
 */
function projectEvent(
  event: ChannelEventV1,
  filter: ChannelSubscriptionFilter
): ChannelEventV1 | null {
  if (event.type !== 'channel-snapshot-v1' && filterIsEmpty(filter)) {
    return event;
  }
  switch (event.type) {
    case 'channel-snapshot-v1': {
      if (filterIsEmpty(filter)) {
        return event;
      }
      return {
        ...event,
        messages: event.messages.filter((message) =>
          channelMessageMatchesSubscriptionFilter(message, filter)
        ),
        ...(event.stateReplacements === undefined
          ? {}
          : {
              // Replacements are state mutations, not new deliveries. They
              // still obey semantic visibility, so a filtered consumer never
              // receives a row it would not be allowed to observe.
              stateReplacements: event.stateReplacements.filter((replacement) =>
                channelMessageMatchesSubscriptionFilter(
                  replacement.message,
                  filter
                )
              ),
            }),
        ...(event.runs === undefined
          ? {}
          : {
              runs: event.runs.filter((run) =>
                channelAsyncRunMatchesSubscriptionFilter(run, filter)
              ),
            }),
        // Semantic filters suppress deltas, so carrying an unfiltered in-flight
        // reference would point at rows the actor never received.
        inFlight: [],
      };
    }
    case 'channel-message-created-v1':
    case 'channel-message-updated-v1':
    case 'channel-message-completed-v1':
    case 'channel-message-edited-v1':
    case 'channel-message-deleted-v1':
      return channelMessageMatchesSubscriptionFilter(event.message, filter)
        ? event
        : null;
    case 'channel-message-delta-v1':
      // A delta has no durable row to evaluate and can expose provider/tool
      // output, so a semantic projection never forwards it.
      return null;
    case 'channel-run-lifecycle-v1':
      return channelAsyncRunMatchesSubscriptionFilter(event.run, filter)
        ? event
        : null;
    case 'channel-delivery-receipt-v1':
      // Receipts are content-free operational signals (ids, state, timestamps),
      // not message rows: semantic projection forwards them unchanged.
      return event;
    case 'channel-resync-required-v1':
      return event;
  }
}

function requestHasContextRead(req: Request): boolean {
  const actor = authenticatedCliGatewayActorCredential(req);
  if (actor) return actor.capabilities.includes(CONTEXT_READ);
  const operatorClient = authenticatedOperatorClientCredential(req);
  if (operatorClient) return operatorClient.capabilities.includes(CONTEXT_READ);
  return (req.header('x-relay-capabilities') ?? '')
    .split(/[\s,]+/)
    .some((capability) => capability === CONTEXT_READ);
}

function actorMayReadChannel(req: Request, channelId: string): boolean {
  const actor = authenticatedCliGatewayActorCredential(req);
  // Browser/session clients retain their established access lane. A scoped
  // actor with no channelIds is deliberately fail-closed for this enumeration
  // capable, long-lived route.
  if (actor) return actor.scope?.channelIds?.includes(channelId) === true;
  const operatorClient = authenticatedOperatorClientCredential(req);
  return (
    !operatorClient ||
    !operatorClient.scope.channelIds ||
    operatorClient.scope.channelIds.includes(channelId)
  );
}

function advanceDurableCursor(current: number, event: ChannelEventV1): number {
  if (event.type === 'channel-message-created-v1') {
    // A live gap must never become the next resume cursor. The existing client
    // reducer will request catch-up; keep the last contiguous durable row here.
    return event.message.seq === current + 1 ? event.message.seq : current;
  }
  if (event.type !== 'channel-snapshot-v1') return current;
  if (!event.truncated) return event.latestSeq;

  // A byte/row-truncated snapshot may advertise a head beyond omitted rows.
  // Advance only through the contiguous committed prefix actually carried by
  // the frame. Resync rows at/below the cursor are replacements, not progress.
  let contiguous = event.mode === 'catchup' ? current : 0;
  const freshSeqs = [...new Set(event.messages.map((message) => message.seq))]
    .filter((seq) => seq > contiguous)
    .sort((a, b) => a - b);
  for (const seq of freshSeqs) {
    if (seq !== contiguous + 1) break;
    contiguous = seq;
  }
  return contiguous;
}

function sendError(
  res: Response,
  status: number,
  code: 'INVALID_ARGUMENT' | 'FORBIDDEN' | 'NOT_FOUND',
  message: string,
  details?: Record<string, unknown>
): void {
  res.status(status).json({
    error: { code, message, retryable: false, ...(details ? { details } : {}) },
  });
}

/**
 * Durable channel subscription endpoint.  It intentionally emits NDJSON (not
 * browser SSE): bearer auth is ordinary HTTP, consumers can parse frames from
 * any harness, and the payload stays identical to the existing WebSocket
 * channel protocol. The channel hub owns replay/live handoff and limits.
 */
export function createChannelSubscriptionRouter(
  deps: ChannelSubscriptionRouterDeps
): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const writableHardLimitBytes =
    deps.writableHardLimitBytes ?? DEFAULT_WRITABLE_HARD_LIMIT_BYTES;
  const writeResponse = deps.writeResponse ?? ((res, data) => res.write(data));
  const isStillAuthorized = deps.isStillAuthorized ?? (() => true);

  router.get(
    '/channels/:id/subscribe',
    deps.requireSubscribeAuth,
    (req, res) => {
      if (req.header('x-relay-cli-gateway') !== 'v1') {
        sendError(
          res,
          400,
          'INVALID_ARGUMENT',
          'channel subscription requires x-relay-cli-gateway: v1'
        );
        return;
      }
      const channelId = req.params['id'] ?? '';
      const afterSeq = queryAfterSeq(req);
      if (afterSeq === 'invalid') {
        sendError(
          res,
          400,
          'INVALID_ARGUMENT',
          'afterSeq must be a non-negative safe integer',
          { field: 'afterSeq' }
        );
        return;
      }
      const filter = querySubscriptionFilter(req);
      if (filter === 'invalid') {
        sendError(
          res,
          400,
          'INVALID_ARGUMENT',
          'subscription filter has an invalid value'
        );
        return;
      }
      if (!requestHasContextRead(req)) {
        sendError(
          res,
          403,
          'FORBIDDEN',
          'missing required capability: context:read',
          {
            capability: CONTEXT_READ,
          }
        );
        return;
      }
      if (!actorMayReadChannel(req, channelId)) {
        sendError(
          res,
          403,
          'FORBIDDEN',
          'actor is not scoped to this channel',
          {
            channelId,
            reasonCode: 'CHANNEL_OUT_OF_SCOPE',
          }
        );
        return;
      }
      // Avoid committing response headers for an id the hub already knows is
      // absent. This is a read-only preflight; registration below remains the
      // authoritative race-free replay/live operation.
      if (!deps.hub.channelExists(channelId)) {
        sendError(res, 404, 'NOT_FOUND', 'channel not found', { channelId });
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('cache-control', 'no-store, no-transform');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();

      let sequence = 0;
      let ended = false;
      let waitingForDrain = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let drainDeadline: NodeJS.Timeout | undefined;
      let durableSeq = afterSeq ?? 0;
      const sinkCloseHandlers = new Set<() => void>();

      const writeFrame = (frame: ChannelSubscriptionFrame): boolean => {
        if (ended || res.destroyed || res.writableEnded) return false;
        if (res.writableLength > writableHardLimitBytes) {
          finish('backpressure', undefined, true);
          return false;
        }
        const accepted = writeResponse(res, `${JSON.stringify(frame)}\n`);
        if (res.writableLength > writableHardLimitBytes) {
          finish('backpressure', undefined, true);
          return false;
        }
        if (!accepted && !waitingForDrain) {
          waitingForDrain = true;
          res.once('drain', onDrain);
          drainDeadline = setTimeout(() => {
            // The bytes that crossed the stream high-water mark were accepted,
            // but they cannot remain retained forever on an idle channel.
            finish('backpressure', undefined, true);
          }, drainTimeoutMs);
          drainDeadline.unref?.();
        }
        // Node accepted the bytes even when it returned false. The hub observes
        // writableLength via bufferedAmount and applies its 1/4MB watermarks;
        // no route-level replay queue is introduced.
        return true;
      };

      const onDrain = (): void => {
        waitingForDrain = false;
        if (drainDeadline) clearTimeout(drainDeadline);
        drainDeadline = undefined;
      };

      const cleanup = (): void => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        if (drainDeadline) clearTimeout(drainDeadline);
        drainDeadline = undefined;
        res.off('drain', onDrain);
        req.off('aborted', onTransportClosed);
        req.off('error', onTransportClosed);
        req.off('close', onRequestClosed);
        res.off('close', onTransportClosed);
        res.off('error', onTransportClosed);
        const current = unsubscribe;
        unsubscribe = undefined;
        current?.();
        sinkCloseHandlers.clear();
      };

      const onTransportClosed = (): void => {
        if (ended) return;
        ended = true;
        for (const handler of [...sinkCloseHandlers]) handler();
        sinkCloseHandlers.clear();
        cleanup();
      };

      const onRequestClosed = (): void => {
        // IncomingMessage emits close after a normally completed GET request on
        // current Node versions. Only treat it as transport loss when aborted
        // or when the response/socket is also closed.
        if (req.aborted || res.destroyed || res.writableEnded) {
          onTransportClosed();
        }
      };

      const finish = (
        reason: NonNullable<ChannelSubscriptionFrame['reason']>,
        latestSeq?: number,
        retryable = reason === 'backpressure' || reason === 'transport-closed'
      ): void => {
        if (ended) return;
        ended = true;
        cleanup();
        // A client that is already backpressured cannot reliably consume a
        // closing frame; it still gets a bounded EOF and resumes from its last
        // durable cursor. Healthy clients receive an explicit reconnect cause.
        if (!res.destroyed && !res.writableEnded) {
          try {
            res.write(
              `${JSON.stringify({
                frame: 'closed',
                schemaVersion: 1,
                channelId,
                sequence: sequence++,
                occurredAt: now().toISOString(),
                durableSeq,
                reason,
                retryable,
                ...(latestSeq === undefined ? {} : { latestSeq }),
              } satisfies ChannelSubscriptionFrame)}\n`
            );
          } catch {
            /* closing a failed transport */
          }
        }
        try {
          res.end();
        } catch {
          /* response already closed */
        }
      };

      const sink: ChannelEventSink = {
        get ready() {
          return (
            !ended && !req.destroyed && !res.destroyed && !res.writableEnded
          );
        },
        get bufferedAmount() {
          return res.writableLength;
        },
        send(event) {
          if (!isStillAuthorized(req, channelId)) {
            finish('authorization-revoked');
            return false;
          }
          if (waitingForDrain) {
            finish('backpressure', undefined, true);
            return false;
          }
          // This is intentionally before projection. A filtered subscription is
          // a view over the same durable log, never a second cursor domain.
          durableSeq = advanceDurableCursor(durableSeq, event);
          const projected = projectEvent(event, filter);
          if (!projected) return true;
          const payload = authenticatedOperatorClientCredential(req)
            ? (projectRelayChannelPublicValue(projected) as ChannelEventV1)
            : projected;
          return writeFrame({
            frame: 'event',
            schemaVersion: 1,
            channelId,
            sequence: sequence++,
            occurredAt: now().toISOString(),
            payload,
            durableSeq,
          });
        },
        close(reason: ChannelSubscriptionCloseReason) {
          finish(
            reason.code,
            reason.code === 'backpressure' ? reason.latestSeq : undefined
          );
        },
        onClose(handler) {
          sinkCloseHandlers.add(handler);
        },
      };

      req.once('aborted', onTransportClosed);
      req.once('error', onTransportClosed);
      req.once('close', onRequestClosed);
      res.once('close', onTransportClosed);
      res.once('error', onTransportClosed);

      if (
        !writeFrame({
          frame: 'open',
          schemaVersion: 1,
          channelId,
          sequence: sequence++,
          occurredAt: now().toISOString(),
          durableSeq,
        })
      ) {
        finish('transport-closed');
        return;
      }

      unsubscribe = deps.hub.subscribe(sink, { channelId, afterSeq });
      if (!sink.ready) {
        cleanup();
        return;
      }
      // Heartbeats have no channel event or durable cursor. They keep proxy
      // idle timers from silently severing an otherwise healthy subscription.
      heartbeat = setInterval(() => {
        if (!isStillAuthorized(req, channelId)) {
          finish('authorization-revoked');
          return;
        }
        // Heartbeats are disposable liveness signals. Never append them to a
        // response already above its high-water mark; the drain deadline owns
        // bounded termination if the client never resumes reading.
        if (waitingForDrain) return;
        writeFrame({
          frame: 'event',
          schemaVersion: 1,
          channelId,
          sequence: sequence++,
          occurredAt: now().toISOString(),
          durableSeq,
          payload: { type: 'channel-heartbeat-v1' },
        });
      }, heartbeatMs);
      heartbeat.unref?.();
    }
  );

  return router;
}
