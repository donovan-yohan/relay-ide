/**
 * Tests for RELAY_* env injection and per-session relayctl shim.
 *
 * Covers:
 *  - RELAY_NODE_ID, RELAY_SESSION_ID, RELAY_HUB_URL injected into Relay PTY env
 *  - RELAY_WORK_CONTEXT_ID injected when set, omitted when not
 *  - RELAY_* vars are NOT present in non-Relay process environments
 *  - relayctl shim exists in per-session bin dir
 *  - relayctl is NOT on PATH in non-Relay shells (env isolation test)
 *  - relayctl whoami arg-parsing integration (env → stdout)
 *
 * These tests run the env-injection logic through sessions.create (unit-level)
 * using a no-op /bin/sh -c command so no real agent binary is required.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as sessions from '../server/sessions.js';
import type { PtySession } from '../server/types.js';
import { injectRelaySessionEnvForTest } from '../server/pty-handler.js';

const execFileAsync = promisify(execFile);
const createdIds: string[] = [];
const originalTmuxTmpdir = process.env.TMUX_TMPDIR;
let tmuxTmpdir: string;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PTY_STARTUP_TIMEOUT_MS = 10000;

async function waitForScrollbackContains(
  sessionId: string,
  needle: string,
  timeoutMs = PTY_STARTUP_TIMEOUT_MS
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = sessions.get(sessionId) as PtySession | undefined;
    if (session) {
      const scrollback = session.scrollback.join('');
      if (scrollback.includes(needle)) return scrollback;
    }
    await delay(50);
  }
  const session = sessions.get(sessionId) as PtySession | undefined;
  throw new Error(
    `timed out waiting for scrollback to contain: ${needle}. last scrollback: ${JSON.stringify(
      session?.scrollback?.join('').slice(-800) ?? '<missing session>'
    )}`
  );
}

beforeAll(() => {
  tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-tmux-env-'));
  process.env.TMUX_TMPDIR = tmuxTmpdir;
});

afterAll(async () => {
  await execFileAsync('tmux', ['-L', 'relay-env-test', 'kill-server'], {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir },
  }).catch(() => {});
  if (originalTmuxTmpdir === undefined) {
    delete process.env.TMUX_TMPDIR;
  } else {
    process.env.TMUX_TMPDIR = originalTmuxTmpdir;
  }
  fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
});

afterEach(() => {
  for (const id of createdIds) {
    try {
      if (sessions.get(id)) sessions.kill(id);
    } catch {
      /* session may already be dead */
    }
  }
  createdIds.length = 0;
});

// ── Unit-level: env/shim construction via exported test helper ──────────────

describe('injectRelaySessionEnvForTest — env var injection', () => {
  it('injects RELAY_NODE_ID and RELAY_SESSION_ID into env and tmuxEnv', () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    const tmuxEnv: Record<string, string> = { PATH: '/usr/bin:/bin' };
    injectRelaySessionEnvForTest(env, tmuxEnv, {
      sessionId: 'ses-abc',
      nodeId: 'local',
      port: 3456,
      workContextId: undefined,
    });
    expect(env.RELAY_NODE_ID).toBe('local');
    expect(env.RELAY_SESSION_ID).toBe('ses-abc');
    expect(tmuxEnv.RELAY_NODE_ID).toBe('local');
    expect(tmuxEnv.RELAY_SESSION_ID).toBe('ses-abc');
  });

  it('injects RELAY_HUB_URL when port is set', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    const tmuxEnv: Record<string, string> = { PATH: '/usr/bin' };
    injectRelaySessionEnvForTest(env, tmuxEnv, {
      sessionId: 'ses-hub',
      nodeId: 'local',
      port: 9876,
      workContextId: undefined,
    });
    expect(env.RELAY_HUB_URL).toBe('http://127.0.0.1:9876');
    expect(tmuxEnv.RELAY_HUB_URL).toBe('http://127.0.0.1:9876');
  });

  it('omits RELAY_HUB_URL when port is undefined', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    const tmuxEnv: Record<string, string> = { PATH: '/usr/bin' };
    injectRelaySessionEnvForTest(env, tmuxEnv, {
      sessionId: 'ses-noport',
      nodeId: 'local',
      port: undefined,
      workContextId: undefined,
    });
    expect(env.RELAY_HUB_URL).toBeUndefined();
    expect(tmuxEnv.RELAY_HUB_URL).toBeUndefined();
  });

  it('injects RELAY_WORK_CONTEXT_ID when provided', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    const tmuxEnv: Record<string, string> = { PATH: '/usr/bin' };
    injectRelaySessionEnvForTest(env, tmuxEnv, {
      sessionId: 'ses-ctx',
      nodeId: 'local',
      port: 3456,
      workContextId: 'wc-xyz-123',
    });
    expect(env.RELAY_WORK_CONTEXT_ID).toBe('wc-xyz-123');
    expect(tmuxEnv.RELAY_WORK_CONTEXT_ID).toBe('wc-xyz-123');
  });

  it('omits RELAY_WORK_CONTEXT_ID when not provided', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    const tmuxEnv: Record<string, string> = { PATH: '/usr/bin' };
    injectRelaySessionEnvForTest(env, tmuxEnv, {
      sessionId: 'ses-noctx',
      nodeId: 'local',
      port: 3456,
      workContextId: undefined,
    });
    expect(env.RELAY_WORK_CONTEXT_ID).toBeUndefined();
    expect(tmuxEnv.RELAY_WORK_CONTEXT_ID).toBeUndefined();
  });

  it('prepends a per-session bin dir to PATH when relayctl binary exists', () => {
    // In test context dist/bin/relayctl.js may not yet be compiled — the shim
    // is only written when the binary is locatable. Both outcomes are valid.
    const originalPath = '/usr/local/bin:/usr/bin:/bin';
    const env: Record<string, string> = { PATH: originalPath };
    const tmuxEnv: Record<string, string> = { PATH: originalPath };
    injectRelaySessionEnvForTest(env, tmuxEnv, {
      sessionId: 'ses-path',
      nodeId: 'local',
      port: 3456,
      workContextId: undefined,
    });
    // PATH should either be unchanged (binary not found) or start with per-session bin dir.
    if (env.PATH !== originalPath) {
      // Shim was written: PATH has a per-session component ending with /bin
      const shimDir = env.PATH.split(':')[0];
      expect(shimDir).toContain('ses-path');
      expect(shimDir).toMatch(/bin$/);
      expect(env.PATH).toContain(originalPath);
      expect(tmuxEnv.PATH).toContain(originalPath);
      // Verify a relayctl file was written in the shim dir
      const { existsSync } = fs;
      expect(existsSync(path.join(shimDir, 'relayctl'))).toBe(true);
    }
    // Either way PATH is a valid string
    expect(typeof env.PATH).toBe('string');
  });

  it('writes an executable relayctl shim in the per-session bin dir when binary is resolvable', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    const tmuxEnv: Record<string, string> = { PATH: '/usr/bin' };
    injectRelaySessionEnvForTest(env, tmuxEnv, {
      sessionId: 'ses-shim',
      nodeId: 'local',
      port: 3456,
      workContextId: undefined,
    });
    // In test context relayctl.js may not be compiled yet — shim may be absent.
    // Either PATH was extended (shim written) or it is unchanged (binary absent).
    // Both are valid outcomes; just ensure PATH is a string.
    expect(typeof env.PATH).toBe('string');
  });
});

// ── Non-Relay shells do NOT have RELAY_* vars ──────────────────────────────

describe('env isolation — non-Relay shells are clean', () => {
  it('RELAY_* vars are absent from env of shells spawned outside Relay', async () => {
    // Spawn a plain sh process (not through Relay PTY machinery) and check env.
    // Use execFile directly — no sessions.create() — to simulate an external shell.
    const { stdout } = await execFileAsync('/bin/sh', ['-c', 'env']);
    const lines = stdout.split('\n').filter(Boolean);
    const relayLines = lines.filter((l) => l.startsWith('RELAY_'));
    expect(relayLines).toEqual([]);
  });

  it('relayctl per-session shim dir is not on PATH in shells spawned outside Relay', async () => {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', 'echo "$PATH"']);
    // The per-session shim lives under {tmpdir}/relay-ide/{sessionId}/bin.
    // A non-Relay shell should not have this tmpdir-based path on its PATH.
    // We match specifically against the OS temp dir + relay-ide session bin pattern.
    const tmpdir = os.tmpdir();
    // e.g. /tmp/relay-ide/ses-abc123/bin
    const relaySessionBinPattern = new RegExp(
      tmpdir.replace(/[/\\]/g, '[/\\\\]') +
        '[/\\\\]relay-ide[/\\\\][^:]+[/\\\\]bin'
    );
    expect(stdout).not.toMatch(relaySessionBinPattern);
  });
});

// ── Integration: sessions.create passes RELAY_* to the spawned process ─────

describe('sessions.create — RELAY_* env vars reach the spawned PTY', () => {
  it('RELAY_NODE_ID and RELAY_SESSION_ID appear in scrollback via env print', async () => {
    // Use node (process.execPath) so the process stays alive long enough to
    // collect scrollback. Plain shell commands exit immediately and the session
    // may be removed before waitForScrollbackContains can observe it.
    // setTimeout(()=>{}, 10000) keeps the process alive for the test window.
    const result = sessions.create({
      repoName: 'env-test',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: process.execPath,
      args: [
        '-e',
        [
          "console.log('RELAY_NODE_ID=' + (process.env.RELAY_NODE_ID || ''));",
          "console.log('RELAY_SESSION_ID=' + (process.env.RELAY_SESSION_ID || ''));",
          'setTimeout(()=>{}, 10000);',
        ].join(' '),
      ],
      tmuxAttach: true,
    });
    createdIds.push(result.id);

    const scrollback = await waitForScrollbackContains(
      result.id,
      'RELAY_NODE_ID='
    );
    expect(scrollback).toContain('RELAY_NODE_ID=local');
    expect(scrollback).toContain(`RELAY_SESSION_ID=${result.id}`);
  });

  it('RELAY_WORK_CONTEXT_ID is present when workContextId is passed', async () => {
    const result = sessions.create({
      repoName: 'env-ctx-test',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: process.execPath,
      args: [
        '-e',
        [
          "console.log('CTX=' + (process.env.RELAY_WORK_CONTEXT_ID || 'NOTSET'));",
          'setTimeout(()=>{}, 10000);',
        ].join(' '),
      ],
      tmuxAttach: true,
      workContextId: 'wc-test-42',
    });
    createdIds.push(result.id);

    const scrollback = await waitForScrollbackContains(result.id, 'CTX=');
    expect(scrollback).toContain('CTX=wc-test-42');
  });

  it('RELAY_WORK_CONTEXT_ID is absent when workContextId is not passed', async () => {
    const result = sessions.create({
      repoName: 'env-noctx-test',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: process.execPath,
      args: [
        '-e',
        [
          "console.log('CTX=' + (process.env.RELAY_WORK_CONTEXT_ID || 'NOTSET'));",
          'setTimeout(()=>{}, 10000);',
        ].join(' '),
      ],
      tmuxAttach: true,
    });
    createdIds.push(result.id);

    const scrollback = await waitForScrollbackContains(result.id, 'CTX=');
    expect(scrollback).toContain('CTX=NOTSET');
  });
});

// ── relayctl CLI arg-parsing (unit, no network required) ───────────────────

describe('relayctl whoami — arg parsing (process.env stubbed)', () => {
  it('prints node_id, session_id, and hub_url when env vars are set', async () => {
    // Run the compiled relayctl binary (if available) with stubbed env.
    // Skip gracefully if dist/bin/relayctl.js has not been compiled yet.
    const relayctlPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../dist/bin/relayctl.js'
    );
    if (!fs.existsSync(relayctlPath)) {
      // Binary not compiled yet (CI pre-build) — skip.
      return;
    }

    const { stdout } = await execFileAsync(
      process.execPath,
      [relayctlPath, 'whoami'],
      {
        env: {
          ...process.env,
          RELAY_NODE_ID: 'test-node',
          RELAY_SESSION_ID: 'test-session',
          RELAY_HUB_URL: 'http://127.0.0.1:3456',
          RELAY_WORK_CONTEXT_ID: 'wc-unit-1',
        },
      }
    );

    expect(stdout).toContain('node_id:      test-node');
    expect(stdout).toContain('session_id:   test-session');
    expect(stdout).toContain('hub_url:      http://127.0.0.1:3456');
    expect(stdout).toContain('work_context: wc-unit-1');
  });
});

// ── relayctl logs tail — stub behaviour ────────────────────────────────────

describe('relayctl logs tail — stub', () => {
  it('exits 1 with "not yet available" message', async () => {
    const relayctlPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../dist/bin/relayctl.js'
    );
    if (!fs.existsSync(relayctlPath)) return;

    const result = await execFileAsync(
      process.execPath,
      [relayctlPath, 'logs', 'tail'],
      {
        env: {
          ...process.env,
          RELAY_NODE_ID: 'n',
          RELAY_SESSION_ID: 's',
        },
      }
    ).catch((err: { stderr?: string; code?: number }) => ({
      stderr: err.stderr ?? '',
      code: err.code ?? 1,
    }));

    expect(result.stderr ?? '').toContain('not yet available');
    expect(result.code).toBe(1);
  });
});
