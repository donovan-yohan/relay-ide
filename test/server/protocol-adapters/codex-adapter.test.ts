/**
 * Legacy test file — now validates that codex registers as the native V2 adapter.
 * Full adapter behavior is covered in codex-native-adapter.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { CodexNativeProtocolAdapter } from '../../../server/protocol-adapters/codex-native-adapter.js';

describe('Codex V2 web adapter registration', () => {
  it('registers codex as CodexNativeProtocolAdapter with full §1.3 capability set', () => {
    const adapter = createAdapterV2('codex');

    expect(adapter).toBeInstanceOf(CodexNativeProtocolAdapter);
    expect(adapter.agentType).toBe('codex');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      questions: true,
      plans: true,
      slashCommands: true,
      queue: true,
      cancelQueued: true,
      interrupt: true,
      resume: true,
      fork: true,
      rollback: true,
      compact: true,
      telemetry: true,
      rateLimits: true,
    });
  });
});
