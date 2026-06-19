import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  home: string;
};

const servers: http.Server[] = [];

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function fakeHub(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake hub did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-pair-cli-'));
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/bin/relay-ide.js', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        RELAY_IDE_NODE_PAIR_POLL_INTERVAL_MS: '100',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, 7_500);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, home });
    });
  });
}

function baseRequest(state: 'pending' | 'approved' | 'denied' | 'expired' = 'pending') {
  return {
    requestId: 'req-1',
    deviceCode: 'ABCD-EFGH',
    displayName: 'test-node',
    requestedProfile: 'dev-workstation',
    state,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function expectNoSecrets(output: string): void {
  expect(output).not.toContain('pstat_SUPER_SECRET');
  expect(output).not.toContain('pair_SUPER_SECRET');
  expect(output).not.toContain('node_SECRET_TOKEN');
  expect(output).not.toContain('user:pass');
  expect(output).not.toContain('apiToken=shhh');
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('relay-ide node pair CLI device-code pairing', () => {
  it('waits pending -> approved, heartbeats, stores credential 0600, and does not leak tokens in JSON output', async () => {
    let polls = 0;
    let heartbeatAuthorization: string | undefined;
    const hub = await fakeHub((req, res) => {
      if (req.method === 'POST' && req.url === '/hub/pairing/requests') {
        json(res, 200, { request: baseRequest('pending'), statusToken: 'pstat_SUPER_SECRET' });
        return;
      }
      if (req.method === 'POST' && req.url === '/hub/pairing/requests/req-1/status') {
        polls += 1;
        json(res, 200, {
          request: baseRequest(polls === 1 ? 'pending' : 'approved'),
          ...(polls > 1
            ? {
                credential: {
                  token: 'node_SECRET_TOKEN',
                  nodeId: 'node-1',
                  credentialId: 'cred-1',
                  publicKeyFingerprint: 'fp-1',
                },
                node: { displayName: 'approved-node' },
              }
            : {}),
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/hub/node-heartbeat') {
        heartbeatAuthorization = req.headers.authorization;
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: 'not found' });
    });

    const result = await runCli(['node', 'pair', hub.url, '--json']);
    expect(result.code).toBe(0);
    expect(heartbeatAuthorization).toBe('Bearer node_SECRET_TOKEN');
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('"event":"pairing-requested"');
    expect(output).toContain('"event":"paired"');
    expectNoSecrets(output);
    const credentialPath = path.join(result.home, '.config', 'relay-ide', 'node-credential.json');
    expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8'))).toMatchObject({ nodeId: 'node-1', credentialId: 'cred-1' });
    expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
  });

  it('treats denied as a terminal state without leaking the status token', async () => {
    const hub = await fakeHub((req, res) => {
      if (req.url === '/hub/pairing/requests') json(res, 200, { request: baseRequest('pending'), statusToken: 'pstat_SUPER_SECRET' });
      else if (req.url === '/hub/pairing/requests/req-1/status') json(res, 200, { request: baseRequest('denied') });
      else json(res, 404, {});
    });
    const result = await runCli(['node', 'pair', hub.url, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('PAIRING_DENIED');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  it('treats expired as a terminal state', async () => {
    const hub = await fakeHub((req, res) => {
      if (req.url === '/hub/pairing/requests') json(res, 200, { request: baseRequest('pending'), statusToken: 'pstat_SUPER_SECRET' });
      else if (req.url === '/hub/pairing/requests/req-1/status') json(res, 200, { request: baseRequest('expired') });
      else json(res, 404, {});
    });
    const result = await runCli(['node', 'pair', hub.url, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('PAIRING_EXPIRED');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  it('fails fast on malformed terminal status responses', async () => {
    const hub = await fakeHub((req, res) => {
      if (req.url === '/hub/pairing/requests') json(res, 200, { request: baseRequest('pending'), statusToken: 'pstat_SUPER_SECRET' });
      else if (req.url === '/hub/pairing/requests/req-1/status') {
        res.statusCode = 200;
        res.end('not json');
      } else json(res, 404, {});
    });
    const result = await runCli(['node', 'pair', hub.url, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('MALFORMED_RESPONSE');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  it('retries a dropped status poll and recovers', async () => {
    let polls = 0;
    const hub = await fakeHub((req, res) => {
      if (req.url === '/hub/pairing/requests') {
        json(res, 200, { request: baseRequest('pending'), statusToken: 'pstat_SUPER_SECRET' });
        return;
      }
      if (req.url === '/hub/pairing/requests/req-1/status') {
        polls += 1;
        if (polls === 1) {
          req.socket.destroy();
          return;
        }
        json(res, 200, {
          request: baseRequest('approved'),
          credential: { token: 'node_SECRET_TOKEN', nodeId: 'node-1', credentialId: 'cred-1' },
        });
        return;
      }
      if (req.url === '/hub/node-heartbeat') {
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, {});
    });
    const result = await runCli(['node', 'pair', hub.url, '--json']);
    expect(result.code).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(2);
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  it('fails fast when approved lacks a valid credential payload', async () => {
    const hub = await fakeHub((req, res) => {
      if (req.url === '/hub/pairing/requests') json(res, 200, { request: baseRequest('pending'), statusToken: 'pstat_SUPER_SECRET' });
      else if (req.url === '/hub/pairing/requests/req-1/status') json(res, 200, { request: baseRequest('approved') });
      else json(res, 404, {});
    });
    const result = await runCli(['node', 'pair', hub.url, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('PAIRING_PROTOCOL_ERROR');
    expect(result.stdout).toContain('approved pairing without a valid node credential');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  it('rejects userinfo hub URLs before request construction and redacts credentials/query secrets', async () => {
    const result = await runCli(['node', 'pair', 'http://user:pass@127.0.0.1:9/?apiToken=shhh', '--json']);
    expect(result.code).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('INVALID_HUB_URL');
    expectNoSecrets(output);
  });

  it('keeps legacy --pair-token routing on the exchange endpoint without leaking the pair token', async () => {
    let sawDeviceRequest = false;
    let sawExchange = false;
    const hub = await fakeHub((req, res) => {
      if (req.url === '/hub/pairing/requests') {
        sawDeviceRequest = true;
        json(res, 500, {});
        return;
      }
      if (req.method === 'POST' && req.url === '/hub/pairing/exchange') {
        sawExchange = true;
        json(res, 200, {
          credential: { token: 'node_SECRET_TOKEN', nodeId: 'node-legacy', credentialId: 'cred-legacy' },
          node: { displayName: 'legacy-node' },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/hub/node-heartbeat') {
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, {});
    });
    const result = await runCli(['node', 'pair', '--hub', hub.url, '--pair-token', 'pair_SUPER_SECRET']);
    expect(result.code).toBe(0);
    expect(sawExchange).toBe(true);
    expect(sawDeviceRequest).toBe(false);
    expectNoSecrets(`${result.stdout}${result.stderr}`);
    const credentialPath = path.join(result.home, '.config', 'relay-ide', 'node-credential.json');
    expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
  });
});
