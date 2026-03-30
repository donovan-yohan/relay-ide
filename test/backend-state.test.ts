import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackendState, fireBackendStateIfChanged, onBackendStateChange } from '../server/sessions.js';
import type { BackendDisplayState } from '../server/sessions.js';
import type { AgentState } from '../server/types.js';

// Minimal mock session shape for computeBackendState
function mockState(agentState: AgentState, idle: boolean): { agentState: AgentState; idle: boolean } {
  return { agentState, idle };
}

describe('computeBackendState', () => {
  it('maps processing + idle=false to running', () => {
    assert.equal(computeBackendState(mockState('processing', false)), 'running');
  });

  it('maps initializing + idle=false to initializing', () => {
    assert.equal(computeBackendState(mockState('initializing', false)), 'initializing');
  });

  it('maps idle + idle=true to idle', () => {
    assert.equal(computeBackendState(mockState('idle', true)), 'idle');
  });

  it('maps waiting-for-input + idle=true to idle', () => {
    assert.equal(computeBackendState(mockState('waiting-for-input', true)), 'idle');
  });

  it('maps permission-prompt + idle=false to permission', () => {
    assert.equal(computeBackendState(mockState('permission-prompt', false)), 'permission');
  });

  it('maps error + idle=false to running', () => {
    assert.equal(computeBackendState(mockState('error', false)), 'running');
  });
});

describe('fireBackendStateIfChanged', () => {
  it('fires callback only once when called twice with the same state', () => {
    const calls: Array<[string, BackendDisplayState]> = [];
    onBackendStateChange((sessionId, state) => {
      calls.push([sessionId, state]);
    });

    // Minimal session mock — only the fields fireBackendStateIfChanged needs
    const session = {
      id: 'test-session-dedup',
      agentState: 'processing' as AgentState,
      idle: false,
      _lastEmittedBackendState: undefined as string | undefined,
    } as Parameters<typeof fireBackendStateIfChanged>[0];

    fireBackendStateIfChanged(session);
    fireBackendStateIfChanged(session); // same state — should be a no-op

    const relevant = calls.filter(([id]) => id === 'test-session-dedup');
    assert.equal(relevant.length, 1, 'callback should fire exactly once for duplicate state');
    assert.equal(relevant[0]![1], 'running');
  });
});
