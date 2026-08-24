import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PiStateAdapter } from '../../../server/provider-state/pi-state-adapter.js';

describe('PiStateAdapter', () => {
  it('reports unsupported status when state root exists but has no session history', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-state-'));
    const adapter = new PiStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const status = await adapter.detectInstall();
    expect(status.provider).toBe('pi');
    expect(status.status).toBe('unsupported');
    expect(status.stateRoots).toEqual([root]);
    expect(status.diagnostics).toHaveLength(1);
    expect(status.diagnostics[0]?.code).toBe('PI_RPC_ONLY_NO_SESSION_HISTORY');
    expect(status.diagnostics[0]?.severity).toBe('info');
  });

  it('reports unavailable status when state root does not exist', async () => {
    const adapter = new PiStateAdapter({
      stateRoot: '/nonexistent/path/that/does/not/exist/.pi',
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const status = await adapter.detectInstall();
    expect(status.provider).toBe('pi');
    expect(status.status).toBe('unavailable');
    expect(status.diagnostics[0]?.code).toBe('PI_STATE_ROOT_NOT_FOUND');
  });

  it('returns an empty list from listNativeSessions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-state-'));
    const adapter = new PiStateAdapter({ stateRoot: root });

    const sessions = await adapter.listNativeSessions();
    expect(sessions).toEqual([]);
  });

  it('throws an honest error from readProviderState instead of faking data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-state-'));
    const adapter = new PiStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'pi',
        nativeId: 'some-session',
      })
    ).rejects.toThrow(/RPC-based/);
  });

  it('throws an honest error from importSession instead of faking data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-state-'));
    const adapter = new PiStateAdapter({ stateRoot: root });

    await expect(
      adapter.importSession({
        provider: 'pi',
        nativeId: 'some-session',
      })
    ).rejects.toThrow(/RPC-based/);
  });

  it('returns copyable resume argv without executing it', () => {
    const adapter = new PiStateAdapter({
      stateRoot: '/tmp/pi',
    });
    expect(
      adapter.resumeCommand({ provider: 'pi', nativeId: 'pi-session-1' })
    ).toEqual(['pi', '--resume', 'pi-session-1']);
  });

  it('reports honest capabilities: no import, no read, but can resume', () => {
    const adapter = new PiStateAdapter({ stateRoot: '/tmp/pi' });
    expect(adapter.capabilities).toMatchObject({
      canImportTranscript: false,
      canReadProviderState: false,
      canResumeNative: true,
      readOnly: true,
    });
  });
});