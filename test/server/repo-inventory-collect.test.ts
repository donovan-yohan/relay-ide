import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collectLocalRepoInventory,
  resetSharedRepoScanGate,
} from '../../server/repo-inventory.js';
import type { Config } from '../../server/types.js';

let root: string;
let repoPaths: string[];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repo-inventory-'));
  repoPaths = Array.from({ length: 12 }, (_, index) => {
    const repoPath = path.join(root, `repo-${index}`);
    fs.mkdirSync(repoPath, { recursive: true });
    return repoPath;
  });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface ExecCall {
  file: string;
  args: string[];
  cwd: string;
}

interface FakeExecOptions {
  delayMs?: number;
  /** Repo paths whose git calls should reject. */
  failing?: (repoPath: string) => Error | null;
}

function createFakeExec(options: FakeExecOptions = {}): {
  exec: (
    file: string,
    args: string[],
    opts: { cwd: string; timeout?: number }
  ) => Promise<{ stdout: string; stderr: string }>;
  calls: ExecCall[];
  peak: () => number;
} {
  const calls: ExecCall[] = [];
  let active = 0;
  let peak = 0;

  async function exec(
    file: string,
    args: string[],
    opts: { cwd: string; timeout?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    calls.push({ file, args: [...args], cwd: opts.cwd });
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      } else {
        await Promise.resolve();
      }
      const failure = options.failing?.(opts.cwd);
      if (failure) throw failure;
      return { stdout: stdoutFor(args, opts.cwd), stderr: '' };
    } finally {
      active -= 1;
    }
  }

  return { exec, calls, peak: () => peak };
}

function stdoutFor(args: string[], cwd: string): string {
  const key = args.join(' ');
  if (key === 'rev-parse --git-dir') return '.git\n';
  if (key === 'symbolic-ref refs/remotes/origin/HEAD --short') {
    return 'origin/main\n';
  }
  if (key === 'symbolic-ref --short HEAD') return 'feature/x\n';
  if (key === 'remote -v') {
    const name = path.basename(cwd);
    return [
      `origin\tgit@github.com:acme/${name}.git (fetch)`,
      `origin\tgit@github.com:acme/${name}.git (push)`,
      '',
    ].join('\n');
  }
  if (key === 'status --porcelain') return ' M server/a.ts\n?? notes.md\n';
  if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
    return 'origin/main\n';
  }
  if (key === 'rev-parse HEAD') return 'abc123\n';
  if (key.startsWith('rev-list')) return '1\t2\n';
  if (key === 'worktree list --porcelain') return '';
  return '';
}

function configFor(paths: string[]): Config {
  return { repos: [...paths] } as unknown as Config;
}

const GIT_SUBCOMMAND = (call: ExecCall): string => call.args.join(' ');

describe('collectLocalRepoInventory', () => {
  it('reports every configured repo in config order', async () => {
    const { exec } = createFakeExec();
    const report = await collectLocalRepoInventory({
      config: configFor(repoPaths),
      configPath: path.join(root, 'config.json'),
      execFileAsync: exec,
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    });

    expect(report.repos.map((repo) => repo.localPath)).toEqual(repoPaths);
    expect(report.generatedAt).toBe('2026-08-29T00:00:00.000Z');
  });

  it('never runs more than `concurrency` git subprocesses at once', async () => {
    const { exec, peak } = createFakeExec({ delayMs: 2 });
    await collectLocalRepoInventory({
      config: configFor(repoPaths),
      configPath: path.join(root, 'config.json'),
      execFileAsync: exec,
      concurrency: 4,
    });

    expect(peak()).toBeLessThanOrEqual(4);
    // The bound is genuinely exercised — a serial scan would peak at 1.
    expect(peak()).toBeGreaterThan(1);
  });

  it('scans repos concurrently rather than one after another', async () => {
    const { exec } = createFakeExec({ delayMs: 5 });
    const started = Date.now();
    await collectLocalRepoInventory({
      config: configFor(repoPaths),
      configPath: path.join(root, 'config.json'),
      execFileAsync: exec,
      concurrency: 8,
    });
    const elapsed = Date.now() - started;
    // 12 repos x >=8 forks x 5 ms serial would be >= 480 ms.
    expect(elapsed).toBeLessThan(300);
  });

  it('full detail keeps dirty, divergence and worktree facts', async () => {
    const { exec, calls } = createFakeExec();
    const report = await collectLocalRepoInventory({
      config: configFor([repoPaths[0]!]),
      configPath: path.join(root, 'config.json'),
      execFileAsync: exec,
      detail: 'full',
    });

    const repo = report.repos[0]!;
    expect(repo.dirty).toMatchObject({ unstagedCount: 1, untrackedCount: 1 });
    expect(repo.divergence).toMatchObject({
      upstreamRef: 'origin/main',
      behindCount: 1,
      aheadCount: 2,
    });
    expect(repo.currentBranch).toBe('feature/x');
    expect(repo.defaultBranch).toBe('main');
    expect(repo.name).toBe(path.basename(repoPaths[0]!));
    const subcommands = calls.map(GIT_SUBCOMMAND);
    expect(subcommands).toContain('status --porcelain');
    expect(subcommands).toContain('worktree list --porcelain');
  });

  it('identity detail skips the working-tree forks it would discard', async () => {
    const { exec, calls } = createFakeExec();
    const report = await collectLocalRepoInventory({
      config: configFor(repoPaths),
      configPath: path.join(root, 'config.json'),
      execFileAsync: exec,
      detail: 'identity',
    });

    const subcommands = calls.map(GIT_SUBCOMMAND);
    expect(subcommands).not.toContain('status --porcelain');
    expect(subcommands).not.toContain('worktree list --porcelain');
    expect(subcommands).not.toContain('rev-parse HEAD');

    // Identity coordinates the /hub/repo-groups projection actually reads
    // survive untouched; the discarded facts come back as graceful absence.
    for (const repo of report.repos) {
      expect(repo.repoIdentity).toContain('github.com/acme/');
      expect(repo.currentBranch).toBe('feature/x');
      expect(repo.defaultBranch).toBe('main');
      expect(repo.selectedRemote?.name).toBe('origin');
      expect(repo.dirty).toBeNull();
      expect(repo.divergence).toBeNull();
      expect(repo.worktrees).toEqual([]);
    }
  });

  it('identity detail costs strictly fewer git forks than full detail', async () => {
    const full = createFakeExec();
    await collectLocalRepoInventory({
      config: configFor(repoPaths),
      configPath: path.join(root, 'config.json'),
      execFileAsync: full.exec,
      detail: 'full',
    });
    const identity = createFakeExec();
    await collectLocalRepoInventory({
      config: configFor(repoPaths),
      configPath: path.join(root, 'config.json'),
      execFileAsync: identity.exec,
      detail: 'identity',
    });

    expect(identity.calls.length).toBeLessThan(full.calls.length);
  });

  it('derives the repo name from the already-fetched remotes, not a second fork', async () => {
    const { exec, calls } = createFakeExec();
    await collectLocalRepoInventory({
      config: configFor([repoPaths[0]!]),
      configPath: path.join(root, 'config.json'),
      execFileAsync: exec,
    });
    expect(calls.map(GIT_SUBCOMMAND)).not.toContain('remote get-url origin');
  });

  it('bounds git forks ACROSS overlapping collections, not just within one', async () => {
    // Cache invalidation under churn can leave a superseded scan running while
    // a fresh one starts. Private per-collection ceilings would multiply; the
    // shared gate must hold the line.
    const previous = process.env.RELAY_REPO_SCAN_CONCURRENCY;
    process.env.RELAY_REPO_SCAN_CONCURRENCY = '3';
    resetSharedRepoScanGate();
    try {
      let active = 0;
      let peak = 0;
      const exec = async (
        _file: string,
        args: string[],
        opts: { cwd: string }
      ): Promise<{ stdout: string; stderr: string }> => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { stdout: stdoutFor(args, opts.cwd), stderr: '' };
      };
      const collect = (): Promise<unknown> =>
        collectLocalRepoInventory({
          config: configFor(repoPaths),
          configPath: path.join(root, 'config.json'),
          execFileAsync: exec,
        });

      await Promise.all([collect(), collect(), collect()]);
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(1);
    } finally {
      if (previous === undefined) delete process.env.RELAY_REPO_SCAN_CONCURRENCY;
      else process.env.RELAY_REPO_SCAN_CONCURRENCY = previous;
      resetSharedRepoScanGate();
    }
  });

  it('surfaces the lowest-index repo failure deterministically', async () => {
    const doomed = new Set([repoPaths[3]!, repoPaths[9]!]);
    const { exec } = createFakeExec({
      delayMs: 1,
      failing: (cwd) => {
        if (!doomed.has(cwd)) return null;
        const error = new Error(`inaccessible ${path.basename(cwd)}`) as Error & {
          code?: string;
        };
        // EACCES is the branch detectGitRepo escalates instead of swallowing.
        error.code = 'EACCES';
        return error;
      },
    });

    await expect(
      collectLocalRepoInventory({
        config: configFor(repoPaths),
        configPath: path.join(root, 'config.json'),
        execFileAsync: exec,
      })
    ).rejects.toThrow(/repo-3/);
  });
});
