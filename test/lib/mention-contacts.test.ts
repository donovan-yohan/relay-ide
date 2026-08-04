import { describe, expect, it } from 'vitest';

import {
  builtInAgentProfileId,
  computeMentionDisambiguators,
} from '../../shared/agent-profile.js';
import {
  annotateMentionCollisions,
  filterMentionContacts,
  isMentionContactSelectable,
  mentionInsertText,
  resolveMentionContact,
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

describe('computeMentionDisambiguators', () => {
  it('assigns a unique token to each member of a same-name group only', () => {
    const tokens = computeMentionDisambiguators([
      { id: 'agent-profile:claude:aaaaaa', displayName: 'Reviewer' },
      { id: 'agent-profile:codex:bbbbbb', displayName: 'Reviewer' },
      { id: 'agent-profile:claude:solo', displayName: 'Backend' },
    ]);
    const a = tokens.get('agent-profile:claude:aaaaaa');
    const b = tokens.get('agent-profile:codex:bbbbbb');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    // The lone "Backend" name is not a collision — no token.
    expect(tokens.get('agent-profile:claude:solo')).toBeUndefined();
  });

  it('grows the id slice until same-suffix ids are still distinguishable', () => {
    // Both ids end in "reviewer"; the token must reach back past the common tail.
    const tokens = computeMentionDisambiguators([
      { id: 'agent-profile:claude:reviewer', displayName: 'Reviewer' },
      { id: 'agent-profile:codex:reviewer', displayName: 'Reviewer' },
    ]);
    const a = tokens.get('agent-profile:claude:reviewer')!;
    const b = tokens.get('agent-profile:codex:reviewer')!;
    expect(a).not.toBe(b);
  });

  it('ignores empty display names (vendor defaults)', () => {
    const tokens = computeMentionDisambiguators([
      { id: builtInAgentProfileId('claude'), displayName: '' },
      { id: builtInAgentProfileId('codex'), displayName: '' },
    ]);
    expect(tokens.size).toBe(0);
  });
});

describe('toResolverContacts', () => {
  it('blanks the vendor-default display name (alias-only) but keeps others', () => {
    const resolver = toResolverContacts([
      vendorDefault('claude', 'Claude'),
      customProfile('agent-profile:claude:backend', 'claude', 'Backend'),
    ]);
    expect(resolver[0]!.displayName).toBe('');
    expect(resolver[1]!.displayName).toBe('Backend');
  });
});

describe('annotateMentionCollisions', () => {
  it('stamps a disambiguator on colliding names and leaves unique ones bare', () => {
    const annotated = annotateMentionCollisions([
      customProfile('agent-profile:claude:aaaaaa', 'claude', 'Reviewer'),
      customProfile('agent-profile:codex:bbbbbb', 'codex', 'Reviewer'),
      customProfile('agent-profile:claude:cccccc', 'claude', 'Backend'),
    ]);
    expect(annotated[0]!.disambiguator).toBeDefined();
    expect(annotated[1]!.disambiguator).toBeDefined();
    expect(annotated[0]!.disambiguator).not.toBe(annotated[1]!.disambiguator);
    expect(annotated[2]!.disambiguator).toBeUndefined();
  });
});

describe('mentionInsertText', () => {
  it('inserts the vendor alias for a vendor default', () => {
    expect(mentionInsertText(vendorDefault('claude', 'Claude'))).toBe(
      '@claude'
    );
  });

  it('inserts the display name for a unique named profile', () => {
    expect(
      mentionInsertText(
        customProfile(
          'agent-profile:claude:backend',
          'claude',
          'Backend Claude'
        )
      )
    ).toBe('@Backend Claude');
  });

  it('appends the disambiguator token for a collision', () => {
    const [a] = annotateMentionCollisions([
      customProfile('agent-profile:claude:aaaaaa', 'claude', 'Reviewer'),
      customProfile('agent-profile:codex:bbbbbb', 'codex', 'Reviewer'),
    ]);
    expect(mentionInsertText(a!)).toBe(`@Reviewer#${a!.disambiguator}`);
  });
});

describe('resolveMentionContact', () => {
  const contacts = [
    vendorDefault('claude', 'Claude'),
    customProfile('agent-profile:claude:backend', 'claude', 'Backend'),
    customProfile(
      'agent-profile:claude:backend-claude',
      'claude',
      'Backend Claude'
    ),
  ];

  it('resolves a vendor alias to the vendor default contact', () => {
    expect(resolveMentionContact('@claude', contacts)?.id).toBe(
      builtInAgentProfileId('claude')
    );
  });

  it('resolves the longest display name over a shorter prefix', () => {
    expect(resolveMentionContact('@Backend Claude', contacts)?.id).toBe(
      'agent-profile:claude:backend-claude'
    );
    expect(resolveMentionContact('@Backend', contacts)?.id).toBe(
      'agent-profile:claude:backend'
    );
  });
});

describe('isMentionContactSelectable', () => {
  it('is true only when available and in channel', () => {
    const base = vendorDefault('claude', 'Claude');
    expect(isMentionContactSelectable(base)).toBe(true);
    expect(isMentionContactSelectable({ ...base, available: false })).toBe(
      false
    );
    expect(isMentionContactSelectable({ ...base, inChannel: false })).toBe(
      false
    );
  });
});

describe('filterMentionContacts', () => {
  it('matches on the disambiguator token too', () => {
    const contacts = annotateMentionCollisions([
      customProfile('agent-profile:claude:aaaaaa', 'claude', 'Reviewer'),
      customProfile('agent-profile:codex:bbbbbb', 'codex', 'Reviewer'),
    ]);
    const token = contacts[0]!.disambiguator!;
    const result = filterMentionContacts(contacts, token);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('agent-profile:claude:aaaaaa');
  });
});
