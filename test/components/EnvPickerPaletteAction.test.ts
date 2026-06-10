// @vitest-environment happy-dom

// EnvPickerPaletteAction (#630) — integration coverage for the command
// palette action that opens the EnvironmentPicker.
//
// Scope:
//   1. The action meta is registered and discoverable in the registry under
//      the natural search terms ("start work", "environment").
//   2. EnvPickerDialog computes its initial selection via
//      `pickDefaultEnvironment` (#628) so palette + new-session dialog share
//      identical default behavior (#629 reuses the same hook).
//   3. Selecting a FRESH environment from the dialog fires the launch hook
//      with typed IDs derived from the EnvironmentOption.
//   4. Selecting a STALE / OFFLINE environment blocks launch and surfaces
//      the typed degraded reason — never silently switches nodes (#615
//      invariant).
//   5. Escape closes the dialog.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentOption } from '../../shared/environment-option.js';
import { sessionStartWorkInEnv } from '../../frontend/src/lib/actions/definitions/session.js';
import {
  _resetForTesting,
  getAction,
  getAllActions,
  registerGlobal,
} from '../../frontend/src/lib/actions/registry.js';
import { EnvPickerDialog } from '../../frontend/src/components/dialogs/EnvPickerDialog.js';
import type { LaunchEnvironmentResult } from '../../frontend/src/lib/launch-environment.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

function freshOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: 'opt-fresh',
    node: {
      nodeId: 'local',
      kind: 'local',
      displayName: 'this host',
      online: true,
    },
    capabilities: ['session:create:terminal'],
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

function staleOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return freshOption({
    id: 'opt-stale',
    freshness: 'stale',
    degradedReasons: [
      { kind: 'node-stale', lastSeenAt: '2026-05-19T11:00:00.000Z' },
    ],
    node: {
      nodeId: 'mac',
      kind: 'remote',
      displayName: 'dev mac',
      online: true,
    },
    ...overrides,
  });
}

function offlineOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return freshOption({
    id: 'opt-offline',
    freshness: 'offline',
    degradedReasons: [
      { kind: 'node-offline', message: 'node offline since 11:30' },
    ],
    node: {
      nodeId: 'offline-host',
      kind: 'remote',
      displayName: 'offline-host',
      online: false,
    },
    ...overrides,
  });
}

// #863: a fresh option whose node advertises a mix of available + degraded /
// unavailable / unknown agent providers. The launch-target chooser renders
// each, gates selection on availability, and never lets an unavailable
// provider block the terminal launch on the same node.
function providerOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return freshOption({
    id: 'opt-providers',
    node: {
      nodeId: 'local',
      kind: 'local',
      displayName: 'this host',
      online: true,
      agentProviders: [
        { id: 'claude', availability: 'available' },
        {
          id: 'codex',
          availability: 'unavailable',
          reason: 'cli not installed',
        },
        { id: 'opencode', availability: 'degraded', authStatus: 'logged out' },
        { id: 'hermes', availability: 'unknown' },
      ],
    },
    ...overrides,
  });
}

describe('sessionStartWorkInEnv action meta', () => {
  it('registers and is discoverable by the palette search terms', () => {
    _resetForTesting();
    registerGlobal([{ ...sessionStartWorkInEnv, handler: () => {} }]);
    const registered = getAction('session.start-work-in-env');
    expect(registered).toBeTruthy();
    expect(registered?.label).toMatch(/start work in environment/i);
    // The palette's `buildResults` matches against label, description, and
    // aliases (lowercased substring). We assert the action would match the
    // user-facing search terms from the issue acceptance criteria.
    const matchSearch = (q: string): boolean => {
      const a = registered!;
      const needle = q.toLowerCase();
      return (
        a.label.toLowerCase().includes(needle) ||
        a.description?.toLowerCase().includes(needle) ||
        a.aliases?.some((alias) => alias.toLowerCase().includes(needle)) ===
          true
      );
    };
    expect(matchSearch('start work')).toBe(true);
    expect(matchSearch('environment')).toBe(true);
    expect(matchSearch('env')).toBe(true);
    expect(matchSearch('node')).toBe(true);
    // #862: the env picker is now the terminal launcher. The palette must
    // surface it under the terminal-first search terms too.
    expect(matchSearch('terminal')).toBe(true);
    expect(matchSearch('start-work')).toBe(true);
    expect(matchSearch('launch')).toBe(true);
    expect(matchSearch('shell')).toBe(true);
  });

  it('appears alongside other session-category actions in getAllActions', () => {
    _resetForTesting();
    registerGlobal([{ ...sessionStartWorkInEnv, handler: () => {} }]);
    expect(
      getAllActions().some((a) => a.id === 'session.start-work-in-env')
    ).toBe(true);
  });
});

describe('<EnvPickerDialog /> (palette wiring)', () => {
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
    props: React.ComponentProps<typeof EnvPickerDialog>
  ) {
    await act(async () => {
      root.render(React.createElement(EnvPickerDialog, props));
    });
  }

  it('does not render when closed', async () => {
    await render({
      open: false,
      options: [freshOption()],
      onClose: vi.fn(),
    });
    expect(container.querySelector('[data-testid="env-picker-dialog"]')).toBe(
      null
    );
  });

  it('renders the picker when open with default selection from pickDefaultEnvironment', async () => {
    const a = freshOption({ id: 'a' });
    const b = freshOption({ id: 'b' });
    await render({
      open: true,
      options: [a, b],
      // No activeTab → safe-defaults rule 3 picks first-fresh = 'a'.
      activeTab: null,
      history: [],
      onClose: vi.fn(),
    });
    const row = container.querySelector(
      '[data-option-id="a"]'
    ) as HTMLElement | null;
    expect(row).toBeTruthy();
    expect(row?.getAttribute('aria-selected')).toBe('true');
    const otherRow = container.querySelector(
      '[data-option-id="b"]'
    ) as HTMLElement | null;
    expect(otherRow?.getAttribute('aria-selected')).toBe('false');
  });

  it('respects history when no active tab is present', async () => {
    const a = freshOption({ id: 'a' });
    const b = freshOption({ id: 'b' });
    await render({
      open: true,
      options: [a, b],
      activeTab: null,
      history: [{ environmentId: 'b', lastUsedAt: GENERATED_AT }],
      onClose: vi.fn(),
    });
    const bRow = container.querySelector(
      '[data-option-id="b"]'
    ) as HTMLElement | null;
    expect(bRow?.getAttribute('aria-selected')).toBe('true');
  });

  it('selecting a fresh option invokes the launch hook with typed env IDs', async () => {
    const fresh = freshOption({ id: 'opt-launch' });
    const launch = vi.fn(async (): Promise<LaunchEnvironmentResult> => ({
      kind: 'launched',
      result: { session: undefined, error: null },
    }));
    const onClose = vi.fn();
    const onLaunched = vi.fn();
    await render({
      open: true,
      options: [fresh],
      onClose,
      onLaunched,
      launch,
    });
    const row = container.querySelector(
      '[data-option-id="opt-launch"]'
    ) as HTMLElement;
    expect(row).toBeTruthy();
    await act(async () => {
      row.click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    const launchArgOption = launch.mock.calls[0]?.[0] as EnvironmentOption;
    // Typed env identity propagates through the launch call — the contract
    // child issues / agent tasks rely on (#615 acceptance criterion).
    expect(launchArgOption.id).toBe('opt-launch');
    expect(launchArgOption.node.nodeId).toBe('local');
    expect(launchArgOption.repoInstance?.repoInstanceId).toBe(
      'local:/Users/dev/repos/relay-ide'
    );
    expect(onLaunched).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks launch on a stale option and surfaces the typed reason', async () => {
    const stale = staleOption({ id: 'opt-stale-block' });
    const launch = vi.fn(async (): Promise<LaunchEnvironmentResult> => ({
      kind: 'launched',
      result: { session: undefined, error: null },
    }));
    const onClose = vi.fn();
    await render({
      open: true,
      options: [stale],
      onClose,
      launch,
    });
    const row = container.querySelector(
      '[data-option-id="opt-stale-block"]'
    ) as HTMLElement;
    await act(async () => {
      row.click();
    });
    // CRITICAL: never silently switch nodes. The launch hook MUST NOT be
    // called, the dialog MUST stay open, and a typed block reason must be
    // surfaced for the user.
    expect(launch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const block = container.querySelector(
      '[data-testid="env-picker-dialog-block-reason"]'
    );
    expect(block).toBeTruthy();
    expect(block?.textContent).toMatch(/stale/i);
  });

  it('blocks launch on an offline option with the offline reason', async () => {
    const offline = offlineOption({ id: 'opt-offline-block' });
    const launch = vi.fn();
    const onClose = vi.fn();
    await render({
      open: true,
      options: [offline],
      onClose,
      launch,
    });
    const row = container.querySelector(
      '[data-option-id="opt-offline-block"]'
    ) as HTMLElement;
    await act(async () => {
      row.click();
    });
    expect(launch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const block = container.querySelector(
      '[data-testid="env-picker-dialog-block-reason"]'
    );
    expect(block?.textContent).toMatch(/offline/i);
  });

  it('closes via Escape from the picker', async () => {
    const onClose = vi.fn();
    await render({
      open: true,
      options: [freshOption()],
      onClose,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards against re-entry: a second click while launching is a no-op', async () => {
    // CodeRabbit PR #646 feedback: a fast double-click on a fresh row would
    // otherwise fire two POST /sessions calls before React rerendered the
    // `launching` flag. The ref-based guard MUST hold synchronously.
    const fresh = freshOption({ id: 'opt-double' });
    let resolveLaunch!: (value: LaunchEnvironmentResult) => void;
    const launch = vi.fn(
      () =>
        new Promise<LaunchEnvironmentResult>((resolve) => {
          resolveLaunch = resolve;
        })
    );
    const onClose = vi.fn();
    await render({
      open: true,
      options: [fresh],
      onClose,
      launch,
    });
    const row = container.querySelector(
      '[data-option-id="opt-double"]'
    ) as HTMLElement;
    await act(async () => {
      row.click();
      row.click(); // second click while the first launch is in-flight
      row.click(); // and a third for good measure
    });
    expect(launch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveLaunch({
        kind: 'launched',
        result: { session: undefined, error: null },
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a typed block reason if the launch hook throws', async () => {
    // CodeRabbit PR #646 feedback: a rejected launch promise must not leave
    // the dialog in a silently-broken state. The error must be surfaced so
    // the user can retry / pick a different env.
    const fresh = freshOption({ id: 'opt-throw' });
    const launch = vi.fn(async (): Promise<LaunchEnvironmentResult> => {
      throw new Error('network down');
    });
    const onClose = vi.fn();
    const onLaunched = vi.fn();
    await render({
      open: true,
      options: [fresh],
      onClose,
      onLaunched,
      launch,
    });
    const row = container.querySelector(
      '[data-option-id="opt-throw"]'
    ) as HTMLElement;
    await act(async () => {
      row.click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const block = container.querySelector(
      '[data-testid="env-picker-dialog-block-reason"]'
    );
    expect(block?.textContent).toMatch(/launch failed/i);
    expect(block?.textContent).toMatch(/network down/i);
  });

  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    await render({
      open: true,
      options: [freshOption()],
      onClose,
    });
    const overlay = container.querySelector(
      '[data-testid="env-picker-dialog"]'
    ) as HTMLElement;
    await act(async () => {
      overlay.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// #863 — agent/provider launch-target chooser. Verifies that the dialog
// surfaces per-node provider choices with availability states + reasons,
// disables non-available providers, launches with `{ type: 'agent', agent }`
// on selection, and NEVER lets an unavailable provider block the always-
// enabled terminal path (preselected — zero extra clicks).
describe('<EnvPickerDialog /> launch-target chooser (#863)', () => {
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

  async function render(props: React.ComponentProps<typeof EnvPickerDialog>) {
    await act(async () => {
      root.render(React.createElement(EnvPickerDialog, props));
    });
  }

  const okLaunch = () =>
    vi.fn(async (): Promise<LaunchEnvironmentResult> => ({
      kind: 'launched',
      result: { session: undefined, error: null },
    }));

  function targetButtons(): HTMLButtonElement[] {
    return Array.from(
      container.querySelectorAll(
        '[data-testid="env-picker-dialog-target-agent"], [data-testid="env-picker-dialog-target-terminal"]'
      )
    ) as HTMLButtonElement[];
  }

  function agentButton(agent: string): HTMLButtonElement {
    return container.querySelector(
      `[data-testid="env-picker-dialog-target-agent"][data-agent="${agent}"]`
    ) as HTMLButtonElement;
  }

  it('renders the provider list with availability states + reasons', async () => {
    await render({
      open: true,
      options: [providerOption()],
      launchOverrides: { type: 'terminal' },
      onClose: vi.fn(),
    });
    // terminal + 4 providers = 5 target buttons.
    expect(targetButtons()).toHaveLength(5);

    const claude = agentButton('claude');
    expect(claude).toBeTruthy();
    expect(claude.getAttribute('data-availability')).toBe('available');
    expect(claude.disabled).toBe(false);

    // Each non-available provider surfaces a lowercase reason.
    const codex = agentButton('codex');
    expect(codex.getAttribute('data-availability')).toBe('unavailable');
    expect(codex.textContent).toMatch(/cli not installed/i);

    const opencode = agentButton('opencode');
    // degraded provider surfaces its auth status in the reason.
    expect(opencode.textContent).toMatch(/logged out/i);

    const hermes = agentButton('hermes');
    expect(hermes.getAttribute('data-availability')).toBe('unknown');
    // unknown falls back to a typed reason rather than a silent disable.
    expect(hermes.textContent).toMatch(/unknown/i);

    // Reasons are lowercase per DESIGN.md.
    const reason = container.querySelector(
      '[data-testid="env-picker-dialog-target-reason"]'
    );
    expect(reason?.textContent).toBe(reason?.textContent?.toLowerCase());
  });

  it('disables degraded / unavailable / unknown providers; enables available', async () => {
    await render({
      open: true,
      options: [providerOption()],
      launchOverrides: { type: 'terminal' },
      onClose: vi.fn(),
    });
    expect(agentButton('claude').disabled).toBe(false);
    expect(agentButton('codex').disabled).toBe(true);
    expect(agentButton('opencode').disabled).toBe(true);
    expect(agentButton('hermes').disabled).toBe(true);
  });

  it('terminal is preselected and launches with { type: terminal } on row click (zero extra clicks)', async () => {
    const launch = okLaunch();
    const onClose = vi.fn();
    await render({
      open: true,
      options: [providerOption()],
      launchOverrides: { type: 'terminal' },
      onClose,
      launch,
    });
    // terminal target carries the persistent "selected" mark from the start.
    const terminal = container.querySelector(
      '[data-testid="env-picker-dialog-target-terminal"]'
    ) as HTMLButtonElement;
    expect(terminal.getAttribute('aria-pressed')).toBe('true');

    // Clicking the option ROW (not a provider) launches a plain terminal —
    // the #862 path is unchanged and takes no extra clicks.
    const row = container.querySelector(
      '[data-option-id="opt-providers"]'
    ) as HTMLElement;
    await act(async () => {
      row.click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[1]).toEqual({ type: 'terminal' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('selecting an available provider launches with { type: agent, agent }', async () => {
    const launch = okLaunch();
    const onClose = vi.fn();
    const onLaunched = vi.fn();
    await render({
      open: true,
      options: [providerOption()],
      launchOverrides: { type: 'terminal' },
      onClose,
      onLaunched,
      launch,
    });
    await act(async () => {
      agentButton('claude').click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    const launchedOption = launch.mock.calls[0]?.[0] as EnvironmentOption;
    expect(launchedOption.id).toBe('opt-providers');
    // The chosen provider rides the launch overrides — the same typed contract
    // the CLI/action manifest uses (#849), never a UI-only path.
    expect(launch.mock.calls[0]?.[1]).toEqual({
      type: 'agent',
      agent: 'claude',
    });
    expect(onLaunched).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking a disabled provider does not launch (native disabled button)', async () => {
    const launch = okLaunch();
    const onClose = vi.fn();
    await render({
      open: true,
      options: [providerOption()],
      launchOverrides: { type: 'terminal' },
      onClose,
      launch,
    });
    // A disabled <button> swallows clicks; the launch hook must never fire.
    await act(async () => {
      agentButton('codex').click();
    });
    expect(launch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('unavailable providers do not block terminal launch on the same node', async () => {
    const launch = okLaunch();
    const onClose = vi.fn();
    // A node whose ONLY providers are unavailable must still terminal-launch.
    const option = providerOption({
      id: 'opt-all-unavailable',
      node: {
        nodeId: 'local',
        kind: 'local',
        displayName: 'this host',
        online: true,
        agentProviders: [
          { id: 'codex', availability: 'unavailable', reason: 'cli missing' },
        ],
      },
    });
    await render({
      open: true,
      options: [option],
      launchOverrides: { type: 'terminal' },
      onClose,
      launch,
    });
    const terminal = container.querySelector(
      '[data-testid="env-picker-dialog-target-terminal"]'
    ) as HTMLButtonElement;
    expect(terminal.disabled).toBe(false);
    await act(async () => {
      terminal.click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[1]).toEqual({ type: 'terminal' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a node with zero providers is still terminal-launchable (chooser shows only terminal)', async () => {
    const launch = okLaunch();
    const onClose = vi.fn();
    // freshOption() has no agentProviders at all.
    await render({
      open: true,
      options: [freshOption({ id: 'opt-no-providers' })],
      launchOverrides: { type: 'terminal' },
      onClose,
      launch,
    });
    const buttons = targetButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('data-target')).toBe('terminal');

    const row = container.querySelector(
      '[data-option-id="opt-no-providers"]'
    ) as HTMLElement;
    await act(async () => {
      row.click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[1]).toEqual({ type: 'terminal' });
  });

  it('surfaces provider-specific copy (not stale copy) when the launch hook returns provider-unavailable', async () => {
    // Defense-in-depth path: if the dialog's own provider gate and the launch
    // hook desync (race, injected hook), the hook can still return a typed
    // `provider-unavailable` block on a FRESH node. The dialog MUST render the
    // provider reason — never the freshness fallback, which would mislabel a
    // fresh node as "stale".
    const launch = vi.fn(
      async (): Promise<LaunchEnvironmentResult> => ({
        kind: 'blocked',
        reason: {
          code: 'provider-unavailable',
          agent: 'claude',
          availability: 'unavailable',
          providerReason: 'cli not installed',
          authStatus: 'logged out',
        },
      })
    );
    const onClose = vi.fn();
    const onLaunched = vi.fn();
    await render({
      open: true,
      options: [providerOption()],
      launchOverrides: { type: 'terminal' },
      onClose,
      onLaunched,
      launch,
    });
    await act(async () => {
      agentButton('claude').click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const block = container.querySelector(
      '[data-testid="env-picker-dialog-block-reason"]'
    );
    // Provider-specific copy: names the agent + its reason, NOT "stale".
    expect(block?.textContent).toMatch(/claude/i);
    expect(block?.textContent).toMatch(/unavailable/i);
    expect(block?.textContent).toMatch(/cli not installed/i);
    expect(block?.textContent).toMatch(/logged out/i);
    expect(block?.textContent).not.toMatch(/stale/i);
    // Lowercase per DESIGN.md.
    expect(block?.textContent).toBe(block?.textContent?.toLowerCase());
  });

  it('agent mode title names the provider once one is chosen', async () => {
    await render({
      open: true,
      options: [providerOption()],
      // An agent-first entry point threads the agent override; the title and
      // chooser open pre-selected on that provider.
      launchOverrides: { type: 'agent', agent: 'claude' },
      onClose: vi.fn(),
    });
    const title = container.querySelector('.env-picker-dialog__title');
    expect(title?.textContent).toMatch(/start claude in environment/i);
    expect(agentButton('claude').getAttribute('aria-pressed')).toBe('true');
  });
});
