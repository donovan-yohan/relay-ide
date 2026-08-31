import { describe, expect, it, vi } from 'vitest';
import { createBrowserIdWithCrypto } from '../frontend/src/lib/browserId.js';

describe('createBrowserIdWithCrypto', () => {
  it('uses crypto.randomUUID when available', () => {
    // The contract under test is "randomUUID's value is returned verbatim",
    // so the fake id is deliberately not a real UUID; it only has to satisfy
    // the Crypto signature the product accepts.
    const randomUUID = vi.fn(
      () => 'uuid-1' as ReturnType<Crypto['randomUUID']>
    );

    expect(createBrowserIdWithCrypto('turn', { randomUUID })).toBe('uuid-1');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('falls back to a prefixed id when randomUUID is unavailable', () => {
    expect(createBrowserIdWithCrypto('turn', undefined)).toMatch(
      /^turn-[a-z0-9]+-[a-z0-9]{8}$/
    );
  });
});
