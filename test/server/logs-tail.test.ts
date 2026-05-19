import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RELAY_LOG_EVENT_SCHEMA_VERSION,
  logEventMatchesFilter,
  parseLogEvent,
  serializeLogEvent,
  type StructuredLogEvent,
} from '../../shared/log-event.js';
import {
  LEGACY_DEFAULT_ALLOWED_CAPABILITIES,
  RELAY_CAPABILITY_BITS,
  isRelayCapabilityBit,
} from '../../shared/security-policy.js';
import {
  parseNodeLogTailRequest,
  readNodeLogTailSnapshot,
  createNodeLogFollower,
} from '../../server/node-logs.js';
import { requiredCapabilitiesForRpcIntent } from '../../server/hub-policy-evaluator.js';
import { appendStructuredLogEvent, structuredLogFilename } from '../../server/log-events.js';

function makeEvent(overrides: Partial<StructuredLogEvent> = {}): StructuredLogEvent {
  return {
    schemaVersion: RELAY_LOG_EVENT_SCHEMA_VERSION,
    ts: '2026-05-19T12:00:00.000Z',
    level: 'info',
    subsystem: 'pty-host',
    msg: 'spawned pty',
    ...overrides,
  };
}

describe('structured log event schema', () => {
  it('round-trips a serialized event through parseLogEvent', () => {
    const event = makeEvent({
      ctx: { sessionId: 'sess-1', pid: 1234 },
    });
    const serialized = serializeLogEvent(event);
    expect(serialized.endsWith('\n')).toBe(false);
    expect(serialized.includes('\n')).toBe(false);
    const parsed = parseLogEvent(serialized);
    expect(parsed).toEqual(event);
  });

  it('rejects malformed lines without throwing', () => {
    expect(parseLogEvent('not json')).toBeUndefined();
    expect(parseLogEvent('')).toBeUndefined();
    expect(parseLogEvent('null')).toBeUndefined();
    expect(parseLogEvent('[]')).toBeUndefined();
    expect(parseLogEvent(JSON.stringify({ schemaVersion: 999, ts: 'x', level: 'info', subsystem: 'a', msg: 'b' }))).toBeUndefined();
    expect(
      parseLogEvent(
        JSON.stringify({ schemaVersion: RELAY_LOG_EVENT_SCHEMA_VERSION, ts: '', level: 'banana', subsystem: 'a', msg: 'b' })
      )
    ).toBeUndefined();
  });

  it('filters by level/subsystem/sinceTs', () => {
    const debugEvent = makeEvent({ level: 'debug', ts: '2026-05-19T12:00:00.000Z' });
    const warnEvent = makeEvent({ level: 'warn', subsystem: 'policy', ts: '2026-05-19T12:00:05.000Z' });
    expect(logEventMatchesFilter(debugEvent, { level: 'info' })).toBe(false);
    expect(logEventMatchesFilter(warnEvent, { level: 'info' })).toBe(true);
    expect(logEventMatchesFilter(warnEvent, { subsystem: 'pty-host' })).toBe(false);
    expect(logEventMatchesFilter(warnEvent, { subsystem: 'policy' })).toBe(true);
    expect(logEventMatchesFilter(warnEvent, { sinceTs: '2026-05-19T12:00:00.000Z' })).toBe(true);
    expect(logEventMatchesFilter(warnEvent, { sinceTs: '2026-05-19T12:00:05.000Z' })).toBe(false);
    expect(logEventMatchesFilter(warnEvent, { sinceTs: 'not-a-date' })).toBe(false);
  });
});

describe('logs:read capability bit', () => {
  it('is registered in the policy capability set', () => {
    expect(RELAY_CAPABILITY_BITS).toContain('logs:read');
    expect(isRelayCapabilityBit('logs:read')).toBe(true);
  });

  it('is included in the legacy default allow-list (logs are operator-visible by default)', () => {
    expect(LEGACY_DEFAULT_ALLOWED_CAPABILITIES).toContain('logs:read');
  });

  it('maps the logs.tail RPC intent to the logs:read capability', () => {
    expect(requiredCapabilitiesForRpcIntent('logs.tail')).toEqual(['logs:read']);
  });
});

describe('appendStructuredLogEvent', () => {
  it('appends a JSON line with a trailing newline to <logDir>/relay-ide.jsonl', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-logs-append-'));
    const event = makeEvent({
      ctx: { sessionId: 'sess-1' },
    });
    appendStructuredLogEvent(tmp, event);
    appendStructuredLogEvent(
      tmp,
      makeEvent({ level: 'error', msg: 'spawn failed', subsystem: 'pty-host' })
    );
    const filePath = path.join(tmp, structuredLogFilename());
    const contents = fs.readFileSync(filePath, 'utf8');
    const lines = contents.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const parsedFirst = parseLogEvent(lines[0]!);
    expect(parsedFirst).toBeDefined();
    expect(parsedFirst?.ctx).toEqual({ sessionId: 'sess-1' });
  });
});

describe('parseNodeLogTailRequest filters', () => {
  it('accepts level/subsystem/sinceTs filter fields', () => {
    const parsed = parseNodeLogTailRequest({
      lines: 50,
      level: 'warn',
      subsystem: 'policy',
      sinceTs: '2026-05-19T12:00:00.000Z',
    });
    expect(parsed).not.toHaveProperty('code');
    expect(parsed).toMatchObject({
      lines: 50,
      level: 'warn',
      subsystem: 'policy',
      sinceTs: '2026-05-19T12:00:00.000Z',
    });
  });

  it('rejects unknown levels', () => {
    const parsed = parseNodeLogTailRequest({ lines: 10, level: 'banana' });
    expect(parsed).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects non-string subsystem', () => {
    const parsed = parseNodeLogTailRequest({ lines: 10, subsystem: 42 });
    expect(parsed).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects malformed sinceTs', () => {
    const parsed = parseNodeLogTailRequest({ lines: 10, sinceTs: 'not-a-date' });
    expect(parsed).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('still accepts the legacy plaintext-only payload', () => {
    const parsed = parseNodeLogTailRequest({ lines: 5 });
    expect(parsed).toMatchObject({ lines: 5, follow: false });
  });
});

describe('readNodeLogTailSnapshot with structured events', () => {
  function setupLogDir(): { tmp: string; configPath: string; logDir: string } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-logs-tail-'));
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    return { tmp, configPath: path.join(tmp, 'config.json'), logDir };
  }

  it('returns redacted JSONL events when the structured log file is present', () => {
    const { configPath, logDir } = setupLogDir();
    const events: StructuredLogEvent[] = [
      makeEvent({ ts: '2026-05-19T12:00:00.000Z', level: 'info', msg: 'startup' }),
      makeEvent({
        ts: '2026-05-19T12:00:01.000Z',
        level: 'warn',
        subsystem: 'policy',
        msg: 'Authorization: Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      }),
    ];
    for (const event of events) appendStructuredLogEvent(logDir, event);
    const snapshot = readNodeLogTailSnapshot({
      configPath,
      serviceLogDir: logDir,
      lines: 100,
      structured: true,
    });
    expect('code' in snapshot).toBe(false);
    if ('code' in snapshot) return;
    expect(snapshot.status).toBe('ok');
    expect(snapshot.events).toBeDefined();
    expect(snapshot.events).toHaveLength(2);
    const second = snapshot.events![1]!;
    expect(second.msg).not.toContain('ghp_1234567890');
    expect(second.msg).toContain('[REDACTED]');
    expect(snapshot.redacted).toBe(true);
  });

  it('filters events by level/subsystem/sinceTs', () => {
    const { configPath, logDir } = setupLogDir();
    appendStructuredLogEvent(logDir, makeEvent({ ts: '2026-05-19T12:00:00.000Z', level: 'debug', subsystem: 'pty-host', msg: 'spawn' }));
    appendStructuredLogEvent(logDir, makeEvent({ ts: '2026-05-19T12:00:01.000Z', level: 'warn', subsystem: 'policy', msg: 'deny' }));
    appendStructuredLogEvent(logDir, makeEvent({ ts: '2026-05-19T12:00:02.000Z', level: 'error', subsystem: 'policy', msg: 'fail-closed' }));
    const snapshot = readNodeLogTailSnapshot({
      configPath,
      serviceLogDir: logDir,
      lines: 100,
      structured: true,
      filter: { level: 'warn', subsystem: 'policy', sinceTs: '2026-05-19T12:00:01.000Z' },
    });
    expect('code' in snapshot).toBe(false);
    if ('code' in snapshot) return;
    expect(snapshot.events).toBeDefined();
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events![0]!.msg).toBe('fail-closed');
  });

  it('returns an empty snapshot when the structured log file is empty', () => {
    const { configPath, logDir } = setupLogDir();
    fs.writeFileSync(path.join(logDir, structuredLogFilename()), '', 'utf8');
    const snapshot = readNodeLogTailSnapshot({
      configPath,
      serviceLogDir: logDir,
      lines: 50,
      structured: true,
    });
    expect('code' in snapshot).toBe(false);
    if ('code' in snapshot) return;
    expect(snapshot.status).toBe('empty');
    expect(snapshot.events).toEqual([]);
  });

  it('keeps the plaintext path working when structured=false (back-compat)', () => {
    const { configPath, logDir } = setupLogDir();
    fs.writeFileSync(path.join(logDir, 'relay-ide.log'), 'plain line one\nplain line two\n', 'utf8');
    const snapshot = readNodeLogTailSnapshot({
      configPath,
      serviceLogDir: logDir,
      lines: 50,
    });
    expect('code' in snapshot).toBe(false);
    if ('code' in snapshot) return;
    expect(snapshot.status).toBe('ok');
    expect(snapshot.output).toContain('plain line two');
    expect(snapshot.events).toBeUndefined();
  });

  it('redacts secret-shaped fixtures: token, PIN, bearer, cookie, ghp_ token', () => {
    const { configPath, logDir } = setupLogDir();
    const fixtures = [
      'Authorization: Bearer relay_bearer_token_fixture',
      'githubToken=ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      'PIN=123456',
      'cookie: session=abc.def.ghi',
    ];
    for (const fixture of fixtures) {
      appendStructuredLogEvent(logDir, makeEvent({ msg: fixture }));
    }
    const snapshot = readNodeLogTailSnapshot({
      configPath,
      serviceLogDir: logDir,
      lines: 100,
      structured: true,
    });
    expect('code' in snapshot).toBe(false);
    if ('code' in snapshot) return;
    const serialized = JSON.stringify(snapshot.events);
    expect(serialized).not.toContain('relay_bearer_token_fixture');
    expect(serialized).not.toContain('ghp_1234567890');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(snapshot.redacted).toBe(true);
  });
});

describe('createNodeLogFollower close semantics', () => {
  it('emits clean close when the log file is empty and no writes happen', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-logs-follower-empty-'));
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'relay-ide.log'), '', 'utf8');
    const writes: string[] = [];
    const follower = createNodeLogFollower({
      configPath: path.join(tmp, 'config.json'),
      serviceLogDir: logDir,
      write: (chunk) => writes.push(chunk),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    follower.close();
    expect(writes).toHaveLength(0);
  });
});

// Suppress unused-import warnings for utilities exercised through dynamic
// branches; vitest's mock helper stays available for follow-up tests.
void vi;
