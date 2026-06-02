import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  collectLanguageServerDiagnostics,
  readProcessTable,
  redactCommandLine,
  scheduleRelayProcessTreeReap,
  summarizeProcessReap,
  type ProcessInfo,
} from '../server/process-tree.js';

function proc(overrides: Partial<ProcessInfo> & Pick<ProcessInfo, 'pid' | 'ppid' | 'pgid'>): ProcessInfo {
  return {
    command: 'node',
    commandLine: 'node',
    rssBytes: 0,
    ...overrides,
  };
}

function writeFakeProc(
  procRoot: string,
  options: {
    pid: number;
    ppid: number;
    pgid: number;
    command: string;
    cmdlineArgs: string[];
    rssKb?: number;
  }
): void {
  const procDir = `${procRoot}/${options.pid}`;
  mkdirSync(procDir, { recursive: true });
  writeFileSync(
    `${procDir}/stat`,
    `${options.pid} (${options.command}) S ${options.ppid} ${options.pgid} 1 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 100`
  );
  writeFileSync(`${procDir}/cmdline`, `${options.cmdlineArgs.join('\0')}\0`);
  writeFileSync(`${procDir}/status`, `Name:\t${options.command}\nVmRSS:\t${options.rssKb ?? 0} kB\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('condition was not met before timeout');
}

describe('process-tree session runtime reaping', () => {
  it('summarizes descendant language servers before session kill', () => {
    const table: ProcessInfo[] = [
      proc({ pid: 100, ppid: 1, pgid: 100, commandLine: 'node relay-ide workspace host' }),
      proc({
        pid: 101,
        ppid: 100,
        pgid: 100,
        commandLine: 'node /typescript/lib/tsserver.js --stdio',
        rssBytes: 42 * 1024 * 1024,
        languageServerKind: 'tsserver',
      }),
      proc({ pid: 102, ppid: 101, pgid: 100, commandLine: 'helper' }),
    ];

    const summary = summarizeProcessReap([100], table);

    expect(summary.rootPids).toEqual([100]);
    expect(summary.descendantPids).toEqual([101, 102]);
    expect(summary.processGroupIds).toEqual([100]);
    expect(summary.languageServers).toEqual([
      {
        pid: 101,
        kind: 'tsserver',
        rssBytes: 42 * 1024 * 1024,
        commandLine: 'node /typescript/lib/tsserver.js --stdio',
      },
    ]);
  });

  it('signals process group and descendants for explicit session teardown', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const table: ProcessInfo[] = [
      proc({ pid: 200, ppid: 1, pgid: 200, commandLine: 'node relay-ide workspace host' }),
      proc({ pid: 201, ppid: 200, pgid: 200, commandLine: 'typescript-language-server --stdio' }),
    ];

    scheduleRelayProcessTreeReap({
      rootPids: [200],
      processTable: table,
      killProcess: (pid, signal) => calls.push({ pid, signal }),
      setTimer: () => ({ unref() {} }),
      logger: {},
      killDelayMs: 1,
    });

    expect(calls).toEqual([
      { pid: -200, signal: 'SIGTERM' },
      { pid: 201, signal: 'SIGTERM' },
      { pid: 200, signal: 'SIGTERM' },
    ]);
  });

  it('redacts likely secrets from language-server diagnostics', () => {
    expect(
      redactCommandLine(
        'node /typescript/lib/tsserver.js --api-key=child-secret https://example.test/?access_token=url-secret GITHUB_TOKEN=env-secret'
      )
    ).toBe(
      'node /typescript/lib/tsserver.js --api-key=[REDACTED] https://example.test/?access_token=[REDACTED] GITHUB_TOKEN=[REDACTED]'
    );
    expect(redactCommandLine('node relay-ide --token parent-secret')).toBe(
      'node relay-ide --token [REDACTED]'
    );
    expect(redactCommandLine('Authorization Bearer abc123')).toBe(
      'Authorization Bearer [REDACTED]'
    );
    expect(
      redactCommandLine(
        'node relay-ide --token="my secret value" --client-secret \'client secret value\' Authorization Basic "basic secret value" GITHUB_TOKEN=\'env secret value\''
      )
    ).toBe(
      'node relay-ide --token=[REDACTED] --client-secret [REDACTED] Authorization Basic [REDACTED] GITHUB_TOKEN=[REDACTED]'
    );
  });

  it('redacts quoted secrets in collected language-server diagnostics', () => {
    const procRoot = mkdtempSync(`${tmpdir()}/relay-proc-`);
    try {
      writeFileSync(`${procRoot}/uptime`, '1000 0');
      writeFakeProc(procRoot, {
        pid: 300,
        ppid: 1,
        pgid: 300,
        command: 'relay-ide',
        cmdlineArgs: ['node', 'relay-ide', '--token="parent secret value"'],
      });
      writeFakeProc(procRoot, {
        pid: 301,
        ppid: 300,
        pgid: 300,
        command: 'node',
        cmdlineArgs: [
          'node',
          '/typescript/lib/tsserver.js',
          '--api-key="child secret value"',
          '--password',
          "'spaced password value'",
          'Authorization',
          'Bearer',
          '"bearer secret value"',
          "GITHUB_TOKEN='env secret value'",
        ],
        rssKb: 42,
      });

      const diagnostics = collectLanguageServerDiagnostics({
        procRoot,
        nowMs: 1_000_000,
        uptimeSeconds: 1000,
        clockTickHz: 100,
      });

      expect(diagnostics.processes).toHaveLength(1);
      expect(diagnostics.processes[0]?.commandLine).toBe(
        'node /typescript/lib/tsserver.js --api-key=[REDACTED] --password [REDACTED] Authorization Bearer [REDACTED] GITHUB_TOKEN=[REDACTED]'
      );
      expect(diagnostics.processes[0]?.ancestors[0]?.commandLine).toBe(
        'node relay-ide --token=[REDACTED]'
      );
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });

  it('spawn/kill cycle returns language-server descendants to baseline on Linux', async () => {
    if (process.platform !== 'linux') return;

    const parentCode = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'tsserver.js'], { stdio: 'ignore' });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ['-e', parentCode], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parentPid = parent.pid;
    if (!parentPid) throw new Error('spawn did not return parent pid');

    let childPid: number | undefined;
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', (chunk: string) => {
      const parsed = Number(chunk.trim());
      if (Number.isSafeInteger(parsed)) childPid = parsed;
    });

    try {
      await waitFor(() => childPid !== undefined);
      const baseline = readProcessTable().filter((p) => p.languageServerKind).length;
      await waitFor(() =>
        readProcessTable().some((p) => p.pid === childPid && p.languageServerKind === 'tsserver')
      );

      scheduleRelayProcessTreeReap({ rootPids: [parentPid], killDelayMs: 50, logger: {} });

      await waitFor(() => {
        const table = readProcessTable();
        return !table.some((p) => p.pid === parentPid || p.pid === childPid);
      });
      const after = readProcessTable().filter((p) => p.languageServerKind).length;
      expect(after).toBeLessThanOrEqual(baseline);
    } finally {
      try {
        process.kill(-parentPid, 'SIGKILL');
      } catch {
        // already gone
      }
      parent.stdout.destroy();
    }
  }, 10_000);
});
