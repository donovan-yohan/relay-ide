import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI = new URL('../dist/bin/relay-ide.js', import.meta.url);

test('operator-client CLI issues once and revokes through the grant-backed API', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/operator-client-credentials') {
        res.end(
          JSON.stringify({
            token: 'relay-occ-v1.credential-id.raw-token',
            credential: { id: 'credential-id', principal: { kind: 'human' } },
          })
        );
        return;
      }
      res.end(
        JSON.stringify({
          credential: { id: 'credential-id', revokedAt: 'now' },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('server unavailable');
  const hub = `http://127.0.0.1:${address.port}`;

  try {
    const issue = await execFileAsync(process.execPath, [
      CLI.pathname,
      'operator-client',
      'issue',
      '--hub',
      hub,
      '--operator-grant',
      'relay-ohg-v1.grant-id.grant-secret',
      '--client-id',
      'desktop-plugin',
      '--channel-id',
      'topic:operator',
    ]);
    expect(issue.stdout.trim()).toBe('relay-occ-v1.credential-id.raw-token');
    expect(requests[0]).toMatchObject({
      url: '/operator-client-credentials',
      body: {
        grantHandle: 'relay-ohg-v1.grant-id.grant-secret',
        client: { id: 'desktop-plugin' },
        capabilities: ['context:read', 'context:write'],
        scope: { channelIds: ['topic:operator'] },
      },
    });

    const revoke = await execFileAsync(process.execPath, [
      CLI.pathname,
      'operator-client',
      'revoke',
      '--hub',
      hub,
      '--operator-grant',
      'relay-ohg-v1.revoke-grant.revoke-secret',
      '--credential-id',
      'credential-id',
      '--client-id',
      'desktop-plugin',
      '--json',
    ]);
    expect(revoke.stdout).toContain('revokedAt');
    expect(revoke.stdout).not.toContain('raw-token');
    expect(requests[1]).toMatchObject({
      url: '/operator-client-credentials/credential-id/revoke',
      body: {
        grantHandle: 'relay-ohg-v1.revoke-grant.revoke-secret',
        client: { id: 'desktop-plugin' },
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
