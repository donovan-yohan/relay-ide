// @vitest-environment happy-dom
//
// WorkbenchBlockCreateDialog tests (#631) — verifies the create-block flow
// wires EnvironmentPicker + pickDefaultEnvironment per the parent epic
// #615 acceptance criteria.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentOption } from '../../shared/environment-option.js';
import { WorkbenchBlockCreateDialog } from '../../frontend/src/workbench/WorkbenchBlockCreateDialog.js';
import {
  WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION,
  buildBlockEnvironmentRef,
} from '../../shared/workbench-block-environment.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-05-19T12:00:00.000Z';

function freshOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: 'opt-relay-nightly',
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
      repoInstanceId: 'local:%2FUsers%2Fdev%2Frepos%2Frelay-ide',
      localPath: '/Users/dev/repos/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'nightly',
      defaultBranch: 'master',
    },
    generatedAt: NOW,
    ...overrides,
  };
}

function staleOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return freshOption({
    id: 'opt-stale',
    freshness: 'stale',
    degradedReasons: [
      { kind: 'node-stale', lastSeenAt: '2026-05-19T11:00:00.000Z' },
    ],
    ...overrides,
  });
}

function offlineOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return freshOption({
    id: 'opt-offline',
    node: { nodeId: 'mac', kind: 'remote', displayName: 'mac', online: false },
    freshness: 'offline',
    degradedReasons: [{ kind: 'node-offline' }],
    ...overrides,
  });
}

describe('<WorkbenchBlockCreateDialog />', () => {
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

  async function render(
    props: React.ComponentProps<typeof WorkbenchBlockCreateDialog>
  ) {
    await act(async () => {
      root.render(React.createElement(WorkbenchBlockCreateDialog, props));
    });
  }

  it('renders the EnvironmentPicker with options', async () => {
    await render({
      candidates: [freshOption(), staleOption()],
      onCreate: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(
      container.querySelector('[data-testid="env-picker-search"]')
    ).toBeTruthy();
    expect(container.querySelectorAll('[role="option"]').length).toBe(2);
  });

  it('preselects the option chosen by pickDefaultEnvironment (history hit)', async () => {
    const fresh = freshOption();
    await render({
      candidates: [staleOption(), fresh],
      activeTab: null,
      history: [{ environmentId: fresh.id, lastUsedAt: NOW }],
      onCreate: vi.fn(),
      onCancel: vi.fn(),
    });
    const selected = container.querySelector(
      '[role="option"][aria-selected="true"]'
    );
    expect(selected?.getAttribute('data-option-id')).toBe(fresh.id);
  });

  it('blocks create when no fresh candidate exists and surfaces a typed reason', async () => {
    const onCreate = vi.fn();
    await render({
      candidates: [staleOption(), offlineOption()],
      onCreate,
      onCancel: vi.fn(),
    });
    const errorBanner = container.querySelector(
      '[data-testid="workbench-block-create-default-error"]'
    );
    expect(errorBanner?.textContent).toContain('no fresh');
    // Title input + stale selection MUST still not enable create.
    const titleInput = container.querySelector(
      '[data-testid="workbench-block-create-title"]'
    ) as HTMLInputElement;
    await act(async () => {
      titleInput.value = 'attempt';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const confirm = container.querySelector(
      '[data-testid="workbench-block-create-confirm"]'
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('never silently switches nodes when the active tab is degraded', async () => {
    const fresh = freshOption();
    const stale = staleOption({ id: 'opt-active-stale' });
    const onCreate = vi.fn();
    await render({
      candidates: [stale, fresh],
      activeTab: { environment: stale },
      onCreate,
      onCancel: vi.fn(),
    });
    // The default error MUST appear (active tab degraded) and the picker MUST
    // start with no preselection — the user has to make an explicit choice.
    const errorBanner = container.querySelector(
      '[data-testid="workbench-block-create-default-error"]'
    );
    expect(errorBanner).toBeTruthy();
    expect(errorBanner?.textContent).toContain('stale');
    const selected = container.querySelector(
      '[role="option"][aria-selected="true"]'
    );
    expect(selected).toBeNull();
  });

  it('emits typed env IDs on confirm — no free-form path strings beyond cwd', async () => {
    const onCreate = vi.fn();
    const fresh = freshOption();
    await render({
      candidates: [fresh],
      history: [{ environmentId: fresh.id, lastUsedAt: NOW }],
      onCreate,
      onCancel: vi.fn(),
      nowIso: () => NOW,
    });
    const titleInput = container.querySelector(
      '[data-testid="workbench-block-create-title"]'
    ) as HTMLInputElement;
    // React's onChange listens via SyntheticEvent on the native input event.
    // Use the native setter so React picks the value up reliably under happy-dom.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setter.call(titleInput, 'shell');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const confirmBtn = container.querySelector(
      '[data-testid="workbench-block-create-confirm"]'
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    await act(async () => {
      confirmBtn.click();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    const req = onCreate.mock.calls[0]?.[0];
    expect(req.title).toBe('shell');
    expect(req.kind).toBe('terminal');
    expect(req.environment.schemaVersion).toBe(
      WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION
    );
    expect(req.environment.nodeId).toBe('local');
    expect(req.environment.repoIdentity).toBe(
      'github.com/donovan-yohan/relay-ide'
    );
    expect(req.environment.repoInstanceId).toBe(
      'local:%2FUsers%2Fdev%2Frepos%2Frelay-ide'
    );
    expect(req.environment.cwd).toBe('/Users/dev/repos/relay-ide');
    expect(req.environment.pickerOptionId).toBe(fresh.id);
    // Sanity: the matching helper produces an identical envelope.
    expect(req.environment).toEqual(
      buildBlockEnvironmentRef({ option: fresh, createdAt: NOW })
    );
  });

  it('filters candidates by required capabilities', async () => {
    await render({
      candidates: [
        freshOption({
          id: 'opt-no-git',
          capabilities: ['session:create:terminal'],
        }),
        freshOption({
          id: 'opt-with-git',
          capabilities: ['session:create:terminal', 'rpc:git:write'],
        }),
      ],
      requiredCapabilities: ['rpc:git:write'],
      onCreate: vi.fn(),
      onCancel: vi.fn(),
    });
    const rows = container.querySelectorAll('[role="option"]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute('data-option-id')).toBe('opt-with-git');
  });

  it('cancels via the cancel button', async () => {
    const onCancel = vi.fn();
    await render({
      candidates: [freshOption()],
      onCreate: vi.fn(),
      onCancel,
    });
    const buttons = Array.from(
      container.querySelectorAll('.workbench-block-create-dialog__cancel-btn')
    ) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    await act(async () => {
      buttons[0]!.click();
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
