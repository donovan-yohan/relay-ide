/**
 * Shared test fixtures for web chat / web-session tests.
 * Centralizes makeWebSession, makeBaseEvent, makeApproval, and common constants.
 */
import { MockProtocolAdapter } from '../../server/protocol-adapters/mock-adapter.js';
import type {
  ChatEvent,
  ApprovalRequestEvent,
} from '../../server/chat-events.js';
import type { WebSession } from '../../server/types.js';
import type { AdapterConfig } from '../../server/protocol-adapter.js';

export const ZERO_DELAYS = { wordMs: 0, toolMs: 0, connectMs: 0, errorMs: 0 };

export const BASE_CONFIG: AdapterConfig = {
  cwd: '/repo',
  port: 3000,
  sessionId: 'sess-integration',
  hookToken: 'test-token',
  configDir: '/config',
};

export function makeWebSession(
  overrides: Partial<WebSession> = {}
): WebSession {
  return {
    mode: 'web',
    id: 'sess-1',
    type: 'agent',
    agent: 'mock',
    repoPath: '/repo',
    worktreePath: null,
    cwd: '/repo',
    repoName: 'repo',
    branchName: 'main',
    displayName: 'Test',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    idle: true,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
    adapter: new MockProtocolAdapter(ZERO_DELAYS),
    adapterType: 'mock',
    messages: [],
    currentTurnId: null,
    ...overrides,
  } as WebSession;
}

export function makeBaseEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    type: 'chat:text-delta',
    sessionId: 'test',
    timestamp: new Date().toISOString(),
    source: 'claude',
    turnId: 'turn-1',
    messageId: 'msg-1',
    delta: 'hello',
    ...overrides,
  } as ChatEvent;
}

export function makeApproval(requestId = 'req-1'): ApprovalRequestEvent {
  return {
    type: 'chat:approval-request',
    sessionId: 'test',
    timestamp: new Date().toISOString(),
    source: 'claude',
    turnId: 'turn-1',
    requestId,
    kind: 'command',
    toolName: 'Bash',
    description: 'Run something',
    target: 'something',
  };
}

/** Connect a MockProtocolAdapter and return an events array (cleared of connect events). */
export async function connectAndClear(
  adapter: MockProtocolAdapter
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  adapter.on((e) => events.push(e));
  await adapter.connect(BASE_CONFIG);
  events.length = 0;
  return events;
}
