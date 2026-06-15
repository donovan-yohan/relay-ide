import { spawn } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENTS_SUBSCRIBE_TOPICS,
  RELAY_CLI_GATEWAY_CONTRACT,
  commandSpec,
  stableCommandNames,
  type RelayCliGatewayCommand,
  type RelayCliGatewayEnvelope,
} from '../../shared/cli-gateway-contract.js';

const RELAY_BIN = 'dist/bin/relay-ide.js';
const ALLOWED_TOPICS = EVENTS_SUBSCRIBE_TOPICS;
const TOPIC_SMOKE_EVENT_TYPES = {
  'automation-runs': 'automation-run.status-changed',
  'pr-overseer': 'pr-overseer.status-changed',
} as const;

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  marker: string | string[] | undefined;
  capabilities: string | string[] | undefined;
};

interface FakeHub {
  port: number;
  captured: CapturedRequest[];
  close: () => Promise<void>;
  /** Resolves when at least one /events stream is open and ready to push. */
  whenSubscribed: () => Promise<http.ServerResponse>;
  /** Active subscriber response, if any. */
  activeStream: () => http.ServerResponse | undefined;
}

interface FakeHubOptions {
  /** Capability decision: 'allow' (default), 'deny', or 'reject-topic'. */
  policy?: 'allow' | 'deny' | 'reject-topic';
}

function ndjsonWrite(res: http.ServerResponse, envelope: unknown): void {
  res.write(`${JSON.stringify(envelope)}\n`);
}

async function startFakeHub(options: FakeHubOptions = {}): Promise<FakeHub> {
  const captured: CapturedRequest[] = [];
  let activeRes: http.ServerResponse | undefined;
  let resolveSubscribed: ((res: http.ServerResponse) => void) | undefined;
  const subscribed = new Promise<http.ServerResponse>((resolve) => {
    resolveSubscribed = resolve;
  });

  const server = http.createServer((req, res) => {
    captured.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      marker: req.headers['x-relay-cli-gateway'],
      capabilities: req.headers['x-relay-capabilities'],
    });

    if (req.method !== 'GET' || !req.url?.startsWith('/events')) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const topic = url.searchParams.get('topic');
    if (!topic || !ALLOWED_TOPICS.includes(topic as (typeof ALLOWED_TOPICS)[number])) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: { code: 'INVALID_ARGUMENT', message: 'unknown topic' },
        })
      );
      return;
    }

    if (options.policy === 'deny') {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'FORBIDDEN',
            message: 'missing required capability: session:read',
            details: { capability: 'session:read' },
          },
        })
      );
      return;
    }

    if (options.policy === 'reject-topic') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'INVALID_ARGUMENT',
            message: `unsupported topic: ${topic}`,
            details: { field: 'topic', value: topic },
          },
        })
      );
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    activeRes = res;
    req.on('close', () => {
      if (activeRes === res) activeRes = undefined;
    });
    resolveSubscribed?.(res);
    resolveSubscribed = undefined;
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    captured,
    activeStream: () => activeRes,
    whenSubscribed: () => subscribed,
    close: async () => {
      if (activeRes) {
        try {
          activeRes.end();
        } catch {
          /* already closed */
        }
      }
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  envelopes: RelayCliGatewayEnvelope[];
  stderr: string;
}

function parseEnvelopesFromStdout(buffer: string): RelayCliGatewayEnvelope[] {
  const envelopes: RelayCliGatewayEnvelope[] = [];
  const trimmed = buffer.trim();
  if (trimmed.length === 0) return envelopes;

  // Try line-by-line NDJSON first (used by streaming verbs).
  let parsedAnyLine = false;
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      envelopes.push(JSON.parse(t) as RelayCliGatewayEnvelope);
      parsedAnyLine = true;
    } catch {
      parsedAnyLine = false;
      break;
    }
  }
  if (parsedAnyLine) return envelopes;

  // Fall back to pretty-printed JSON (used by printGatewayEnvelope error/oneshot).
  envelopes.length = 0;
  try {
    envelopes.push(JSON.parse(trimmed) as RelayCliGatewayEnvelope);
  } catch {
    /* malformed — leave empty so the test surfaces it */
  }
  return envelopes;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { killAfterEnvelopes?: number; timeoutMs?: number } = {}
): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELAY_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const streamingEnvelopes: RelayCliGatewayEnvelope[] = [];
    let stdoutBuf = '';
    let stderrBuf = '';
    let killed = false;
    let leftover = '';

    const killTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, options.timeoutMs ?? 5000);

    const handleLine = (line: string): void => {
      if (line.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !('ok' in (parsed as Record<string, unknown>)) ||
        !('contract' in (parsed as Record<string, unknown>))
      ) {
        return;
      }
      streamingEnvelopes.push(parsed as RelayCliGatewayEnvelope);
      if (
        options.killAfterEnvelopes !== undefined &&
        streamingEnvelopes.length >= options.killAfterEnvelopes &&
        !killed
      ) {
        killed = true;
        child.kill('SIGINT');
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuf += text;
      leftover += text;
      let newlineIdx = leftover.indexOf('\n');
      while (newlineIdx >= 0) {
        const line = leftover.slice(0, newlineIdx).trim();
        leftover = leftover.slice(newlineIdx + 1);
        handleLine(line);
        newlineIdx = leftover.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(killTimer);
      const envelopes =
        streamingEnvelopes.length > 0
          ? streamingEnvelopes
          : parseEnvelopesFromStdout(stdoutBuf);
      resolve({ exitCode, signal, envelopes, stderr: stderrBuf });
    });
  });
}

describe('CLI gateway events.subscribe contract', () => {
  it('advertises events.subscribe in the stable command manifest', () => {
    expect(stableCommandNames()).toContain('events.subscribe');
  });

  it('declares non-destructive, capability-gated, NDJSON streaming behavior', () => {
    const spec = commandSpec('events.subscribe' as RelayCliGatewayCommand);
    expect(spec.stable).toBe(true);
    expect(spec.requiresAuth).toBe(true);
    expect(spec.cli).toContain('subscribe');
    expect(spec.cli).toContain('--topic');
    expect(spec.cli).toContain('--json');
    expect(spec.capabilityHints).toEqual(
      expect.arrayContaining(['session:read', 'tab:intervention:read', 'context:read', 'inbox:read'])
    );
    expect(spec.transport).toBe('hub-http');

    // No destructive ops in the verb's argument surface.
    expect(JSON.stringify(spec.inputSchema)).not.toContain('exec');
    expect(JSON.stringify(spec.inputSchema)).not.toContain('write');
    expect(JSON.stringify(spec.inputSchema)).not.toContain('delete');

    const inputProps = spec.inputSchema.properties ?? {};
    expect(inputProps['topic']).toBeDefined();
    expect(inputProps['topic']?.enum).toEqual(expect.arrayContaining([...ALLOWED_TOPICS]));

    expect(spec.errorCodes).toEqual(
      expect.arrayContaining(['UNAUTHORIZED', 'INVALID_ARGUMENT', 'FORBIDDEN'])
    );
  });

  it('validates the streaming output envelope shape', () => {
    const spec = commandSpec('events.subscribe' as RelayCliGatewayCommand);
    const outputData = spec.outputSchema.properties?.data;
    expect(outputData).toBeDefined();
    const dataProps = outputData?.properties ?? {};
    expect(dataProps['event']).toBeDefined();
    expect(dataProps['event']?.enum).toEqual(
      expect.arrayContaining(['open', 'event', 'closed'])
    );
    expect(dataProps['topic']).toBeDefined();
    expect(dataProps['topic']?.enum).toEqual(
      expect.arrayContaining([...ALLOWED_TOPICS])
    );
    expect(dataProps['sequence']).toBeDefined();
  });

  it('does not register additional destructive verbs on the manifest', () => {
    // events.subscribe is the only new verb in this slice. No siblings.
    const eventsCommands = RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.filter((spec) =>
      spec.name.startsWith('events.')
    );
    expect(eventsCommands.map((s) => s.name)).toEqual(['events.subscribe']);
  });
});

describe('CLI gateway events.subscribe runtime', () => {
  let hub: FakeHub | undefined;
  afterEach(async () => {
    if (hub) {
      await hub.close();
      hub = undefined;
    }
  });

  it('streams NDJSON envelopes from the hub for an allowed topic', async () => {
    hub = await startFakeHub();
    const port = hub.port;

    const runPromise = runCli(
      ['v1', 'events', 'subscribe', '--topic', 'sessions', '--max-events', '2', '--json'],
      {
        RELAY_IDE_PORT: String(port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
      { timeoutMs: 5000 }
    );

    const streamRes = await hub.whenSubscribed();
    ndjsonWrite(streamRes, { event: 'open', topic: 'sessions', sequence: 0 });
    ndjsonWrite(streamRes, {
      event: 'event',
      topic: 'sessions',
      sequence: 1,
      occurredAt: '2026-05-19T00:00:00.000Z',
      payload: { type: 'session.started', sessionId: 's1' },
    });
    ndjsonWrite(streamRes, {
      event: 'event',
      topic: 'sessions',
      sequence: 2,
      occurredAt: '2026-05-19T00:00:00.100Z',
      payload: { type: 'session.ended', sessionId: 's1' },
    });

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    // CLI should emit at least: open frame, 2 event frames, closed frame.
    const events = result.envelopes.filter(
      (e) => e.ok === true && e.command === 'events.subscribe'
    );
    expect(events.length).toBeGreaterThanOrEqual(3);
    const openFrame = events.find((e) => (e.ok && (e.data as { event: string }).event) === 'open');
    expect(openFrame).toBeDefined();
    const dataFrames = events.filter(
      (e) => e.ok && (e.data as { event: string }).event === 'event'
    );
    expect(dataFrames).toHaveLength(2);
    const closed = events.find((e) => e.ok && (e.data as { event: string }).event === 'closed');
    expect(closed).toBeDefined();

    const captured = hub.captured.find((entry) => entry.url?.startsWith('/events'));
    expect(captured?.authorization).toBe('Bearer scoped-token');
    expect(captured?.marker).toBe('v1');
    expect(captured?.capabilities).toContain('session:read');
    expect(captured?.url).toContain('topic=sessions');
  });

  it('reports a typed FORBIDDEN error when the hub denies the capability', async () => {
    hub = await startFakeHub({ policy: 'deny' });

    const result = await runCli(
      ['v1', 'events', 'subscribe', '--topic', 'sessions', '--json'],
      {
        RELAY_IDE_PORT: String(hub.port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
      { timeoutMs: 5000 }
    );

    expect(result.exitCode).not.toBe(0);
    const errorEnvelope = result.envelopes.find((e) => e.ok === false);
    expect(errorEnvelope).toBeDefined();
    if (!errorEnvelope || errorEnvelope.ok) throw new Error('expected error envelope');
    expect(errorEnvelope.command).toBe('events.subscribe');
    expect(errorEnvelope.error.code).toBe('FORBIDDEN');
  });

  it('rejects unknown topics locally before opening any hub request', async () => {
    const result = await runCli(
      ['v1', 'events', 'subscribe', '--topic', 'pty-bytes', '--json'],
      {
        // Use a definitely-unused port; the CLI must fail fast before connecting.
        RELAY_IDE_PORT: '1',
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
      { timeoutMs: 5000 }
    );

    expect(result.exitCode).not.toBe(0);
    const errorEnvelope = result.envelopes.find((e) => e.ok === false);
    if (!errorEnvelope) {
      throw new Error(
        `expected error envelope; envelopes=${JSON.stringify(result.envelopes)} stderr=${result.stderr}`
      );
    }
    if (errorEnvelope.ok) throw new Error('expected error envelope');
    expect(errorEnvelope.command).toBe('events.subscribe');
    expect(errorEnvelope.error.code).toBe('INVALID_ARGUMENT');
    const details = errorEnvelope.error.details ?? {};
    expect(details).toMatchObject({ field: 'topic' });
  });

  it('closes the stream cleanly when the hub ends the connection', async () => {
    hub = await startFakeHub();

    const runPromise = runCli(
      ['v1', 'events', 'subscribe', '--topic', 'nodes', '--json'],
      {
        RELAY_IDE_PORT: String(hub.port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
      { timeoutMs: 5000 }
    );

    const res = await hub.whenSubscribed();
    ndjsonWrite(res, { event: 'open', topic: 'nodes', sequence: 0 });
    ndjsonWrite(res, {
      event: 'event',
      topic: 'nodes',
      sequence: 1,
      occurredAt: '2026-05-19T00:00:00.000Z',
      payload: { type: 'node.online', nodeId: 'node-a' },
    });
    // Hub closes the stream after one event.
    res.end();

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    const closed = result.envelopes.find(
      (e) => e.ok && (e.data as { event: string }).event === 'closed'
    );
    expect(closed).toBeDefined();
  });

  it('subscribes to workflow-runs metadata with context read capability', async () => {
    hub = await startFakeHub();

    const runPromise = runCli(
      ['v1', 'events', 'subscribe', '--topic', 'workflow-runs', '--max-events', '1', '--json'],
      {
        RELAY_IDE_PORT: String(hub.port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
      { timeoutMs: 5000 }
    );

    const streamRes = await hub.whenSubscribed();
    ndjsonWrite(streamRes, { event: 'open', topic: 'workflow-runs', sequence: 0 });
    ndjsonWrite(streamRes, {
      event: 'event',
      topic: 'workflow-runs',
      sequence: 1,
      cursor: 'cg:1:1',
      occurredAt: '2026-05-19T00:00:00.000Z',
      payload: {
        type: 'workflow-run.state-changed',
        workflowRunId: 'workflow-run:test',
        workContextId: 'wc:test',
        state: 'succeeded',
        redaction: {
          rawPayloadIncluded: false,
          rawTranscriptIncluded: false,
          artifactBodyIncluded: false,
        },
      },
    });

    const result = await runPromise;
    expect(result.exitCode).toBe(0);

    const captured = hub.captured.find((entry) => entry.url?.startsWith('/events'));
    expect(captured?.url).toContain('topic=workflow-runs');
    expect(captured?.capabilities).toContain('context:read');

    const dataFrame = result.envelopes.find(
      (e) => e.ok && e.command === 'events.subscribe' && (e.data as { event: string }).event === 'event'
    );
    if (!dataFrame || !dataFrame.ok) throw new Error('expected workflow-runs event frame');
    const data = dataFrame.data as { topic: string; payload: { type?: string; workflowRunId?: string } };
    expect(data.topic).toBe('workflow-runs');
    expect(data.payload.type).toBe('workflow-run.state-changed');
    expect(data.payload.workflowRunId).toBe('workflow-run:test');
  });

  it.each(['automation-runs', 'pr-overseer'] as const)(
    'subscribes to %s metadata with context read capability',
    async (topic) => {
      hub = await startFakeHub();

      const runPromise = runCli(
        ['v1', 'events', 'subscribe', '--topic', topic, '--max-events', '1', '--json'],
        {
          RELAY_IDE_PORT: String(hub.port),
          RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
        },
        { timeoutMs: 5000 }
      );

      const streamRes = await hub.whenSubscribed();
      ndjsonWrite(streamRes, { event: 'open', topic, sequence: 0 });
      ndjsonWrite(streamRes, {
        event: 'event',
        topic,
        sequence: 1,
        cursor: 'cg:1:1',
        occurredAt: '2026-06-15T00:00:00.000Z',
        payload: {
          type: TOPIC_SMOKE_EVENT_TYPES[topic],
          redaction: {
            rawPayloadIncluded: false,
            rawTranscriptIncluded: false,
            artifactBodyIncluded: false,
          },
        },
      });

      const result = await runPromise;
      expect(result.exitCode).toBe(0);

      const captured = hub.captured.find((entry) => entry.url?.startsWith('/events'));
      expect(captured?.url).toContain(`topic=${topic}`);
      expect(captured?.capabilities).toContain('context:read');
      expect(captured?.capabilities).not.toContain('session:read');
    }
  );

  it('passes attention cursor/replay through to the CLI envelope for resume', async () => {
    // #963: an automation loop resumes from the per-event cursor. The CLI must
    // surface `cursor` and `replay` (not just `payload`) so the resume + gap
    // contract works end-to-end.
    hub = await startFakeHub();

    const runPromise = runCli(
      [
        'v1',
        'events',
        'subscribe',
        '--topic',
        'attention',
        '--session-id',
        'local:s1',
        '--max-events',
        '1',
        '--json',
      ],
      {
        RELAY_IDE_PORT: String(hub.port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
      { timeoutMs: 5000 }
    );

    const streamRes = await hub.whenSubscribed();
    ndjsonWrite(streamRes, { event: 'open', topic: 'attention', sequence: 0 });
    ndjsonWrite(streamRes, {
      event: 'event',
      topic: 'attention',
      sequence: 1,
      cursor: 'cg:42:7',
      replay: true,
      occurredAt: '2026-06-15T00:00:00.000Z',
      payload: {
        type: 'attention.state-changed',
        sessionId: 's1',
        backendState: 'permission',
        needsAttention: true,
        reasons: ['permission-prompt'],
        redaction: {
          rawPayloadIncluded: false,
          rawTranscriptIncluded: false,
          artifactBodyIncluded: false,
        },
      },
    });

    const result = await runPromise;
    expect(result.exitCode).toBe(0);

    const captured = hub.captured.find((entry) => entry.url?.startsWith('/events'));
    expect(captured?.url).toContain('topic=attention');
    expect(captured?.url).toContain('sessionId=local%3As1');
    expect(captured?.capabilities).toContain('session:read');

    const dataFrame = result.envelopes.find(
      (e) =>
        e.ok &&
        e.command === 'events.subscribe' &&
        (e.data as { event: string }).event === 'event'
    );
    if (!dataFrame || !dataFrame.ok) throw new Error('expected attention event frame');
    const data = dataFrame.data as {
      topic: string;
      cursor?: string;
      replay?: boolean;
      payload: { backendState?: string; needsAttention?: boolean };
    };
    expect(data.topic).toBe('attention');
    expect(data.cursor).toBe('cg:42:7');
    expect(data.replay).toBe(true);
    expect(data.payload.backendState).toBe('permission');
    expect(data.payload.needsAttention).toBe(true);
  });

  it('subscribes to the audit topic with the union of required capabilities', async () => {
    // PR #608 / Copilot+Gemini regression guard: the `audit` topic needs both
    // `session:read` and `tab:intervention:read` on the hub side. The CLI
    // must send both so the hub doesn't return FORBIDDEN, and the redacted
    // audit payload shape must round-trip cleanly through the gateway envelope.
    hub = await startFakeHub();

    const runPromise = runCli(
      ['v1', 'events', 'subscribe', '--topic', 'audit', '--max-events', '1', '--json'],
      {
        RELAY_IDE_PORT: String(hub.port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
      { timeoutMs: 5000 }
    );

    const streamRes = await hub.whenSubscribed();
    ndjsonWrite(streamRes, { event: 'open', topic: 'audit', sequence: 0 });
    ndjsonWrite(streamRes, {
      event: 'event',
      topic: 'audit',
      sequence: 1,
      occurredAt: '2026-05-19T00:00:00.000Z',
      payload: {
        type: 'audit.event',
        kind: 'tab.mode-changed',
        sessionId: 's1',
        // Redaction envelope: raw control bytes are never forwarded.
        redacted: true,
      },
    });

    const result = await runPromise;
    expect(result.exitCode).toBe(0);

    const captured = hub.captured.find((entry) => entry.url?.startsWith('/events'));
    expect(captured?.url).toContain('topic=audit');
    expect(captured?.capabilities).toContain('session:read');
    expect(captured?.capabilities).toContain('tab:intervention:read');

    const events = result.envelopes.filter(
      (e) => e.ok === true && e.command === 'events.subscribe'
    );
    const dataFrames = events.filter(
      (e) => e.ok && (e.data as { event: string }).event === 'event'
    );
    expect(dataFrames).toHaveLength(1);
    const frame = dataFrames[0];
    if (!frame || !frame.ok) throw new Error('expected ok frame');
    const data = frame.data as { topic: string; payload: { redacted?: boolean; kind?: string } };
    expect(data.topic).toBe('audit');
    expect(data.payload.kind).toBe('tab.mode-changed');
    expect(data.payload.redacted).toBe(true);
  });
});
