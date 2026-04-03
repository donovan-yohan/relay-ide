import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('server starts without PIN in non-TTY mode and serves /auth/status', async () => {
  // Create a temporary config with no pinHash
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 0, host: '127.0.0.1' }));

  const serverScript = path.resolve(
    import.meta.dirname,
    '..',
    'server',
    'index.js'
  );

  // Spawn server as a non-TTY child process (pipe = no TTY)
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      NO_PIN: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    // Wait for the server to print the listening port
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server did not start within 10s'));
      }, 10_000);
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        const match = text.match(/listening on [\w.]+:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}. stderr: ${stderr}`));
      });
    });

    // Hit GET /auth/status — should work without auth
    const res = await fetch(`http://127.0.0.1:${port}/auth/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasPIN: boolean };
    expect(body.hasPIN).toBe(false);
  } finally {
    child.kill('SIGTERM');
    // Wait for the child to fully exit before cleaning up temp files.
    // Without this, SQLite WAL/SHM files may still be open, causing ENOTEMPTY.
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
