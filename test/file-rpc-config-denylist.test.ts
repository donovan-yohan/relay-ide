import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
