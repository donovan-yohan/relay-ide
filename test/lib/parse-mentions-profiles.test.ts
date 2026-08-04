import { describe, expect, it } from 'vitest';

import { parseMentions } from '../../shared/channel-chat-protocol.js';
import { builtInAgentProfileId } from '../../shared/agent-profile.js';
import {
  annotateMentionCollisions,
  mentionInsertText,
  toResolverContacts,
  type MentionContact,
} from '../../shared/mention-contacts.js';

function vendorDefault(providerId: string, label: string): MentionContact {
  return {
    id: builtInAgentProfileId(providerId),
    providerId,
    displayName: label,
    kind: 'vendor-default',
    owner: 'system',
    available: true,
    reason: null,
    inChannel: true,
    isDefault: true,
    isBuiltIn: true,
  };
}

function customProfile(
  id: string,
  providerId: string,
  displayName: string
): MentionContact {
  return {
    id,
    providerId,
    displayName,
    kind: 'profile',
    owner: 'donovan',
    available: true,
    reason: null,
    inChannel: true,
    isDefault: false,
    isBuiltIn: false,
  };
}

// SYNTHETIC contact set: no custom-profile creation UI exists yet, so the
// multi-word / collision machinery is proven against hand-built profiles that
// share a vendor and, deliberately, a display name.
const CONTACTS = annotateMentionCollisions([
  vendorDefault('claude', 'Claude'),
  vendorDefault('codex', 'Codex'),
  customProfile('agent-profile:claude:backend', 'claude', 'Backend'),
  customProfile(
    'agent-profile:claude:backend-claude',
    'claude',
    'Backend Claude'
  ),
  customProfile('agent-profile:claude:rev1', 'claude', 'Reviewer'),
  customProfile('agent-profile:codex:rev2', 'codex', 'Reviewer'),
  {
    id: 'human:alex',
    providerId: 'human',
    displayName: 'alex',
    kind: 'human',
    owner: '',
    available: true,
    reason: null,
    inChannel: true,
    isDefault: false,
    isBuiltIn: false,
  },
]);
const RESOLVER = toResolverContacts(CONTACTS);

const rev1 = CONTACTS.find((c) => c.id === 'agent-profile:claude:rev1')!;
const rev2 = CONTACTS.find((c) => c.id === 'agent-profile:codex:rev2')!;

describe('parseMentions — vendor-default alias', () => {
  it('resolves @claude to the vendor default profile id', () => {
    expect(parseMentions('ping @claude now', [], RESOLVER)).toEqual([
      {
        raw: '@claude',
        providerId: 'claude',
        profileId: builtInAgentProfileId('claude'),
      },
    ]);
  });

  it('is case-insensitive on the alias', () => {
    const [m] = parseMentions('@CLAUDE', [], RESOLVER);
    expect(m?.profileId).toBe(builtInAgentProfileId('claude'));
  });
});

describe('parseMentions — named, longest-match-first', () => {
  it('prefers a multi-word name over a shorter prefix', () => {
    expect(parseMentions('@Backend Claude ship it', [], RESOLVER)).toEqual([
      {
        raw: '@Backend Claude',
        providerId: 'claude',
        profileId: 'agent-profile:claude:backend-claude',
      },
    ]);
  });

  it('still resolves the shorter name for the shorter token', () => {
    expect(parseMentions('@Backend please', [], RESOLVER)).toEqual([
      {
        raw: '@Backend',
        providerId: 'claude',
        profileId: 'agent-profile:claude:backend',
      },
    ]);
  });

  it('does not swallow trailing prose past the matched name', () => {
    // "backend now" is not a profile name; only "backend" is consumed.
    const [m] = parseMentions('@Backend now go', [], RESOLVER);
    expect(m?.raw).toBe('@Backend');
    expect(m?.profileId).toBe('agent-profile:claude:backend');
  });

  it('resolves a human contact by name', () => {
    const [m] = parseMentions('hey @alex look', [], RESOLVER);
    expect(m?.profileId).toBe('human:alex');
    expect(m?.providerId).toBe('human');
  });
});

describe('parseMentions — collision disambiguation', () => {
  it('resolves a bare colliding name to the deterministic tiebreak winner', () => {
    const [m] = parseMentions('@Reviewer', [], RESOLVER);
    // smallest id wins the keystone tiebreak: claude:rev1 < codex:rev2.
    expect(m?.profileId).toBe('agent-profile:claude:rev1');
  });

  it('a #token selects the specific same-name profile', () => {
    const [a] = parseMentions(`@Reviewer#${rev1.disambiguator}`, [], RESOLVER);
    expect(a?.profileId).toBe('agent-profile:claude:rev1');
    const [b] = parseMentions(`@Reviewer#${rev2.disambiguator}`, [], RESOLVER);
    expect(b?.profileId).toBe('agent-profile:codex:rev2');
  });

  it('a #token that matches no peer falls back to the resolver winner', () => {
    const [m] = parseMentions('@Reviewer#zzzzzz', [], RESOLVER);
    expect(m?.profileId).toBe('agent-profile:claude:rev1');
  });
});

describe('parseMentions — round-trip', () => {
  it('every inserted mention text parses back to the same profile Actor id', () => {
    for (const contact of CONTACTS) {
      const text = mentionInsertText(contact);
      const [m] = parseMentions(text, [], RESOLVER);
      expect(m, `round-trip for ${contact.id}`).toBeDefined();
      expect(m!.profileId, `round-trip for ${contact.id}`).toBe(contact.id);
    }
  });
});

describe('parseMentions — hardening carried over', () => {
  it('dedupes repeated resolved mentions by profile id', () => {
    expect(parseMentions('@claude @Claude @claude', [], RESOLVER)).toEqual([
      {
        raw: '@claude',
        providerId: 'claude',
        profileId: builtInAgentProfileId('claude'),
      },
    ]);
  });

  it('ignores mentions inside code spans', () => {
    expect(parseMentions('```\n@claude\n```', [], RESOLVER)).toEqual([]);
    expect(parseMentions('run `@Reviewer`', [], RESOLVER)).toEqual([]);
  });

  it('ignores emails and a bare @', () => {
    expect(parseMentions('mail foo@bar.com', [], RESOLVER)).toEqual([]);
    expect(parseMentions('meet @ noon', [], RESOLVER)).toEqual([]);
  });

  it('keeps an unresolved mention with its raw token, provider-tagged if known', () => {
    const out = parseMentions('@nobody and @hermes', ['hermes'], RESOLVER);
    expect(out).toEqual([
      { raw: '@nobody' },
      { raw: '@hermes', providerId: 'hermes' },
    ]);
  });
});
