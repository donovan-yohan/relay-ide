import { describe, expect, it } from 'vitest';

import {
  builtInAgentProfileId,
  isAgentProfile,
  normalizeMentionToken,
  parseHistoricalAgentSenderProviderId,
  resolveHistoricalAgentSenderProfileId,
  resolveProfileForMention,
  type AgentProfile,
} from '../shared/agent-profile.js';

function profile(
  overrides: Partial<AgentProfile> & { id: string }
): AgentProfile {
  return {
    providerId: 'claude',
    displayName: '',
    avatar: null,
    isDefault: false,
    isBuiltIn: false,
    ...overrides,
  };
}

/** Built-in defaults carry an EMPTY display name (inherit vendor label). */
const claudeDefault = profile({
  id: builtInAgentProfileId('claude'),
  providerId: 'claude',
  displayName: '',
  isDefault: true,
  isBuiltIn: true,
});
const codexDefault = profile({
  id: builtInAgentProfileId('codex'),
  providerId: 'codex',
  displayName: '',
  isDefault: true,
  isBuiltIn: true,
});
const backend = profile({
  id: 'agent-profile:claude:backend',
  providerId: 'claude',
  displayName: 'Backend',
});
const backendClaude = profile({
  id: 'agent-profile:claude:backend-claude',
  providerId: 'claude',
  displayName: 'Backend Claude',
});

const contactSet: AgentProfile[] = [
  claudeDefault,
  codexDefault,
  backend,
  backendClaude,
];

describe('resolveProfileForMention — vendor alias', () => {
  it('resolves @claude to the default claude profile', () => {
    expect(resolveProfileForMention('@claude', contactSet)).toBe(claudeDefault);
  });

  it('resolves the bare token (no @) as a vendor alias too', () => {
    expect(resolveProfileForMention('codex', contactSet)).toBe(codexDefault);
  });

  it('is case-insensitive on the vendor alias', () => {
    expect(resolveProfileForMention('@CLAUDE', contactSet)).toBe(claudeDefault);
  });

  it('vendor alias wins over a same-named custom profile', () => {
    const namedClaude = profile({
      id: 'agent-profile:claude:literal',
      providerId: 'claude',
      displayName: 'claude',
    });
    // Even with a custom profile literally named "claude", @claude → the default.
    expect(
      resolveProfileForMention('@claude', [...contactSet, namedClaude])
    ).toBe(claudeDefault);
  });
});

describe('resolveProfileForMention — named, longest-match-first', () => {
  it('matches the longest display name when names nest', () => {
    expect(resolveProfileForMention('@Backend Claude', contactSet)).toBe(
      backendClaude
    );
  });

  it('still matches the shorter name for the shorter token', () => {
    expect(resolveProfileForMention('@Backend', contactSet)).toBe(backend);
  });

  it('is case-insensitive on multi-word names', () => {
    expect(resolveProfileForMention('@backend claude', contactSet)).toBe(
      backendClaude
    );
  });

  it('longest-match-first over a whitespace-boundary prefix', () => {
    // "backend claude reviewer" prefix-matches "Backend Claude", not "Backend".
    expect(
      resolveProfileForMention('@backend claude reviewer', contactSet)
    ).toBe(backendClaude);
  });

  it('does not partial-match across a word boundary', () => {
    // "backendc" is neither an exact name nor a boundary prefix of any name.
    expect(resolveProfileForMention('@backendc', contactSet)).toBeNull();
  });

  it('built-in defaults (empty name) are never reached by the named path', () => {
    // An empty token normalizes away and resolves to nothing.
    expect(resolveProfileForMention('@', contactSet)).toBeNull();
    expect(resolveProfileForMention('   ', contactSet)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(resolveProfileForMention('@nobody', contactSet)).toBeNull();
  });
});

describe('resolveProfileForMention — collision tiebreak', () => {
  it('prefers the default profile on an equal-name collision', () => {
    const a = profile({
      id: 'agent-profile:claude:aaa',
      displayName: 'Reviewer',
      isDefault: false,
    });
    const b = profile({
      id: 'agent-profile:codex:bbb',
      providerId: 'codex',
      displayName: 'Reviewer',
      isDefault: true,
    });
    // Both named "Reviewer"; the default (b) wins the tiebreak.
    expect(resolveProfileForMention('@Reviewer', [a, b])).toBe(b);
  });

  it('prefers built-in over user-created when neither is default', () => {
    const userMade = profile({
      id: 'agent-profile:claude:zzz',
      displayName: 'Reviewer',
      isBuiltIn: false,
    });
    const builtIn = profile({
      id: 'agent-profile:codex:yyy',
      providerId: 'codex',
      displayName: 'Reviewer',
      isBuiltIn: true,
    });
    expect(resolveProfileForMention('@Reviewer', [userMade, builtIn])).toBe(
      builtIn
    );
  });

  it('breaks a full tie by lexicographically smallest id', () => {
    const first = profile({ id: 'agent-profile:a', displayName: 'Reviewer' });
    const second = profile({ id: 'agent-profile:b', displayName: 'Reviewer' });
    // Deterministic regardless of input order.
    expect(resolveProfileForMention('@Reviewer', [second, first])).toBe(first);
    expect(resolveProfileForMention('@Reviewer', [first, second])).toBe(first);
  });
});

describe('read-time shim — resolveHistoricalAgentSenderProfileId', () => {
  it('maps agent:<framework> to that vendor default profile id', () => {
    expect(
      resolveHistoricalAgentSenderProfileId('agent:claude', contactSet)
    ).toBe(builtInAgentProfileId('claude'));
    expect(
      resolveHistoricalAgentSenderProfileId('agent:codex', contactSet)
    ).toBe(builtInAgentProfileId('codex'));
  });

  it('is case-insensitive on the framework id', () => {
    expect(
      resolveHistoricalAgentSenderProfileId('agent:CLAUDE', contactSet)
    ).toBe(builtInAgentProfileId('claude'));
  });

  it('returns null for non-agent sender ids', () => {
    expect(
      resolveHistoricalAgentSenderProfileId('human:abc', contactSet)
    ).toBeNull();
    expect(
      resolveHistoricalAgentSenderProfileId('system', contactSet)
    ).toBeNull();
  });

  it('returns null for a bare or compound agent id', () => {
    expect(
      resolveHistoricalAgentSenderProfileId('agent:', contactSet)
    ).toBeNull();
    expect(
      resolveHistoricalAgentSenderProfileId('agent:claude:default', contactSet)
    ).toBeNull();
  });

  it('returns null when the vendor has no default in the contact set', () => {
    expect(
      resolveHistoricalAgentSenderProfileId('agent:hermes', contactSet)
    ).toBeNull();
  });
});

describe('parseHistoricalAgentSenderProviderId', () => {
  it('extracts the framework id from a legacy sender', () => {
    expect(parseHistoricalAgentSenderProviderId('agent:codex')).toBe('codex');
  });
  it('rejects non-legacy shapes', () => {
    expect(parseHistoricalAgentSenderProviderId('human:x')).toBeNull();
    expect(parseHistoricalAgentSenderProviderId('agent:')).toBeNull();
    expect(parseHistoricalAgentSenderProviderId('agent:a:b')).toBeNull();
  });
});

describe('normalizeMentionToken', () => {
  it('strips @, lowercases, and collapses whitespace', () => {
    expect(normalizeMentionToken('@@Backend   Claude ')).toBe('backend claude');
  });
});

describe('isAgentProfile', () => {
  it('accepts a minimal valid profile', () => {
    expect(isAgentProfile(claudeDefault)).toBe(true);
  });
  it('rejects a row missing required fields', () => {
    expect(isAgentProfile({ id: 'x' })).toBe(false);
    expect(isAgentProfile(null)).toBe(false);
    expect(isAgentProfile({ ...claudeDefault, isDefault: 'yes' })).toBe(false);
  });
});
