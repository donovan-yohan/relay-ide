import type { SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { probeRmuxCapability } from '../server/rmux-probe.js';

function spawnResult(overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 123,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

describe('probeRmuxCapability', () => {
  it('reports unavailable when neither rmux nor helper can be resolved', () => {
    const probe = probeRmuxCapability({
      env: { PATH: '' },
      platform: 'linux',
      arch: 'x64',
      resolveExecutable: () => null,
    });

    expect(probe).toMatchObject({
      id: 'rmux',
      status: 'unavailable',
      binaryPresent: false,
      helperPresent: false,
      platform: 'linux',
      arch: 'x64',
      ipc: {
        kind: 'unix-socket',
        source: 'platform-default',
      },
    });
    expect(probe.message).toContain('optional rmux backend remains disabled');
    expect(probe.r0Checklist.map((item) => item.id)).toEqual([
      'version-pinning',
      'crash-restart-behavior',
      'socket-ipc-exposure',
      'permission-boundary',
      'packaging-update-path',
    ]);
  });

  it('detects experimental rmux with pinned diagnostic provenance and env IPC shape', () => {
    const probe = probeRmuxCapability({
      env: { PATH: '/bin', RMUX_SDK_ENDPOINT: '/tmp/rmux.sock' },
      platform: 'linux',
      arch: 'arm64',
      resolveExecutable: (command) => (command === 'rmux' ? '/bin/rmux' : null),
      spawn: (command, args) => {
        expect(command).toBe('/bin/rmux');
        expect(args).toEqual(['--version']);
        return spawnResult({ stdout: 'rmux 0.1.2\n' });
      },
    });

    expect(probe).toMatchObject({
      status: 'available-experimental',
      binaryPresent: true,
      helperPresent: true,
      binaryPath: '/bin/rmux',
      helperPath: '/bin/rmux',
      version: 'rmux 0.1.2',
      ipc: {
        kind: 'unix-socket',
        source: 'env',
        endpoint: '/tmp/rmux.sock',
      },
    });
    expect(probe.message).toContain('optional experimental capability');
    expect(probe.r0Checklist).toContainEqual(
      expect.objectContaining({
        id: 'version-pinning',
        status: 'warn',
        message: expect.stringContaining('Helvesec/rmux@a37614c026e18616fa57bc27ae23e1f8241c43fe'),
      })
    );
  });

  it('uses RMUX_SDK_DAEMON_BINARY helper override when supplied', () => {
    const probe = probeRmuxCapability({
      env: { PATH: '/bin', RMUX_SDK_DAEMON_BINARY: '/opt/rmux-helper' },
      platform: 'darwin',
      arch: 'arm64',
      resolveExecutable: (command) => (command === 'rmux' ? '/bin/rmux' : null),
      spawn: (command) => {
        expect(command).toBe('/opt/rmux-helper');
        return spawnResult({ stdout: 'rmux 0.1.0\n' });
      },
    });

    expect(probe).toMatchObject({
      status: 'available-experimental',
      binaryPath: '/bin/rmux',
      helperPath: '/opt/rmux-helper',
      binaryPresent: true,
      helperPresent: true,
    });
  });

  it('fails explicit unresolved helper override instead of falling back to PATH rmux', () => {
    const probe = probeRmuxCapability({
      env: { PATH: '/bin', RMUX_SDK_DAEMON_BINARY: 'definitely-not-rmux-helper' },
      platform: 'linux',
      arch: 'x64',
      resolveExecutable: (command) => (command === 'rmux' ? '/bin/rmux' : null),
      spawn: (command) => {
        expect(command).toBe('definitely-not-rmux-helper');
        return spawnResult({
          status: null,
          error: new Error('spawn definitely-not-rmux-helper ENOENT'),
        });
      },
    });

    expect(probe).toMatchObject({
      status: 'probe-failed',
      binaryPath: '/bin/rmux',
      binaryPresent: true,
      helperPresent: false,
    });
    expect(probe).not.toHaveProperty('helperPath');
    expect(probe.message).toContain('definitely-not-rmux-helper');
  });

  it('resolves absolute helper overrides using the injected platform', () => {
    const probe = probeRmuxCapability({
      env: { PATH: 'C:\\Windows\\System32', RMUX_SDK_DAEMON_BINARY: 'C:\\Tools\\rmux-helper.exe' },
      platform: 'win32',
      arch: 'x64',
      resolveExecutable: (command) => (command === 'rmux' ? 'C:\\Tools\\rmux.exe' : null),
      spawn: (command) => {
        expect(command).toBe('C:\\Tools\\rmux-helper.exe');
        return spawnResult({ stdout: 'rmux 0.1.0\n' });
      },
    });

    expect(probe).toMatchObject({
      status: 'available-experimental',
      binaryPath: 'C:\\Tools\\rmux.exe',
      helperPath: 'C:\\Tools\\rmux-helper.exe',
      binaryPresent: true,
      helperPresent: true,
    });
  });

  it('marks old rmux versions as available-but-unsupported', () => {
    const probe = probeRmuxCapability({
      env: { PATH: '/bin' },
      platform: 'linux',
      resolveExecutable: () => '/bin/rmux',
      spawn: () => spawnResult({ stdout: 'rmux 0.0.9\n' }),
    });

    expect(probe.status).toBe('available-but-unsupported');
    expect(probe.r0Checklist).toContainEqual(
      expect.objectContaining({ id: 'version-pinning', status: 'fail' })
    );
  });

  it('keeps probe execution failures non-fatal', () => {
    const probe = probeRmuxCapability({
      env: { PATH: '/bin', RMUX_SDK_ENDPOINT: 'not-a-socket' },
      platform: 'linux',
      resolveExecutable: () => '/bin/rmux',
      spawn: () => spawnResult({ status: 2, stderr: 'bad rmux\n' }),
    });

    expect(probe).toMatchObject({
      status: 'probe-failed',
      ipc: {
        kind: 'unknown',
        source: 'env',
        endpoint: 'not-a-socket',
      },
    });
    expect(probe.message).toContain('bad rmux');
  });

  it('reports Windows pipe IPC defaults without requiring rmux to exist', () => {
    const probe = probeRmuxCapability({
      env: { PATH: '' },
      platform: 'win32',
      resolveExecutable: () => null,
    });

    expect(probe.ipc).toMatchObject({
      kind: 'windows-pipe',
      source: 'platform-default',
    });
    expect(probe.ipc.shape).toContain('\\\\.\\pipe\\rmux');
  });
});
