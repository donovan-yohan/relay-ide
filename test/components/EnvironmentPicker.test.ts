// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentOption } from '../../shared/environment-option.js';
import {
  EnvironmentPicker,
  groupOptionsByRepoIdentity,
  filterOptions,
} from '../../frontend/src/components/EnvironmentPicker.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

function option(overrides: Partial<EnvironmentOption> = {}): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: 'opt-default',
    node: {
      nodeId: 'local',
      kind: 'local',
      displayName: 'this host',
      online: true,
    },
    capabilities: ['session:create:terminal', 'rpc:fs:read'],
    cwd: '/Users/dev/repos/relay-ide',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: 'local:/Users/dev/repos/relay-ide',
      localPath: '/Users/dev/repos/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'nightly',
      defaultBranch: 'master',
    },
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

function freeOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: 'opt-free',
    node: {
      nodeId: 'local',
      kind: 'local',
      displayName: 'this host',
      online: true,
    },
    capabilities: ['session:create:terminal'],
    cwd: '/tmp/scratch',
    cwdMode: 'free',
    freshness: 'fresh',
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

describe('groupOptionsByRepoIdentity', () => {
  it('groups options by repoIdentity and puts free (no repo) in its own group last', () => {
    const opts: EnvironmentOption[] = [
      option({ id: 'a' }),
      option({
        id: 'b',
        repoInstance: {
          repoInstanceId: 'mac:/repos/relay-ide',
          localPath: '/repos/relay-ide',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          name: 'relay-ide',
          currentBranch: 'main',
          defaultBranch: 'master',
        },
        node: {
          nodeId: 'mac',
          kind: 'remote',
          displayName: 'mac',
          online: true,
        },
      }),
      option({
        id: 'c',
        repoInstance: {
          repoInstanceId: 'local:/repos/other',
          localPath: '/repos/other',
          repoIdentity: 'github.com/donovan-yohan/other',
          name: 'other',
        },
      }),
      freeOption({ id: 'd' }),
    ];
    const groups = groupOptionsByRepoIdentity(opts);
    // Two repo groups + one free group
    expect(groups).toHaveLength(3);
    const relay = groups.find(
      (g) => g.repoIdentity === 'github.com/donovan-yohan/relay-ide'
    );
    expect(relay).toBeTruthy();
    expect(relay?.options.map((o) => o.id)).toEqual(['a', 'b']);
    // free is last
    const free = groups[groups.length - 1];
    expect(free?.repoIdentity).toBeNull();
    expect(free?.options.map((o) => o.id)).toEqual(['d']);
  });

  it('treats options without repoInstance as the free / non-git group', () => {
    const groups = groupOptionsByRepoIdentity([freeOption({ id: 'x' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.repoIdentity).toBeNull();
    expect(groups[0]?.options).toHaveLength(1);
  });
});

describe('filterOptions', () => {
  const opts: EnvironmentOption[] = [
    option({ id: 'a' }),
    option({
      id: 'b',
      node: {
        nodeId: 'mac',
        kind: 'remote',
        displayName: 'dev mac',
        online: true,
      },
      repoInstance: {
        repoInstanceId: 'mac:/repos/relay-ide',
        localPath: '/repos/relay-ide',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        name: 'relay-ide',
        currentBranch: 'main',
      },
    }),
    freeOption({ id: 'c', cwd: '/tmp/scratch' }),
  ];

  it('returns all options for empty query', () => {
    expect(filterOptions(opts, '').map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('matches node displayName case-insensitively', () => {
    expect(filterOptions(opts, 'dev mac').map((o) => o.id)).toEqual(['b']);
    expect(filterOptions(opts, 'MAC').map((o) => o.id)).toEqual(['b']);
  });

  it('matches cwd substring', () => {
    expect(filterOptions(opts, 'scratch').map((o) => o.id)).toEqual(['c']);
  });

  it('matches repo identity', () => {
    expect(filterOptions(opts, 'donovan-yohan').map((o) => o.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('returns empty when nothing matches', () => {
    expect(filterOptions(opts, 'absolutely-nothing-here')).toEqual([]);
  });
});

describe('<EnvironmentPicker />', () => {
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

  async function renderPicker(
    props: React.ComponentProps<typeof EnvironmentPicker>
  ) {
    await act(async () => {
      root.render(React.createElement(EnvironmentPicker, props));
    });
  }

  it('renders option rows grouped by RepoIdentity', async () => {
    await renderPicker({
      options: [
        option({ id: 'a' }),
        option({
          id: 'b',
          repoInstance: {
            repoInstanceId: 'local:/repos/other',
            localPath: '/repos/other',
            repoIdentity: 'github.com/donovan-yohan/other',
            name: 'other',
          },
        }),
        freeOption({ id: 'c' }),
      ],
      onSelect: vi.fn(),
    });
    const groupHeaders = container.querySelectorAll(
      '[data-testid="env-picker-group"]'
    );
    expect(groupHeaders.length).toBe(3);
    const optionRows = container.querySelectorAll('[role="option"]');
    expect(optionRows.length).toBe(3);
  });

  it('renders a distinct non-git group label for free cwd options', async () => {
    await renderPicker({
      options: [option({ id: 'a' }), freeOption({ id: 'c' })],
      onSelect: vi.fn(),
    });
    const headers = Array.from(
      container.querySelectorAll('[data-testid="env-picker-group-label"]')
    ).map((el) => el.textContent);
    // Free/non-git group uses an explicit lowercase label that is NOT a repo identity
    expect(headers).toContain('non-git cwd');
  });

  it('shows freshness state on each option', async () => {
    await renderPicker({
      options: [
        option({ id: 'a', freshness: 'fresh' }),
        option({
          id: 'b',
          freshness: 'stale',
          degradedReasons: [
            { kind: 'node-stale', lastSeenAt: '2026-05-19T11:00:00.000Z' },
          ],
        }),
        option({
          id: 'c',
          freshness: 'offline',
          node: {
            nodeId: 'offline',
            kind: 'remote',
            displayName: 'offline',
            online: false,
          },
          degradedReasons: [{ kind: 'node-offline' }],
        }),
      ],
      onSelect: vi.fn(),
    });
    const fresh = container.querySelector('[data-option-id="a"]');
    const stale = container.querySelector('[data-option-id="b"]');
    const offline = container.querySelector('[data-option-id="c"]');
    expect(fresh?.getAttribute('data-freshness')).toBe('fresh');
    expect(stale?.getAttribute('data-freshness')).toBe('stale');
    expect(offline?.getAttribute('data-freshness')).toBe('offline');
  });

  it('renders one badge per advertised capability', async () => {
    await renderPicker({
      options: [
        option({
          id: 'a',
          capabilities: [
            'session:create:terminal',
            'rpc:fs:read',
            'rpc:git:read',
          ],
        }),
      ],
      onSelect: vi.fn(),
    });
    const row = container.querySelector('[data-option-id="a"]') as HTMLElement;
    expect(row).toBeTruthy();
    const badges = row.querySelectorAll(
      '[data-testid="env-picker-capability"]'
    );
    expect(badges.length).toBe(3);
    const labels = Array.from(badges).map((b) => b.textContent);
    expect(labels).toContain('session:create:terminal');
    expect(labels).toContain('rpc:git:read');
  });

  it('renders degraded reason text when present', async () => {
    await renderPicker({
      options: [
        option({
          id: 'a',
          freshness: 'stale',
          degradedReasons: [
            {
              kind: 'capability-missing',
              capability: 'rpc:git:write',
              message: 'git write capability not granted',
            },
          ],
        }),
      ],
      onSelect: vi.fn(),
    });
    const row = container.querySelector('[data-option-id="a"]') as HTMLElement;
    const reason = row.querySelector('[data-testid="env-picker-degraded"]');
    expect(reason?.textContent).toContain('git write capability not granted');
  });

  it('invokes onSelect when an option is clicked', async () => {
    const onSelect = vi.fn();
    await renderPicker({
      options: [option({ id: 'a' }), option({ id: 'b' })],
      onSelect,
    });
    const row = container.querySelector('[data-option-id="b"]') as HTMLElement;
    await act(async () => {
      row.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.id).toBe('b');
  });

  it('moves keyboard focus with ArrowDown/ArrowUp and selects with Enter', async () => {
    const onSelect = vi.fn();
    await renderPicker({
      options: [option({ id: 'a' }), option({ id: 'b' }), option({ id: 'c' })],
      onSelect,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox).toBeTruthy();
    // First option is active by default
    expect(listbox.getAttribute('aria-activedescendant')).toContain('a');
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      );
    });
    expect(listbox.getAttribute('aria-activedescendant')).toContain('b');
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      );
    });
    expect(listbox.getAttribute('aria-activedescendant')).toContain('c');
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
      );
    });
    expect(listbox.getAttribute('aria-activedescendant')).toContain('b');
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.id).toBe('b');
  });

  it('calls onCancel on Escape', async () => {
    const onCancel = vi.fn();
    await renderPicker({
      options: [option({ id: 'a' })],
      onSelect: vi.fn(),
      onCancel,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('filters options as the search input changes', async () => {
    await renderPicker({
      options: [
        option({
          id: 'a',
          node: {
            nodeId: 'local',
            kind: 'local',
            displayName: 'this host',
            online: true,
          },
        }),
        option({
          id: 'b',
          node: {
            nodeId: 'mac',
            kind: 'remote',
            displayName: 'dev mac',
            online: true,
          },
        }),
      ],
      onSelect: vi.fn(),
    });
    const input = container.querySelector(
      '[data-testid="env-picker-search"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    // Use React's native input-value setter so the input event is observed
    // as a real user keystroke. Setting `.value` directly bypasses React's
    // change tracker and the synthetic onChange never fires.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      setter!.call(input, 'mac');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const rows = container.querySelectorAll('[role="option"]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute('data-option-id')).toBe('b');
  });

  it('exposes ARIA combobox/listbox roles and aria-expanded', async () => {
    await renderPicker({
      options: [option({ id: 'a' })],
      onSelect: vi.fn(),
    });
    const combobox = container.querySelector(
      '[role="combobox"]'
    ) as HTMLElement;
    expect(combobox).toBeTruthy();
    expect(combobox.getAttribute('aria-expanded')).toBe('true');
    expect(combobox.getAttribute('aria-controls')).toBeTruthy();
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox).toBeTruthy();
    expect(listbox.id).toBe(combobox.getAttribute('aria-controls'));
  });

  it('renders an empty state when no options match the filter', async () => {
    await renderPicker({
      options: [option({ id: 'a' })],
      onSelect: vi.fn(),
    });
    const input = container.querySelector(
      '[data-testid="env-picker-search"]'
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      setter!.call(input, 'nothing-matches');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('[role="option"]').length).toBe(0);
    expect(
      container.querySelector('[data-testid="env-picker-empty"]')
    ).toBeTruthy();
  });
});
