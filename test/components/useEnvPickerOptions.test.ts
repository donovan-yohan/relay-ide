// @vitest-environment happy-dom

// useEnvPickerOptions (#862) — focused coverage for the env-picker option
// selector that App's <EnvPickerLauncher> consumes. Asserts:
//   1. With mocked nodes + inventory, the option list includes the remote node
//      and offline/stale rows surface their typed degraded reasons (the #861
//      read-model invariant: never silently drop / switch a stale node).
//   2. With null inventory, the synthetic local node + fallbackWorkspace path
//      still yields a launchable local terminal option (a fresh hub with no
//      inventory feed must not block launch).
//   3. `generatedAt` is stable across re-renders: when the query inputs are
//      unchanged the returned options array keeps reference equality, so the
//      dialog's default-selection effect does not re-fire (Gemini PR #646/#647).
//
// Mocking policy: `@tanstack/react-query`'s `useQuery` is mocked to dispatch by
// query key from a `vi.hoisted` fixture store (per the repo's vi.hoisted
// convention, see test/workspace-area-node-picker.test.ts). No network.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import type { AggregatedRepoInventoryResponse } from '../../shared/repo-inventory.js';
import type { EnvironmentOption } from '../../shared/environment-option.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  nodes: undefined as HubNodeSummary[] | undefined,
  inventory: undefined as AggregatedRepoInventoryResponse | undefined,
}));

// Dispatch by query key so the hook's two `useQuery` calls return the right
// seeded data. Mirrors the shared TanStack cache the real app warms.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === 'hub-nodes') return { data: mocks.nodes };
    if (key === 'repo-inventory') return { data: mocks.inventory };
    return { data: undefined };
  },
}));

// Keep the api module importable without touching the network.
vi.mock('../../frontend/src/lib/api.js', () => ({
  fetchHubNodes: vi.fn(),
  fetchRepoInventory: vi.fn(),
}));

// Imported AFTER the mocks so the hook binds to the mocked useQuery.
const { useEnvPickerOptions } =
  await import('../../frontend/src/lib/hooks/use-env-picker-options.js');

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
      terminalBackends: {
        'relay-pty': 'available',
        'tmux-compat': 'available',
      },
      agents: { claude: 'available', codex: 'available' },
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

function inventory(): AggregatedRepoInventoryResponse {
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
            repoInstanceId: 'local:/Users/kyle/relay-ide',
            nodeId: 'local',
            localPath: '/Users/kyle/relay-ide',
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

// Test harness: mounts the hook and pushes its output into a sink so the test
// can assert on the derived option list and its reference identity.
function Harness({
  sink,
  fallbackWorkspace,
}: {
  sink: (opts: EnvironmentOption[]) => void;
  fallbackWorkspace?: {
    name: string;
    path: string;
    isGitRepo?: boolean;
  } | null;
}) {
  const options = useEnvPickerOptions({
    ...(fallbackWorkspace !== undefined ? { fallbackWorkspace } : {}),
  });
  sink(options);
  return null;
}

describe('useEnvPickerOptions (#862)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.nodes = undefined;
    mocks.inventory = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('includes remote + offline/stale rows with typed degraded reasons', () => {
    mocks.inventory = inventory();
    mocks.nodes = [
      node(),
      node({
        nodeId: 'linux',
        displayName: 'linux lab',
        status: 'stale',
        homeDir: '/home/linux',
        lastSeenAt: '2026-05-19T11:00:00.000Z',
      }),
    ];
    let captured: EnvironmentOption[] = [];
    act(() => {
      root.render(
        React.createElement(Harness, { sink: (o) => (captured = o) })
      );
    });

    const local = captured.find((o) => o.node.nodeId === 'local');
    const linux = captured.find((o) => o.node.nodeId === 'linux');
    expect(local?.node.kind).toBe('local');
    expect(local?.freshness).toBe('fresh');
    // Remote node is surfaced (never silently dropped) AND carries the typed
    // stale reason so the dialog can block + explain.
    expect(linux?.node.kind).toBe('remote');
    expect(linux?.freshness).toBe('stale');
    expect(linux?.degradedReasons?.[0]?.kind).toBe('node-stale');
  });

  it('null inventory + fallbackWorkspace yields a launchable local terminal option', () => {
    mocks.inventory = undefined; // no inventory feed yet
    mocks.nodes = []; // no paired nodes → synthetic local node fills in
    let captured: EnvironmentOption[] = [];
    act(() => {
      root.render(
        React.createElement(Harness, {
          sink: (o) => (captured = o),
          fallbackWorkspace: {
            name: 'relay-ide',
            path: '/Users/kyle/relay-ide',
            isGitRepo: true,
          },
        })
      );
    });

    expect(captured.length).toBeGreaterThan(0);
    const launchable = captured.find(
      (o) =>
        o.node.kind === 'local' &&
        o.freshness === 'fresh' &&
        o.capabilities.includes('session:create:terminal')
    );
    expect(launchable).toBeTruthy();
    // Fallback workspace path surfaces so the user can launch into it.
    expect(captured.some((o) => o.cwd === '/Users/kyle/relay-ide')).toBe(true);
  });

  it('keeps options array reference-stable across re-renders when inputs are unchanged', () => {
    mocks.inventory = inventory();
    mocks.nodes = [node()];
    const captures: EnvironmentOption[][] = [];
    const sink = (o: EnvironmentOption[]) => captures.push(o);

    act(() => {
      root.render(React.createElement(Harness, { sink }));
    });
    // Force a second render with identical inputs.
    act(() => {
      root.render(React.createElement(Harness, { sink }));
    });

    expect(captures.length).toBeGreaterThanOrEqual(2);
    // Same array identity → the dialog's default-selection effect (keyed on the
    // options reference) does not re-fire. This is the generatedAt-stability
    // guarantee: a fresh `new Date()` stamp would mint a new array every render.
    expect(captures[captures.length - 1]).toBe(captures[0]);
    // And the generatedAt is the inventory snapshot time, not "now".
    expect(captures[0]?.[0]?.generatedAt).toBe('2026-05-19T00:00:00.000Z');
  });

  it('nodes-only (no inventory, no fallbackWorkspace) yields at least one launchable local option', () => {
    // #862 primary use case: repo-less hub where activeRepoPath is null and
    // repo-inventory has not resolved yet. The local node (with homeDir) must
    // still produce a free-cwd row so bare shell launch is always reachable.
    mocks.inventory = undefined;
    mocks.nodes = [
      node({ nodeId: 'local', homeDir: '/Users/kyle', status: 'online' }),
    ];
    let captured: EnvironmentOption[] = [];
    act(() => {
      root.render(
        React.createElement(Harness, {
          sink: (o) => (captured = o),
          fallbackWorkspace: null, // explicitly no fallback
        })
      );
    });

    expect(captured.length).toBeGreaterThan(0);
    const localOption = captured.find(
      (o) =>
        o.node.nodeId === 'local' &&
        o.node.kind === 'local' &&
        o.freshness === 'fresh' &&
        o.capabilities.includes('session:create:terminal')
    );
    expect(localOption).toBeTruthy();
    // cwd should be the node's homeDir (free-cwd mode, not repo-pinned).
    expect(localOption?.cwd).toBe('/Users/kyle');
    expect(localOption?.cwdMode).toBe('free');
  });

  it('falls back to a fixed epoch generatedAt before inventory loads', () => {
    mocks.inventory = undefined; // no inventory snapshot time yet
    mocks.nodes = [node({ homeDir: '/Users/kyle' })];
    let captured: EnvironmentOption[] = [];
    act(() => {
      root.render(
        React.createElement(Harness, {
          sink: (o) => (captured = o),
          // A fallback workspace gives a repo-pinned option to read the stamp
          // from; the local node's free-cwd row also carries the epoch stamp.
          fallbackWorkspace: {
            name: 'relay-ide',
            path: '/Users/kyle/relay-ide',
            isGitRepo: true,
          },
        })
      );
    });
    expect(captured.length).toBeGreaterThan(0);
    // Never `new Date()` — a stable epoch keeps the option list referentially
    // stable while still a valid non-empty ISO string.
    expect(captured[0]?.generatedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
