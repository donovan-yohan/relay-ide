import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  PrimeAgentRpcClient,
  PrimeAgentRpcResponseError,
} from '../../server/prime-agent-rpc-client.js';

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

describe('PrimeAgentRpcClient', () => {
  it('uses get_state as a correlated readiness barrier', async () => {
    const child = fakeChild();
    const client = new PrimeAgentRpcClient({
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
    const client = new PrimeAgentRpcClient({
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
    const client = new PrimeAgentRpcClient({
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
    const client = new PrimeAgentRpcClient({
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
    await expect(client.call('prompt', { message: 'x' })).rejects.toMatchObject(
      {
        name: 'PrimeAgentRpcResponseError',
        command: 'prompt',
        message: 'nope',
        response: expect.objectContaining({
          command: 'prompt',
          success: false,
        }),
      }
    );
    await expect(
      Promise.reject(
        new PrimeAgentRpcResponseError('compact', {
          type: 'response',
          command: 'compact',
          success: false,
          error: { message: 'method not found: compact' },
        })
      )
    ).rejects.toThrow('method not found: compact');
  });

  it('bounds oversized records and a trailing unterminated tail', async () => {
    const child = fakeChild();
    const client = new PrimeAgentRpcClient({
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
      const client = new PrimeAgentRpcClient({
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
    const client = new PrimeAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
      readinessTimeoutMs: 5,
      stopTimeoutMs: 1,
    });
    await expect(client.start()).rejects.toThrow('get_state timed out');
  });

  it('rejects calls when stdin.write throws synchronously', async () => {
    const child = fakeChild();
    const client = new PrimeAgentRpcClient({
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
    vi.spyOn(child.stdin, 'write').mockImplementation(() => {
      throw new Error('stdin exploded');
    });

    await expect(client.call('prompt', { message: 'x' })).rejects.toThrow(
      'stdin exploded'
    );
  });

  it('cleans a failed readiness attempt before a later start', async () => {
    const failed = fakeChild();
    const ready = fakeChild();
    ready.kill.mockImplementation(() => {
      ready.emit('close', 0);
      return true;
    });
    ready.stdin.once('data', (chunk) => {
      const request = JSON.parse(String(chunk)) as { id: string; type: string };
      ready.stdout.write(
        JSON.stringify({
          id: request.id,
          type: 'response',
          command: request.type,
          success: true,
        }) + '\n'
      );
    });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(failed as unknown as ChildProcess)
      .mockReturnValueOnce(ready as unknown as ChildProcess);
    const client = new PrimeAgentRpcClient({
      spawn,
      readinessTimeoutMs: 1,
      stopTimeoutMs: 1,
    });

    await expect(client.start()).rejects.toThrow('get_state timed out');
    expect(failed.kill).toHaveBeenCalledWith('SIGTERM');
    expect(failed.listenerCount('close')).toBe(0);
    expect(failed.stdout.listenerCount('data')).toBe(0);
    await expect(client.start()).resolves.toMatchObject({
      command: 'get_state',
      success: true,
    });
  });

  it('rejects backpressured calls and removes queued writes on stop', async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      child.emit('close', 0);
      return true;
    });
    let writeCount = 0;
    const write = child.stdin.write.bind(child.stdin);
    vi.spyOn(child.stdin, 'write').mockImplementation((chunk) => {
      writeCount += 1;
      if (writeCount === 1) {
        write(chunk);
        return true;
      }
      return false;
    });
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk)) as { id: string; type: string };
      child.stdout.write(
        JSON.stringify({
          id: request.id,
          type: 'response',
          command: request.type,
          success: true,
        }) + '\n'
      );
    });
    const client = new PrimeAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
    });
    await client.start();
    const first = client.call('prompt', { message: 'one' });
    const second = client.call('prompt', { message: 'two' });

    await client.stop();
    child.stdin.emit('drain');
    await expect(first).rejects.toThrow('PrimeAgentRpcClient stopped');
    await expect(second).rejects.toThrow('PrimeAgentRpcClient stopped');
    expect(writeCount).toBe(2);
    expect(child.stdin.listenerCount('drain')).toBe(0);
  });

  it('times out correlated commands independently', async () => {
    const child = fakeChild();
    const client = new PrimeAgentRpcClient({
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
