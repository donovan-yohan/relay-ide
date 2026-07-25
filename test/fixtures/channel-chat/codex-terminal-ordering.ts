/**
 * Hand-sanitized Codex app-server notification shapes for #1188.
 *
 * IDs and text are synthetic; no production transcript bytes are retained.
 * These preserve only the incident-defining notification order.
 */
export interface SanitizedCodexTerminalFixture {
  name: string;
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
}

export const CODEX_TERMINAL_ORDERING_FIXTURES = {
  partialThenLateFinal: {
    name: 'partial delta, native turn boundary, late terminal item',
    notifications: [
      {
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'message-partial' } },
      },
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'message-partial', delta: 'Partial handoff' },
      },
      {
        method: 'turn/completed',
        params: { turn: { id: 'native-turn', status: 'completed' } },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: 'message-partial',
            text: 'Partial handoff completed.',
          },
        },
      },
    ],
  },
  emptyStartThenLateFinal: {
    name: 'empty start, native turn boundary, late terminal item',
    notifications: [
      {
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'message-empty' } },
      },
      {
        method: 'turn/completed',
        params: { turn: { id: 'native-turn', status: 'completed' } },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: 'message-empty',
            text: 'Synthetic terminal handoff.',
          },
        },
      },
    ],
  },
  twoItemsLastLate: {
    name: 'two legitimate outputs, last terminal item after turn boundary',
    notifications: [
      {
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'message-first' } },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: 'message-first',
            text: 'First durable output.',
          },
        },
      },
      {
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'message-last' } },
      },
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'message-last', delta: 'Last output' },
      },
      {
        method: 'turn/completed',
        params: { turn: { id: 'native-turn', status: 'completed' } },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: 'message-last',
            text: 'Last output is durable.',
          },
        },
      },
    ],
  },
} satisfies Record<string, SanitizedCodexTerminalFixture>;

/**
 * Representative sanitized replay for the three identical Codex rows observed
 * at seq 23-25. The production transcript is not retained; synthetic content
 * preserves the incident's 3x final-emission multiplicity while the stable
 * native item id preserves the required (session, turn, item) idempotency seam.
 */
export const CODEX_TRIPLE_FINAL_FIXTURE: SanitizedCodexTerminalFixture = {
  name: 'three finalize views for one native assistant item',
  notifications: [
    ...Array.from({ length: 3 }, () => [
      {
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'message-replayed' } },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          itemId: 'message-replayed',
          delta: 'Synthetic durable answer.',
        },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: 'message-replayed',
            text: 'Synthetic durable answer.',
          },
        },
      },
    ]).flat(),
    {
      method: 'turn/completed',
      params: { turn: { id: 'native-turn', status: 'completed' } },
    },
  ],
};
