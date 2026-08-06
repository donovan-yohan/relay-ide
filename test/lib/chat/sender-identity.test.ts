import { describe, expect, it } from 'vitest';
import {
  resolveSenderIdentity,
  resolveRenderSenderId,
} from '../../../frontend/src/lib/chat/sender-identity.js';
import { deriveColor } from '../../../frontend/src/lib/colors.js';
import { builtInAgentProfileId } from '../../../shared/agent-profile.js';

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
    ['prime-agent', 'var(--sender-prime-agent)'],
    ['pi', 'var(--sender-pi)'],
  ] as const)(
    'keeps the curated vendor token + glyph for the %s DEFAULT profile',
    (providerId, colorVar) => {
      const id = resolveSenderIdentity({
        kind: 'agent',
        id: builtInAgentProfileId(providerId),
        providerId,
      });
      expect(id.kind).toBe('agent');
      expect(id.colorVar).toBe(colorVar);
      expect(id.glyph).toBe(providerId);
      expect(id.label).toBe(providerId);
    }
  );

  it('hashes a NON-default profile via deriveColor(profileActorId) while sharing the vendor glyph', () => {
    const profileId = 'agent-profile:claude:backend-abc';
    const id = resolveSenderIdentity({
      kind: 'agent',
      id: profileId,
      providerId: 'claude',
      displayName: 'Backend Claude',
    });
    // NOT the curated token — a concrete hex hashed on the profile Actor id.
    expect(id.colorVar).toBe(deriveColor(profileId));
    expect(id.colorVar.startsWith('#')).toBe(true);
    expect(id.colorVar).not.toBe('var(--sender-claude)');
    // The vendor glyph is shared across a vendor's profiles.
    expect(id.glyph).toBe('claude');
    expect(id.label).toBe('Backend Claude');
  });

  it('renders two non-default profiles of one vendor with distinct colors, same glyph', () => {
    const a = resolveSenderIdentity({
      kind: 'agent',
      id: 'agent-profile:claude:backend-1',
      providerId: 'claude',
      displayName: 'Backend Claude',
    });
    const b = resolveSenderIdentity({
      kind: 'agent',
      id: 'agent-profile:claude:reviewer-2',
      providerId: 'claude',
      displayName: 'Reviewer Claude',
    });
    expect(a.glyph).toBe('claude');
    expect(b.glyph).toBe('claude');
    expect(a.colorVar).not.toBe(b.colorVar);
    expect(a.colorVar).toBe(deriveColor('agent-profile:claude:backend-1'));
    expect(b.colorVar).toBe(deriveColor('agent-profile:claude:reviewer-2'));
  });

  it('sources providerId from the explicit field, NOT by stripping the id', () => {
    // The id is a profile Actor id that does not contain "claude"; providerId is
    // still resolved from the field, so the vendor glyph + default token resolve.
    const id = resolveSenderIdentity({
      kind: 'agent',
      id: builtInAgentProfileId('claude'),
      providerId: 'claude',
    });
    expect(id.glyph).toBe('claude');
    expect(id.colorVar).toBe('var(--sender-claude)');
  });

  it('falls back to a hash-derived color and null glyph for a custom-vendor default profile', () => {
    const id = resolveSenderIdentity({
      kind: 'agent',
      id: builtInAgentProfileId('custom-acme'),
      providerId: 'custom-acme',
      displayName: 'Acme Bot',
    });
    expect(id.glyph).toBe(null);
    expect(id.label).toBe('Acme Bot');
    // No curated token for an unknown vendor — a concrete hex from the palette.
    expect(id.colorVar).toBe(deriveColor(builtInAgentProfileId('custom-acme')));
    expect(id.colorVar.startsWith('#')).toBe(true);
  });

  // #1245: rows persisted BEFORE the #1234 re-key carry the bare `agent:<vendor>`
  // sender id. Heal the curated color at the render boundary WITHOUT mutating the
  // wire id (the CLI-gateway lane also emits `agent:<actorId>` and must stay
  // byte-exact — see test/channel-routes.test.ts).
  it.each([
    ['claude', 'var(--sender-claude)'],
    ['codex', 'var(--sender-codex)'],
    ['hermes', 'var(--sender-hermes)'],
    ['opencode', 'var(--sender-opencode)'],
    ['prime-agent', 'var(--sender-prime-agent)'],
    ['pi', 'var(--sender-pi)'],
  ] as const)(
    'heals a legacy agent:%s row to the curated vendor token + glyph',
    (providerId, colorVar) => {
      const id = resolveSenderIdentity({
        kind: 'agent',
        id: `agent:${providerId}`,
        providerId,
      });
      expect(id.colorVar).toBe(colorVar);
      // NOT a hash of the legacy wire id (the exact P2 the re-key regressed).
      expect(id.colorVar).not.toBe(deriveColor(`agent:${providerId}`));
      expect(id.glyph).toBe(providerId);
    }
  );

  it('heals a legacy custom-vendor row to its built-in default hash, no curated token', () => {
    const id = resolveSenderIdentity({
      kind: 'agent',
      id: 'agent:acme',
      providerId: 'acme',
    });
    expect(id.glyph).toBe(null);
    // Hashes on the built-in default id (matching a new agent-profile:acme:default
    // row), not on the legacy `agent:acme` wire id.
    expect(id.colorVar).toBe(deriveColor(builtInAgentProfileId('acme')));
    expect(id.colorVar).not.toBe(deriveColor('agent:acme'));
  });

  it('resolveRenderSenderId heals only legacy vendor-default ids, else passes through', () => {
    // Legacy vendor-default row → the vendor built-in default profile id.
    expect(
      resolveRenderSenderId({
        kind: 'agent',
        id: 'agent:claude',
        providerId: 'claude',
      })
    ).toBe(builtInAgentProfileId('claude'));
    // Already-migrated non-default profile → unchanged.
    expect(
      resolveRenderSenderId({
        kind: 'agent',
        id: 'agent-profile:claude:backend-xyz',
        providerId: 'claude',
      })
    ).toBe('agent-profile:claude:backend-xyz');
    // Human sender → unchanged.
    expect(resolveRenderSenderId({ kind: 'human', id: 'human:operator' })).toBe(
      'human:operator'
    );
    // A row whose parsed vendor disagrees with the authoritative providerId is
    // left alone (never seen from the bridge, but the guard stays precise).
    expect(
      resolveRenderSenderId({
        kind: 'agent',
        id: 'agent:codex',
        providerId: 'claude',
      })
    ).toBe('agent:codex');
  });
});
