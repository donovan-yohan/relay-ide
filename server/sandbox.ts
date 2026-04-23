import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import getPort, { portNumbers } from 'get-port';
import type { ChildProcess } from 'node:child_process';

export interface SandboxOptions {
  port?: number | undefined;
  workspacePath?: string | undefined;
  noBuild?: boolean | undefined;
}

export interface SandboxInstance {
  url: string;
  port: number;
  configPath: string;
  dataDir: string;
  process: ChildProcess;
  teardown: () => Promise<void>;
}

export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred !== undefined) {
    const allocated = await getPort({ port: preferred });
    if (allocated === preferred) return allocated;
  }
  return getPort({ port: portNumbers(3456, 3556) });
}

export async function startSandbox(
  options: SandboxOptions = {}
): Promise<SandboxInstance> {
  const uuid = crypto.randomUUID();
  const dataDir = path.join('/tmp', `relay-ide-sandbox-${uuid}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await findFreePort(options.port);
  const workspacePath = options.workspacePath ?? process.cwd();

  const config = {
    host: '127.0.0.1',
    port,
    repos: [workspacePath],
  };

  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const serverEntry = path.resolve(
    import.meta.dirname,
    '..',
    'dist',
    'server',
    'index.js'
  );
  const packageRoot = path.resolve(import.meta.dirname, '..', '..');

  const child = spawn('node', [serverEntry], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RELAY_IDE_CONFIG: configPath,
      NO_PIN: '1',
    },
    stdio: 'inherit',
    detached: false,
  });

  const url = `http://127.0.0.1:${port}`;
  const startTime = Date.now();
  const timeoutMs = 30_000;
  const pollIntervalMs = 200;

  let ready = false;
  while (!ready && Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // Server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (!ready) {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!child.killed) {
      child.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`Sandbox server did not start within ${timeoutMs}ms`);
  }

  const teardown = async (): Promise<void> => {
    if (!child.killed) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return {
    url,
    port,
    configPath,
    dataDir,
    process: child,
    teardown,
  };
}
