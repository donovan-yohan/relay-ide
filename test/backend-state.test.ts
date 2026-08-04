import { describe, it, expect } from 'vitest';
import {
  computeBackendState,
  fireBackendStateIfChanged,
  onBackendStateChange,
} from '../server/sessions.js';
import type { BackendDisplayState } from '../server/sessions.js';
import type { TerminalActivityState } from '../server/types.js';

// Minimal mock session shape for computeBackendState
function mockState(
  activityState: TerminalActivityState,
  idle: boolean
): { activityState: TerminalActivityState; idle: boolean } {
  return { activityState, idle };
}

describe('computeBackendState', () => {
  it('maps processing + idle=false to running', () => {
    expect(computeBackendState(mockState('processing', false))).toBe('running');
  });

  it('maps initializing + idle=false to initializing', () => {
    expect(computeBackendState(mockState('initializing', false))).toBe(
      'initializing'
    );
  });

  it('maps idle + idle=true to idle', () => {
    expect(computeBackendState(mockState('idle', true))).toBe('idle');
  });

  it('maps waiting-for-input + idle=true to idle', () => {
    expect(computeBackendState(mockState('waiting-for-input', true))).toBe(
      'idle'
    );
  });

  it('maps permission-prompt + idle=false to permission', () => {
    expect(computeBackendState(mockState('permission-prompt', false))).toBe(
      'permission'
    );
  });

  it('maps error + idle=false to error', () => {
    expect(computeBackendState(mockState('error', false))).toBe('error');
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
      activityState: 'processing' as TerminalActivityState,
      idle: false,
      _lastEmittedBackendState: undefined as string | undefined,
    } as Parameters<typeof fireBackendStateIfChanged>[0];

    fireBackendStateIfChanged(session);
    fireBackendStateIfChanged(session); // same state — should be a no-op

    const relevant = calls.filter(([id]) => id === 'test-session-dedup');
    expect(relevant.length).toBe(1);
    expect(relevant[0]![1]).toBe('running');
  });
});
