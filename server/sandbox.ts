import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import getPort, { portNumbers } from 'get-port';
import type { ChildProcess } from 'node:child_process';

export interface SandboxOptions {
  port?: number | undefined;
  workspacePath?: string | undefined;
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

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGTERM');
  const exited = await waitForExit(child, 500);

  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 500);
  }
}

async function syncFrontendBuild(packageRoot: string): Promise<void> {
  const worktreeFrontend = path.join(packageRoot, 'dist', 'frontend');
  if (fs.existsSync(path.join(worktreeFrontend, 'index.html'))) return;

  // Try to locate the main repo's frontend build for bootstrapping
  const mainRepoRoot = packageRoot.replace(/\.worktrees[/\\][^/\\]+$/, '');
  if (mainRepoRoot === packageRoot) return; // already the main repo

  const mainFrontend = path.join(mainRepoRoot, 'dist', 'frontend');
  if (!fs.existsSync(path.join(mainFrontend, 'index.html'))) return;

  fs.mkdirSync(worktreeFrontend, { recursive: true });

  // Copy recursively (lightweight — frontend builds are ~1-2MB)
  const entries = fs.readdirSync(mainFrontend, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(mainFrontend, entry.name);
    const dest = path.join(worktreeFrontend, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[sandbox] Bootstrapped frontend build from ${mainFrontend}`);
}

export async function startSandbox(
  options: SandboxOptions = {}
): Promise<SandboxInstance> {
  const uuid = crypto.randomUUID();
  const dataDir = path.join(os.tmpdir(), `relay-ide-sandbox-${uuid}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const port = options.port ?? await findFreePort();
  const workspacePath = options.workspacePath ?? process.cwd();

  const config = {
    host: '127.0.0.1',
    port,
    repos: [workspacePath],
  };

  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const moduleDir = import.meta.dirname;
  const packageRoot =
    path.basename(path.dirname(moduleDir)) === 'dist'
      ? path.resolve(moduleDir, '..', '..')
      : path.resolve(moduleDir, '..');
  const serverEntry = path.resolve(packageRoot, 'dist', 'server', 'index.js');

  // Bootstrap frontend build from main repo if this is a worktree without one
  syncFrontendBuild(packageRoot);

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
    await terminateChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`Sandbox server did not start within ${timeoutMs}ms`);
  }

  const teardown = async (): Promise<void> => {
    await terminateChild(child);
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
