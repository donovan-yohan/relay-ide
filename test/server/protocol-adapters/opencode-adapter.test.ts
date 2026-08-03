import { describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';
import { OpenCodeProtocolAdapter } from '../../../server/protocol-adapters/opencode-adapter.js';
import { OpenCodeAttachedAdapter } from '../../../server/protocol-adapters/opencode-attached-adapter.js';
import { mapChatEventToAgentPatchV2 } from '../../../shared/agent-chat-v1-compat.js';
import type { ChatEvent } from '../../../shared/agent-chat-protocol.js';

interface OpenCodeEventLike {
  type: string;
  properties?: Record<string, unknown>;
}

/** Drive the adapter's real SSE event dispatcher and collect what it fires. */
function driveOpenCodeEvent(
  adapter: OpenCodeProtocolAdapter | OpenCodeAttachedAdapter,
  event: OpenCodeEventLike
): ChatEvent[] {
  const seen: ChatEvent[] = [];
  const off = adapter.on((chatEvent) => {
    seen.push(chatEvent);
  });
  (
    adapter as unknown as { mapOpenCodeEvent(event: OpenCodeEventLike): void }
  ).mapOpenCodeEvent(event);
  off();
  return seen;
}

describe('OpenCode V2 web adapter registration', () => {
  it('registers opencode as a ProtocolAdapterV2 bridge while native mapping is ported', () => {
    const adapter = createAdapterV2('opencode');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('opencode');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      interrupt: true,
      telemetry: true,
      streaming: true,
    });
  });

  it('registers opencode-attached as a ProtocolAdapterV2 bridge', () => {
    const adapter = createAdapterV2('opencode-attached');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('opencode');
    expect(adapter.capabilities).toMatchObject({ streaming: true });
  });
});

// The `streaming` bit means "this adapter emits live `agent-item-delta-v2`
// patches". Advertising it without the emission would repeat the hermes
// `telemetry` trap (event fired, no compat mapping, silently dropped), so both
// halves are asserted against the real code path rather than the literal.
describe('OpenCode streaming capability is backed by real deltas', () => {
  it('fires chat:text-delta from the web adapter and maps it to a V2 delta patch', () => {
    const adapter = new OpenCodeProtocolAdapter();
    const events = driveOpenCodeEvent(adapter, {
      type: 'message.part.updated',
      properties: {
        part: { type: 'text', id: 'part-1', messageID: 'msg-1', text: 'hel' },
        delta: 'hel',
      },
    });

    const delta = events.find((event) => event.type === 'chat:text-delta');
    expect(delta).toMatchObject({ type: 'chat:text-delta', delta: 'hel' });

    const patches = mapChatEventToAgentPatchV2(delta!);
    expect(patches.map((patch) => patch.type)).toContain(
      'agent-item-delta-v2'
    );
  });

  it('fires chat:text-delta from the attached adapter and maps it to a V2 delta patch', () => {
    const adapter = new OpenCodeAttachedAdapter();
    const events = driveOpenCodeEvent(adapter, {
      type: 'message.part.updated',
      properties: { delta: 'lo world' },
    });

    const delta = events.find((event) => event.type === 'chat:text-delta');
    expect(delta).toMatchObject({ type: 'chat:text-delta', delta: 'lo world' });

    const patches = mapChatEventToAgentPatchV2(delta!);
    expect(patches.map((patch) => patch.type)).toContain(
      'agent-item-delta-v2'
    );
  });
});
