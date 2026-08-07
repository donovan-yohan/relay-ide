#!/usr/bin/env node
/* eslint-disable no-console */
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PiAgentRpcClient } from '../server/pi-agent-rpc-client.js';
import { PrimeAgentRpcClient } from '../server/prime-agent-rpc-client.js';

const PI = 'pi';
const PRIME_AGENT = 'prime-agent';

export type SmokeProvider = typeof PI | typeof PRIME_AGENT;

type RpcMessage = Record<string, unknown>;

type RpcClient = {
  start(): Promise<RpcMessage>;
  call(type: string, fields?: Record<string, unknown>): Promise<RpcMessage>;
  stop(): Promise<void>;
  on(event: 'event', listener: (message: RpcMessage) => void): unknown;
  off(event: 'event', listener: (message: RpcMessage) => void): unknown;
};

export interface ProviderSmokeOptions {
  provider: SmokeProvider;
  command: string;
  model: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ProviderSmokeResult {
  provider: SmokeProvider;
  terminalEvent: 'agent_settled' | 'agent_end';
  sessionHash: string;
}

export interface SmokeCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

const DISABLED_LOCAL_FEATURE_ARGS = [
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--no-tools',
] as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const LIVE_GATE = 'RELAY_AGENT_RPC_SMOKE_LIVE';
const CREDENTIAL_GATE = 'RELAY_AGENT_RPC_SMOKE_CREDENTIALS';
const GET_STATE = 'get_state';

function record(value: unknown): RpcMessage {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RpcMessage)
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} was missing from RPC response`);
  return value;
}

function assertCorrelatedResponse(message: RpcMessage, command: string): void {
  if (message.type !== 'response')
    throw new Error(`${command} did not return an RPC response`);
  requiredString(message.id, `${command} response id`);
  if (message.command !== command)
    throw new Error(`${command} response command did not match request`);
  if (message.success !== true)
    throw new Error(
      typeof message.error === 'string' && message.error.length > 0
        ? message.error
        : `${command} was unsuccessful`
    );
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function sessionIdFrom(message: RpcMessage): string {
  return requiredString(record(message.data).sessionId, 'sessionId');
}

function assertConfiguredModel(message: RpcMessage): void {
  const model = record(record(message.data).model);
  if (typeof model.id !== 'string' || model.id.length === 0)
    throw new Error('provider model unavailable or not configured');
}

function parseTimeout(value: string | undefined): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > MAX_TIMEOUT_MS)
    throw new Error(
      'RELAY_AGENT_RPC_SMOKE_TIMEOUT_MS must be an integer from 1000 to 60000'
    );
  return parsed;
}

function terminalEvent(provider: SmokeProvider): 'agent_settled' | 'agent_end' {
  return provider === PI ? 'agent_settled' : 'agent_end';
}

function commandFor(provider: SmokeProvider): string {
  return provider === PI ? PI : PRIME_AGENT;
}

function resumeArgs(provider: SmokeProvider, sessionId: string): string[] {
  return provider === PI
    ? ['--session-id', sessionId, '--offline']
    : ['--resume', sessionId, '--offline'];
}

function createClient(
  provider: SmokeProvider,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): RpcClient {
  const processEnv = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  delete processEnv.CLAUDECODE;
  if (provider === PI) processEnv.PI_TELEMETRY = '0';
  const options = {
    command,
    args,
    cwd,
    env: processEnv,
    readinessTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs,
    stopTimeoutMs: Math.min(timeoutMs, 2_000),
  };
  return provider === PI
    ? new PiAgentRpcClient(options)
    : new PrimeAgentRpcClient(options);
}

function waitForEvent(
  client: RpcClient,
  type: string,
  timeoutMs: number
): { promise: Promise<RpcMessage>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let rejectPromise: ((reason: Error) => void) | undefined;
  const listener = (message: RpcMessage) => {
    if (message.type !== type || settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    client.off('event', listener);
    resolvePromise?.(message);
  };
  let resolvePromise: ((message: RpcMessage) => void) | undefined;
  const promise = new Promise<RpcMessage>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.off('event', listener);
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    timer.unref?.();
  });
  // A failure before the caller awaits this event still needs a handled
  // rejection when finally() cancels the listener during cleanup.
  void promise.catch(() => undefined);
  client.on('event', listener);
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      client.off('event', listener);
      rejectPromise?.(new Error(`stopped waiting for ${type}`));
    },
  };
}

function baseArgs(model: string, sessionDir: string): string[] {
  return [
    '--mode',
    'rpc',
    ...DISABLED_LOCAL_FEATURE_ARGS,
    '--session-dir',
    sessionDir,
    '--model',
    model,
  ];
}

/**
 * Runs a real provider protocol probe. This function intentionally has no live
 * environment gate so deterministic tests can call it with a fake executable;
 * the CLI entrypoint applies the gate before invoking it.
 */
export async function runProviderSmoke(
  options: ProviderSmokeOptions
): Promise<ProviderSmokeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const root = mkdtempSync(join(tmpdir(), 'relay-agent-rpc-smoke-'));
  const cwd = join(root, 'cwd');
  const sessionDir = join(root, 'sessions');
  const terminal = terminalEvent(options.provider);
  let client: RpcClient | undefined;
  let resumed: RpcClient | undefined;
  const waits: ReturnType<typeof waitForEvent>[] = [];

  try {
    // Providers own their contents, but spawn requires cwd to exist. Keeping
    // both directories under one mkdtemp root makes cleanup atomic.
    mkdirSync(cwd);
    mkdirSync(sessionDir);
    const args = baseArgs(options.model, sessionDir);
    client = createClient(
      options.provider,
      options.command,
      args,
      cwd,
      env,
      timeoutMs
    );

    const ready = await client.start();
    assertCorrelatedResponse(ready, GET_STATE);
    assertConfiguredModel(ready);
    const sessionId = sessionIdFrom(ready);

    const normalStart = waitForEvent(client, 'agent_start', timeoutMs);
    const normalTerminal = waitForEvent(client, terminal, timeoutMs);
    waits.push(normalStart, normalTerminal);
    // This prompt is intentionally never logged. Keep the normal completion
    // tiny and deterministic so the smoke proves the terminal boundary without
    // spending its timeout budget on response generation.
    const normalPrompt = await client.call('prompt', {
      message: 'Reply with exactly: OK',
    });
    assertCorrelatedResponse(normalPrompt, 'prompt');
    await normalStart.promise;
    await normalTerminal.promise;
    const normalSettled = await client.call(GET_STATE);
    assertCorrelatedResponse(normalSettled, GET_STATE);
    if (record(normalSettled.data).isStreaming !== false)
      throw new Error(
        'provider remained streaming after normal terminal event'
      );

    const abortStart = waitForEvent(client, 'agent_start', timeoutMs);
    const abortTerminal = waitForEvent(client, terminal, timeoutMs);
    waits.push(abortStart, abortTerminal);
    const abortPrompt = await client.call('prompt', {
      message:
        'Begin another long response about deterministic testing. Do not use tools.',
    });
    assertCorrelatedResponse(abortPrompt, 'prompt');
    await abortStart.promise;
    const abort = await client.call('abort');
    assertCorrelatedResponse(abort, 'abort');
    await abortTerminal.promise;

    const settled = await client.call(GET_STATE);
    assertCorrelatedResponse(settled, GET_STATE);
    if (record(settled.data).isStreaming !== false)
      throw new Error('provider remained streaming after abort terminal event');
    await client.stop();
    client = undefined;

    resumed = createClient(
      options.provider,
      options.command,
      [...args, ...resumeArgs(options.provider, sessionId)],
      cwd,
      env,
      timeoutMs
    );
    const resumedState = await resumed.start();
    assertCorrelatedResponse(resumedState, GET_STATE);
    if (sessionIdFrom(resumedState) !== sessionId)
      throw new Error('resume did not restore the original provider session');

    return {
      provider: options.provider,
      terminalEvent: terminal,
      sessionHash: hashIdentifier(sessionId),
    };
  } finally {
    for (const wait of waits) wait.cancel();
    await resumed?.stop().catch(() => undefined);
    await client?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function commandAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  const candidates =
    isAbsolute(command) || command.includes('/')
      ? [command]
      : (env.PATH ?? '').split(delimiter).map((entry) => join(entry, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function readProvider(argv: string[]): SmokeProvider[] {
  const positionalIndex = argv.indexOf('--provider');
  const selected =
    argv.find((arg) => arg.startsWith('--provider='))?.slice(11) ??
    (positionalIndex >= 0 ? argv[positionalIndex + 1] : undefined);
  if (!selected || selected === 'both') return [PI, PRIME_AGENT];
  if (selected === PI) return [PI];
  if (selected === PRIME_AGENT || selected === 'prime') return [PRIME_AGENT];
  throw new Error('provider must be pi, prime-agent, or both');
}

function modelFor(
  provider: SmokeProvider,
  env: NodeJS.ProcessEnv
): string | undefined {
  return (
    env[
      provider === PI
        ? 'RELAY_AGENT_RPC_SMOKE_PI_MODEL'
        : 'RELAY_AGENT_RPC_SMOKE_PRIME_MODEL'
    ] ?? env.RELAY_AGENT_RPC_SMOKE_MODEL
  );
}

function commandEnvName(provider: SmokeProvider): string {
  return provider === PI
    ? 'RELAY_AGENT_RPC_SMOKE_PI_COMMAND'
    : 'RELAY_AGENT_RPC_SMOKE_PRIME_COMMAND';
}

function providerSkipReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    /(?:no (?:configured )?model|model.*(?:not found|unknown|not configured|missing|not selected)|(?:not found|unknown|not configured|missing|not selected).*model)/.test(
      message
    )
  )
    return 'provider reported missing or unconfigured model';
  if (
    /(?:\bauth(?:entication|orization)?\b|\bcredentials?\b|\bapi[ -]?key\b|\blogin\b|\bunauthori[sz]ed\b|\bforbidden\b|\baccess token\b)/.test(
      message
    )
  )
    return 'provider reported missing or invalid credentials';
  return undefined;
}

export async function runSmokeCli(
  options: SmokeCliOptions = {}
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  let providers: SmokeProvider[];
  try {
    providers = readProvider(argv);
  } catch (error) {
    log(
      `ERROR agent RPC smoke: ${error instanceof Error ? error.message : 'invalid arguments'}`
    );
    return 1;
  }

  if (env[LIVE_GATE] !== '1') {
    for (const provider of providers)
      log(
        `SKIP ${provider}: set ${LIVE_GATE}=1 to allow model-backed RPC calls`
      );
    return 0;
  }
  if (env[CREDENTIAL_GATE] !== '1') {
    for (const provider of providers)
      log(
        `SKIP ${provider}: set ${CREDENTIAL_GATE}=1 after configuring provider credentials`
      );
    return 0;
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseTimeout(env.RELAY_AGENT_RPC_SMOKE_TIMEOUT_MS);
  } catch (error) {
    log(
      `ERROR agent RPC smoke: ${error instanceof Error ? error.message : 'invalid timeout'}`
    );
    return 1;
  }

  let failed = false;
  for (const provider of providers) {
    const model = modelFor(provider, env);
    if (!model) {
      log(
        `SKIP ${provider}: configure RELAY_AGENT_RPC_SMOKE_${provider === PI ? 'PI' : 'PRIME'}_MODEL or RELAY_AGENT_RPC_SMOKE_MODEL`
      );
      continue;
    }
    const command = env[commandEnvName(provider)] ?? commandFor(provider);
    if (!commandAvailable(command, env)) {
      log(`SKIP ${provider}: command unavailable (${command})`);
      continue;
    }
    try {
      const result = await runProviderSmoke({
        provider,
        command,
        model,
        env,
        timeoutMs,
      });
      log(
        `PASS ${provider}: terminal=${result.terminalEvent} session=${result.sessionHash}`
      );
    } catch (error) {
      // Deliberately do not print provider stderr, prompt text, or raw session
      // identifiers. The concise failure still gives CI a trustworthy signal.
      const skip = providerSkipReason(error);
      if (skip) log(`SKIP ${provider}: ${skip}`);
      else {
        log(`FAIL ${provider}: RPC smoke contract did not complete`);
        failed = true;
      }
    }
  }
  return failed ? 1 : 0;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runSmokeCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        `ERROR agent RPC smoke: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    });
}
