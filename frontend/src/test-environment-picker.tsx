// Visual fixture for the EnvironmentPicker component (#627).
//
// Render with `RELAY_IDE_E2E_FIXTURES=1 npm run dev:vite` and open the
// `/test-environment-picker.html` page. Pure presentational — the picker
// receives a hard-coded option list and an `onSelect` that logs to the
// page-level <output>. No store, no API.

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { EnvironmentOption } from '../../shared/environment-option.js';
import EnvironmentPicker from './components/EnvironmentPicker.js';
import './App.css';
import './components/EnvironmentPicker.css';

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

const OPTIONS: EnvironmentOption[] = [
  {
    schemaVersion: 1,
    id: 'local-relay',
    node: {
      nodeId: 'local',
      kind: 'local',
      displayName: 'this host',
      online: true,
    },
    capabilities: [
      'session:create:terminal',
      'session:create:agent',
      'rpc:fs:read',
      'rpc:git:read',
    ],
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
  {
    schemaVersion: 1,
    id: 'mac-relay-nightly',
    node: {
      nodeId: 'mac',
      kind: 'remote',
      displayName: 'dev mac',
      online: true,
    },
    capabilities: [
      'session:create:terminal',
      'session:create:agent',
      'rpc:fs:read',
      'rpc:git:read',
    ],
    cwd: '/Users/dev/code/relay-ide/.worktrees/627-env-picker',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: 'mac:/Users/dev/code/relay-ide',
      localPath: '/Users/dev/code/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'feature/627-env-picker',
      defaultBranch: 'master',
    },
    bench: {
      worktreeInstanceId:
        'mac:/Users/dev/code/relay-ide/.worktrees/627-env-picker',
      localPath: '/Users/dev/code/relay-ide/.worktrees/627-env-picker',
      branchName: 'feature/627-env-picker',
      displayName: '627-env-picker',
    },
    generatedAt: GENERATED_AT,
  },
  {
    schemaVersion: 1,
    id: 'wsl-relay-stale',
    node: {
      nodeId: 'wsl',
      kind: 'remote',
      displayName: 'win wsl',
      online: true,
    },
    capabilities: ['session:create:terminal', 'rpc:fs:read'],
    cwd: '/home/dev/repos/relay-ide',
    cwdMode: 'repo',
    freshness: 'stale',
    repoInstance: {
      repoInstanceId: 'wsl:/home/dev/repos/relay-ide',
      localPath: '/home/dev/repos/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'nightly',
    },
    degradedReasons: [
      {
        kind: 'node-stale',
        lastSeenAt: '2026-05-19T11:30:00.000Z',
        message: 'heartbeat 30 min stale',
      },
      {
        kind: 'capability-missing',
        capability: 'rpc:git:read',
        message: 'git capability not granted on this node',
      },
    ],
    generatedAt: GENERATED_AT,
  },
  {
    schemaVersion: 1,
    id: 'lab-other-offline',
    node: {
      nodeId: 'lab',
      kind: 'remote',
      displayName: 'lab box',
      online: false,
    },
    capabilities: ['session:create:terminal'],
    cwd: '/srv/repos/other-project',
    cwdMode: 'repo',
    freshness: 'offline',
    repoInstance: {
      repoInstanceId: 'lab:/srv/repos/other-project',
      localPath: '/srv/repos/other-project',
      repoIdentity: 'github.com/donovan-yohan/other-project',
      name: 'other-project',
      currentBranch: 'main',
    },
    degradedReasons: [
      { kind: 'node-offline', message: 'node has not checked in' },
    ],
    generatedAt: GENERATED_AT,
  },
  {
    schemaVersion: 1,
    id: 'local-free-scratch',
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

function Harness() {
  const [selected, setSelected] = useState<EnvironmentOption | null>(null);
  const [cancelled, setCancelled] = useState(0);
  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <h2 style={{ fontFamily: 'monospace', color: '#e0e0e0' }}>
        environment picker fixture (#627)
      </h2>
      <EnvironmentPicker
        options={OPTIONS}
        {...(selected ? { selectedOptionId: selected.id } : {})}
        onSelect={(opt) => setSelected(opt)}
        onCancel={() => setCancelled((n) => n + 1)}
      />
      <output
        data-testid="env-picker-selected"
        style={{
          display: 'block',
          marginTop: 16,
          color: '#888',
          fontFamily: 'monospace',
        }}
      >
        selected: {selected?.id ?? '(none)'} · cancels: {cancelled}
      </output>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>
);
