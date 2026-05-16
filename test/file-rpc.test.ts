import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileRpcFollower, executeLocalFileRpc, normalizeHubFileRpcRequest } from '../server/file-rpc.js';
import { createRoutedNodeSessionEnvelope } from '../shared/session-envelope.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-rpc-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'README.md'), 'line 1\nline 2\nline 3\n');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  return root;
}

function sessionSummary(root: string) {
  const registry = createSessionEnvelopeRegistry();
  registry.upsert(
    createRoutedNodeSessionEnvelope({
      nodeId: 'node_a',
      sessionId: 'session_a',
      cwd: root,
      repoPath: root,
      issuedAt: '2026-01-02T03:04:05.000Z',
    })
  );
  const validation = registry.validate({
    nodeId: 'node_a',
    sessionId: 'session_a',
    now: new Date('2026-01-02T03:04:05.000Z'),
  });
  if (validation.ok === false) throw new Error(validation.error.message);
  return validation.summary;
}

describe('read-only File RPC foundation', () => {
  it('normalizes hub requests against the scoped cwd/root and clamps payload bounds', () => {
    const root = fixtureRoot();
    const normalized = normalizeHubFileRpcRequest({
      operation: 'read',
      nodeId: 'node_a',
      nodePlatform: process.platform,
      session: sessionSummary(root),
      body: { path: 'README.md', maxBytes: 999_999, maxLines: 10_000 },
    });

    expect(normalized).toMatchObject({
      ok: true,
      value: {
        request: {
          sessionId: 'session_a',
          root,
          cwd: root,
          path: path.join(root, 'README.md'),
          maxBytes: 65536,
          maxLines: 2000,
        },
      },
    });
  });

  it('rejects cwd and path escapes before dispatching to a node', () => {
    const root = fixtureRoot();
    expect(
      normalizeHubFileRpcRequest({
        operation: 'list',
        nodeId: 'node_a',
        nodePlatform: process.platform,
        session: sessionSummary(root),
        body: { cwd: '..', path: '.' },
      })
    ).toMatchObject({ ok: false, error: { details: { reasonCode: 'FILE_RPC_CWD_ESCAPE' } } });

    expect(
      normalizeHubFileRpcRequest({
        operation: 'stat',
        nodeId: 'node_a',
        nodePlatform: process.platform,
        session: sessionSummary(root),
        body: { path: '../outside' },
      })
    ).toMatchObject({ ok: false, error: { details: { reasonCode: 'FILE_RPC_ROOT_ESCAPE' } } });
  });

  it('executes local list/stat/read with entry and byte/line bounds', async () => {
    const root = fixtureRoot();
    const list = await executeLocalFileRpc('list', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: root,
      maxEntries: 1,
    });
    expect(list).toMatchObject({ operation: 'list', truncated: true, entries: [{ name: 'README.md' }] });

    const stat = await executeLocalFileRpc('stat', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: path.join(root, 'README.md'),
    });
    expect(stat).toMatchObject({ operation: 'stat', stat: { name: 'README.md', type: 'file' } });

    const read = await executeLocalFileRpc('read', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: path.join(root, 'README.md'),
      maxBytes: 12,
      maxLines: 1,
    });
    expect(read).toMatchObject({
      operation: 'read',
      content: 'line 1',
      bytesRead: 12,
      truncatedBytes: true,
      truncatedLines: true,
    });
  });

  it('continues reading after short file-handle reads before reporting truncation', async () => {
    const root = fixtureRoot();
    const file = path.join(root, 'short-read.txt');
    fs.writeFileSync(file, 'abcdefghijklmnopqrstuvwxyz');
    const probeHandle = await fsPromises.open(file, 'r');
    const handlePrototype = Object.getPrototypeOf(probeHandle) as {
      read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>;
    };
    const realRead = handlePrototype.read;
    await probeHandle.close();
    handlePrototype.read = function shortRead(
      this: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) {
      return realRead.call(this, buffer, offset, Math.min(length, 5), position);
    };

    try {
      const completeRead = await executeLocalFileRpc('read', {
        sessionId: 'session_a',
        root,
        cwd: root,
        path: file,
        maxBytes: 30,
      });

      expect(completeRead).toMatchObject({
        operation: 'read',
        content: 'abcdefghijklmnopqrstuvwxyz',
        bytesRead: 26,
        truncatedBytes: false,
        truncatedLines: false,
      });

      const truncatedRead = await executeLocalFileRpc('read', {
        sessionId: 'session_a',
        root,
        cwd: root,
        path: file,
        maxBytes: 10,
      });

      expect(truncatedRead).toMatchObject({
        operation: 'read',
        content: 'abcdefghij',
        bytesRead: 10,
        truncatedBytes: true,
        truncatedLines: false,
      });
    } finally {
      handlePrototype.read = realRead;
    }
  });

  it('executes local tail from the end with byte and line bounds', async () => {
    const root = fixtureRoot();
    const logFile = path.join(root, 'app.log');
    fs.writeFileSync(logFile, 'one\ntwo\nthree\nfour\nfive\n');

    const tail = await executeLocalFileRpc('tail', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: logFile,
      maxBytes: 18,
      maxLines: 2,
    });

    expect(tail).toMatchObject({
      operation: 'tail',
      content: 'four\nfive\n',
      bytesRead: 18,
      truncatedBytes: true,
      truncatedLines: true,
      follow: false,
      maxBytes: 18,
      maxLines: 2,
      maxFollowChunkBytes: 16384,
    });
    expect('startOffset' in tail && tail.startOffset).toBeGreaterThan(0);
  });

  it('denies tail for directories and missing files with typed File RPC reasons', async () => {
    const root = fixtureRoot();

    await expect(
      executeLocalFileRpc('tail', {
        sessionId: 'session_a',
        root,
        cwd: root,
        path: path.join(root, 'src'),
      })
    ).resolves.toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_NOT_FILE' },
    });

    await expect(
      executeLocalFileRpc('tail', {
        sessionId: 'session_a',
        root,
        cwd: root,
        path: path.join(root, 'missing.log'),
      })
    ).resolves.toMatchObject({
      code: 'NOT_FOUND',
      details: { reasonCode: 'FILE_RPC_NOT_FOUND' },
    });
  });

  it('denies realpath symlink escapes from the scoped root', async () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-rpc-outside-'));
    cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.symlinkSync(outside, path.join(root, 'outside-link'));

    const denied = await executeLocalFileRpc('read', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: path.join(root, 'outside-link', 'secret.txt'),
      maxBytes: 64,
    });

    expect(denied).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_ROOT_ESCAPE' },
    });
  });

  it('emits a typed terminal error when a followed file is replaced by a directory', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'app.log');
    fs.writeFileSync(target, 'initial\n', 'utf8');
    const errors: unknown[] = [];
    const follower = createFileRpcFollower({
      request: { path: target, maxFollowChunkBytes: 64 },
      startOffset: fs.statSync(target).size,
      write: () => {},
      onError: (error) => errors.push(error),
      pollIntervalMs: 10,
    });
    cleanup.push(() => follower.close());

    fs.rmSync(target);
    fs.mkdirSync(target);

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_NOT_FILE', path: target },
    });
  });
});
