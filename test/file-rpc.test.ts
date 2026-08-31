import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileRpcFollower, executeLocalFileRpc, normalizeHubFileRpcRequest } from '../server/file-rpc.js';
import { FILE_RPC_MAX_WRITE_BYTES } from '../shared/file-rpc.js';
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

  it('executes local base64 reads for bounded binary previews', async () => {
    const root = fixtureRoot();
    const imageFile = path.join(root, 'tiny.png');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    fs.writeFileSync(imageFile, imageBytes);

    const read = await executeLocalFileRpc('read', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: imageFile,
      maxBytes: 4,
      maxLines: 1,
      encoding: 'base64',
    });

    expect(read).toMatchObject({
      operation: 'read',
      encoding: 'base64',
      content: imageBytes.subarray(0, 4).toString('base64'),
      bytesRead: 4,
      truncatedBytes: true,
      truncatedLines: false,
      maxBytes: 4,
      maxLines: 1,
    });
  });

  it('rejects unsupported read encodings before filesystem access', async () => {
    const root = fixtureRoot();

    const read = await executeLocalFileRpc('read', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: path.join(root, 'README.md'),
      encoding: 'hex',
    });

    expect(read).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_INVALID_REQUEST', field: 'encoding' },
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

  it('preserves a trailing empty line when tailing one line from a blank final line', async () => {
    const root = fixtureRoot();
    const logFile = path.join(root, 'blank-final-line.log');
    fs.writeFileSync(logFile, 'one\ntwo\n\n');

    const tail = await executeLocalFileRpc('tail', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: logFile,
      maxBytes: 64,
      maxLines: 1,
    });

    expect(tail).toMatchObject({
      operation: 'tail',
      content: '\n',
      truncatedBytes: false,
      truncatedLines: true,
      maxLines: 1,
    });
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

  it('does not poll or enqueue more follow chunks while an async writer is backpressured', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'slow-writer.log');
    fs.writeFileSync(target, 'initial\n', 'utf8');
    const writes: unknown[] = [];
    let releaseWrite: (() => void) | undefined;
    const follower = createFileRpcFollower({
      request: { path: target, maxFollowChunkBytes: 64 },
      startOffset: fs.statSync(target).size,
      write: (chunk) => {
        writes.push(chunk);
        return new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      },
      pollIntervalMs: 10,
      writeTimeoutMs: 1_000,
    });
    cleanup.push(() => follower.close());

    fs.appendFileSync(target, 'first\n', 'utf8');
    await vi.waitFor(() => expect(writes).toHaveLength(1));

    fs.appendFileSync(target, 'second\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes).toHaveLength(1);

    releaseWrite?.();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ content: 'second\n' });
  });

  it('closes follow streams with a typed retryable error when writes stay backpressured', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'stuck-writer.log');
    fs.writeFileSync(target, 'initial\n', 'utf8');
    const errors: unknown[] = [];
    const follower = createFileRpcFollower({
      request: { path: target, maxFollowChunkBytes: 64 },
      startOffset: fs.statSync(target).size,
      write: () => new Promise<void>(() => {}),
      onError: (error) => errors.push(error),
      pollIntervalMs: 10,
      writeTimeoutMs: 20,
    });
    cleanup.push(() => follower.close());

    fs.appendFileSync(target, 'blocked\n', 'utf8');

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({
      code: 'NODE_BUSY',
      retryable: true,
      details: { reasonCode: 'FILE_RPC_FOLLOW_BACKPRESSURE', path: target },
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

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writePayload(
  root: string,
  filePath: string,
  mode: string,
  content: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    sessionId: 'session_a',
    root,
    cwd: root,
    path: filePath,
    operation: 'write',
    mode,
    contentBase64: Buffer.from(content).toString('base64'),
    ...extra,
  };
}

describe('fs.write executor', () => {
  it('happy create: writes new file, returns created=true and correct hash', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'new-file.txt');
    const content = 'hello relay\n';
    const buf = Buffer.from(content);

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'create', content));

    expect(result).toMatchObject({
      operation: 'write',
      mode: 'create',
      bytesWritten: buf.length,
      created: true,
    });
    if (!('code' in result) && result.operation === 'write') {
      expect(result.newHash).toBe(sha256Hex(buf));
      expect(new Date(result.newMtime).getTime()).toBeGreaterThan(Date.now() - 5000);
    }
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
  });

  it('happy overwrite with correct expectedHash: replaces content, returns created=false', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'existing.txt');
    const oldContent = 'old content\n';
    const newContent = 'new content\n';
    fs.writeFileSync(target, oldContent);
    const oldBuf = Buffer.from(oldContent);
    const newBuf = Buffer.from(newContent);
    const oldHash = sha256Hex(oldBuf);

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'overwrite', newContent, {
      expectedHash: oldHash,
    }));

    expect(result).toMatchObject({
      operation: 'write',
      mode: 'overwrite',
      bytesWritten: newBuf.length,
      created: false,
    });
    if (!('code' in result) && result.operation === 'write') {
      expect(result.newHash).toBe(sha256Hex(newBuf));
      expect(result.newHash).not.toBe(oldHash);
    }
    expect(fs.readFileSync(target, 'utf8')).toBe(newContent);
  });

  it('happy append: appends content, file contains concat, created=false', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'appendme.txt');
    fs.writeFileSync(target, 'aaa\n');
    const appendContent = 'bbb\n';
    const appendBuf = Buffer.from(appendContent);

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'append', appendContent));

    expect(result).toMatchObject({
      operation: 'write',
      mode: 'append',
      bytesWritten: appendBuf.length,
      created: false,
    });
    const finalContent = 'aaa\nbbb\n';
    if (!('code' in result) && result.operation === 'write') {
      expect(result.newHash).toBe(sha256Hex(Buffer.from(finalContent)));
    }
    expect(fs.readFileSync(target, 'utf8')).toBe(finalContent);
  });

  it('mode=create on existing file returns FILE_RPC_OVERWRITE_REQUIRED, file unchanged', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'existing.txt');
    const original = 'original\n';
    fs.writeFileSync(target, original);

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'create', 'replacement\n'));

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_OVERWRITE_REQUIRED' },
    });
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });

  it('mode=overwrite without expectedHash returns FILE_RPC_EXPECTED_HASH_REQUIRED', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'existing.txt');
    fs.writeFileSync(target, 'some content\n');

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'overwrite', 'new content\n'));

    expect(result).toMatchObject({
      details: { reasonCode: 'FILE_RPC_EXPECTED_HASH_REQUIRED' },
    });
  });

  it('mode=overwrite with stale expectedHash returns FILE_RPC_EXPECTED_HASH_MISMATCH, file unchanged', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'existing.txt');
    const original = 'original content\n';
    fs.writeFileSync(target, original);
    const staleHash = sha256Hex(Buffer.from('some other content\n'));

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'overwrite', 'new content\n', {
      expectedHash: staleHash,
    }));

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_EXPECTED_HASH_MISMATCH' },
    });
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });

  it('size cap: oversized content returns FILE_RPC_WRITE_SIZE_EXCEEDED before any disk I/O', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'too-big.bin');
    const oversized = Buffer.alloc(FILE_RPC_MAX_WRITE_BYTES + 1).toString('base64');

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: target,
      operation: 'write',
      mode: 'create',
      contentBase64: oversized,
    });

    expect(result).toMatchObject({
      details: { reasonCode: 'FILE_RPC_WRITE_SIZE_EXCEEDED' },
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('path traversal returns FILE_RPC_ROOT_ESCAPE, target not created', async () => {
    const root = fixtureRoot();
    const traversalPath = path.join(root, '..', 'outside.txt');

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: traversalPath,
      operation: 'write',
      mode: 'create',
      contentBase64: Buffer.from('evil').toString('base64'),
    });

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_ROOT_ESCAPE' },
    });
    expect(fs.existsSync(traversalPath)).toBe(false);
  });

  it('EACCES on read-only parent dir returns FILE_RPC_WRITE_PERMISSION_DENIED', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root = fixtureRoot();
    const subdir = path.join(root, 'readonly-dir');
    fs.mkdirSync(subdir);
    const target = path.join(subdir, 'blocked.txt');
    fs.chmodSync(subdir, 0o555);
    cleanup.push(() => fs.chmodSync(subdir, 0o755));

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'create', 'blocked content\n'));

    expect(result).toMatchObject({
      code: 'FORBIDDEN',
      details: { reasonCode: 'FILE_RPC_WRITE_PERMISSION_DENIED' },
    });
  });

  it('NOT_FILE: target is an existing directory returns FILE_RPC_NOT_FILE', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'src'); // src dir created by fixtureRoot

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'create', 'content\n'));

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_NOT_FILE' },
    });
  });

  it('envelope round-trip: JSON parse/stringify preserves typed fields', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'round-trip.txt');
    const content = 'round trip test\n';

    const result = await executeLocalFileRpc('write', writePayload(root, target, 'create', content));
    expect('code' in result).toBe(false);
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toMatchObject({
      operation: 'write',
      mode: 'create',
      created: true,
    });
    expect(typeof roundTripped.newHash).toBe('string');
    expect(typeof roundTripped.newMtime).toBe('string');
    expect(typeof roundTripped.bytesWritten).toBe('number');
  });

  it('buildWriteRequest input validation: mode=bogus returns invalid request', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'foo.txt');

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: target,
      operation: 'write',
      mode: 'bogus',
      contentBase64: Buffer.from('test').toString('base64'),
    });

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_INVALID_REQUEST' },
    });
  });

  it('buildWriteRequest input validation: contentBase64=42 returns invalid request', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'foo.txt');

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: target,
      operation: 'write',
      mode: 'create',
      contentBase64: 42,
    });

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_INVALID_REQUEST' },
    });
  });

  it('buildWriteRequest input validation: mode=overwrite with no expectedHash returns invalid request', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'foo.txt');
    fs.writeFileSync(target, 'existing\n');

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: target,
      operation: 'write',
      mode: 'overwrite',
      contentBase64: Buffer.from('new\n').toString('base64'),
    });

    expect(result).toMatchObject({
      details: { reasonCode: 'FILE_RPC_EXPECTED_HASH_REQUIRED' },
    });
  });

  it('CRIT-6: malformed base64 (@@@@@@) returns FILE_RPC_INVALID_REQUEST with malformed_base64 reason', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'bad-b64.txt');

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: target,
      operation: 'write',
      mode: 'create',
      contentBase64: '@@@@@@',
    });

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_INVALID_REQUEST', reason: 'malformed_base64' },
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('CRIT-3: overwrite-through-symlink returns FILE_RPC_WRITE_THROUGH_SYMLINK', async () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-rpc-outside2-'));
    cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    const outsideFile = path.join(outside, 'real.txt');
    fs.writeFileSync(outsideFile, 'real content\n');
    const symlinkPath = path.join(root, 'symlink.txt');
    fs.symlinkSync(outsideFile, symlinkPath);

    // Attempt overwrite through the symlink (not append)
    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: symlinkPath,
      operation: 'write',
      mode: 'create',
      contentBase64: Buffer.from('evil\n').toString('base64'),
    });

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_WRITE_THROUGH_SYMLINK' },
    });
    // Original symlink and its target must be unchanged
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('real content\n');
  });

  it('CRIT-4: root realpath failure returns FILE_RPC_ROOT_UNAVAILABLE and refuses the write', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'new-file.txt');

    // Remove the root directory to make realpath fail
    fs.rmSync(root, { recursive: true, force: true });

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: target,
      operation: 'write',
      mode: 'create',
      contentBase64: Buffer.from('hello').toString('base64'),
    });

    // normalizeNodeRequest's realpath(root) fails before executeWrite is reached
    expect(result).toMatchObject({
      details: { reasonCode: 'FILE_RPC_ROOT_UNAVAILABLE' },
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('Strong-2: append-mode write to a symlink path rejects with FILE_RPC_WRITE_SYMLINK_ESCAPE', async () => {
    if (process.platform === 'win32') return; // O_NOFOLLOW is POSIX-only
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-rpc-outside3-'));
    cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    const outsideFile = path.join(outside, 'target.log');
    fs.writeFileSync(outsideFile, 'existing\n');
    const symlinkPath = path.join(root, 'link.log');
    fs.symlinkSync(outsideFile, symlinkPath);

    const result = await executeLocalFileRpc('write', {
      sessionId: 'session_a',
      root,
      cwd: root,
      path: symlinkPath,
      operation: 'write',
      mode: 'append',
      contentBase64: Buffer.from('injected\n').toString('base64'),
    });

    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { reasonCode: 'FILE_RPC_WRITE_SYMLINK_ESCAPE' },
    });
    // The outside file must not have been modified
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('existing\n');
  });
});
