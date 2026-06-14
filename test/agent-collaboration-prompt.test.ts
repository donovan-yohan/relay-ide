import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sessions from '../server/sessions.js';
import {
  BUILTIN_FRAMEWORKS,
  collaborationPromptArgsForFramework,
  resolveFramework,
  type AgentFramework,
  type PtySession,
} from '../server/types.js';
import { collaborationPromptAppendix } from '../shared/agent-roster.js';

// #955 — Relay-launched agent collaboration prompt injection.
//
// Part A: pure unit tests on the framework→args mapper (deterministic, no
// spawn). Part B: integration tests that spawn a recording stub via the
// relay-pty backend and assert the real launch argv.

const APPENDIX_MARKERS = [
  'role: implementer',
  'relay-ide v1 sessions list',
  'relay-ide v1 roster list',
  'relay-ide v1 inbox',
  'events subscribe --topic inbox',
];

// Substrings that would indicate raw transcripts/secrets/provider-store paths
// leaking into the injected prompt. The appendix must contain NONE of these.
const FORBIDDEN_SUBSTRINGS = [
  'tmux',
  'pty',
  '.claude',
  '.codex',
  '.hermes',
  '.opencode',
  'token',
  'transcript',
  'secret',
  'password',
  'api_key',
  'apikey',
  '/home/',
  '/users/',
  '/root/',
];

describe('collaborationPromptArgsForFramework (#955)', () => {
  it('returns the Claude append-system-prompt flag + the shared appendix', () => {
    const args = collaborationPromptArgsForFramework(BUILTIN_FRAMEWORKS.claude);
    expect(args).toEqual([
      '--append-system-prompt',
      collaborationPromptAppendix({ provider: 'claude' }),
    ]);
    // Role-resolved appendix text reaches the launch argument.
    const appendix = args[1];
    for (const marker of APPENDIX_MARKERS) {
      expect(appendix).toContain(marker);
    }
  });

  it('embeds no raw transcripts/secrets/provider-store paths in the prompt', () => {
    const appendix = collaborationPromptArgsForFramework(
      BUILTIN_FRAMEWORKS.claude
    )[1];
    const lowered = appendix.toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(lowered).not.toContain(forbidden);
    }
  });

  it('skips unsupported builtin providers (no Claude-specific flag)', () => {
    for (const id of ['codex', 'opencode', 'hermes'] as const) {
      expect(
        collaborationPromptArgsForFramework(BUILTIN_FRAMEWORKS[id])
      ).toEqual([]);
    }
  });

  it('skips a custom framework that declares no support', () => {
    const custom = resolveFramework(
      {
        frameworks: {
          myagent: {
            id: 'myagent',
            displayName: 'My Agent',
            command: 'myagent',
            continueArgs: [],
            yoloArgs: [],
            parserType: 'myagent',
            eventSource: 'parser',
            capabilities: {
              supportsHooks: false,
              supportsContinue: false,
              supportsYolo: false,
              supportsTelemetry: false,
              supportsAttachedRuntime: false,
            },
          },
        },
      },
      'myagent'
    );
    expect(collaborationPromptArgsForFramework(custom)).toEqual([]);
  });

  it('requires BOTH the capability flag and a collaborationPromptArg', () => {
    // Capability declared but no provider flag → cannot inject → [].
    const noArg: AgentFramework = {
      ...BUILTIN_FRAMEWORKS.codex,
      collaborationPromptArg: undefined,
      capabilities: {
        ...BUILTIN_FRAMEWORKS.codex.capabilities,
        supportsCollaborationPrompt: true,
      },
    };
    expect(collaborationPromptArgsForFramework(noArg)).toEqual([]);

    // Provider flag present but capability not declared → [].
    const noCapability: AgentFramework = {
      ...BUILTIN_FRAMEWORKS.codex,
      collaborationPromptArg: '--some-flag',
    };
    expect(collaborationPromptArgsForFramework(noCapability)).toEqual([]);
  });

  it('lets an operator opt a builtin out via config.frameworks override', () => {
    const optedOut = resolveFramework(
      {
        frameworks: {
          claude: {
            capabilities: {
              supportsCollaborationPrompt: false,
            } as AgentFramework['capabilities'],
          },
        },
      },
      'claude'
    );
    expect(collaborationPromptArgsForFramework(optedOut)).toEqual([]);
  });

  it('supports a custom provider that wires its own append-prompt flag', () => {
    const custom = resolveFramework(
      {
        frameworks: {
          myagent: {
            id: 'myagent',
            displayName: 'My Agent',
            command: 'myagent',
            continueArgs: [],
            yoloArgs: [],
            collaborationPromptArg: '--system-append',
            parserType: 'myagent',
            eventSource: 'parser',
            capabilities: {
              supportsHooks: false,
              supportsContinue: false,
              supportsYolo: false,
              supportsTelemetry: false,
              supportsAttachedRuntime: false,
              supportsCollaborationPrompt: true,
            },
          },
        },
      },
      'myagent'
    );
    expect(collaborationPromptArgsForFramework(custom)).toEqual([
      '--system-append',
      collaborationPromptAppendix({ provider: 'myagent' }),
    ]);
  });
});

describe('createPtySession collaboration prompt injection (#955)', () => {
  const createdIds: string[] = [];
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const id of createdIds) {
      try {
        if (sessions.get(id)) sessions.kill(id);
      } catch {
        /* already cleaned up */
      }
    }
    createdIds.length = 0;
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  // A stub that records its full argv (one element per `ARGV<<...>>` line,
  // followed by an `ARGV_DONE` sentinel) and then idles so it can be killed.
  function writeRecordingStub(): { stubPath: string; probePath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-collab-prompt-'));
    tmpDirs.push(dir);
    const probePath = path.join(dir, 'argv.txt');
    const stubPath = path.join(dir, 'agent-stub.sh');
    fs.writeFileSync(
      stubPath,
      `#!/bin/sh
probe=${JSON.stringify(probePath)}
: > "$probe"
for arg in "$@"; do
  printf 'ARGV<<%s>>\\n' "$arg" >> "$probe"
done
printf 'ARGV_DONE\\n' >> "$probe"
printf 'STUB_READY\\n'
sleep 30
`,
      { mode: 0o755 }
    );
    return { stubPath, probePath };
  }

  async function waitForRecordedArgv(probePath: string): Promise<string> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const out = fs.readFileSync(probePath, 'utf-8');
        if (out.includes('ARGV_DONE')) return out;
      } catch {
        /* probe not written yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for recorded argv at ${probePath}`);
  }

  it('appends the appendix at the launch argv tail, preserving claudeArgs + yolo order', async () => {
    const { stubPath, probePath } = writeRecordingStub();
    // `args` mirrors what the HTTP launch path's buildAgentArgs produces:
    // claudeArgs first, then the yolo flag. createPtySession must append the
    // collaboration args AFTER these without reordering them.
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      args: ['--model', 'opus', '--dangerously-skip-permissions'],
      claudeArgs: ['--model', 'opus'],
      yolo: true,
      terminalBackend: 'relay-pty',
      useTmux: false,
      frameworks: { claude: { command: stubPath } },
    });
    createdIds.push(result.id);

    const out = await waitForRecordedArgv(probePath);

    // Appendix flag + text reached the real spawn.
    expect(out).toContain('ARGV<<--append-system-prompt>>');
    expect(out).toContain('relay-ide v1 roster list');

    const iModel = out.indexOf('ARGV<<--model>>');
    const iOpus = out.indexOf('ARGV<<opus>>');
    const iYolo = out.indexOf('ARGV<<--dangerously-skip-permissions>>');
    const iAppend = out.indexOf('ARGV<<--append-system-prompt>>');

    // claudeArgs preserved in order.
    expect(iModel).toBeGreaterThanOrEqual(0);
    expect(iModel).toBeLessThan(iOpus);
    // yolo flag preserved.
    expect(iYolo).toBeGreaterThanOrEqual(0);
    // collaboration args appended at the tail (after claudeArgs and yolo).
    expect(iOpus).toBeLessThan(iAppend);
    expect(iYolo).toBeLessThan(iAppend);

    // The appendix is NOT persisted onto the session — serialized args stay the
    // operator-configured claudeArgs only.
    const session = sessions.get(result.id) as PtySession;
    expect(session.sessionArgs).toEqual(['--model', 'opus']);
    expect(session.claudeArgs).toEqual(['--model', 'opus']);
  });

  it('does not inject Claude-specific args for an unsupported provider', async () => {
    const { stubPath, probePath } = writeRecordingStub();
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'codex',
      args: ['--marker'],
      terminalBackend: 'relay-pty',
      useTmux: false,
      frameworks: { codex: { command: stubPath, eventSource: 'parser' } },
    });
    createdIds.push(result.id);

    const out = await waitForRecordedArgv(probePath);
    expect(out).toContain('ARGV<<--marker>>');
    expect(out).not.toContain('--append-system-prompt');
    expect(out).not.toContain('relay-ide v1 roster list');
  });

  it('skips injection when a custom command overrides the framework CLI', async () => {
    const { stubPath, probePath } = writeRecordingStub();
    // A custom `command` (not a framework override) means we are not launching
    // Claude's own CLI, so the provider flag may be invalid → skip safely.
    const result = sessions.create({
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      agent: 'claude',
      command: stubPath,
      args: ['--marker'],
      terminalBackend: 'relay-pty',
      useTmux: false,
    });
    createdIds.push(result.id);

    const out = await waitForRecordedArgv(probePath);
    expect(out).toContain('ARGV<<--marker>>');
    expect(out).not.toContain('--append-system-prompt');
  });
});
