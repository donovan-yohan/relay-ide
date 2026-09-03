import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CursorStateAdapter } from '../../../server/provider-state/cursor-state-adapter.js';
import { NATIVE_SESSION_PROVIDERS } from '../../../shared/provider-native-session-state.js';

describe('CursorStateAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'cursor-state-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('declares honest read-only capabilities with native resume', () => {
    const adapter = new CursorStateAdapter({ stateRoot: tempDir });
    expect(adapter.provider).toBe('cursor');
    expect(adapter.capabilities).toEqual({
      canImportTranscript: false,
      canReadProviderState: false,
      canResumeNative: true,
      canStreamLiveEvents: false,
      canRespondToApprovals: false,
      canExposeToolCalls: false,
      readOnly: true,
    });
  });

  it('detectInstall reports installed when stateRoot exists', async () => {
    const adapter = new CursorStateAdapter({
      stateRoot: tempDir,
      now: () => new Date('2026-09-02T12:00:00.000Z'),
    });
    const status = await adapter.detectInstall();
    expect(status).toMatchObject({
      provider: 'cursor',
      status: 'installed',
      detectedAt: '2026-09-02T12:00:00.000Z',
      stateRoots: [tempDir],
    });
  });

  it('detectInstall reports unavailable when stateRoot is missing', async () => {
    const missingDir = path.join(tempDir, 'missing');
    const adapter = new CursorStateAdapter({
      stateRoot: missingDir,
      now: () => new Date('2026-09-02T12:00:00.000Z'),
    });
    const status = await adapter.detectInstall();
    expect(status).toMatchObject({
      provider: 'cursor',
      status: 'unavailable',
      stateRoots: [missingDir],
    });
  });

  // The HTTP native-session routes (list/get/import/watch) validate the
  // `provider` param against this list, so an adapter registered without a row
  // here 400s on every route.
  it('is an accepted provider on the native-session routes', () => {
    expect(NATIVE_SESSION_PROVIDERS).toContain('cursor');
  });

  it('listNativeSessions returns empty array', async () => {
    const adapter = new CursorStateAdapter({ stateRoot: tempDir });
    const list = await adapter.listNativeSessions();
    expect(list).toEqual([]);
  });

  it('readProviderState throws unsupported error', async () => {
    const adapter = new CursorStateAdapter({ stateRoot: tempDir });
    await expect(
      adapter.readProviderState({ provider: 'cursor', nativeId: 's-1' })
    ).rejects.toThrow(/not supported/);
  });

  it('importSession throws unsupported error', async () => {
    const adapter = new CursorStateAdapter({ stateRoot: tempDir });
    await expect(
      adapter.importSession({ provider: 'cursor', nativeId: 's-1' })
    ).rejects.toThrow(/not supported/);
  });

  it('resumeCommand formats cursor-agent --resume <id>', () => {
    const adapter = new CursorStateAdapter({ stateRoot: tempDir });
    expect(
      adapter.resumeCommand({ provider: 'cursor', nativeId: 'chat_12345' })
    ).toEqual(['cursor-agent', '--resume', 'chat_12345']);

    expect(adapter.resumeCommand({ provider: 'cursor', nativeId: '' })).toEqual(
      []
    );
  });
});
