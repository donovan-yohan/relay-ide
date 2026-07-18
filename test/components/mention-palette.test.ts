// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  MentionPalette,
  filterRoster,
} from '../../frontend/src/components/chat/MentionPalette.js';
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

describe('filterRoster', () => {
  it('prefix-filters by id and displayName (case-insensitive)', () => {
    expect(filterRoster(roster, 'h').map((e) => e.id)).toEqual(['hermes']);
    expect(filterRoster(roster, 'Cod').map((e) => e.id)).toEqual(['codex']);
  });

  it('keeps unavailable entries in the filtered list', () => {
    // 'c' matches both claude (available) and codex (unavailable) — the
    // unavailable one is retained (rendered greyed/non-selectable, not dropped).
    const result = filterRoster(roster, 'c');
    expect(result.map((e) => e.id)).toEqual(['claude', 'codex']);
    expect(result.some((e) => !e.available)).toBe(true);
  });

  it('returns the whole roster for an empty query', () => {
    expect(filterRoster(roster, '')).toHaveLength(3);
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

  it('renders one option per entry and marks unavailable rows disabled with the reason title', async () => {
    await act(async () => {
      root.render(
        React.createElement(MentionPalette, {
          entries: roster,
          activeIndex: 0,
          visible: true,
        })
      );
    });

    const options = Array.from(
      container.querySelectorAll('[role="option"]')
    ) as HTMLElement[];
    expect(options).toHaveLength(3);

    // Available rows are selectable (no aria-disabled).
    const claudeRow = options[0]!;
    expect(claudeRow.getAttribute('aria-disabled')).toBeNull();
    expect(claudeRow.textContent).toContain('Claude');

    // The unavailable row is greyed, aria-disabled, and exposes its reason as a
    // hover title.
    const codexRow = container.querySelector(
      '.mention-palette__row--unavailable'
    ) as HTMLElement;
    expect(codexRow).not.toBeNull();
    expect(codexRow.getAttribute('aria-disabled')).toBe('true');
    expect(codexRow.getAttribute('title')).toBe('no api key configured');
    expect(codexRow.getAttribute('role')).toBe('option');
  });

  it('hides the listbox when not visible', async () => {
    await act(async () => {
      root.render(
        React.createElement(MentionPalette, {
          entries: roster,
          activeIndex: 0,
          visible: false,
        })
      );
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.style.display).toBe('none');
  });
});
