import { describe, it, expect } from 'vitest';
import { onStateChange, fireStateChange } from '../server/sessions.js';
import type { AgentState } from '../server/types.js';

describe('fireStateChange callbacks', () => {
  it('calls a registered onStateChange callback with correct args', () => {
    const received: Array<{ sessionId: string; state: AgentState }> = [];

    onStateChange((sessionId, state) => {
      received.push({ sessionId, state });
    });

    fireStateChange('test-session-id', 'processing');

    const match = received.find(
      (e) => e.sessionId === 'test-session-id' && e.state === 'processing'
    );
    expect(match).toBeTruthy();
  });

  it('fires multiple registered callbacks', () => {
    let count = 0;
    onStateChange(() => {
      count++;
    });
    onStateChange(() => {
      count++;
    });

    fireStateChange('multi-cb-session', 'idle');

    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('passes idle state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'idle');

    expect(received).toBe('idle');
  });

  it('passes permission-prompt state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'permission-prompt');

    expect(received).toBe('permission-prompt');
  });

  it('passes waiting-for-input state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'waiting-for-input');

    expect(received).toBe('waiting-for-input');
  });
});
