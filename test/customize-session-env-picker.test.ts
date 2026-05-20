// @vitest-environment happy-dom
//
// #629 — Environment picker integration into the new-session dialog.
//
// These tests focus exclusively on the wiring contract: that the picker
// component (#627) renders inside CustomizeSessionDialog with a default
// selected by pickDefaultEnvironment (#628), that selecting a stale/offline
// option surfaces the typed degraded reason and blocks launch, and that
// selecting a fresh option from the picker patches the existing environment
// resolution so the downstream createSession payload reflects the picked
// node/repo/worktree. Loading-state coverage is included for the
// inventory-pending case.

import React, { act, createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';
import type { CustomizeSessionDialogHandle } from '../frontend/src/components/dialogs/CustomizeSessionDialog.js';
import type { AggregatedRepoInventoryResponse } from '../shared/repo-inventory.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';

const mocks = vi.hoisted(() => ({
  fetchRepoInventory: vi.fn(),
  fetchHubNodes: vi.fn(),
  createAgentSession: vi.fn(),
  configState: {
    defaultContinue: false,
    defaultYolo: false,
    defaultAgent: 'claude',
    defaultNotifications: true,
    claudeFullscreen: true,
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
  createAgentSession: mocks.createAgentSession,
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

const { default: CustomizeSessionDialog } =
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
      supportsWebSessions: false,
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

function freshInventoryTwoNodes(): AggregatedRepoInventoryResponse {
  return {
    generatedAt: '2026-05-12T00:00:00.000Z',
    reports: [],
    groups: [
      {
        groupId: 'github.com/example/relay-ide',
        repoIdentity: 'github.com/example/relay-ide',
        displayName: 'relay-ide',
        selectedRemote: null,
        remotes: [],
        warnings: [],
        identityDebug: {
          groupedBy: 'repoIdentity',
          repoIdentity: 'github.com/example/relay-ide',
          instanceCount: 2,
          nodeIds: ['local', 'linux'],
        },
        instances: [
          {
            repoInstanceId: 'local:%2Ftmp%2Frelay-local',
            nodeId: 'local',
            localPath: '/tmp/relay-local',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'master',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/example/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
          {
            repoInstanceId: 'linux:%2Fsrv%2Frelay-linux',
            nodeId: 'linux',
            localPath: '/srv/relay-linux',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'master',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/example/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
        ],
      },
    ],
  };
}

async function renderAndOpen(
  workspace: { name: string; path: string },
  inventoryResponse:
    | AggregatedRepoInventoryResponse
    | Promise<AggregatedRepoInventoryResponse>,
  nodes: HubNodeSummary[]
) {
  mocks.configState.frameworks = [framework('claude')];
  mocks.fetchRepoInventory.mockResolvedValue(inventoryResponse);
  mocks.fetchHubNodes.mockResolvedValue(nodes);
  mocks.configState.refreshConfig.mockResolvedValue(undefined);
  mocks.createAgentSession.mockResolvedValue({ session: { id: 'sess-1' } });

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
    await Promise.resolve();
  });
}

describe('CustomizeSessionDialog environment picker (#629)', () => {
  beforeEach(() => {
    mocks.configState.frameworks = [framework('claude')];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.clearAllMocks();
    mocks.configState.defaultContinue = false;
    mocks.configState.defaultYolo = false;
    mocks.configState.defaultAgent = 'claude';
    mocks.configState.frameworks = [framework('claude')];
  });

  it('renders the EnvironmentPicker inside the dialog with options derived from inventory + nodes', async () => {
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-local' },
      freshInventoryTwoNodes(),
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

    const pickerSection = el.querySelector(
      '[data-testid="customize-session-env-picker"]'
    );
    expect(pickerSection).toBeTruthy();
    // The picker exposes its search input via a stable test id (see
    // EnvironmentPicker.tsx). Its presence here proves the new picker
    // component was mounted as part of the dialog, not just the legacy
    // select fallback.
    expect(el.querySelector('[data-testid="env-picker-search"]')).toBeTruthy();
    // Both nodes show up as picker options, with stable composite ids.
    const optionEls = el.querySelectorAll('[role="option"]');
    const optionIds = Array.from(optionEls)
      .map((node) => node.getAttribute('data-option-id'))
      .filter((id): id is string => typeof id === 'string');
    expect(optionIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^local\|/),
        expect.stringMatching(/^linux\|/),
      ])
    );
  });

  it('defaults selection via pickDefaultEnvironment (first-fresh) on initial render', async () => {
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-local' },
      freshInventoryTwoNodes(),
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
    // pickDefaultEnvironment with no active tab + no history walks candidates
    // in order and returns the first fresh option. Inventory order puts
    // `local` before `linux`, so the default selection is the local option.
    const selectedRow = el.querySelector('[aria-selected="true"]');
    expect(selectedRow).toBeTruthy();
    const selectedId = selectedRow?.getAttribute('data-option-id');
    expect(selectedId).toMatch(/^local\|/);
  });

  it('selecting a fresh remote option from the picker routes the create payload to that node', async () => {
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-local' },
      freshInventoryTwoNodes(),
      [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          homeDir: '/home/linux',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ]
    );

    // Click the linux option inside the new picker.
    const linuxOption = Array.from(el.querySelectorAll('[role="option"]')).find(
      (opt) => opt.getAttribute('data-option-id')?.startsWith('linux|')
    ) as HTMLElement | undefined;
    expect(linuxOption).toBeTruthy();
    await act(async () => {
      linuxOption!.click();
    });
    await flush();

    // Now click create. The dialog must dispatch a session-create payload
    // that targets the linux node — typed id from the picker option, not a
    // silent substitution back to local.
    const createBtn = el.querySelector(
      '[data-track="dialog.customize-session.create"]'
    ) as HTMLButtonElement;
    expect(createBtn).toBeTruthy();
    expect(createBtn.disabled).toBe(false);
    await act(async () => {
      createBtn.click();
    });
    await flush();

    expect(mocks.createAgentSession).toHaveBeenCalled();
    const payload = mocks.createAgentSession.mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({ nodeId: 'linux' });
  });

  it('blocks launch and surfaces a typed degraded chip when the selected option is offline', async () => {
    const offlineLinux = node({
      nodeId: 'linux',
      displayName: 'linux lab',
      status: 'offline',
      capabilities: { ...node().capabilities, agents: { claude: 'available' } },
    });
    const el = await renderAndOpen(
      { name: 'relay-ide', path: '/tmp/relay-local' },
      freshInventoryTwoNodes(),
      [node(), offlineLinux]
    );

    // Click the offline linux option deliberately.
    const linuxOption = Array.from(el.querySelectorAll('[role="option"]')).find(
      (opt) => opt.getAttribute('data-option-id')?.startsWith('linux|')
    ) as HTMLElement | undefined;
    expect(linuxOption).toBeTruthy();
    expect(linuxOption!.getAttribute('data-freshness')).toBe('offline');
    await act(async () => {
      linuxOption!.click();
    });
    await flush();

    // Typed degraded chip is now visible with the typed reason copy.
    const chip = el.querySelector(
      '[data-testid="customize-session-degraded-chip"]'
    );
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toMatch(/offline|stale|unavailable/i);

    // Create button is disabled — never silently substitutes another node.
    const createBtn = el.querySelector(
      '[data-track="dialog.customize-session.create"]'
    ) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    // Even attempting to click should not fire createAgentSession.
    await act(async () => {
      createBtn.click();
    });
    await flush();
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it('hides the new picker while inventory is pending (no candidates yet)', async () => {
    // Resolve inventory only after we capture the initial DOM. The dialog
    // opens optimistically and the picker should not render with zero
    // candidates — keeping the loading affordance to the existing dialog
    // chrome instead of an empty picker frame.
    let resolveInventory!: (value: AggregatedRepoInventoryResponse) => void;
    const inventoryPromise = new Promise<AggregatedRepoInventoryResponse>(
      (resolve) => {
        resolveInventory = resolve;
      }
    );
    mocks.configState.frameworks = [framework('claude')];
    mocks.fetchRepoInventory.mockResolvedValue(inventoryPromise);
    mocks.fetchHubNodes.mockResolvedValue([]);
    mocks.configState.refreshConfig.mockResolvedValue(undefined);
    mocks.createAgentSession.mockResolvedValue({ session: { id: 'sess-1' } });

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
    // Kick off open but do not flush the inventory resolve yet.
    const openPromise = act(async () => {
      await ref.current!.open({
        name: 'relay-ide',
        path: '/tmp/relay-local',
      });
    });
    // Section should not be rendered because no candidates exist yet.
    expect(
      container.querySelector('[data-testid="customize-session-env-picker"]')
    ).toBeNull();

    // Resolve inventory and complete the open flow.
    resolveInventory(freshInventoryTwoNodes());
    await openPromise;
    await flush();

    // Now the picker is mounted with real candidates.
    expect(
      container.querySelector('[data-testid="customize-session-env-picker"]')
    ).toBeTruthy();
  });
});
