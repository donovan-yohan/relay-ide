import { describe, expect, it } from 'vitest';
import { BaseProtocolAdapter } from '../../../server/protocol-adapter.js';
import type {
  AdapterConfig,
  AdapterStatus,
  Attachment,
  SessionOptions,
} from '../../../server/protocol-adapter.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';
import type { AgentCapabilitySetV2 } from '../../../shared/agent-chat-protocol-v2.js';
import type { ChatEventSource } from '../../../shared/chat-events.js';

const BASE_CONFIG: AdapterConfig = {
  cwd: '/repo',
  port: 3456,
  sessionId: 'sess-bridge',
  hookToken: 'hook-token',
  configDir: '/config',
};

const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  resume: true,
};

class ReconnectingLegacyAdapter extends BaseProtocolAdapter {
  readonly agentType = 'mock';
  readonly runtimeOwnership = 'attached' as const;

  private config: AdapterConfig | null = null;
  private turnIndex = 0;
  private currentStatus: AdapterStatus = 'disconnected';

  get status(): AdapterStatus {
    return this.currentStatus;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.currentStatus = 'connected';
  }

  protected async onDisconnect(): Promise<void> {
    this.currentStatus = 'disconnected';
  }

  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('Cannot reconnect before connect');
    const config = this.config;
    await this.disconnect();
    await this.connect(config);
  }

  async sendMessage(
    turnId: string,
    content: string,
    _attachments?: Attachment[]
  ): Promise<void> {
    const sessionId = this.config?.sessionId;
    if (!sessionId) throw new Error('No session ID');
    const timestamp = new Date().toISOString();
    const source: ChatEventSource = 'mock';

    this.emit({
      type: 'chat:turn-started',
      sessionId,
      timestamp,
      source,
      turnId,
      turnIndex: this.turnIndex++,
    });
    this.emit({
      type: 'chat:message-complete',
      sessionId,
      timestamp,
      source,
      turnId,
      messageId: `user-${turnId}`,
      role: 'user',
      content,
    });
  }

  async interrupt(_turnId: string): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async createSession(
    _cwd: string,
    _options?: SessionOptions
  ): Promise<string> {
    return 'created-session';
  }
  async resumeSession(_sessionId: string): Promise<void> {}
  async forkSession(_sessionId: string): Promise<string> {
    return 'forked-session';
  }
}

describe('LegacyProtocolAdapterV2Bridge reconnect', () => {
  it('keeps forwarding legacy adapter events after reconnect clears inner listeners', async () => {
    const bridge = new LegacyProtocolAdapterV2Bridge(
      new ReconnectingLegacyAdapter(),
      CAPABILITIES
    );
    const patches: string[] = [];
    bridge.onPatch((patch) => patches.push(patch.type));

    await bridge.connect(BASE_CONFIG);
    await bridge.reconnect();
    await bridge.sendMessage({ turnId: 'turn-1', content: 'hello' });

    expect(patches).toContain('agent-turn-started-v2');
    expect(patches).toContain('agent-item-updated-v2');
  });
});
