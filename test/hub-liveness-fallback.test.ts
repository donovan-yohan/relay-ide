import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub } from '../server/hub-lock.js';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-liveness-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('hub liveness fallback when hub.lock missing (#1587)', () => {
  it('refuses when /health answers on configured port', async () => {
    const configDir = makeTmpDir();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    const port = addr.port;

    try {
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ port, host: '127.0.0.1' }),
        'utf8'
      );
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          timeoutMs: 500,
        })
      ).rejects.toThrow(/no hub\.lock present/);
    } finally {
      server.close();
    }
  });

  it('treats a stale hub.lock as absent and still probes /health', async () => {
    const configDir = makeTmpDir();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    const port = addr.port;

    try {
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ port, host: '127.0.0.1' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(configDir, 'hub.lock'),
        JSON.stringify(
          {
            pid: 999_999,
            port,
            host: '127.0.0.1',
            startedAt: new Date().toISOString(),
            hostname: os.hostname(),
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          timeoutMs: 500,
        })
      ).rejects.toThrow(/stale hub\.lock \(pid=/);
    } finally {
      server.close();
    }
  });

  it('skips the /health probe when a live hub.lock exists (refuses by lock)', async () => {
    const configDir = makeTmpDir();
    const sleeper: ChildProcess = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1_000_000)',
    ]);
    try {
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ port: 3456, host: '127.0.0.1' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(configDir, 'hub.lock'),
        JSON.stringify(
          {
            pid: sleeper.pid,
            port: 3456,
            host: '127.0.0.1',
            startedAt: new Date().toISOString(),
            hostname: os.hostname(),
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          timeoutMs: 500,
        })
      ).rejects.toThrow(/hub\.lock/);
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('refuses when a hub.lock from another hostname exists (sync guard blocks)', async () => {
    const configDir = makeTmpDir();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    const port = addr.port;
    try {
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ port }), 'utf8');
      // Foreign hostname: should not be trusted as "owned", so /health decides.
      fs.writeFileSync(
        path.join(configDir, 'hub.lock'),
        JSON.stringify(
          {
            pid: 12345,
            port,
            host: '127.0.0.1',
            startedAt: new Date().toISOString(),
            hostname: 'some-other-host',
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          timeoutMs: 500,
        })
      ).rejects.toThrow(/hub\.lock/);
    } finally {
      server.close();
    }
  });

  it('passes when no hub.lock exists and no /health listener answers', async () => {
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');
    // Use a port that's very unlikely to be in use in CI.
    fs.writeFileSync(configPath, JSON.stringify({ port: 54321 }), 'utf8');
    await expect(
      assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
        configPath,
        timeoutMs: 200,
      })
    ).resolves.toBeUndefined();
  });

  it('uses fallbackPort when config.json is missing', async () => {
    const configDir = makeTmpDir();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    const port = addr.port;
    try {
      const missingConfigPath = path.join(configDir, 'config.json');
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath: missingConfigPath,
          fallbackPort: port,
          timeoutMs: 500,
        })
      ).rejects.toThrow(/hub is listening on/);
    } finally {
      server.close();
    }
  });

  it('does not refuse on an unrelated listener when fallbackPort points elsewhere', async () => {
    const configDir = makeTmpDir();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    try {
      const missingConfigPath = path.join(configDir, 'config.json');
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath: missingConfigPath,
          fallbackPort: addr.port + 1,
          timeoutMs: 200,
        })
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('times out the /health probe after 500ms and does not hang', async () => {
    const configDir = makeTmpDir();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        // Accept the request and then never respond.
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    const port = addr.port;
    const configPath = path.join(configDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ port }), 'utf8');
    const start = Date.now();
    try {
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          timeoutMs: 500,
        })
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('prefers fallbackPort over config.json when provided (flag/env > config)', async () => {
    const configDir = makeTmpDir();

    const answering = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      answering.listen(0, '127.0.0.1', resolve)
    );
    const addr = answering.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    const listenerPort = addr.port;

    // Config says "probe this other port that has no listener".
    const configPath = path.join(configDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ port: listenerPort + 1, host: '127.0.0.1' }),
      'utf8'
    );

    try {
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          fallbackPort: listenerPort,
          timeoutMs: 200,
        })
      ).rejects.toThrow(/hub is listening on/);
    } finally {
      answering.close();
    }
  });

  it('uses fallbackPort when config.json exists but has no numeric port', async () => {
    const configDir = makeTmpDir();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    const port = addr.port;
    try {
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          fallbackPort: port,
          timeoutMs: 200,
        })
      ).rejects.toThrow(/hub is listening on/);
    } finally {
      server.close();
    }
  });

  it('probes using the explicit config.json path even when it is outside the default dir', async () => {
    const outside = makeTmpDir();
    const configDir = makeTmpDir();
    const configPath = path.join(outside, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ port: 54321 }), 'utf8');

    // Listener elsewhere must not matter when the explicit config points elsewhere
    // AND no override port is provided.
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected tcp addr');
    try {
      await expect(
        assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(configDir, {
          configPath,
          timeoutMs: 200,
        })
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });
});
