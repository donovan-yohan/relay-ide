import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runProviderSmoke,
  runSmokeCli,
  type SmokeProvider,
} from '../scripts/agent-rpc-smoke.js';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function fixture(provider: SmokeProvider): { command: string; log: string } {
  tmp = mkdtempSync(join(tmpdir(), 'relay-agent-rpc-smoke-test-'));
  const command = join(tmp, `${provider}.mjs`);
  const log = join(tmp, 'events.jsonl');
  writeFileSync(
    command,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const terminal = process.env.FAKE_PROVIDER === 'pi' ? 'agent_settled' : 'agent_end';
const failure = process.env.FAKE_FAILURE;
const missingModel = process.env.FAKE_MISSING_MODEL === '1';
let promptCount = 0;
appendFileSync(process.env.FAKE_RPC_LOG, JSON.stringify({ args, cwd: process.cwd(), piTelemetry: process.env.PI_TELEMETRY }) + '\\n');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    if (failure) {
      emit({ id: request.id, type: 'response', command: 'get_state', success: false, error: failure });
      continue;
    }
    emit({ id: request.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'fixture-session', isStreaming: false, ...(missingModel ? {} : { model: { id: 'fixture-model' } }) } });
  } else if (request.type === 'prompt') {
    const expectedIntent = promptCount === 0
      ? request.message === 'Reply with exactly: OK'
      : request.message.startsWith('Begin another long response');
    if (!expectedIntent) {
      emit({ id: request.id, type: 'response', command: 'prompt', success: false, error: 'unexpected prompt intent' });
      continue;
    }
    emit({ id: request.id, type: 'response', command: 'prompt', success: true });
    emit({ type: 'agent_start' });
    promptCount += 1;
    if (promptCount === 1) emit({ type: terminal });
  } else if (request.type === 'abort') {
    emit({ id: request.id, type: 'response', command: 'abort', success: true });
    emit({ type: terminal });
  }
}
`
  );
  chmodSync(command, 0o755);
  return { command, log };
}

function fixtureEvents(
  log: string
): Array<{ args: string[]; cwd: string; piTelemetry?: string }> {
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          args: string[];
          cwd: string;
          piTelemetry?: string;
        }
    );
}

describe('agent RPC smoke harness', () => {
  it.each([
    ['pi', 'agent_settled'],
    ['prime-agent', 'agent_end'],
  ] as const)(
    'runs %s through active abort and same-session resume',
    async (provider, terminal) => {
      const { command, log } = fixture(provider);
      const result = await runProviderSmoke({
        provider,
        command,
        model: 'fixture-model',
        timeoutMs: 1_000,
        env: {
          ...process.env,
          FAKE_PROVIDER: provider,
          FAKE_RPC_LOG: log,
          PI_TELEMETRY: '1',
        },
      });

      expect(result).toEqual({
        provider,
        terminalEvent: terminal,
        sessionHash: expect.stringMatching(/^[a-f0-9]{10}$/),
      });
      const starts = fixtureEvents(log);
      expect(starts).toHaveLength(2);
      for (const start of starts)
        expect(start.args).toEqual(
          expect.arrayContaining([
            '--mode',
            'rpc',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-context-files',
            '--no-tools',
            '--session-dir',
            expect.any(String),
            '--model',
            'fixture-model',
          ])
        );
      expect(starts[1]!.args).toEqual(
        expect.arrayContaining(
          provider === 'pi'
            ? ['--session-id', 'fixture-session', '--offline']
            : ['--resume', 'fixture-session', '--offline']
        )
      );
      expect(starts.map((start) => start.piTelemetry)).toEqual(
        provider === 'pi' ? ['0', '0'] : ['1', '1']
      );
      expect(existsSync(starts[0]!.cwd)).toBe(false);
      const sessionDirIndex = starts[0]!.args.indexOf('--session-dir');
      expect(existsSync(starts[0]!.args[sessionDirIndex + 1]!)).toBe(false);
    }
  );

  it('skips without the explicit live and credential gates', async () => {
    const output: string[] = [];
    await expect(
      runSmokeCli({
        argv: ['--provider', 'pi'],
        env: {},
        log: (line) => output.push(line),
      })
    ).resolves.toBe(0);
    expect(output).toEqual([
      'SKIP pi: set RELAY_AGENT_RPC_SMOKE_LIVE=1 to allow model-backed RPC calls',
    ]);

    output.length = 0;
    await expect(
      runSmokeCli({
        argv: ['--provider', 'pi'],
        env: { RELAY_AGENT_RPC_SMOKE_LIVE: '1' },
        log: (line) => output.push(line),
      })
    ).resolves.toBe(0);
    expect(output).toEqual([
      'SKIP pi: set RELAY_AGENT_RPC_SMOKE_CREDENTIALS=1 after configuring provider credentials',
    ]);
  });

  it('reports a missing provider binary as a skip, not a pass', async () => {
    const output: string[] = [];
    await expect(
      runSmokeCli({
        argv: ['--provider=prime-agent'],
        env: {
          RELAY_AGENT_RPC_SMOKE_LIVE: '1',
          RELAY_AGENT_RPC_SMOKE_CREDENTIALS: '1',
          RELAY_AGENT_RPC_SMOKE_MODEL: 'fixture-model',
          RELAY_AGENT_RPC_SMOKE_PRIME_COMMAND: join(
            tmpdir(),
            'not-a-real-prime-agent'
          ),
        },
        log: (line) => output.push(line),
      })
    ).resolves.toBe(0);
    expect(output).toEqual([
      expect.stringContaining('SKIP prime-agent: command unavailable'),
    ]);
  });

  it.each([
    ['model unavailable', 'model not found', 'missing or unconfigured model'],
    [
      'credentials unavailable',
      'authentication required',
      'missing or invalid credentials',
    ],
  ])(
    'turns explicit provider %s responses into a skip',
    async (_name, failure, expected) => {
      const { command, log } = fixture('pi');
      const output: string[] = [];
      await expect(
        runSmokeCli({
          argv: ['--provider=pi'],
          env: {
            ...process.env,
            RELAY_AGENT_RPC_SMOKE_LIVE: '1',
            RELAY_AGENT_RPC_SMOKE_CREDENTIALS: '1',
            RELAY_AGENT_RPC_SMOKE_MODEL: 'fixture-model',
            RELAY_AGENT_RPC_SMOKE_PI_COMMAND: command,
            FAKE_PROVIDER: 'pi',
            FAKE_RPC_LOG: log,
            FAKE_FAILURE: failure,
          },
          log: (line) => output.push(line),
        })
      ).resolves.toBe(0);
      expect(output).toEqual([expect.stringContaining(expected)]);
    }
  );

  it('turns a successful get_state without a configured model into a skip', async () => {
    const { command, log } = fixture('pi');
    const output: string[] = [];
    await expect(
      runSmokeCli({
        argv: ['--provider=pi'],
        env: {
          ...process.env,
          RELAY_AGENT_RPC_SMOKE_LIVE: '1',
          RELAY_AGENT_RPC_SMOKE_CREDENTIALS: '1',
          RELAY_AGENT_RPC_SMOKE_MODEL: 'fixture-model',
          RELAY_AGENT_RPC_SMOKE_PI_COMMAND: command,
          FAKE_PROVIDER: 'pi',
          FAKE_RPC_LOG: log,
          FAKE_MISSING_MODEL: '1',
        },
        log: (line) => output.push(line),
      })
    ).resolves.toBe(0);
    expect(output).toEqual([
      expect.stringContaining(
        'SKIP pi: provider reported missing or unconfigured model'
      ),
    ]);
  });

  it.each([
    'provider temporarily unavailable',
    'unsupported RPC capability',
    'incompatible RPC protocol',
  ])(
    'fails closed for provider protocol/runtime error: %s',
    async (failure) => {
      const { command, log } = fixture('pi');
      const output: string[] = [];
      await expect(
        runSmokeCli({
          argv: ['--provider=pi'],
          env: {
            ...process.env,
            RELAY_AGENT_RPC_SMOKE_LIVE: '1',
            RELAY_AGENT_RPC_SMOKE_CREDENTIALS: '1',
            RELAY_AGENT_RPC_SMOKE_MODEL: 'fixture-model',
            RELAY_AGENT_RPC_SMOKE_PI_COMMAND: command,
            FAKE_PROVIDER: 'pi',
            FAKE_RPC_LOG: log,
            FAKE_FAILURE: failure,
          },
          log: (line) => output.push(line),
        })
      ).resolves.toBe(1);
      expect(output).toEqual(['FAIL pi: RPC smoke contract did not complete']);
    }
  );
});
