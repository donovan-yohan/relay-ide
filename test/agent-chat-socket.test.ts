import { describe, expect, it } from 'vitest';
import { createGlobalSessionId } from '../shared/identity.js';
import { agentChatWebSocketPath } from '../frontend/src/hooks/useAgentChatSocket.js';

describe('agent chat websocket path', () => {
  it('uses the local websocket route for raw local session ids', () => {
    expect(agentChatWebSocketPath('c0dbeb605f82d893')).toBe(
      '/ws/c0dbeb605f82d893'
    );
  });

  it('normalizes local scoped session ids before opening /ws', () => {
    expect(
      agentChatWebSocketPath(createGlobalSessionId('local', 'c0dbeb605f82d893'))
    ).toBe('/ws/c0dbeb605f82d893');
  });

  it('routes non-local scoped session ids through the node websocket path', () => {
    expect(
      agentChatWebSocketPath(
        createGlobalSessionId('node/dev box', 'session one')
      )
    ).toBe('/nodes/node%2Fdev%20box/ws/sessions/session%20one');
  });
});
