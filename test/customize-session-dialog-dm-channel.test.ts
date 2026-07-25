// @vitest-environment happy-dom

import React, { act, createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';
import type { CustomizeSessionDialogHandle } from '../frontend/src/components/dialogs/CustomizeSessionDialog.js';
import type { AggregatedRepoInventoryResponse } from '../shared/repo-inventory.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import { dmChannelTopicId } from '../frontend/src/lib/dm-channels.js';

const mocks = vi.hoisted(() => ({
  fetchRepoInventory: vi.fn(),
  fetchHubNodes: vi.fn(),
  createAgentSession: vi.fn(),
  getOrCreateDmChannel: vi.fn(),
  setActiveChannelId: vi.fn(),
  configState: {
    defaultContinue: false,
    defaultYolo: false,
    defaultAgent: 'hermes',
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

vi.mock('../frontend/src/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    fetchRepoInventory: mocks.fetchRepoInventory,
    fetchHubNodes: mocks.fetchHubNodes,
  };
});

vi.mock(
  '../frontend/src/hooks/useTopicRoomCreate.js',
  async (importOriginal) => {
    const actual = await importOriginal<object>();
    return { ...actual, getOrCreateDmChannel: mocks.getOrCreateDmChannel };
  }
);

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
    getState: () => ({
      terminalFontSize: 14,
      activeWorkspaceId: null,
      setActiveChannelId: mocks.setActiveChannelId,
    }),
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

function webFramework(id = 'hermes'): FrameworkInfo {
  return {
    id,
    displayName: id === 'hermes' ? 'Hermes' : id,
    command: id,
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: false,
      supportsWebSessions: true,
    },
    eventSource: 'hooks',
    availability: { installed: true, path: `/usr/local/bin/${id}` },
  } as FrameworkInfo;
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
        git: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      terminalBackends: { 'relay-pty': 'available' },
      agents: { hermes: 'available' },
      serviceManager: 'launchd',
      wsl: false,
    },
    createdAt: '2026-05-12T00:00:00.000Z',
    pairedAt: '2026-05-12T00:00:00.000Z',
    lastSeenAt: '2026-05-12T00:00:00.000Z',
    credentialId: 'cred-local',
    ...overrides,
  } as HubNodeSummary;
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
  } as AggregatedRepoInventoryResponse;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderAndOpen(): Promise<{
  el: HTMLElement;
  onSessionCreated: ReturnType<typeof vi.fn>;
}> {
  mocks.configState.frameworks = [webFramework('hermes')];
  mocks.configState.defaultAgent = 'hermes';
  mocks.configState.refreshConfig.mockResolvedValue(undefined);
  mocks.fetchRepoInventory.mockResolvedValue(inventory('local'));
  mocks.fetchHubNodes.mockResolvedValue([node()]);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<CustomizeSessionDialogHandle>();
  const onSessionCreated = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  await act(async () => {
    root!.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(CustomizeSessionDialog, { ref, onSessionCreated })
      )
    );
  });
  await act(async () => {
    await ref.current!.open({ name: 'local-one', path: '/tmp/local-one' });
  });
  await flush();
  return { el: container, onSessionCreated };
}

describe('CustomizeSessionDialog DM channel routing (#1178)', () => {
  beforeEach(() => {
    mocks.getOrCreateDmChannel.mockResolvedValue({
      id: dmChannelTopicId('hermes', null),
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.clearAllMocks();
  });

  it('opens the DM channel without routing the topic id through onSessionCreated', async () => {
    const { el, onSessionCreated } = await renderAndOpen();

    // hermes defaults to web mode; make it explicit if the mode select exists.
    const modeSelect = el.querySelector('#cs-mode') as HTMLSelectElement | null;
    if (modeSelect && modeSelect.value !== 'web') {
      await act(async () => {
        modeSelect.value = 'web';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();
    }

    await act(async () => {
      (
        el.querySelector(
          '[data-track="dialog.customize-session.create"]'
        ) as HTMLButtonElement
      ).click();
    });
    await flush();

    const dmId = dmChannelTopicId('hermes', null);
    // Routed a web agent launch to the DM channel...
    expect(mocks.getOrCreateDmChannel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'hermes' })
    );
    // ...opened via the channel path...
    expect(mocks.setActiveChannelId).toHaveBeenCalledWith(dmId);
    // ...and NEVER through the session-selection callback (no flash-and-close,
    // no bogus 'topic:...' active-session key).
    expect(onSessionCreated).not.toHaveBeenCalled();
    // No mode:'web' session was created either.
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });
});
