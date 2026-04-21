/**
 * Tests for mapHookEvent() in all 3 real protocol adapters.
 * Verifies that native hook payloads are correctly translated into canonical ChatEvents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeProtocolAdapter } from '../server/protocol-adapters/claude-adapter.js';
import { CodexProtocolAdapter } from '../server/protocol-adapters/codex-adapter.js';
import { OpenCodeProtocolAdapter } from '../server/protocol-adapters/opencode-adapter.js';
import type { ChatEvent } from '../shared/chat-events.js';
import type { AdapterConfig } from '../server/protocol-adapter.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../server/sessions.js', () => ({
  fireBackendStateIfChanged: vi.fn(),
}));

const BASE_CONFIG: AdapterConfig = {
  cwd: '/repo',
  port: 3000,
  sessionId: 'sess-test',
  hookToken: 'test-token',
  configDir: '/config',
};

/** Collect events emitted by an adapter without spawning a process */
function collectEvents(
  adapter:
    | ClaudeProtocolAdapter
    | CodexProtocolAdapter
    | OpenCodeProtocolAdapter
): ChatEvent[] {
  const events: ChatEvent[] = [];
  adapter.on((e) => events.push(e));
  // Set internal config so fire() has a sessionId

  (adapter as any)._config = BASE_CONFIG;

  (adapter as any)._status = 'connected';
  return events;
}

// ── Claude Adapter ───────────────────────────────────────────────────────────

describe('ClaudeProtocolAdapter.mapHookEvent', () => {
  let adapter: ClaudeProtocolAdapter;
  let events: ChatEvent[];

  beforeEach(() => {
    adapter = new ClaudeProtocolAdapter();
    events = collectEvents(adapter);
    // Set a current turn so events have a turnId

    (adapter as any)._currentTurnId = 'turn-1';
  });

  it('maps "assistant" payload to chat:text-delta', () => {
    adapter.handleHookEvent({
      type: 'assistant',
      sessionId: 'sess-test',
      data: { content: 'Hello world' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:text-delta');
    const evt = events[0] as ChatEvent & { delta: string };
    expect(evt.delta).toBe('Hello world');
  });

  it('ignores assistant payload with no content', () => {
    adapter.handleHookEvent({
      type: 'assistant',
      sessionId: 'sess-test',
      data: {},
    });

    expect(events).toHaveLength(0);
  });

  it('maps "tool.started" / "PreToolUse" to chat:tool-call', () => {
    for (const type of ['tool.started', 'PreToolUse']) {
      events.length = 0;
      adapter.handleHookEvent({
        type,
        sessionId: 'sess-test',
        data: {
          toolCallId: 'tc-1',
          tool: {
            name: 'Bash',
            description: 'Run command',
            input: { command: 'ls' },
          },
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('chat:tool-call');
      const evt = events[0] as ChatEvent & { toolName: string; status: string };
      expect(evt.toolName).toBe('Bash');
      expect(evt.status).toBe('running');
    }
  });

  it('maps "tool.finished" / "PostToolUse" to chat:tool-result', () => {
    for (const type of ['tool.finished', 'PostToolUse']) {
      events.length = 0;
      adapter.handleHookEvent({
        type,
        sessionId: 'sess-test',
        data: {
          toolCallId: 'tc-1',
          toolName: 'Bash',
          output: 'file.txt',
          durationMs: 150,
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('chat:tool-result');
      const evt = events[0] as ChatEvent & {
        status: string;
        durationMs: number;
      };
      expect(evt.status).toBe('completed');
      expect(evt.durationMs).toBe(150);
    }
  });

  it('maps tool.finished with error to error status', () => {
    adapter.handleHookEvent({
      type: 'tool.finished',
      sessionId: 'sess-test',
      data: {
        toolCallId: 'tc-1',
        toolName: 'Bash',
        error: 'command not found',
      },
    });

    expect(events).toHaveLength(1);
    const evt = events[0] as ChatEvent & { status: string; error: string };
    expect(evt.status).toBe('error');
    expect(evt.error).toBe('command not found');
  });

  it('maps "session.idle" / "Stop" to turn-completed + session-status idle', () => {
    for (const type of ['session.idle', 'Stop']) {
      events.length = 0;
      // Reset turn

      (adapter as any)._currentTurnId = 'turn-x';

      adapter.handleHookEvent({ type, sessionId: 'sess-test' });

      const types = events.map((e) => e.type);
      expect(types).toContain('chat:turn-completed');
      expect(types).toContain('chat:session-status');
    }
  });

  it('maps "permission.requested" to chat:approval-request', () => {
    adapter.handleHookEvent({
      type: 'permission.requested',
      sessionId: 'sess-test',
      data: {
        type: 'permission',
        requestId: 'req-1',
        toolName: 'Bash',
        description: 'Run rm',
        target: 'rm -rf /tmp',
      },
    });

    expect(events).toHaveLength(2); // approval-request + session-status
    expect(events[0]!.type).toBe('chat:approval-request');
    const evt = events[0] as ChatEvent & { toolName: string; target: string };
    expect(evt.toolName).toBe('Bash');
    expect(evt.target).toBe('rm -rf /tmp');
  });
});

// ── Codex Adapter ────────────────────────────────────────────────────────────

describe('CodexProtocolAdapter.mapHookEvent', () => {
  let adapter: CodexProtocolAdapter;
  let events: ChatEvent[];

  beforeEach(() => {
    adapter = new CodexProtocolAdapter();
    events = collectEvents(adapter);

    (adapter as any)._currentTurnId = 'turn-1';
  });

  it('maps "tool.started" to chat:tool-call', () => {
    adapter.handleHookEvent({
      type: 'tool.started',
      sessionId: 'sess-test',
      data: {
        toolCallId: 'tc-1',
        tool: {
          name: 'Edit',
          description: 'Edit file',
          input: { path: 'foo.ts' },
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:tool-call');
    const evt = events[0] as ChatEvent & { toolName: string };
    expect(evt.toolName).toBe('Edit');
  });

  it('maps "tool.finished" to chat:tool-result', () => {
    adapter.handleHookEvent({
      type: 'tool.finished',
      sessionId: 'sess-test',
      data: {
        toolCallId: 'tc-1',
        toolName: 'Edit',
        output: 'done',
        durationMs: 200,
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:tool-result');
  });

  it('maps "session.ended" to turn-completed + session-status idle', () => {
    adapter.handleHookEvent({ type: 'session.ended', sessionId: 'sess-test' });

    const types = events.map((e) => e.type);
    expect(types).toContain('chat:turn-completed');
    expect(types).toContain('chat:session-status');
  });

  it('maps "prompt.submitted" to session-status active', () => {
    adapter.handleHookEvent({
      type: 'prompt.submitted',
      sessionId: 'sess-test',
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:session-status');
    const evt = events[0] as ChatEvent & { status: string };
    expect(evt.status).toBe('active');
  });
});

// ── OpenCode Adapter ─────────────────────────────────────────────────────────

describe('OpenCodeProtocolAdapter.mapHookEvent', () => {
  let adapter: OpenCodeProtocolAdapter;
  let events: ChatEvent[];

  beforeEach(() => {
    adapter = new OpenCodeProtocolAdapter();
    events = collectEvents(adapter);

    (adapter as any)._currentTurnId = 'turn-1';
  });

  it('maps "tool.started" to chat:tool-call', () => {
    adapter.handleHookEvent({
      type: 'tool.started',
      sessionId: 'sess-test',
      data: {
        toolCallId: 'tc-1',
        tool: { name: 'Read', description: 'Read file', input: {} },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:tool-call');
  });

  it('maps "tool.finished" to chat:tool-result with nested result', () => {
    adapter.handleHookEvent({
      type: 'tool.finished',
      sessionId: 'sess-test',
      data: {
        toolCallId: 'tc-1',
        tool: { name: 'Read' },
        result: { output: 'file content', durationMs: 100 },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:tool-result');
    const evt = events[0] as ChatEvent & { output: string; durationMs: number };
    expect(evt.output).toBe('file content');
    expect(evt.durationMs).toBe(100);
  });

  it('maps "session.idle" to turn-completed + session-status idle', () => {
    adapter.handleHookEvent({ type: 'session.idle', sessionId: 'sess-test' });

    const types = events.map((e) => e.type);
    expect(types).toContain('chat:turn-completed');
    expect(types).toContain('chat:session-status');
  });

  it('maps "state.changed" with error status to chat:error', () => {
    adapter.handleHookEvent({
      type: 'state.changed',
      sessionId: 'sess-test',
      data: { status: 'error', error: 'model timeout' },
    });

    expect(events).toHaveLength(2); // chat:error + session-status
    expect(events[0]!.type).toBe('chat:error');
    const evt = events[0] as ChatEvent & { message: string };
    expect(evt.message).toBe('model timeout');
  });

  it('ignores "state.changed" with non-error status', () => {
    adapter.handleHookEvent({
      type: 'state.changed',
      sessionId: 'sess-test',
      data: { status: 'active' },
    });

    expect(events).toHaveLength(0);
  });

  it('maps "permission.requested" to chat:approval-request', () => {
    adapter.handleHookEvent({
      type: 'permission.requested',
      sessionId: 'sess-test',
      data: {
        requestId: 'req-1',
        permission: { tool: 'Bash', description: 'Run ls', target: '/tmp' },
      },
    });

    expect(events).toHaveLength(2); // approval-request + session-status
    expect(events[0]!.type).toBe('chat:approval-request');
    const evt = events[0] as ChatEvent & { toolName: string };
    expect(evt.toolName).toBe('Bash');
  });

  it('maps "permission.resolved" to session-status active', () => {
    adapter.handleHookEvent({
      type: 'permission.resolved',
      sessionId: 'sess-test',
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:session-status');
    const evt = events[0] as ChatEvent & { status: string };
    expect(evt.status).toBe('active');
  });

  it('maps "telemetry.updated" to chat:telemetry', () => {
    adapter.handleHookEvent({
      type: 'telemetry.updated',
      sessionId: 'sess-test',
      data: {
        message: {
          model: 'gpt-4',
          tokens: { input: 100, output: 50, cache_read: 10, cache_write: 5 },
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('chat:telemetry');
    const evt = events[0] as ChatEvent & { model: string; inputTokens: number };
    expect(evt.model).toBe('gpt-4');
    expect(evt.inputTokens).toBe(100);
  });
});
