// @vitest-environment happy-dom

import React, { act, createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function inventory(prefix: string): AggregatedRepoInventoryResponse {
  return {
    generatedAt: '2026-05-12T00:00:00.000Z',
    reports: [],
    groups: ['one', 'two'].map((suffix, index) => ({
      groupId: `${prefix}-${suffix}`,
      repoIdentity: `github.com/example/${prefix}-${suffix}`,
      displayName: `${prefix}-${suffix}`,
      selectedRemote: null,
      remotes: [],
      warnings: [],
      identityDebug: {
        groupedBy: 'repoIdentity',
        repoIdentity: `github.com/example/${prefix}-${suffix}`,
        instanceCount: 1,
        nodeIds: ['local'],
      },
      instances: [
        {
          repoInstanceId: `local:%2Ftmp%2F${prefix}-${suffix}`,
          nodeId: 'local',
          localPath: `/tmp/${prefix}-${suffix}`,
          name: `${prefix}-${suffix}`,
          isGitRepo: true,
          defaultBranch: 'nightly',
          currentBranch: index === 0 ? 'nightly' : 'feature',
          repoIdentity: `github.com/example/${prefix}-${suffix}`,
          selectedRemote: null,
          remotes: [],
          repoIdentityWarnings: [],
          worktrees: [],
          reportedAt: '2026-05-12T00:00:00.000Z',
        },
      ],
    })),
  };
}

function remoteLaneInventory(): AggregatedRepoInventoryResponse {
  const localInstance = {
    repoInstanceId: 'local:%2Ftmp%2Fremote-lane',
    nodeId: 'local',
    localPath: '/tmp/remote-lane',
    name: 'remote-lane',
    isGitRepo: true,
    defaultBranch: 'nightly',
    currentBranch: 'nightly',
    repoIdentity: 'github.com/example/remote-lane',
    selectedRemote: null,
    remotes: [],
    repoIdentityWarnings: [],
    worktrees: [],
    reportedAt: '2026-05-12T00:00:00.000Z',
  };
  return {
    generatedAt: '2026-05-12T00:00:00.000Z',
    reports: [],
    groups: [
      {
        groupId: 'github.com/example/remote-lane',
        repoIdentity: 'github.com/example/remote-lane',
        displayName: 'remote-lane',
        selectedRemote: null,
        remotes: [],
        warnings: [],
        identityDebug: {
          groupedBy: 'repoIdentity',
          repoIdentity: 'github.com/example/remote-lane',
          instanceCount: 2,
          nodeIds: ['local', 'remote'],
        },
        instances: [
          localInstance,
          {
            ...localInstance,
            repoInstanceId: 'remote:%2Fsrv%2Fremote-lane',
            nodeId: 'remote',
            localPath: '/srv/remote-lane',
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
  mocks.createAgentSession.mockResolvedValue({ session: { id: 'sess-1' } });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<CustomizeSessionDialogHandle>();

  await act(async () => {
    root!.render(React.createElement(CustomizeSessionDialog, { ref }));
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

describe('CustomizeSessionDialog open races', () => {
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

  it('marks local repo launches with the local-repo lane', async () => {
    const el = await renderAndOpen(
      { name: 'local-one', path: '/tmp/local-one' },
      inventory('local'),
      [node()]
    );

    await act(async () => {
      (el.querySelector('[data-track="dialog.customize-session.create"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(mocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'local',
        repoPath: '/tmp/local-one',
        sessionLane: 'local-repo',
      })
    );
  });

  it('marks remote cwd launches with the remote-cwd lane', async () => {
    const el = await renderAndOpen(
      { name: 'remote-lane', path: '/tmp/remote-lane' },
      remoteLaneInventory(),
      [
        node(),
        node({ nodeId: 'remote', displayName: 'remote box', homeDir: '/home/relay' }),
      ]
    );

    await act(async () => {
      const select = el.querySelector('#cs-node') as HTMLSelectElement;
      select.value = 'remote';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    await act(async () => {
      (el.querySelector('[data-track="dialog.customize-session.create"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(mocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'remote',
        cwd: '/home/relay',
        sessionLane: 'remote-cwd',
      })
    );
  });

  it('marks remote home launches with the remote-home lane', async () => {
    const el = await renderAndOpen(
      { name: 'remote-lane', path: '/tmp/remote-lane' },
      remoteLaneInventory(),
      [
        node(),
        node({ nodeId: 'remote', displayName: 'remote box', homeDir: '/home/relay' }),
      ]
    );

    await act(async () => {
      const select = el.querySelector('#cs-node') as HTMLSelectElement;
      select.value = 'remote';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    await act(async () => {
      (el.querySelector('[data-track="dialog.customize-session.start-in-home"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(mocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'remote',
        cwd: '/home/relay',
        sessionLane: 'remote-home',
      })
    );
  });

  it('ignores stale inventory and config from an earlier overlapping open call', async () => {
    mocks.configState.frameworks = [framework('claude')];
    const firstInventory = deferred<AggregatedRepoInventoryResponse>();
    const secondInventory = deferred<AggregatedRepoInventoryResponse>();
    const firstNodes = deferred<HubNodeSummary[]>();
    const secondNodes = deferred<HubNodeSummary[]>();
    mocks.fetchRepoInventory
      .mockReturnValueOnce(firstInventory.promise)
      .mockReturnValueOnce(secondInventory.promise);
    mocks.fetchHubNodes
      .mockReturnValueOnce(firstNodes.promise)
      .mockReturnValueOnce(secondNodes.promise);
    mocks.configState.refreshConfig.mockResolvedValue(undefined);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ref = createRef<CustomizeSessionDialogHandle>();

    await act(async () => {
      root!.render(React.createElement(CustomizeSessionDialog, { ref }));
    });

    let firstOpen!: Promise<void>;
    let secondOpen!: Promise<void>;
    await act(async () => {
      firstOpen = ref.current!.open({
        name: 'stale workspace',
        path: '/tmp/stale',
      });
      secondOpen = ref.current!.open({
        name: 'latest workspace',
        path: '/tmp/latest',
      });
    });

    await act(async () => {
      secondInventory.resolve(inventory('latest'));
      secondNodes.resolve([node()]);
      await secondOpen;
    });
    await flush();

    expect(container.textContent).toContain('latest workspace');
    expect(container.textContent).toContain(
      'latest-one — github.com/example/latest-one'
    );
    expect(container.textContent).not.toContain(
      'stale-one — github.com/example/stale-one'
    );

    await act(async () => {
      firstInventory.resolve(inventory('stale'));
      firstNodes.resolve([node()]);
      await firstOpen;
    });
    await flush();

    expect(container.textContent).toContain('latest workspace');
    expect(container.textContent).toContain(
      'latest-one — github.com/example/latest-one'
    );
    expect(container.textContent).not.toContain(
      'stale-one — github.com/example/stale-one'
    );
  });
});
