import { describe, expect, it } from 'vitest';
import { authLaneErrorMessage } from '../frontend/src/lib/api.js';

describe('authLaneErrorMessage', () => {
  it('maps browser-session denials to browser PIN copy', () => {
    expect(authLaneErrorMessage('browser-auth-required', 'fallback')).toBe(
      'browser session required; enter the browser PIN for this web UI.'
    );
    expect(authLaneErrorMessage('BROWSER_SESSION_REQUIRED', 'fallback')).toBe(
      'browser session required; enter the browser PIN for this web UI.'
    );
  });

  it('distinguishes actor, node, pair, capability, and approval denials', () => {
    expect(authLaneErrorMessage('actor-credential-required', 'fallback')).toContain(
      'scoped actor credential required'
    );
    expect(authLaneErrorMessage('NODE_CREDENTIAL_REQUIRED', 'fallback')).toContain(
      'node credential required'
    );
    expect(authLaneErrorMessage('pair-token-required', 'fallback')).toContain(
      'pair token required'
    );
    expect(authLaneErrorMessage('CAPABILITY_DENIED', 'fallback')).toContain(
      'capability denied'
    );
    expect(authLaneErrorMessage('approval-required', 'fallback')).toContain(
      'approval required'
    );
  });

  it('preserves fallback copy for unknown codes', () => {
    expect(authLaneErrorMessage('unknown-auth-code', 'server supplied message')).toBe(
      'server supplied message'
    );
  });
});
