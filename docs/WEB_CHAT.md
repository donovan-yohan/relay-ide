# Unified Web Chat Interface

> Agent Chat Protocol v2 is the canonical web-chat protocol. The older
> `ChatEvent` protocol is deprecated and exists only as a temporary migration
> input until all adapters and UI surfaces consume v2.

This document describes the unified web chat interface architecture for multi-agent support in relay-ide. The system enables browser-based chat with multiple AI agents (Claude, Codex, OpenCode) through a normalized protocol.

## Overview

The web chat system provides a terminal-like chat interface that connects to AI agents through WebSocket connections. Unlike the PTY-based terminal sessions, web sessions use a structured event protocol (`ChatEvent`) that enables rich UI components for tool calls, file changes, and approval prompts.

```
┌─────────────────┐     WebSocket      ┌──────────────────┐     Stdio/Hooks     ┌─────────────┐
│  Browser (Chat) │◄──────────────────►│  relay-ide       │◄───────────────────►│  Agent      │
│  Components     │   ChatEvent JSON   │  WebSession      │   Adapter-specific  │  Process    │
└─────────────────┘                    └──────────────────┘                     └─────────────┘
```

## Architecture

### Three Pillars

The web chat system is built on three core abstractions:

#### 1. ChatEvent — Canonical Event System

**Location:** `shared/chat-events.ts` (imported by both server and frontend)

A type-safe event system with 18 event types organized into categories:

| Category      | Events                                                                         | Description                                            |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **Content**   | `text-delta`, `message-complete`, `reasoning`, `compaction`                    | Streaming text, thinking traces, context compaction    |
| **Tools**     | `tool-call`, `tool-output-delta`, `tool-result`, `file-change`                 | Tool invocations, streaming output, file modifications |
| **Approvals** | `approval-request`, `approval-response`, `input-request`, `input-response`     | Permission prompts, structured input                   |
| **Lifecycle** | `session-started`, `session-status`, `turn-started`, `turn-completed`, `error` | Session and turn management                            |
| **Telemetry** | `telemetry`, `rate-limit`                                                      | Usage metrics and rate limiting                        |

All events extend `ChatEventBase`:

```typescript
interface ChatEventBase {
  sessionId: string;
  timestamp: string;
  source: 'claude' | 'codex' | 'opencode' | 'mock' | 'hermes';
}
```

#### 2. ProtocolAdapter — Agent Normalization

**Location:** `server/protocol-adapter.ts`

The `ProtocolAdapter` interface normalizes all agent backends into ChatEvents:

```typescript
interface ProtocolAdapter {
  // Lifecycle
  connect(config: AdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;

  // User Actions
  sendMessage(
    turnId: string,
    content: string,
    attachments?: Attachment[]
  ): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void>;
  respondToInput(
    requestId: string,
    answers: Record<string, string[]>
  ): Promise<void>;

  // Session Management
  createSession(cwd: string, options?: SessionOptions): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  forkSession(sessionId: string): Promise<void>;

  // Event Subscription
  on(handler: ChatEventHandler): () => void;
}
```

**Adapter Implementations:**

| Adapter                   | Location                                | Backend Protocol                          |
| ------------------------- | --------------------------------------- | ----------------------------------------- |
| `ClaudeProtocolAdapter`   | `protocol-adapters/claude-adapter.ts`   | `--output-format stream-json` + env hooks |
| `CodexProtocolAdapter`    | `protocol-adapters/codex-adapter.ts`    | Hook file callbacks                       |
| `OpenCodeProtocolAdapter` | `protocol-adapters/opencode-adapter.ts` | Relay plugin events                       |
| `HermesProtocolAdapter`   | `protocol-adapters/hermes-adapter.ts`   | Attached host gateway + SSE/REST          |
| `MockProtocolAdapter`     | `protocol-adapters/mock-adapter.ts`     | Programmable test scenarios               |

#### 3. WebSession — Session Container

**Location:** `server/types.ts`, `server/web-session-handler.ts`

`WebSession` extends `BaseSession` with web-specific fields:

```typescript
interface WebSession extends BaseSession {
  mode: 'web';
  adapter: ProtocolAdapter;
  adapterType: string;
  messages: ChatEvent[]; // 1000-event bounded buffer
  currentTurnId: string | null;
  process?: ChildProcess;
}
```

The session factory (`createWebSession`):

1. Creates the appropriate `ProtocolAdapter` via the factory
2. Wires the adapter's `on()` handler to push events into the message buffer
3. Maps ChatEvent types to `agentState` transitions (`processing`, `idle`, `permission-prompt`, `error`)
4. Maintains a bounded FIFO buffer (1000 events) with protection for approval events

## Frontend Components

**Location:** `frontend/src/components/chat/`

| Component             | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `ChatView.tsx`        | Main container, orchestrates MessageTimeline and Composer      |
| `MessageTimeline.tsx` | Renders turn groups with streaming text, tool calls, approvals |
| `Composer.tsx`        | Text input with Enter-to-send, auto-resize, interrupt button   |
| `ToolCard.tsx`        | Expandable tool call display with input/output/status          |
| `FileChangeCard.tsx`  | File changes with +/- stats                                    |
| `ApprovalCard.tsx`    | Permission buttons: allow, allow-always, deny                  |

**Hook:** `frontend/src/hooks/useChatSocket.ts`

Manages WebSocket connection with:

- Ping/pong heartbeat (30s interval, 5s timeout)
- Auto-reconnect (up to 10 attempts, 3s delay)
- Message sending: `send-message`, `interrupt`, `approve`
- Event filtering: only stores `chat:*` events

## WebSocket Protocol

**Location:** `server/ws.ts`

WebSocket endpoint: `/ws/:sessionId`

### Client → Server Messages

```typescript
// Send a user message
{ type: 'send-message', turnId: string, content: string }

// Interrupt current turn
{ type: 'interrupt', turnId: string }

// Respond to approval request
{ type: 'approve', requestId: string, decision: 'allow' | 'allow-always' | 'deny' }

// Respond to input request
{ type: 'input-response', requestId: string, answers: Record<string, string[]> }
```

### Server → Client Messages

All messages are JSON-serialized `ChatEvent` objects. The server sends a snapshot of the message buffer on connection, then streams live events.

### Connection Flow

1. Client connects to `/ws/:sessionId`
2. Server identifies session (PTY vs Web by `session.mode`)
3. For web sessions:
   - Registers live listener on the adapter
   - Sends buffer snapshot (last 1000 events)
   - Begins streaming live events

## Multi-Agent Integration Matrix

| Agent       | Adapter    | Native Protocol                           | Status         |
| ----------- | ---------- | ----------------------------------------- | -------------- |
| Claude Code | `claude`   | `--output-format stream-json` + env hooks | ✅ Implemented |
| Codex       | `codex`    | Hook file callbacks                       | ✅ Implemented |
| OpenCode    | `opencode` | Relay plugin events                       | ✅ Implemented |
| Hermes      | `hermes`   | Attached host gateway + SSE/REST          | ✅ Implemented |
| Mock        | `mock`     | Programmable scenarios                    | ✅ Implemented |

## Creating a New Protocol Adapter

To add support for a new agent:

1. **Create adapter file** in `server/protocol-adapters/myagent-adapter.ts`

2. **Extend `BaseHookAdapter`** (for hook-based agents) or implement `ProtocolAdapter` directly:

```typescript
import { BaseHookAdapter } from './base-hook-adapter.js';
import type { AdapterConfig, ChatEvent } from '../protocol-adapter.js';

export class MyAgentProtocolAdapter extends BaseHookAdapter {
  protected buildSpawnCommand(config: AdapterConfig): string[] {
    return [
      'my-agent',
      '--cwd',
      config.cwd,
      '--hooks-url',
      `http://localhost:${config.port}/hooks/${config.sessionId}`,
    ];
  }

  protected setupHooks(config: AdapterConfig): void {
    // Install any hook files or config needed by the agent
  }

  protected cleanupHooks(config: AdapterConfig): void {
    // Clean up hook files on disconnect
  }

  protected mapHookEvent(event: unknown): ChatEvent | null {
    // Map native agent events to ChatEvent
    const native = event as MyAgentEvent;
    switch (native.type) {
      case 'text':
        return {
          type: 'chat:text-delta',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
          source: 'myagent',
          turnId: native.turnId,
          messageId: native.messageId,
          delta: native.content,
        };
      // ... other event types
    }
    return null;
  }
}
```

3. **Register in adapter factory** (`server/protocol-adapters/index.ts`):

```typescript
import { MyAgentProtocolAdapter } from './myagent-adapter.js';

const adapters = {
  mock: MockProtocolAdapter,
  claude: ClaudeProtocolAdapter,
  codex: CodexProtocolAdapter,
  opencode: OpencodeProtocolAdapter,
  myagent: MyAgentProtocolAdapter, // Add here
};
```

4. **Add to frontend types** (`frontend/src/lib/types.ts`):

```typescript
export type AgentFramework =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'hermes'
  | 'myagent';
```

## Testing with Mock Adapter

The `MockProtocolAdapter` provides configurable test scenarios:

```typescript
// Start a mock session with a specific scenario
const adapter = new MockProtocolAdapter();
await adapter.connect({
  cwd: '/tmp/test',
  port: 3456,
  sessionId: 'test-123',
  hookToken: 'token',
  configDir: '/tmp/config',
  extra: {
    scenario: 'approval-flow', // or 'happy-path', 'tool-chain', 'file-changes', 'error-recovery'
  },
});
```

Available scenarios:

- `happy-path` — Simple message exchange
- `tool-chain` — Multiple sequential tool calls
- `approval-flow` — Tool call requiring user approval
- `file-changes` — File modification events
- `error-recovery` — Error handling and recovery

## Files Reference

| File                                            | Purpose                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `shared/chat-events.ts`                         | ChatEvent type definitions + type guards (cross-boundary wire protocol) |
| `server/protocol-adapter.ts`                    | ProtocolAdapter interface + base class                                  |
| `server/protocol-adapters/index.ts`             | Adapter factory                                                         |
| `server/protocol-adapters/base-hook-adapter.ts` | Common hook-based adapter                                               |
| `server/protocol-adapters/*-adapter.ts`         | Agent-specific adapters                                                 |
| `server/web-session-handler.ts`                 | WebSession creation + event buffering                                   |
| `server/ws.ts`                                  | WebSocket relay for web sessions                                        |
| `frontend/src/hooks/useChatSocket.ts`           | React hook for WebSocket management                                     |
| `frontend/src/components/chat/*.tsx`            | Chat UI components                                                      |
| `test/helpers/web-chat-fixtures.ts`             | Test utilities                                                          |
| `test/*web*.test.ts`                            | Web chat tests                                                          |

## Related Work

- PTY-based session management (`server/sessions.ts`, `server/pty-handler.ts`)
- Claude Code and Codex CLI integration
- WebSocket message relay system (`server/ws.ts`)
- Epic #209: Unified Web Chat Interface for Multi-Agent Support
