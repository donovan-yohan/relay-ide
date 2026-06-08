import { afterEach, beforeAll, expect, test } from 'vitest';
import * as http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const RELAY_IDE_BIN = path.resolve('dist/bin/relay-ide.js');
const tempRoots: string[] = [];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Relay Test',
  GIT_AUTHOR_EMAIL: 'relay-test@example.invalid',
  GIT_COMMITTER_NAME: 'Relay Test',
  GIT_COMMITTER_EMAIL: 'relay-test@example.invalid',
};

type CapturedRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  capabilities?: string | string[];
  body?: Record<string, unknown>;
};

function mkTempRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`));
  tempRoots.push(root);
  return root;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function createCleanRepo(branchName: string): string {
  const repo = path.join(mkTempRoot('workflow-repo'), 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', branchName, repo], { env: GIT_ENV, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), '# workflow fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial fixture']);
  return repo;
}

function findOnPath(command: string): string {
  for (const segment of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!segment) continue;
    const candidate = path.join(segment, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${command} not found on PATH`);
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runRelay(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RELAY_IDE_BIN, ...args],
      { env, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode = (error as NodeJS.ErrnoException | null)?.code;
        const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

function workflowArgs(command: 'branches open-session' | 'tickets start-work', input: unknown): string[] {
  return [
    'v1',
    ...command.split(' '),
    '--input-json',
    JSON.stringify(input),
    '--json',
  ];
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build:server'], {
    cwd: path.resolve('.'),
    env: process.env,
    stdio: 'inherit',
  });
}, 60_000);

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('branches.openSession delegates to /sessions with resolved repo/worktree and no explicit cwd', async () => {
  const repo = createCleanRepo('desired-branch');
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const entry: CapturedRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        capabilities: req.headers['x-relay-capabilities'],
        ...(rawBody ? { body: JSON.parse(rawBody) as Record<string, unknown> } : {}),
      };
      captured.push(entry);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/sessions') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: 'session-workflow-1',
            type: 'terminal',
            mode: 'pty',
            cwd: repo,
            workContextId: 'wc-workflow-1',
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
  });

  const port = await listen(server);
  try {
    const result = await runRelay(
      workflowArgs('branches open-session', {
        repo: { repoPath: repo },
        branch: { name: 'desired-branch' },
        worktree: { mode: 'reuse-existing', worktreePath: repo },
        session: { type: 'terminal', mode: 'pty', terminalBackend: 'relay-pty' },
        prompt: { mode: 'initial-prompt', prompt: 'continue the workflow' },
      }),
      {
        ...process.env,
        RELAY_IDE_PORT: String(port),
        RELAY_IDE_BROWSER_TOKEN: 'browser-token',
      }
    );

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope).toMatchObject({ ok: true, command: 'branches.openSession' });
  } finally {
    await close(server);
  }

  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({
    method: 'POST',
    url: '/sessions',
    authorization: 'Bearer browser-token',
    capabilities: 'session:create:terminal',
  });
  expect(captured[0].body).toMatchObject({
    repoPath: repo,
    worktreePath: repo,
    branchName: 'desired-branch',
    type: 'terminal',
    mode: 'pty',
    terminalBackend: 'relay-pty',
    initialPrompt: 'continue the workflow',
  });
  expect(captured[0].body).not.toHaveProperty('cwd');
});

test('explicit worktree path checked out on a different branch fails before session creation', async () => {
  const repo = createCleanRepo('existing-other');
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    captured.push({ method: req.method, url: req.url });
    res.statusCode = 500;
    res.end('session creation should not be reached');
  });

  const port = await listen(server);
  try {
    const result = await runRelay(
      workflowArgs('branches open-session', {
        repo: { repoPath: repo },
        branch: { name: 'desired-branch' },
        worktree: { mode: 'reuse-existing', worktreePath: repo },
        session: { type: 'terminal', mode: 'pty' },
      }),
      {
        ...process.env,
        RELAY_IDE_PORT: String(port),
        RELAY_IDE_BROWSER_TOKEN: 'browser-token',
      }
    );

    expect(result.code).toBe(1);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      command: 'branches.openSession',
      error: {
        code: 'SESSION_CONFLICT',
        details: {
          reasonCode: 'WORKTREE_BRANCH_MISMATCH',
          worktreePath: repo,
          branchName: 'desired-branch',
          actualBranchName: 'existing-other',
        },
      },
    });
  } finally {
    await close(server);
  }

  expect(captured).toHaveLength(0);
});

test('missing gh CLI while resolving pr.number returns a typed GH_CLI_MISSING error', async () => {
  const repo = createCleanRepo('main');
  const binDir = path.join(mkTempRoot('workflow-path'), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(findOnPath('git'), path.join(binDir, 'git'));

  const result = await runRelay(
    workflowArgs('branches open-session', {
      repo: { repoPath: repo },
      pr: { number: 879 },
      worktree: { mode: 'reuse-existing' },
      session: { type: 'terminal', mode: 'pty' },
    }),
    {
      ...process.env,
      PATH: binDir,
      RELAY_IDE_BROWSER_TOKEN: 'browser-token',
      RELAY_IDE_PORT: '9',
    }
  );

  expect(result.code).toBe(1);
  const envelope = parseEnvelope(result.stdout);
  expect(envelope).toMatchObject({
    ok: false,
    command: 'branches.openSession',
    error: {
      code: 'UPSTREAM_ERROR',
      details: {
        reasonCode: 'GH_CLI_MISSING',
        command: 'gh',
        prNumber: 879,
      },
    },
  });
});

test('pr.number create-if-missing fetches the PR head instead of creating from base', async () => {
  const repo = createCleanRepo('main');
  const origin = path.join(mkTempRoot('workflow-origin'), 'origin.git');
  execFileSync('git', ['init', '--bare', origin], { env: GIT_ENV, stdio: 'ignore' });
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', 'origin', 'main']);
  execFileSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']).trim();

  git(repo, ['checkout', '-b', 'temporary-pr-head']);
  fs.writeFileSync(path.join(repo, 'PR.md'), '# actual PR head\n');
  git(repo, ['add', 'PR.md']);
  git(repo, ['commit', '-m', 'actual pr head']);
  const prHeadSha = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['push', 'origin', 'HEAD:refs/pull/879/head']);
  git(repo, ['checkout', 'main']);
  git(repo, ['branch', '-D', 'temporary-pr-head']);

  const binDir = path.join(mkTempRoot('workflow-gh'), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(
      JSON.stringify({
        headRefName: 'feature-from-fork',
        headRefOid: prHeadSha,
        baseRefName: 'main',
        url: 'https://github.com/donovan-yohan/relay-ide/pull/879',
        title: 'fixture PR',
        number: 879,
      })
    )});\n`
  );
  fs.chmodSync(ghPath, 0o755);

  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      captured.push({
        method: req.method,
        url: req.url,
        ...(rawBody ? { body: JSON.parse(rawBody) as Record<string, unknown> } : {}),
      });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/sessions') {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 'session-pr-head', type: 'terminal', mode: 'pty' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
  });

  const port = await listen(server);
  try {
    const result = await runRelay(
      workflowArgs('branches open-session', {
        repo: { repoPath: repo },
        pr: { number: 879 },
        worktree: { mode: 'create-if-missing' },
        session: { type: 'terminal', mode: 'pty' },
      }),
      {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        RELAY_IDE_BROWSER_TOKEN: 'browser-token',
        RELAY_IDE_PORT: String(port),
      }
    );

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope).toMatchObject({ ok: true, command: 'branches.openSession' });
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toMatchObject({
      branchName: 'feature-from-fork',
      type: 'terminal',
      mode: 'pty',
    });
    const worktreePath = captured[0].body?.worktreePath as string;
    expect(git(worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(prHeadSha);
    expect(git(worktreePath, ['rev-parse', 'HEAD']).trim()).not.toBe(baseSha);
  } finally {
    await close(server);
  }
});

test('tickets.startWork validates ticket.source and ticket.id before session creation', async () => {
  const repo = createCleanRepo('main');
  const result = await runRelay(
    workflowArgs('tickets start-work', {
      ticket: { source: 'github' },
      repo: { repoPath: repo },
      branch: { name: 'main' },
      worktree: { mode: 'reuse-existing', worktreePath: repo },
      session: { type: 'terminal', mode: 'pty' },
    }),
    {
      ...process.env,
      RELAY_IDE_BROWSER_TOKEN: 'browser-token',
      RELAY_IDE_PORT: '9',
    }
  );

  expect(result.code).toBe(1);
  const envelope = parseEnvelope(result.stdout);
  expect(envelope).toMatchObject({
    ok: false,
    command: 'tickets.startWork',
    error: {
      code: 'INVALID_ARGUMENT',
      details: { field: 'id' },
    },
  });
});
