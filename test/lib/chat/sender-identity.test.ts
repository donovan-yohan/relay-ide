import { describe, expect, it } from 'vitest';
import { resolveSenderIdentity } from '../../../frontend/src/lib/chat/sender-identity.js';

describe('resolveSenderIdentity', () => {
  it('renders human as "you" with no glyph and the text color', () => {
    const id = resolveSenderIdentity({ kind: 'human', id: 'human:operator' });
    expect(id.kind).toBe('human');
    expect(id.label).toBe('you');
    expect(id.glyph).toBe(null);
    expect(id.colorVar).toBe('var(--text)');
  });

  it('honors a human displayName override', () => {
    const id = resolveSenderIdentity({
      kind: 'human',
      id: 'human:op',
      displayName: 'operator',
    });
    expect(id.label).toBe('operator');
  });

  it('renders system with the muted sender token and no glyph', () => {
    const id = resolveSenderIdentity({ kind: 'system', id: 'system' });
    expect(id.kind).toBe('system');
    expect(id.glyph).toBe(null);
    expect(id.colorVar).toBe('var(--sender-system)');
  });

  it.each([
    ['claude', 'var(--sender-claude)'],
    ['codex', 'var(--sender-codex)'],
    ['hermes', 'var(--sender-hermes)'],
    ['opencode', 'var(--sender-opencode)'],
  ] as const)(
    'maps known agent %s to its fixed color token and glyph',
    (providerId, colorVar) => {
      const id = resolveSenderIdentity({
        kind: 'agent',
        id: `agent:${providerId}`,
        providerId,
      });
      expect(id.kind).toBe('agent');
      expect(id.colorVar).toBe(colorVar);
      expect(id.glyph).toBe(providerId);
      expect(id.label).toBe(providerId);
    }
  );

  it('derives providerId from the id when the field is absent', () => {
    const id = resolveSenderIdentity({ kind: 'agent', id: 'agent:claude' });
    expect(id.glyph).toBe('claude');
    expect(id.colorVar).toBe('var(--sender-claude)');
  });

  it('falls back to a hash-derived color and null glyph for custom providers', () => {
    const id = resolveSenderIdentity({
      kind: 'agent',
      id: 'agent:custom:acme',
      providerId: 'custom:acme',
      displayName: 'Acme Bot',
    });
    expect(id.glyph).toBe(null);
    expect(id.label).toBe('Acme Bot');
    // Not a sender token — a concrete hex from the hash palette.
    expect(id.colorVar.startsWith('#')).toBe(true);
  });
});
