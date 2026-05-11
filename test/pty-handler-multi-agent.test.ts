import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as sessions from '../server/sessions.js';
import type { PtySession } from '../server/types.js';

const createdIds: string[] = [];
const execFileAsync = promisify(execFile);
const originalTmuxTmpdir = process.env.TMUX_TMPDIR;
let tmuxTmpdir: string;

// Keep tmux cleanup pinned to this file's socket dir. Full-suite runs may have
// other tmux-backed test files mutating process.env.TMUX_TMPDIR concurrently.
function tmuxCommandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TMUX_TMPDIR: tmuxTmpdir };
}

function execTmux(args: string[]) {
  return execFileAsync('tmux', args, { env: tmuxCommandEnv() });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForScrollbackContains(
  sessionId: string,
  needle: string,
  timeoutMs = 8000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = sessions.get(sessionId) as PtySession | undefined;
    if (session) {
      const output = session.scrollback.join('');
      if (output.includes(needle)) return output;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for scrollback to contain: ${needle}`);
}

async function waitForFileContains(
  filePath: string,
  needle: string,
  timeoutMs = 8000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const output = fs.readFileSync(filePath, 'utf-8');
      if (output.includes(needle)) return output;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${filePath} to contain: ${needle}`);
}

describe('PTY multi-agent hook/plugin wiring', () => {
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeAll(() => {
    tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-tmux-'));
    process.env.TMUX_TMPDIR = tmuxTmpdir;
  });

  afterAll(async () => {
    await execTmux(['kill-server']).catch(() => {});
    if (originalTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = originalTmuxTmpdir;
    }
    fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
  });

  beforeEach(() => {
    testHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-ide-multi-agent-home-')
    );
    process.env.HOME = testHome;
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

    process.env.HOME = originalHome;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it('installs OpenCode relay plugin and injects relay env vars', async () => {
    const port = 4567;
    const hookToken = 'opencode-hook-token';
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'opencode',
      command: process.execPath,
      args: [
        '-e',
        [
          "const fs=require('node:fs');",
          "const os=require('node:os');",
          "const path=require('node:path');",
          "console.log('RELAY_IDE_URL='+(process.env.RELAY_IDE_URL||''));",
          "console.log('RELAY_IDE_SESSION_ID='+(process.env.RELAY_IDE_SESSION_ID||''));",
          "console.log('RELAY_IDE_TOKEN='+(process.env.RELAY_IDE_TOKEN||''));",
          "const pluginPath=path.join(os.homedir(),'.config','opencode','plugins','relay-ide-relay.ts');",
          "console.log('PLUGIN_EXISTS='+fs.existsSync(pluginPath));",
          'setTimeout(()=>{},10000);',
        ].join(' '),
      ],
      port,
      hookToken,
    });
    createdIds.push(result.id);

    const output = await waitForScrollbackContains(
      result.id,
      'PLUGIN_EXISTS=true'
    );
    expect(output).toMatch(
      new RegExp(`RELAY_IDE_URL=http://127\\.0\\.0\\.1:${port}`)
    );
    expect(output).toMatch(new RegExp(`RELAY_IDE_SESSION_ID=${result.id}`));
    expect(output).toMatch(new RegExp(`RELAY_IDE_TOKEN=${hookToken}`));
  });

  it('writes Codex hooks adapter and injects CODEX_CONFIG_DIR', async () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          "const fs=require('node:fs');",
          "const path=require('node:path');",
          "const dir=process.env.CODEX_CONFIG_DIR||'';",
          "console.log('CODEX_CONFIG_DIR='+dir);",
          "console.log('HAS_HOOKS_JSON='+(dir && fs.existsSync(path.join(dir,'hooks.json'))));",
          "console.log('HAS_RELAY_SH='+(dir && fs.existsSync(path.join(dir,'relay.sh'))));",
          'setTimeout(()=>{},10000);',
        ].join(' '),
      ],
      port: 7777,
      hookToken: 'codex-token',
      configDir: '/tmp',
    });
    createdIds.push(result.id);

    const output = await waitForScrollbackContains(
      result.id,
      'HAS_RELAY_SH=true'
    );
    expect(output).toMatch(/CODEX_CONFIG_DIR=\/.*codex-hooks-/);
    expect(output).toMatch(/HAS_HOOKS_JSON=true/);
  });

  it('resolves framework from config.frameworks overrides', () => {
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: '/bin/cat',
      args: [],
      frameworks: {
        claude: {
          eventSource: 'parser',
        },
      },
    });
    createdIds.push(result.id);

    const session = sessions.get(result.id) as PtySession;
    expect(session).toBeTruthy();
    expect(session.dataQuality).toBe('parser');
  });

  it('uses parser startup signal for hook-backed tmux sessions before hooks fire', async () => {
    const agentStub = path.join(testHome, 'claude-stub.sh');
    fs.writeFileSync(
      agentStub,
      `#!/bin/sh
while [ "$1" = "--settings" ]; do
  shift 2
done
printf 'How can I help you today?\\n>\\n'
sleep 10
`,
      'utf-8'
    );
    fs.chmodSync(agentStub, 0o755);

    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      args: [],
      port: 4568,
      hookToken: 'claude-hook-token',
      configDir: '/tmp',
      frameworks: {
        claude: {
          command: agentStub,
          eventSource: 'hooks',
          parserType: 'claude',
          capabilities: {
            supportsHooks: true,
            supportsContinue: true,
            supportsYolo: true,
            supportsTelemetry: true,
            supportsAttachedRuntime: true,
            supportsWebSessions: true,
          },
        },
      },
    });
    createdIds.push(result.id);

    await waitForScrollbackContains(result.id, 'How can I help');
    await delay(100);

    const session = sessions.get(result.id) as PtySession;
    expect(session.hooksActive).toBe(true);
    expect(session.dataQuality).toBe('hooks');
    expect(session.agentState, session.scrollback.join('')).toBe(
      'waiting-for-input'
    );
  });

  it('injects framework.yoloEnv for opencode in yolo mode', async () => {
    const probePath = path.join(testHome, 'opencode-yolo-env.txt');
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'opencode',
      yolo: true,
      command: process.execPath,
      args: [
        '-e',
        [
          "const fs=require('node:fs');",
          `const probePath=${JSON.stringify(probePath)};`,
          "const cfg=process.env.OPENCODE_CONFIG_CONTENT||'';",
          "fs.writeFileSync(probePath,cfg);",
          "console.log('OPENCODE_CONFIG_CONTENT='+cfg);",
          'setTimeout(()=>{},10000);',
        ].join(' '),
      ],
    });
    createdIds.push(result.id);

    const output = await waitForFileContains(probePath, '"permission"');
    expect(output).toMatch(/"permission"/);
  });
});
