// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MentionPalette } from '../../frontend/src/components/chat/MentionPalette.js';
import { buildMentionContacts } from '../../frontend/src/lib/chat/mention-contacts.js';
import {
  annotateMentionCollisions,
  filterMentionContacts,
  type MentionContact,
} from '../../shared/mention-contacts.js';
import { builtInAgentProfileId } from '../../shared/agent-profile.js';
import type { RosterEntry } from '../../frontend/src/lib/api.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roster: RosterEntry[] = [
  {
    id: 'claude',
    displayName: 'Claude',
    kind: 'framework',
    available: true,
    reason: null,
    binding: null,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    kind: 'framework',
    available: false,
    reason: 'no api key configured',
    binding: null,
  },
  {
    id: 'hermes',
    displayName: 'Hermes',
    kind: 'framework',
    available: true,
    reason: null,
    binding: { sessionId: 'sess-1', status: 'thinking' },
  },
];

describe('buildMentionContacts', () => {
  it('synthesizes a vendor-default profile per framework, keyed on the built-in id', () => {
    const contacts = buildMentionContacts(roster);
    expect(contacts.map((c) => c.id)).toEqual([
      builtInAgentProfileId('claude'),
      builtInAgentProfileId('codex'),
      builtInAgentProfileId('hermes'),
    ]);
    for (const c of contacts) {
      expect(c.kind).toBe('vendor-default');
      expect(c.owner).toBe('system');
      expect(c.isDefault).toBe(true);
      expect(c.isBuiltIn).toBe(true);
      expect(c.inChannel).toBe(true);
    }
    const codex = contacts.find((c) => c.providerId === 'codex')!;
    expect(codex.available).toBe(false);
    expect(codex.reason).toBe('no api key configured');
  });

  it('folds human members in as human contacts (prefix-stripped label)', () => {
    const contacts = buildMentionContacts(roster, [
      { kind: 'human', id: 'human:alex', joinedAt: 't' },
      { kind: 'agent', id: 'agent:mock', joinedAt: 't' },
    ]);
    const human = contacts.find((c) => c.kind === 'human')!;
    expect(human.id).toBe('human:alex');
    expect(human.displayName).toBe('alex');
    expect(human.providerId).toBe('human');
    // agent members are not folded in as humans.
    expect(contacts.filter((c) => c.kind === 'human')).toHaveLength(1);
  });
});

describe('filterMentionContacts', () => {
  const contacts = buildMentionContacts(roster);

  it('prefix-filters by display name / vendor id (case-insensitive)', () => {
    expect(
      filterMentionContacts(contacts, 'h').map((c) => c.providerId)
    ).toEqual(['hermes']);
    expect(
      filterMentionContacts(contacts, 'Cod').map((c) => c.providerId)
    ).toEqual(['codex']);
  });

  it('keeps unavailable contacts in the filtered list', () => {
    const result = filterMentionContacts(contacts, 'c');
    expect(result.map((c) => c.providerId)).toEqual(['claude', 'codex']);
    expect(result.some((c) => !c.available)).toBe(true);
  });

  it('returns the whole set for an empty query', () => {
    expect(filterMentionContacts(contacts, '')).toHaveLength(3);
  });
});

describe('MentionPalette rendering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(contacts: MentionContact[]): void {
    act(() => {
      root.render(
        React.createElement(MentionPalette, {
          contacts,
          activeIndex: 0,
          visible: true,
        })
      );
    });
  }

  it('renders one option per contact, with a kind tag and an owner label', () => {
    render(buildMentionContacts(roster));
    const options = Array.from(
      container.querySelectorAll('[role="option"]')
    ) as HTMLElement[];
    expect(options).toHaveLength(3);
    const claude = options[0]!;
    expect(claude.textContent).toContain('Claude');
    expect(claude.querySelector('.mention-palette__kind')?.textContent).toBe(
      'vendor'
    );
    expect(claude.querySelector('.mention-palette__owner')?.textContent).toBe(
      'system'
    );
  });

  it('marks an unavailable contact inert with its reason as the hover title', () => {
    render(buildMentionContacts(roster));
    const inert = container.querySelector(
      '.mention-palette__row--inert'
    ) as HTMLElement;
    expect(inert).not.toBeNull();
    expect(inert.getAttribute('aria-disabled')).toBe('true');
    expect(inert.getAttribute('title')).toBe('no api key configured');
    expect(inert.textContent).toContain('no api key configured');
  });

  it('renders a not-in-channel state and marks the row inert', () => {
    const notMember: MentionContact = {
      id: 'agent-profile:claude:reviewer',
      providerId: 'claude',
      displayName: 'Reviewer',
      kind: 'profile',
      owner: 'donovan',
      available: true,
      reason: null,
      inChannel: false,
      isDefault: false,
      isBuiltIn: false,
    };
    render([notMember]);
    const row = container.querySelector('[role="option"]') as HTMLElement;
    expect(row.className).toContain('mention-palette__row--inert');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(
      container.querySelector('.mention-palette__state')?.textContent
    ).toBe('not in channel');
    // owner label surfaces for a custom profile.
    expect(
      container.querySelector('.mention-palette__owner')?.textContent
    ).toBe('donovan');
  });

  it('renders a monospace disambiguator token for same-name collisions', () => {
    const collide: MentionContact[] = [
      {
        id: 'agent-profile:claude:aaaaaa',
        providerId: 'claude',
        displayName: 'Reviewer',
        kind: 'profile',
        owner: 'donovan',
        available: true,
        reason: null,
        inChannel: true,
        isDefault: false,
        isBuiltIn: false,
      },
      {
        id: 'agent-profile:codex:bbbbbb',
        providerId: 'codex',
        displayName: 'Reviewer',
        kind: 'profile',
        owner: 'donovan',
        available: true,
        reason: null,
        inChannel: true,
        isDefault: false,
        isBuiltIn: false,
      },
    ];
    // Annotate exactly as the builder does before rendering.
    render(annotateMentionCollisions(collide));
    const tokens = Array.from(
      container.querySelectorAll('.mention-palette__disambiguator')
    ).map((el) => el.textContent);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('hides the listbox when not visible', () => {
    act(() => {
      root.render(
        React.createElement(MentionPalette, {
          contacts: buildMentionContacts(roster),
          activeIndex: 0,
          visible: false,
        })
      );
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.style.display).toBe('none');
  });
});
