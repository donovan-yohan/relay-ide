import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getNodeManifest, probeCommand } from '../server/node-manifest.js';

describe('node manifest', () => {
  it('reports platform, service manager, and degraded missing tool probes without throwing', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-node-manifest-')
    );
    try {
      for (const command of ['tmux', 'git']) {
        const bin = path.join(tmpDir, command);
        fs.writeFileSync(bin, '#!/bin/sh\necho fake-version\n', {
          mode: 0o755,
        });
      }

      const manifest = await getNodeManifest({
        env: { PATH: tmpDir },
        platform: 'darwin',
        arch: 'arm64',
        hostname: 'relay-test-node',
        relayVersion: '9.9.9-test',
        now: new Date('2026-01-02T03:04:05.000Z'),
      });

      expect(manifest).toMatchObject({
        schemaVersion: 1,
        platform: 'darwin',
        arch: 'arm64',
        hostname: 'relay-test-node',
        relayVersion: '9.9.9-test',
        generatedAt: '2026-01-02T03:04:05.000Z',
        wsl: { detected: false, version: null, systemd: false },
        serviceManager: { kind: 'launchd', supported: true, installable: true },
        capabilities: {
          tmux: { status: 'available' },
          git: { status: 'available' },
          githubCli: { status: 'unavailable' },
        },
      });
      expect(Object.keys(manifest.capabilities.agents)).toEqual(
        expect.arrayContaining(['claude', 'codex', 'opencode', 'hermes'])
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('turns configured framework resolution failures into a degraded agent capability', async () => {
    const manifest = await getNodeManifest({
      env: { PATH: '' },
      platform: 'darwin',
      config: { frameworks: { broken: { id: 'broken' } } },
    });

    expect(manifest.capabilities.agents.frameworks).toMatchObject({
      id: 'frameworks',
      status: 'degraded',
    });
    expect(manifest.capabilities.agents.frameworks.message).toContain(
      'Agent framework probes failed non-fatally'
    );
  });

  it('probeCommand reports missing commands as unavailable instead of throwing', () => {
    expect(
      probeCommand('missing', 'Missing tool', 'definitely-missing-tool', {
        PATH: '',
      })
    ).toEqual({
      id: 'missing',
      label: 'Missing tool',
      status: 'unavailable',
      message: 'definitely-missing-tool was not found on PATH.',
    });
  });

  it('includes simulated WSL lifecycle and path capability state in the manifest', async () => {
    const manifest = await getNodeManifest({
      env: {
        PATH: '',
        WSL_DISTRO_NAME: 'Ubuntu',
        WSL_INTEROP: '/run/WSL/123_interop',
      },
      platform: 'linux',
      cwd: '/mnt/c/Users/dev/relay-ide',
    });

    expect(manifest.wsl).toMatchObject({
      detected: true,
      supportTier: 'tier-1.5',
      pathMode: 'windows-mount',
      windowsPath: '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\dev\\relay-ide',
    });
    expect(['wsl-systemd', 'wsl-manual']).toContain(
      manifest.wsl.lifecycleMode
    );
    expect(manifest.wsl.caveats?.join(' ')).toMatch(/not native Windows/i);
    expect(manifest.wsl.caveats?.join(' ')).toMatch(/capability-gated/i);
    expect(['wsl-systemd', 'wsl-manual']).toContain(
      manifest.serviceManager.kind
    );
  });
});
