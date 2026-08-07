// E2E fixture for EnvPickerDialog (#632) — exercises the four canonical
// picker scenarios from epic #615 acceptance criteria:
//
//   1. remote node selection
//   2. local repo selection
//   3. same-remote-different-path aggregation across nodes
//   4. non-git cwd launch
//
// The fixture renders EnvPickerDialog with a button per scenario. Each
// scenario supplies its own pre-built EnvironmentOption[]. The launch hook is
// stubbed to record the launched option's typed IDs (nodeId, repoIdentity,
// repoInstanceId, cwdMode) into a <output data-testid> sink so the Playwright
// spec can assert the typed-IDs contract round-trips through the dialog
// without depending on the real session-create API.
//
// Pure presentational — no store, no API, no router.

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { EnvironmentOption } from '../../shared/environment-option.js';
import EnvPickerDialog from './components/dialogs/EnvPickerDialog.js';
import type {
  LaunchEnvironmentResult,
  LaunchEnvironmentOptions,
} from './lib/launch-environment.js';
import './App.css';
import './components/EnvironmentPicker.css';
import './components/dialogs/EnvPickerDialog.css';

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

type ScenarioId = 'remote' | 'local' | 'same-remote' | 'non-git';

// ---------------------------------------------------------------------------
// Scenario 1: remote-only options. Picker must surface a remote node and a
// launched session must record the remote nodeId via typed IDs.
// ---------------------------------------------------------------------------
const REMOTE_SCENARIO: EnvironmentOption[] = [
  {
    schemaVersion: 1,
    id: 'mac::repo-relay',
    node: {
      nodeId: 'mac',
      kind: 'remote',
      displayName: 'dev mac',
      online: true,
    },
    capabilities: ['session:create:terminal', 'rpc:fs:read', 'rpc:git:read'],
    cwd: '/Users/dev/code/relay-ide',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: 'mac:/Users/dev/code/relay-ide',
      localPath: '/Users/dev/code/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'nightly',
      defaultBranch: 'master',
    },
    generatedAt: GENERATED_AT,
  },
];

// ---------------------------------------------------------------------------
// Scenario 2: local repo. Picker groups by RepoIdentity; launch carries the
// local RepoInstance path.
// ---------------------------------------------------------------------------
const LOCAL_SCENARIO: EnvironmentOption[] = [
  {
    schemaVersion: 1,
    id: 'local::repo-relay',
    node: {
      nodeId: 'local',
      kind: 'local',
      displayName: 'this host',
      online: true,
    },
    capabilities: ['session:create:terminal', 'rpc:fs:read', 'rpc:git:read'],
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
  },
];

// ---------------------------------------------------------------------------
// Scenario 3: same RepoIdentity on TWO different nodes, with DIFFERENT
// node-local paths. The picker MUST surface ONE group (aggregated by
// RepoIdentity) with TWO instances. Selecting each instance MUST launch
// against the correct node — no silent substitution (#615 invariant).
// ---------------------------------------------------------------------------
const SAME_REMOTE_DIFFERENT_PATH_SCENARIO: EnvironmentOption[] = [
  {
    schemaVersion: 1,
    id: 'mac::repo-relay',
    node: {
      nodeId: 'mac',
      kind: 'remote',
      displayName: 'dev mac',
      online: true,
    },
    capabilities: ['session:create:terminal', 'rpc:git:read'],
    cwd: '/Users/dev/code/relay-ide',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: 'mac:/Users/dev/code/relay-ide',
      localPath: '/Users/dev/code/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'nightly',
      defaultBranch: 'master',
    },
    generatedAt: GENERATED_AT,
  },
  {
    schemaVersion: 1,
    id: 'linux::repo-relay',
    node: {
      nodeId: 'linux',
      kind: 'remote',
      displayName: 'linux lab',
      online: true,
    },
    capabilities: ['session:create:terminal', 'rpc:git:read'],
    cwd: '/srv/checkouts/relay-ide',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: 'linux:/srv/checkouts/relay-ide',
      localPath: '/srv/checkouts/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'master',
      defaultBranch: 'master',
    },
    generatedAt: GENERATED_AT,
  },
];

// ---------------------------------------------------------------------------
// Scenario 4: non-git cwd. Picker surfaces a free / non-git cwd group;
// launch succeeds without a repoInstance, and the launched record carries
// `cwdMode: free`. The non-git option carries no repo-only capabilities
// (rpc:git:* absent) so repo-only actions never surface.
// ---------------------------------------------------------------------------
const NON_GIT_SCENARIO: EnvironmentOption[] = [
  {
    schemaVersion: 1,
    id: 'local::scratch',
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
  },
];

const SCENARIOS: Record<ScenarioId, EnvironmentOption[]> = {
  remote: REMOTE_SCENARIO,
  local: LOCAL_SCENARIO,
  'same-remote': SAME_REMOTE_DIFFERENT_PATH_SCENARIO,
  'non-git': NON_GIT_SCENARIO,
};

interface LaunchedRecord {
  optionId: string;
  nodeId: string;
  nodeKind: 'local' | 'remote';
  repoIdentity: string | null;
  repoInstanceId: string | null;
  cwd: string;
  cwdMode: string;
  overrides: LaunchEnvironmentOptions | undefined;
}

function recordFromOption(
  option: EnvironmentOption,
  overrides: LaunchEnvironmentOptions | undefined
): LaunchedRecord {
  return {
    optionId: option.id,
    nodeId: option.node.nodeId,
    nodeKind: option.node.kind,
    repoIdentity: option.repoInstance?.repoIdentity ?? null,
    repoInstanceId: option.repoInstance?.repoInstanceId ?? null,
    cwd: option.cwd,
    cwdMode: option.cwdMode,
    overrides,
  };
}

function Harness() {
  const [scenario, setScenario] = useState<ScenarioId | null>(null);
  const [launched, setLaunched] = useState<LaunchedRecord | null>(null);
  const [launchedCount, setLaunchedCount] = useState(0);

  const handleOpen = (id: ScenarioId) => {
    setLaunched(null);
    setScenario(id);
  };

  const stubLaunch = async (
    option: EnvironmentOption,
    overrides?: LaunchEnvironmentOptions
  ): Promise<LaunchEnvironmentResult> => {
    setLaunched(recordFromOption(option, overrides));
    setLaunchedCount((n) => n + 1);
    return {
      kind: 'launched',
      result: {
        session: undefined,
        error: null,
      },
    };
  };

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ fontFamily: 'monospace', color: '#e0e0e0' }}>
        env picker dialog fixture (#632)
      </h2>
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <button
          type="button"
          data-testid="open-remote"
          onClick={() => handleOpen('remote')}
        >
          open remote scenario
        </button>
        <button
          type="button"
          data-testid="open-local"
          onClick={() => handleOpen('local')}
        >
          open local scenario
        </button>
        <button
          type="button"
          data-testid="open-same-remote"
          onClick={() => handleOpen('same-remote')}
        >
          open same-remote-different-path scenario
        </button>
        <button
          type="button"
          data-testid="open-non-git"
          onClick={() => handleOpen('non-git')}
        >
          open non-git cwd scenario
        </button>
      </div>
      <EnvPickerDialog
        open={scenario !== null}
        options={scenario ? SCENARIOS[scenario] : []}
        onClose={() => setScenario(null)}
        launch={stubLaunch}
      />
      <output
        data-testid="launched-payload"
        style={{
          display: 'block',
          marginTop: 16,
          color: '#888',
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
        }}
      >
        {launched ? JSON.stringify(launched) : '(none)'}
      </output>
      <output
        data-testid="launched-count"
        style={{
          display: 'block',
          marginTop: 4,
          color: '#888',
          fontFamily: 'monospace',
        }}
      >
        launches: {launchedCount}
      </output>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>
);
