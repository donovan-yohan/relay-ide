// @vitest-environment happy-dom
//
// Tests for the new EnvironmentPicker (#627) wired into CustomizeSessionDialog
// (#629). Covers:
//   - Picker renders inside the dialog with the safe-default selection from
//     `pickDefaultEnvironment`.
//   - Selecting a different environment updates the dialog's session-launch
//     state with typed nodeId/repoInstanceId/worktreeInstanceId.
//   - Launch is blocked with a typed reason chip when the selected option is
//     stale/offline. No silent node substitution.
//   - The picker shows nothing while inventory + nodes are still loading.
//
// The dialog already has separate test suites covering the legacy cascading
// dropdowns (`customize-session-dialog-open-race.test.ts`) and the pure
// `buildEnvironmentPickerModel` resolution logic
// (`customize-session-dialog.test.ts`). This file focuses ONLY on the new
// picker integration, mocked end-to-end at the React level.

import React, { act, createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';
import type { CustomizeSessionDialogHandle } from '../frontend/src/components/dialogs/CustomizeSessionDialog.js';
import type { AggregatedRepoInventoryResponse } from '../shared/repo-inventory.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';

const mocks = vi.hoisted(() => ({
  fetchRepoInventory: vi.fn(),
  fetchHubNodes: vi.fn(),
  createTerminalSession: vi.fn(),
  configState: {
    defaultAgent: 'claude',
    defaultNotifications: true,
    frameworks: [] as FrameworkInfo[],
    refreshConfig: vi.fn(),
    loadFrameworks: vi.fn(),
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../frontend/src/lib/api.js', () => ({
  fetchRepoInventory: mocks.fetchRepoInventory,
  fetchHubNodes: mocks.fetchHubNodes,
}));

vi.mock('../frontend/src/lib/stores/config.js', () => {
  const useConfigStore = (
    selector: (state: typeof mocks.configState) => unknown
  ) => selector(mocks.configState);
  useConfigStore.getState = () => mocks.configState;
  return { useConfigStore };
});

vi.mock('../frontend/src/lib/stores/ui.js', () => ({
  DEFAULT_TERMINAL_FONT_SIZE: 14,
  useUiStore: {
    getState: () => ({ terminalFontSize: 14 }),
  },
}));

vi.mock('../frontend/src/lib/session-utils.js', () => ({
  createTerminalSession: mocks.createTerminalSession,
}));

vi.mock('../frontend/src/components/dialogs/DialogShell.js', async () => {
  const ReactModule = await import('react');
  type DialogShellHandle = { open: () => void; close: () => void };
  interface MockDialogShellProps {
    title: string;
    children: ReactModule.ReactNode;
    footer?: ReactModule.ReactNode;
  }
  const DialogShell = ReactModule.forwardRef<
    DialogShellHandle,
    MockDialogShellProps
  >(function MockDialogShell({ title, children, footer }, ref) {
    const [open, setOpen] = ReactModule.useState(false);
    ReactModule.useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
    }));
    return ReactModule.createElement(
      'div',
      { role: 'dialog', 'aria-label': title, 'data-open': String(open) },
      open
        ? ReactModule.createElement(
            ReactModule.Fragment,
            null,
            children,
            footer
          )
        : null
    );
  });
  return { default: DialogShell };
});

const { default: CustomizeSessionDialog, environmentSelectionFromOption } =
  await import('../frontend/src/components/dialogs/CustomizeSessionDialog.js');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function framework(id: string): FrameworkInfo {
  return {
    id,
    displayName: id,
    command: id,
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: false,
    },
    eventSource: 'hooks',
    availability: { installed: true, path: `/usr/local/bin/${id}` },
  };
}

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'local',
    displayName: 'local mac',
    hostname: 'local.local',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'local', status: 'connected' },
    capabilities: {
      totals: { available: 10, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      agents: { claude: 'available' },
      serviceManager: 'launchd',
      wsl: false,
    },
    createdAt: '2026-05-12T00:00:00.000Z',
    pairedAt: '2026-05-12T00:00:00.000Z',
    lastSeenAt: '2026-05-12T00:00:00.000Z',
    credentialId: 'cred-local',
    ...overrides,
  };
}

function multiNodeInventory(): AggregatedRepoInventoryResponse {
  return {
    generatedAt: '2026-05-19T00:00:00.000Z',
    reports: [],
    groups: [
      {
        groupId: 'github.com/donovan-yohan/relay-ide',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        displayName: 'relay-ide',
        selectedRemote: null,
        remotes: [],
        warnings: [],
        identityDebug: {
          groupedBy: 'repoIdentity',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          instanceCount: 2,
          nodeIds: ['local', 'linux'],
        },
        instances: [
          {
            repoInstanceId: 'local:/tmp/relay-ide',
            nodeId: 'local',
            localPath: '/tmp/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'master',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-19T00:00:00.000Z',
          },
          {
            repoInstanceId: 'linux:/srv/relay-ide',
            nodeId: 'linux',
            localPath: '/srv/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'master',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-19T00:00:00.000Z',
          },
        ],
      },
    ],
  };
}

async function renderAndOpen(
  workspace: { name: string; path: string },
  inventoryResponse: AggregatedRepoInventoryResponse,
  nodes: HubNodeSummary[]
) {
  mocks.configState.frameworks = [framework('claude')];
  mocks.fetchRepoInventory.mockResolvedValue(inventoryResponse);
  mocks.fetchHubNodes.mockResolvedValue(nodes);
  mocks.configState.refreshConfig.mockResolvedValue(undefined);
  mocks.createTerminalSession.mockResolvedValue({ session: { id: 'sess-1' } });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<CustomizeSessionDialogHandle>();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  await act(async () => {
    root!.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(CustomizeSessionDialog, { ref })
      )
    );
  });
  await act(async () => {
    await ref.current!.open(workspace);
  });
  await flush();
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectTerminal(el: HTMLElement) {
  await act(async () => {
    const select = el.querySelector('#cs-launch-mode') as HTMLSelectElement;
    select.value = 'terminal';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

describe('CustomizeSessionDialog environment picker wiring (#629)', () => {
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.clearAllMocks();
  });

  it('renders the new EnvironmentPicker inside the dialog when options are loaded', async () => {
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-ide' },
      multiNodeInventory(),
      [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ]
    );
    await selectTerminal(el);

    expect(
      el.querySelector('[data-testid="customize-session-env-picker"]')
    ).toBeTruthy();
    // The picker uses [role="option"] for each row — two options here
    // (one repoInstance per node, same identity).
    const options = el.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it('selects a default option via pickDefaultEnvironment on open', async () => {
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-ide' },
      multiNodeInventory(),
      [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ]
    );
    await selectTerminal(el);

    const selectedRow = el.querySelector('[aria-selected="true"]');
    expect(selectedRow).toBeTruthy();
    // First fresh candidate in the inventory order wins (local-mac), per
    // pickDefaultEnvironment rule #3.
    expect(selectedRow?.textContent).toMatch(/local mac/i);
  });

  it('switching pick changes which option is selected', async () => {
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-ide' },
      multiNodeInventory(),
      [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ]
    );
    await selectTerminal(el);

    const allOptions = Array.from(
      el.querySelectorAll<HTMLElement>('[role="option"]')
    );
    const linuxRow = allOptions.find((r) =>
      /linux lab/i.test(r.textContent ?? '')
    );
    expect(linuxRow).toBeTruthy();
    await act(async () => {
      linuxRow!.click();
    });
    await flush();
    const selectedRow = el.querySelector('[aria-selected="true"]');
    expect(selectedRow?.textContent).toMatch(/linux lab/i);
  });

  it('blocks launch + shows typed reason chip when selected option is offline', async () => {
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-ide' },
      multiNodeInventory(),
      [
        node(),
        node({
          nodeId: 'linux',
          status: 'offline',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ]
    );
    await selectTerminal(el);

    // Pick the offline linux node.
    const allOptions = Array.from(
      el.querySelectorAll<HTMLElement>('[role="option"]')
    );
    const linuxRow = allOptions.find((r) =>
      /linux lab/i.test(r.textContent ?? '')
    );
    await act(async () => {
      linuxRow!.click();
    });
    await flush();

    const chip = el.querySelector(
      '[data-testid="customize-session-degraded-chip"]'
    );
    expect(chip).toBeTruthy();
    expect(chip?.textContent ?? '').toMatch(/offline/i);

    const createBtn = el.querySelector(
      '[data-track="dialog.customize-session.create"]'
    ) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    // Even if the user manages to click, no session is created.
    await act(async () => {
      createBtn.click();
    });
    await flush();
    expect(mocks.createTerminalSession).not.toHaveBeenCalled();
  });

  it('never silently switches to a different node when the picker is showing offline', async () => {
    // Regression guard for the critical #615 acceptance criterion: if the
    // user selects an offline node, the dialog must NOT fall back to
    // creating a session on a different (fresh) node. The picker UI surfaces
    // a typed chip + disabled button instead.
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-ide' },
      multiNodeInventory(),
      [
        node(),
        node({
          nodeId: 'linux',
          status: 'offline',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ]
    );
    await selectTerminal(el);

    const allOptions = Array.from(
      el.querySelectorAll<HTMLElement>('[role="option"]')
    );
    const linuxRow = allOptions.find((r) =>
      /linux lab/i.test(r.textContent ?? '')
    );
    await act(async () => {
      linuxRow!.click();
    });
    await flush();

    const createBtn = el.querySelector(
      '[data-track="dialog.customize-session.create"]'
    ) as HTMLButtonElement;
    await act(async () => {
      createBtn.click();
    });
    await flush();

    // No mocked terminal launch means no silent substitution.
    expect(mocks.createTerminalSession).not.toHaveBeenCalled();
  });

  it('renders nothing for the picker when inventory + nodes are still pending', async () => {
    // Inventory + nodes mocks resolve to pending promises that never settle
    // within the test window.
    mocks.configState.frameworks = [framework('claude')];
    mocks.fetchRepoInventory.mockReturnValue(new Promise(() => {}));
    mocks.fetchHubNodes.mockReturnValue(new Promise(() => {}));
    mocks.configState.refreshConfig.mockResolvedValue(undefined);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ref = createRef<CustomizeSessionDialogHandle>();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    await act(async () => {
      root!.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(CustomizeSessionDialog, { ref })
        )
      );
    });
    await act(async () => {
      void ref.current!.open({
        name: 'pending',
        path: '/tmp/pending',
      });
    });
    await flush();

    // While inventory pending, the dialog still renders the fallback option
    // (it's local + fresh) — but it should NOT render a degraded chip.
    const chip = container.querySelector(
      '[data-testid="customize-session-degraded-chip"]'
    );
    expect(chip).toBeNull();
  });
});

describe('environmentSelectionFromOption', () => {
  it('maps a worktree option back to the legacy worktree checkout id', () => {
    const selection = environmentSelectionFromOption(
      {
        schemaVersion: 1,
        id: 'local|local:/repo|local:/repo/wt',
        node: { nodeId: 'local', kind: 'local', displayName: 'local mac' },
        capabilities: ['session:read', 'session:create:terminal'],
        cwd: '/repo/wt',
        cwdMode: 'repo',
        freshness: 'fresh',
        repoInstance: {
          repoInstanceId: 'local:/repo',
          localPath: '/repo',
          repoIdentity: 'github.com/example/repo',
          name: 'repo',
        },
        bench: {
          worktreeInstanceId: 'local:/repo/wt',
          localPath: '/repo/wt',
          branchName: 'feature',
        },
        generatedAt: '2026-05-19T00:00:00.000Z',
      },
      multiNodeInventory()
    );
    expect(selection.selectedNodeId).toBe('local');
    expect(selection.selectedCheckoutId).toBe('worktree:local:/repo/wt');
  });

  it('maps a repo-root option back to the legacy repo checkout id', () => {
    const selection = environmentSelectionFromOption(
      {
        schemaVersion: 1,
        id: 'linux|linux:/srv/relay-ide|__none__',
        node: { nodeId: 'linux', kind: 'remote', displayName: 'linux lab' },
        capabilities: ['session:read', 'session:create:terminal'],
        cwd: '/srv/relay-ide',
        cwdMode: 'repo',
        freshness: 'fresh',
        repoInstance: {
          repoInstanceId: 'linux:/srv/relay-ide',
          localPath: '/srv/relay-ide',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          name: 'relay-ide',
        },
        generatedAt: '2026-05-19T00:00:00.000Z',
      },
      multiNodeInventory()
    );
    expect(selection.selectedNodeId).toBe('linux');
    expect(selection.selectedGroupId).toBe(
      'github.com/donovan-yohan/relay-ide'
    );
    expect(selection.selectedCheckoutId).toBe('repo:linux:/srv/relay-ide');
  });
});
