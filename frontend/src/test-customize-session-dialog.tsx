/* eslint-disable sonarjs/no-duplicate-string */
import React, { useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import CustomizeSessionDialog, {
  type CustomizeSessionDialogHandle,
} from './components/dialogs/CustomizeSessionDialog.js';
import { useConfigStore } from './lib/stores/config.js';
import type { FrameworkInfo } from './lib/types.js';
import type { AggregatedRepoInventoryResponse } from '../../shared/repo-inventory.js';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import './App.css';
import './components/dialogs/DialogShell.css';
import './components/dialogs/CustomizeSessionDialog.css';

const nativeFetch = window.fetch.bind(window);
let scenario:
  | 'multi'
  | 'multi-hermes'
  | 'single'
  | 'single-hermes'
  | 'single-disabled' = 'multi';
let lastCreateRequest = '';

function framework(id: string): FrameworkInfo {
  return {
    id,
    displayName: id,
    command: id,
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: true,
      supportsWebSessions: id === 'hermes',
    },
    eventSource: 'hooks',
    availability: { installed: true, path: `/usr/local/bin/${id}` },
  };
}

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'local',
    identity: {
      nodeId: 'local',
      displayName: 'local mac',
      hostname: 'local.local',
      createdAt: '2026-05-12T00:00:00.000Z',
      pairedAt: '2026-05-12T00:00:00.000Z',
    },
    displayName: 'local mac',
    hostname: 'local.local',
    homeDir: '/Users/kyle',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'local', status: 'connected' },
    trust: {
      state: 'trusted',
      level: 'privileged-local-user',
      warning: 'test node is trusted',
    },
    credentialState: 'active',
    credential: {
      credentialId: 'cred-local',
      issuedAt: '2026-05-12T00:00:00.000Z',
      state: 'active',
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
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
      worktrees: 'available',
      agents: { claude: 'available', codex: 'available', hermes: 'available' },
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
  if (
    scenario === 'single' ||
    scenario === 'single-hermes' ||
    scenario === 'single-disabled'
  ) {
    return {
      generatedAt: '2026-05-12T00:00:00.000Z',
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
            instanceCount: 1,
            nodeIds: ['local'],
          },
          instances: [
            {
              repoInstanceId: 'local:%2FUsers%2Fkyle%2Frelay-ide',
              nodeId: 'local',
              localPath: '/Users/kyle/relay-ide',
              name: 'relay-ide',
              isGitRepo: true,
              defaultBranch: 'nightly',
              currentBranch: 'nightly',
              repoIdentity: 'github.com/donovan-yohan/relay-ide',
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
  return {
    generatedAt: '2026-05-12T00:00:00.000Z',
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
          instanceCount: 5,
          nodeIds: ['local', 'linux', 'no-claude', 'offline', 'no-tmux'],
        },
        instances: [
          {
            repoInstanceId: 'linux:%2Fsrv%2Frelay-ide',
            nodeId: 'linux',
            localPath: '/srv/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [
              {
                worktreeInstanceId:
                  'linux:%2Fsrv%2Frelay-ide%2F.worktrees%2Ffeature',
                localPath: '/srv/relay-ide/.worktrees/feature',
                branchName: 'feature/linux',
                displayName: 'feature',
              },
            ],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
          {
            repoInstanceId: 'local:%2FUsers%2Fkyle%2Frelay-ide',
            nodeId: 'local',
            localPath: '/Users/kyle/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
          {
            repoInstanceId: 'offline:%2Foffline%2Frelay-ide',
            nodeId: 'offline',
            localPath: '/offline/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
          {
            repoInstanceId: 'no-claude:%2Fno-claude%2Frelay-ide',
            nodeId: 'no-claude',
            localPath: '/no-claude/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
          {
            repoInstanceId: 'no-tmux:%2Fno-tmux%2Frelay-ide',
            nodeId: 'no-tmux',
            localPath: '/no-tmux/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
        ],
      },
      {
        groupId: 'github.com/example/tools',
        repoIdentity: 'github.com/example/tools',
        displayName: 'tools',
        selectedRemote: null,
        remotes: [],
        warnings: [],
        identityDebug: {
          groupedBy: 'repoIdentity',
          repoIdentity: 'github.com/example/tools',
          instanceCount: 1,
          nodeIds: ['local'],
        },
        instances: [
          {
            repoInstanceId: 'local:%2FUsers%2Fkyle%2Ftools',
            nodeId: 'local',
            localPath: '/Users/kyle/tools',
            name: 'tools',
            isGitRepo: true,
            defaultBranch: 'main',
            currentBranch: 'main',
            repoIdentity: 'github.com/example/tools',
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

function nodes(): HubNodeSummary[] {
  if (scenario === 'single-disabled') return [node({ status: 'offline' })];
  if (scenario === 'single' || scenario === 'single-hermes') return [node()];
  return [
    node(),
    node({ nodeId: 'linux', displayName: 'linux lab', homeDir: '/home/linux' }),
    node({ nodeId: 'offline', displayName: 'offline lab', status: 'offline' }),
    node({
      nodeId: 'no-tmux',
      displayName: 'no tmux box',
      capabilities: {
        ...node().capabilities,
        core: {
          ...node().capabilities.core,
          tmux: 'unavailable',
        },
        terminalBackends: {
          'relay-pty': 'available',
          'tmux-compat': 'unavailable',
        },
      },
    }),
    node({
      nodeId: 'no-claude',
      displayName: 'no claude box',
      capabilities: {
        ...node().capabilities,
        agents: { claude: 'unavailable', codex: 'available' },
      },
    }),
  ];
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

window.fetch = async (input, init) => {
  const url = new URL(String(input), window.location.origin);
  if (url.pathname === '/hub/repo-inventory') return jsonResponse(inventory());
  if (url.pathname === '/nodes') return jsonResponse({ nodes: nodes() });
  if (url.pathname === '/config/defaultContinue')
    return jsonResponse({ defaultContinue: false });
  if (url.pathname === '/config/defaultYolo')
    return jsonResponse({ defaultYolo: false });
  if (url.pathname === '/config/defaultAgent')
    return jsonResponse({
      defaultAgent:
        scenario === 'multi-hermes' || scenario === 'single-hermes'
          ? 'hermes'
          : 'claude',
    });
  if (url.pathname === '/config/defaultNotifications')
    return jsonResponse({ defaultNotifications: true });
  if (url.pathname === '/config/claudeFullscreen')
    return jsonResponse({ claudeFullscreen: true });
  if (url.pathname === '/sessions' && init?.method === 'POST') {
    lastCreateRequest = `${url.pathname} ${init.body ?? ''}`;
    const body = JSON.parse(String(init.body ?? '{}')) as { agent?: string };
    return jsonResponse({
      id: 'local-session',
      type: 'agent',
      agent: body.agent ?? 'claude',
      repoName: 'relay-ide',
      repoPath: '/Users/kyle/relay-ide',
      worktreePath: null,
      cwd: '/Users/kyle/relay-ide',
      branchName: 'nightly',
      displayName: 'default',
      createdAt: '2026-05-12T00:00:00.000Z',
      lastActivity: '2026-05-12T00:00:00.000Z',
      idle: false,
    });
  }
  if (url.pathname === '/hub/nodes/linux/sessions' && init?.method === 'POST') {
    lastCreateRequest = `${url.pathname} ${init.body ?? ''}`;
    const body = JSON.parse(String(init.body ?? '{}')) as {
      agent?: string;
      cwd?: string;
    };
    return jsonResponse({
      id: body.cwd === '/home/linux' ? 'remote-home-session' : 'remote-session',
      nodeId: 'linux',
      globalSessionId: 'linux:remote-session',
      type: 'agent',
      agent: body.agent ?? 'claude',
      cwd: body.cwd ?? '/home/linux',
      displayName: 'linux shell',
      createdAt: '2026-05-12T00:00:00.000Z',
      lastActivity: '2026-05-12T00:00:00.000Z',
      idle: false,
    });
  }
  if (url.pathname === '/sessions') return jsonResponse([]);
  if (url.pathname === '/git/worktrees') return jsonResponse([]);
  if (url.pathname === '/workspaces') {
    return jsonResponse({
      workspaces: [
        {
          name: 'relay-ide',
          path: '/Users/kyle/relay-ide',
          isGitRepo: true,
          defaultBranch: 'nightly',
          currentBranch: 'nightly',
        },
      ],
    });
  }
  if (url.pathname === '/workspace-groups') return jsonResponse([]);
  return nativeFetch(input, init);
};

useConfigStore.setState({
  defaultAgent: 'claude',
  defaultContinue: false,
  defaultYolo: false,
  frameworks: [framework('claude'), framework('codex'), framework('hermes')],
});

function Harness() {
  const dialogRef = useRef<CustomizeSessionDialogHandle>(null);
  const [createdSession, setCreatedSession] = useState('');
  return (
    <div className="test-harness">
      <button
        type="button"
        onClick={() => {
          scenario = 'multi';
          void dialogRef.current?.open({
            name: 'relay-ide',
            path: '/Users/kyle/relay-ide',
          });
        }}
      >
        open customize session
      </button>
      <button
        type="button"
        onClick={() => {
          scenario = 'multi-hermes';
          void dialogRef.current?.open({
            name: 'relay-ide',
            path: '/Users/kyle/relay-ide',
          });
        }}
      >
        open web-capable remote customize session
      </button>
      <button
        type="button"
        onClick={() => {
          scenario = 'single';
          void dialogRef.current?.open({
            name: 'relay-ide',
            path: '/Users/kyle/relay-ide',
          });
        }}
      >
        open single-node customize session
      </button>
      <button
        type="button"
        onClick={() => {
          scenario = 'single-hermes';
          void dialogRef.current?.open({
            name: 'relay-ide',
            path: '/Users/kyle/relay-ide',
          });
        }}
      >
        open local web-capable customize session
      </button>
      <button
        type="button"
        onClick={() => {
          scenario = 'single-disabled';
          void dialogRef.current?.open({
            name: 'relay-ide',
            path: '/Users/kyle/relay-ide',
          });
        }}
      >
        open single disabled-node customize session
      </button>
      <output data-testid="created-session">{createdSession}</output>
      <output data-testid="last-create-request">{lastCreateRequest}</output>
      <CustomizeSessionDialog
        ref={dialogRef}
        onSessionCreated={setCreatedSession}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>
);
