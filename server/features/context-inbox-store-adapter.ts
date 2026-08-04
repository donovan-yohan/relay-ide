// #759 / ADR-019: adapter wiring the #765 gateway router's narrow
// `ContextInboxStore` seam to the concrete #758 SQLite `ContextPacketStore`.
//
// The two interfaces were authored in parallel lanes and don't line up
// mechanically. This adapter is the integration seam:
//
//   1. METHOD RENAMES — the router calls `createPacket/getPacket/listPackets`
//      and `updateInboxState`; the store exposes
//      `createContextPacket/getContextPacket/listContextPackets` and
//      `transitionInboxMessage`. The adapter forwards verbatim.
//
//   2. THROW → RESULT UNION — `transitionInboxMessage` THROWS a
//      `ContextPacketStoreError` (`inbox_message_not_found`,
//      `inbox_transition_terminal_state`, `inbox_transition_illegal_transition`),
//      but the router expects a `{ ok: false, reason }` union so it can map to a
//      gateway error code WITHOUT re-implementing the lifecycle. The adapter
//      catches and remaps (terminal → `terminal`, illegal → `invalid_transition`,
//      not-found → `not_found`); any other store error propagates (a real 500).
//
//   3. PULL-AS-DELIVERY — #758's `listInboxMessages`/`getInboxMessage` are PURE
//      reads (they do NOT flip `queued → delivered`). ADR-019 D3 makes a fetch
//      BY THE TARGET the delivery event. The adapter implements the flip on the
//      read path by calling the store's transition-guarded
//      `transitionInboxMessage(id, 'delivered')` for any `queued` row whose
//      target matches the fetch filter. Idempotent: re-fetching a
//      `delivered`/`acknowledged`/terminal row is a no-op (the transition guard's
//      same-state idempotence + forward-only rule make a redundant flip safe, and
//      we only attempt it for `queued` rows). NEVER pushed via `sessions.input`.
//
// The `actorId` the router forwards is threaded into the store's
// `transitionInboxMessage(id, to, transitionedBy)`, which records it blob-only on
// the message (`transitionedBy`, mirroring `ignoredAt` — no denormalized column).
// This attributes WHO acked/resolved/ignored a message. Full ADR-019 hash-chained
// audit of inbox transitions (parity with #499 PTY intervention envelopes) remains
// a follow-up; this is the minimal attribution the transition needs today.

import type {
  ContextPacketStore,
  ContextPacketStoreError as ContextPacketStoreErrorType,
} from '../context-packets.js';
import { ContextPacketStoreError } from '../context-packets.js';
import type {
  ContextInboxStore,
  CreateContextPacketInput,
  CreateInboxMessageInput,
  ListContextPacketsFilter,
  ListInboxMessagesFilter,
  UpdateInboxStateResult,
} from './context-inbox-router.js';
import type {
  ContextPacket,
  ContextPacketId,
  SessionInboxMessage,
  SessionInboxMessageId,
  SessionInboxMessageState,
} from '../../shared/context-packet.js';

function isStoreError(err: unknown): err is ContextPacketStoreErrorType {
  return err instanceof ContextPacketStoreError;
}

/**
 * Map a thrown `ContextPacketStoreError.code` from `transitionInboxMessage` onto
 * the router's `{ ok: false, reason }` union. Returns `null` for codes that are
 * NOT lifecycle failures (those should propagate as real errors / 500s).
 */
function remapTransitionFailure(
  err: ContextPacketStoreErrorType,
  currentState: SessionInboxMessageState | undefined
): Exclude<UpdateInboxStateResult, { ok: true }> | null {
  switch (err.code) {
    case 'inbox_message_not_found':
      return { ok: false, reason: 'not_found' };
    case 'inbox_transition_terminal_state':
      // `currentState` is always available here: the row exists (we read it just
      // before transitioning), it's the terminal state itself.
      return {
        ok: false,
        reason: 'terminal',
        currentState: currentState ?? 'resolved',
      };
    case 'inbox_transition_illegal_transition':
      return {
        ok: false,
        reason: 'invalid_transition',
        currentState: currentState ?? 'queued',
      };
    default:
      return null;
  }
}

/**
 * Flip a freshly-read message to `delivered` IF it is `queued` and addressed to
 * the fetch's target. Returns the (possibly transitioned) message. The flip goes
 * through the store's transition-guarded `transitionInboxMessage`, so a
 * concurrent ack/resolve that raced ahead of us cannot be clobbered: a no-longer-
 * `queued` row is left untouched, and a terminal-state throw is swallowed (the
 * read still returns the row in its real current state).
 */
function deliverOnPull(
  store: ContextPacketStore,
  message: SessionInboxMessage
): SessionInboxMessage {
  if (message.state !== 'queued') return message;
  try {
    return store.transitionInboxMessage(message.id, 'delivered');
  } catch (err) {
    // A race (the row moved out of `queued` between our read and the flip) or a
    // terminal-state guard rejection: the read is still valid, return what we
    // have. Re-read to reflect the racing writer's state.
    if (isStoreError(err)) {
      return store.getInboxMessage(message.id) ?? message;
    }
    throw err;
  }
}

/**
 * Build the #765 `ContextInboxStore` over the concrete #758 `ContextPacketStore`.
 * Pure wiring: no new persistence, no new lifecycle rules — the store remains
 * the single authority on the transition machine.
 */
export function createContextInboxStoreAdapter(
  store: ContextPacketStore
): ContextInboxStore {
  return {
    createPacket(input: CreateContextPacketInput): ContextPacket {
      return store.createContextPacket({
        kind: input.kind,
        ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
        ...(input.fileRef !== undefined ? { fileRef: input.fileRef } : {}),
        ...(input.artifactRef !== undefined
          ? { artifactRef: input.artifactRef }
          : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.binding !== undefined ? { binding: input.binding } : {}),
        createdBy: input.createdBy,
      });
    },

    getPacket(id: ContextPacketId): ContextPacket | null {
      return store.getContextPacket(id);
    },

    listPackets(filter?: ListContextPacketsFilter): ContextPacket[] {
      return store.listContextPackets({
        ...(filter?.nodeId !== undefined ? { nodeId: filter.nodeId } : {}),
        ...(filter?.workspaceId !== undefined
          ? { workspaceId: filter.workspaceId }
          : {}),
        ...(filter?.limit !== undefined ? { limit: filter.limit } : {}),
      });
    },

    createInboxMessage(input: CreateInboxMessageInput): SessionInboxMessage {
      return store.createInboxMessage({
        ...(input.targetSessionId
          ? { targetSessionId: input.targetSessionId }
          : {}),
        ...(input.targetWorkContextId
          ? { targetWorkContextId: input.targetWorkContextId }
          : {}),
        contextPacketIds: input.contextPacketIds,
        ...(input.text !== undefined ? { text: input.text } : {}),
        createdBy: input.createdBy,
      });
    },

    // PULL delivery: reading a queued message flips it to delivered (ADR-019 D3)
    // unless a sender-side preview explicitly opts out.
    listInboxMessages(
      filter: ListInboxMessagesFilter,
      options: { markDelivered?: boolean } = {}
    ): SessionInboxMessage[] {
      const messages = store.listInboxMessages({
        ...(filter.targetSessionId
          ? { targetSessionId: filter.targetSessionId }
          : {}),
        ...(filter.targetWorkContextId
          ? { targetWorkContextId: filter.targetWorkContextId }
          : {}),
        ...(filter.state ? { state: filter.state } : {}),
      });
      const visible =
        filter.limit !== undefined ? messages.slice(0, filter.limit) : messages;
      return options.markDelivered === false
        ? visible
        : visible.map((m) => deliverOnPull(store, m));
    },

    // PULL delivery: getting a queued message by id flips it to delivered unless
    // a sender-side preview explicitly opts out.
    getInboxMessage(
      id: SessionInboxMessageId,
      options: { markDelivered?: boolean } = {}
    ): SessionInboxMessage | null {
      const message = store.getInboxMessage(id);
      if (!message) return null;
      if (options.markDelivered === false) return message;
      return deliverOnPull(store, message);
    },

    updateInboxState(
      id: SessionInboxMessageId,
      targetState: SessionInboxMessageState,
      actorId?: string
    ): UpdateInboxStateResult {
      // Read the current state first so a terminal/illegal rejection can report
      // it without a second round trip after the throw.
      const before = store.getInboxMessage(id);
      try {
        // Forward the actor performing the ack/resolve/ignore so the store records
        // WHO advanced the message (blob-only `transitionedBy`).
        const message = store.transitionInboxMessage(id, targetState, actorId);
        return { ok: true, message };
      } catch (err) {
        if (isStoreError(err)) {
          const mapped = remapTransitionFailure(err, before?.state);
          if (mapped) return mapped;
        }
        throw err;
      }
    },
  };
}
