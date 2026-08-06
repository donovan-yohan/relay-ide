import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { PiAgentRpcClient } from '../../server/pi-agent-rpc-client.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('PiAgentRpcClient', () => {
  it('uses get_state as a correlated readiness barrier', async () => {
    const child = fakeChild();
    const client = new PiAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
    });
    let outbound = '';
    child.stdin.on('data', (chunk) => {
      outbound += String(chunk);
      const line = outbound.split('\n')[0];
      if (line) {
        const request = JSON.parse(line) as { id: string; type: string };
        child.stdout.write(
          JSON.stringify({
            id: request.id,
            type: 'response',
            command: request.type,
            success: true,
            data: { sessionId: 's1' },
          }) + '\n'
        );
      }
    });
    const ready = await client.start();
    expect(JSON.parse(outbound.trim())).toMatchObject({ type: 'get_state' });
    expect(ready.data).toEqual({ sessionId: 's1' });
  });

  it('splits on LF only and preserves Unicode line separators inside JSON', async () => {
    const child = fakeChild();
    const client = new PiAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
    });
    child.stdin.once('data', (chunk) => {
      const request = JSON.parse(String(chunk)) as { id: string };
      child.stdout.write(
        `{"id":"${request.id}","type":"response","command":"get_state","success":true}\r\n`
      );
    });
    await client.start();
    const events: unknown[] = [];
    client.on('event', (event) => events.push(event));
    child.stdout.write('{"type":"message_update","text":"a\u2028b\u2029c"}\n');
    expect(events).toEqual([
      { type: 'message_update', text: 'a\u2028b\u2029c' },
    ]);
  });

  it('decodes UTF-8 characters split across stdout chunks', async () => {
    const child = fakeChild();
    const client = new PiAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
    });
    child.stdin.once('data', (chunk) => {
      const request = JSON.parse(String(chunk)) as { id: string };
      child.stdout.write(
        JSON.stringify({
          id: request.id,
          type: 'response',
          command: 'get_state',
          success: true,
        }) + '\n'
      );
    });
    await client.start();
    const events: unknown[] = [];
    client.on('event', (event) => events.push(event));
    const record = Buffer.from(
      JSON.stringify({ type: 'message_update', text: 'before 😀 after' }) + '\n'
    );
    const emoji = Buffer.from('😀');
    const splitAt = record.indexOf(emoji) + 2;
    child.stdout.write(record.subarray(0, splitAt));
    child.stdout.write(record.subarray(splitAt));
    expect(events).toEqual([
      { type: 'message_update', text: 'before 😀 after' },
    ]);
  });

  it('rejects failed and mismatched correlated responses', async () => {
    const child = fakeChild();
    const client = new PiAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
    });
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk)) as { id: string; type: string };
      child.stdout.write(
        JSON.stringify({
          id: request.id,
          type: 'response',
          command: request.type,
          success: request.type === 'get_state',
          error: 'nope',
        }) + '\n'
      );
    });
    await client.start();
    await expect(client.call('prompt', { message: 'x' })).rejects.toThrow(
      'nope'
    );
  });

  it('bounds oversized records and a trailing unterminated tail', async () => {
    const child = fakeChild();
    const client = new PiAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
      maxBufferBytes: 32,
      maxRecordBytes: 100,
      stopTimeoutMs: 5,
    });
    child.stdin.once('data', (chunk) => {
      const request = JSON.parse(String(chunk)) as { id: string };
      child.stdout.write(
        JSON.stringify({
          id: request.id,
          type: 'response',
          command: 'get_state',
          success: true,
        }) + '\n'
      );
    });
    await client.start();
    const errors: Error[] = [];
    const events: unknown[] = [];
    client.on('protocolError', (error) => errors.push(error));
    client.on('event', (event) => events.push(event));
    child.stdout.write(
      JSON.stringify({ type: 'event', text: 'y'.repeat(120) }) + '\n'
    );
    child.stdout.write(
      JSON.stringify({ type: 'event', accepted: true }) + '\n' + 'x'.repeat(33)
    );
    expect(events).toEqual([{ type: 'event', accepted: true }]);
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringContaining('record exceeded'),
      expect.stringContaining('input buffer exceeded'),
    ]);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0);
  });

  it('awaits close and escalates stop to SIGKILL after a bounded delay', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const client = new PiAgentRpcClient({
        spawn: () => child as unknown as ChildProcess,
        stopTimeoutMs: 10,
      });
      child.stdin.once('data', (chunk) => {
        const request = JSON.parse(String(chunk)) as { id: string };
        child.stdout.write(
          JSON.stringify({
            id: request.id,
            type: 'response',
            command: 'get_state',
            success: true,
          }) + '\n'
        );
      });
      await client.start();

      let stopped = false;
      const stopping = client.stop().then(() => {
        stopped = true;
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(stopped).toBe(false);
      child.emit('close', 0);
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out readiness when get_state never responds', async () => {
    const child = fakeChild();
    const client = new PiAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
      readinessTimeoutMs: 5,
    });
    await expect(client.start()).rejects.toThrow('get_state timed out');
  });

  it('times out correlated commands independently', async () => {
    const child = fakeChild();
    const client = new PiAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
      requestTimeoutMs: 5,
    });
    child.stdin.once('data', (chunk) => {
      const request = JSON.parse(String(chunk)) as { id: string };
      child.stdout.write(
        JSON.stringify({
          id: request.id,
          type: 'response',
          command: 'get_state',
          success: true,
        }) + '\n'
      );
    });
    await client.start();
    await expect(client.call('prompt', { message: 'wait' })).rejects.toThrow(
      'prompt timed out'
    );
  });
});
