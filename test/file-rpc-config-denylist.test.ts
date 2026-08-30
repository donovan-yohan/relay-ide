import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileRpcFollower,
  executeLocalFileRpc,
  normalizeHubFileRpcRequest,
} from '../server/file-rpc.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import { createRoutedNodeSessionEnvelope } from '../shared/session-envelope.js';
import { localHubActorTokenPath } from '../shared/local-hub-actor-token.js';

/**
 * #1467: a scoped session rooted at `$HOME` used to put Relay's own config
 * directory — the PIN hash, the login credential, the node credential, and the
 * new local CLI trust token — inside a legitimate file-RPC read range. These
 * tests pin the denylist that closes that.
 */

const cleanup: string[] = [];
let fakeHome: string;
let configRoot: string;
let previousXdg: string | undefined;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fs-denylist-'));
  cleanup.push(fakeHome);
  // `sharedConfigRoots()` derives its first root from $XDG_CONFIG_HOME, so the
  // test owns a real config root without touching the operator's.
  previousXdg = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = fakeHome;
  configRoot = path.join(fakeHome, 'relay-ide');
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(configRoot, 'config.json'),
    JSON.stringify({ pinHash: 'scrypt$secret' }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    localHubActorTokenPath(configRoot, 3469),
    JSON.stringify({ token: 'relay-sac-v1.cred.secret' }),
    { mode: 0o600 }
  );
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = previousXdg;
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sessionRootedAtHome() {
  const registry = createSessionEnvelopeRegistry();
  registry.upsert(
    createRoutedNodeSessionEnvelope({
      nodeId: 'node_a',
      sessionId: 'session_a',
      cwd: fakeHome,
      repoPath: fakeHome,
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

describe('#1467 file-RPC config-root denylist', () => {
  it('denies the hub-side normalizer even when the session root contains the config dir', () => {
    for (const target of [
      localHubActorTokenPath(configRoot, 3469),
      path.join(configRoot, 'config.json'),
      configRoot,
    ]) {
      expect(
        normalizeHubFileRpcRequest({
          operation: 'read',
          nodeId: 'node_a',
          nodePlatform: process.platform,
          session: sessionRootedAtHome(),
          body: { path: target },
        })
      ).toMatchObject({
        ok: false,
        error: { details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } },
      });
    }
  });

  it('denies read, stat, list, tail, and write on the executing node', async () => {
    const tokenPath = localHubActorTokenPath(configRoot, 3469);
    for (const operation of ['read', 'stat', 'tail'] as const) {
      expect(
        await executeLocalFileRpc(operation, {
          sessionId: 'session_a',
          root: fakeHome,
          cwd: fakeHome,
          path: tokenPath,
        })
      ).toMatchObject({ details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } });
    }
    expect(
      await executeLocalFileRpc('list', {
        sessionId: 'session_a',
        root: fakeHome,
        cwd: fakeHome,
        path: configRoot,
      })
    ).toMatchObject({ details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } });
    expect(
      await executeLocalFileRpc('write', {
        sessionId: 'session_a',
        root: fakeHome,
        cwd: fakeHome,
        path: path.join(configRoot, 'planted.json'),
        mode: 'create',
        contentBase64: Buffer.from('{}').toString('base64'),
      })
    ).toMatchObject({ details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } });
    expect(fs.existsSync(path.join(configRoot, 'planted.json'))).toBe(false);
  });

  it('denies a relative path resolved from a cwd inside the config root', async () => {
    // Exercises the cwd clause specifically: the request path is relative, so
    // only the cwd puts the target inside a protected root.
    expect(
      normalizeHubFileRpcRequest({
        operation: 'read',
        nodeId: 'node_a',
        nodePlatform: process.platform,
        session: sessionRootedAtHome(),
        body: { path: 'config.json', cwd: configRoot },
      })
    ).toMatchObject({
      ok: false,
      error: { details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } },
    });
    expect(
      await executeLocalFileRpc('read', {
        sessionId: 'session_a',
        root: fakeHome,
        cwd: configRoot,
        path: path.join(configRoot, 'config.json'),
      })
    ).toMatchObject({ details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } });
  });

  it('denies a symlink inside the session root that resolves into the config dir', async () => {
    const link = path.join(fakeHome, 'innocent.json');
    fs.symlinkSync(localHubActorTokenPath(configRoot, 3469), link);
    expect(
      await executeLocalFileRpc('read', {
        sessionId: 'session_a',
        root: fakeHome,
        cwd: fakeHome,
        path: link,
      })
    ).toMatchObject({ details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } });
  });

  it('denies a write through a symlinked directory that lands in the config root', async () => {
    // Exercises the write-path parent-dir guard specifically: the requested
    // path is not itself inside a config root, only its resolved parent is.
    const linkDir = path.join(fakeHome, 'linkdir');
    fs.symlinkSync(configRoot, linkDir);
    expect(
      await executeLocalFileRpc('write', {
        sessionId: 'session_a',
        root: fakeHome,
        cwd: fakeHome,
        path: path.join(linkDir, 'planted-through-link.json'),
        mode: 'create',
        contentBase64: Buffer.from('{}').toString('base64'),
      })
    ).toMatchObject({ details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } });
    expect(
      fs.existsSync(path.join(configRoot, 'planted-through-link.json'))
    ).toBe(false);
  });

  it('protects the pinned config file and its credential siblings, but not the whole directory', async () => {
    // A `RELAY_IDE_CONFIG` directory may also be a repo checkout (#961 tells
    // operators to pin `<repo>/config.dev.json`), so denying it wholesale would
    // break every legitimate read there. Only the config file, the credential
    // files beside it, and the port-keyed local tokens are protected.
    const pinnedDir = path.join(fakeHome, 'srv-relay');
    fs.mkdirSync(pinnedDir, { recursive: true });
    for (const name of [
      'config.json',
      'actor-token.json',
      'node-credential.json',
      'node-identity-key.json',
      'local-actor-token-3469.json',
      'src.ts',
    ]) {
      fs.writeFileSync(path.join(pinnedDir, name), 'x', { mode: 0o600 });
    }
    const previousPinned = process.env['RELAY_IDE_CONFIG'];
    process.env['RELAY_IDE_CONFIG'] = path.join(pinnedDir, 'config.json');
    try {
      for (const name of [
        'config.json',
        'actor-token.json',
        'node-credential.json',
        'node-identity-key.json',
        'local-actor-token-3469.json',
      ]) {
        expect(
          await executeLocalFileRpc('read', {
            sessionId: 'session_a',
            root: fakeHome,
            cwd: fakeHome,
            path: path.join(pinnedDir, name),
          })
        ).toMatchObject({ details: { reasonCode: 'FILE_RPC_PROTECTED_PATH' } });
      }
      // Ordinary files in that same directory stay readable.
      expect(
        await executeLocalFileRpc('read', {
          sessionId: 'session_a',
          root: fakeHome,
          cwd: fakeHome,
          path: path.join(pinnedDir, 'src.ts'),
        })
      ).toMatchObject({ content: 'x' });
    } finally {
      if (previousPinned === undefined) delete process.env['RELAY_IDE_CONFIG'];
      else process.env['RELAY_IDE_CONFIG'] = previousPinned;
    }

    // With the var unset the config file is an ordinary readable path, so the
    // denials above came from the pin and not from something incidental.
    expect(
      await executeLocalFileRpc('read', {
        sessionId: 'session_a',
        root: fakeHome,
        cwd: fakeHome,
        path: path.join(pinnedDir, 'config.json'),
      })
    ).toMatchObject({ content: 'x' });
  });

  it('stops a tail --follow whose file is swapped for a link into the config root', async () => {
    // The follow loop keeps reading a path validated once at request time.
    // Swapping the file for a symlink into the config root must not stream the
    // token out through fs.tail.chunk.
    const bait = path.join(fakeHome, 'bait.log');
    fs.writeFileSync(bait, 'line one\n');
    const chunks: unknown[] = [];
    const errors: Array<{ details?: Record<string, unknown> }> = [];
    const follower = createFileRpcFollower({
      request: { path: bait, maxFollowChunkBytes: 65536 },
      startOffset: 0,
      write: (chunk) => {
        chunks.push(chunk);
      },
      onError: (error) => {
        errors.push(error as { details?: Record<string, unknown> });
      },
      pollIntervalMs: 5,
    });
    fs.rmSync(bait);
    fs.symlinkSync(localHubActorTokenPath(configRoot, 3469), bait);
    await new Promise((resolve) => setTimeout(resolve, 120));
    follower.close();
    expect(errors[0]?.details?.['reasonCode']).toBe('FILE_RPC_PROTECTED_PATH');
    expect(JSON.stringify(chunks)).not.toContain('relay-sac-v1');
  });

  it('still serves ordinary files inside the same session root', async () => {
    const ordinary = path.join(fakeHome, 'notes.txt');
    fs.writeFileSync(ordinary, 'hello\n');
    const response = await executeLocalFileRpc('read', {
      sessionId: 'session_a',
      root: fakeHome,
      cwd: fakeHome,
      path: ordinary,
    });
    expect(response).toMatchObject({ content: 'hello\n', bytesRead: 6 });
  });
});
