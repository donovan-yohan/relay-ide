import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { PrimeAgentRpcClient } from '../../server/prime-agent-rpc-client.js';

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
    await expect(client.call('prompt', { message: 'x' })).rejects.toThrow(
      'nope'
    );
  });

  it('bounds unterminated input and oversized records without killing the transport', async () => {
    const child = fakeChild();
    const client = new PrimeAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
      maxBufferBytes: 32,
      maxRecordBytes: 100,
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
    client.on('protocolError', (error) => errors.push(error));
    child.stdout.write('x'.repeat(33));
    child.stdout.write(
      JSON.stringify({ type: 'event', text: 'y'.repeat(120) }) + '\n'
    );
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringContaining('input buffer exceeded'),
      expect.stringContaining('record exceeded'),
    ]);
  });

  it('times out readiness when get_state never responds', async () => {
    const child = fakeChild();
    const client = new PrimeAgentRpcClient({
      spawn: () => child as unknown as ChildProcess,
      readinessTimeoutMs: 5,
    });
    await expect(client.start()).rejects.toThrow('get_state timed out');
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
