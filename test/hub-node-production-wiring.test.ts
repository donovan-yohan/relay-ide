import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../server/types.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import type { RelayNodeEnvelope } from '../shared/relay-node-protocol.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../shared/relay-node-protocol.js';
import { hashPin } from '../server/auth.js';
import { mintPairTokenWithOperatorGrantForTest } from './helpers/operator-pairing.js';

function manifest(): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'production-wiring-node',
    relayVersion: '0.1.0-test',
    generatedAt: '2026-01-02T03:04:05.000Z',
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'systemd-user',
      label: 'systemd user',
      supported: true,
      installable: true,
      installHint: 'install',
      uninstallHint: 'uninstall',
      message: 'ok',
      caveats: [],
    },
    capabilities: {
      terminalBackends: {
        'relay-pty': {
          id: 'relay-pty',
          label: 'Relay PTY',
          status: 'available',
          message: 'ok',
        },
      },
      git: { id: 'git', label: 'Git', status: 'available', message: 'ok' },
      clipboard: {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'unknown',
        message: 'unknown',
      },
      browserAutomation: {
        id: 'browserAutomation',
        label: 'Browser automation',
        status: 'degraded',
        message: 'missing deps',
      },
      githubCli: {
        id: 'githubCli',
        label: 'GitHub CLI',
        status: 'available',
        message: 'ok',
      },
      tailscale: {
        id: 'tailscale',
        label: 'Tailscale CLI',
        status: 'unavailable',
        message: 'missing',
      },
      ssh: {
        id: 'ssh',
        label: 'SSH client',
        status: 'available',
        message: 'ok',
      },
      agents: {
        claude: {
          id: 'claude',
          label: 'Claude',
          status: 'available',
          message: 'ok',
        },
      },
    },
  };
}

function remoteSession(nodeId: string): SessionSummary {
  return {
    id: 'remote-session-1',
    type: 'terminal',
    agent: 'claude',
    mode: 'pty',
    repoPath: '/srv/relay-ide',
    worktreePath: null,
    cwd: '/srv/relay-ide',
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: 'relay-ide terminal',
    createdAt: '2026-01-02T03:04:05.000Z',
    lastActivity: '2026-01-02T03:04:05.000Z',
    idle: false,
    customCommand: null,
    nodeId,
    globalSessionId: `${nodeId}:remote-session-1`,
    repoInstanceId: `${nodeId}:%2Fsrv%2Frelay-ide`,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
  };
}

async function waitForServer(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('server did not start within 10s'));
    }, 10_000);
    let settled = false;
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/listening on [\w.]+:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`server exited with code ${code}. stderr: ${stderr}`));
    });
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function nextJson(ws: WebSocket): Promise<RelayNodeEnvelope> {
  return await new Promise<RelayNodeEnvelope>((resolve) => {
    ws.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as RelayNodeEnvelope)
    );
  });
}

describe('production hub node link wiring', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('uses one HubNodeLinkManager for production hub routes and routed PTY websocket upgrades', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-production-node-links-')
    );
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const configPath = path.join(tmpDir, 'config.json');
    const pin = '123456';
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        port: 0,
        host: '127.0.0.1',
        pinHash: await hashPin(pin),
      })
    );

    const serverScript = path.resolve(
      import.meta.dirname,
      '..',
      'dist',
      'server',
      'index.js'
    );
    const child = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        RELAY_IDE_CONFIG: configPath,
        RELAY_IDE_PORT: '0',
        RELAY_IDE_DEV_INSTANCE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanup.push(async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    });

    const port = await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;

    const loginRes = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    expect(loginRes.status).toBe(200);
    const authCookie = loginRes.headers.get('set-cookie') ?? '';
    expect(authCookie).toContain('token=');

    const pair = await mintPairTokenWithOperatorGrantForTest(base, {
      displayName: 'Remote Node',
      authCookie,
    });

    const exchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: pair.pairToken, manifest: manifest() }),
    });
    expect(exchangeRes.status).toBe(201);
    const exchange = (await exchangeRes.json()) as {
      credential: { token: string; nodeId: string };
    };
    const { token, nodeId } = exchange.credential;

    const heartbeatRes = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        nodeId,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        manifest: manifest(),
      }),
    });
    expect(heartbeatRes.status).toBe(200);

    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, [], {
      headers: { Authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: authCookie },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'sessions.create',
    });
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(nodeId),
            nodeId: undefined,
            globalSessionId: undefined,
          },
        },
      })
    );

    const createRes = await createPromise;
    expect(createRes.status).toBe(201);
    await expect(createRes.json()).resolves.toMatchObject({
      id: 'remote-session-1',
      nodeId,
      globalSessionId: `${nodeId}:remote-session-1`,
    });

    const browserWs = new WebSocket(
      `${wsBase}/nodes/${encodeURIComponent(nodeId)}/ws/sessions/remote-session-1`,
      [],
      { headers: { Cookie: authCookie } }
    );
    cleanup.push(() => browserWs.close());
    await waitForOpen(browserWs);

    await expect(nextJson(nodeWs)).resolves.toMatchObject({
      nodeId,
      channel: 'pty',
      type: 'pty.attach',
      payload: { sessionId: 'remote-session-1' },
    });
  });
});
