import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import {
  createMockAttachmentFactory,
  createRawAttachmentFactory,
  createTmuxAttachmentFactory,
} from '../server/session-attachment.js';

type DataHandler = (chunk: string) => void;
type ExitHandler = (event: { exitCode: number; signal?: number }) => void;

class FakePty {
  cols: number;
  rows: number;
  written: string[] = [];
  killed = false;
  private dataHandlers: DataHandler[] = [];
  private exitHandlers: ExitHandler[] = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  onData(handler: DataHandler): { dispose: () => void } {
    this.dataHandlers.push(handler);
    return {
      dispose: () => {
        this.dataHandlers = this.dataHandlers.filter((h) => h !== handler);
      },
    };
  }

  onExit(handler: ExitHandler): { dispose: () => void } {
    this.exitHandlers.push(handler);
    return {
      dispose: () => {
        this.exitHandlers = this.exitHandlers.filter((h) => h !== handler);
      },
    };
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(): void {
    this.killed = true;
    for (const handler of this.exitHandlers.slice()) handler({ exitCode: 0 });
  }

  emitData(chunk: string): void {
    for (const handler of this.dataHandlers.slice()) handler(chunk);
  }
}

describe('SessionAttachment — raw factory', () => {
  it('spawns shell, writes/resizes propagate, close kills pty', async () => {
    let lastPty: FakePty | undefined;
    const factory = createRawAttachmentFactory({
      spawn: (cmd, args, options) => {
        lastPty = new FakePty(options.cols ?? 80, options.rows ?? 24);
        return lastPty as unknown as IPty;
      },
    });
    const attachment = await factory.open({
      sessionId: 's1',
      command: 'bash',
      args: ['-i'],
      cwd: '/tmp',
      env: {},
      cols: 100,
      rows: 30,
    });
    expect(attachment.mode).toBe('raw');
    expect(lastPty!.cols).toBe(100);

    let received: Buffer | undefined;
    attachment.onData((bytes) => {
      received = bytes;
    });
    lastPty!.emitData('hello');
    expect(received?.toString('utf8')).toBe('hello');

    attachment.write(Buffer.from('echo hi\n', 'utf8'));
    expect(lastPty!.written).toEqual(['echo hi\n']);

    attachment.resize(120, 40);
    expect(lastPty!.cols).toBe(120);
    expect(lastPty!.rows).toBe(40);

    await attachment.close();
    expect(lastPty!.killed).toBe(true);
    expect(attachment.status()).toBe('closed');
  });
});

describe('SessionAttachment — tmux factory', () => {
  it('ensures session then attaches via spawn (no real tmux invoked)', async () => {
    const ensureCalls: Array<{ target: string; sessionId: string }> = [];
    let attachArgs: string[] | undefined;
    const factory = createTmuxAttachmentFactory({
      tmuxPath: '/fake/tmux',
      socketName: 'relay-test',
      configDir: '/tmp/relay-tmux-test',
      ensureSession: ({ target, options }) => {
        ensureCalls.push({ target, sessionId: options.sessionId });
      },
      spawn: (cmd, args, options) => {
        attachArgs = args;
        const proc = new FakePty(options.cols ?? 80, options.rows ?? 24);
        return proc as unknown as IPty;
      },
    });
    const attachment = await factory.open({
      sessionId: 'sess-1',
      command: 'bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    expect(attachment.mode).toBe('tmux');
    expect(ensureCalls).toEqual([
      { target: 'relay-sess-1', sessionId: 'sess-1' },
    ]);
    expect(attachArgs).toContain('attach-session');
    expect(attachArgs).toContain('relay-sess-1');
    expect(attachArgs).toContain('-L');
    expect(attachArgs).toContain('relay-test');
  });

  it('sanitizes session ids containing tmux-illegal characters', async () => {
    let attachArgs: string[] | undefined;
    const factory = createTmuxAttachmentFactory({
      tmuxPath: '/fake/tmux',
      socketName: 'relay-test',
      configDir: '/tmp/relay-tmux-test',
      ensureSession: () => undefined,
      spawn: (cmd, args, options) => {
        attachArgs = args;
        return new FakePty(
          options.cols ?? 80,
          options.rows ?? 24
        ) as unknown as IPty;
      },
    });
    await factory.open({
      sessionId: 'has:colon and space.dot',
      command: 'bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    expect(attachArgs).toContain('relay-has_colon_and_space_dot');
  });

  it('reattaching to the same sessionId reuses the existing tmux session', async () => {
    const calls: string[] = [];
    const factory = createTmuxAttachmentFactory({
      tmuxPath: '/fake/tmux',
      socketName: 'relay-test',
      configDir: '/tmp/relay-tmux-test',
      ensureSession: ({ target }) => {
        calls.push(target);
      },
      spawn: (cmd, args, options) =>
        new FakePty(options.cols ?? 80, options.rows ?? 24) as unknown as IPty,
    });
    await factory.open({
      sessionId: 'live',
      command: 'bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    await factory.open({
      sessionId: 'live',
      command: 'bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    // ensureSession is invoked for both opens — its body is responsible
    // for choosing has-session/new-session. Both invocations resolve to
    // the same tmux target, which is the resume primitive.
    expect(calls).toEqual(['relay-live', 'relay-live']);
  });
});

describe('SessionAttachment — mock factory', () => {
  it('records writes and resizes, replays scripted data', async () => {
    const factory = createMockAttachmentFactory({
      data: ['boot-banner\n'],
    });
    const received: Buffer[] = [];
    const attachment = await factory.open({
      sessionId: 's1',
      command: 'bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    attachment.onData((bytes) => received.push(bytes));
    factory.emit('after-listener');
    expect(received.map((b) => b.toString('utf8'))).toEqual(['after-listener']);

    attachment.write(Buffer.from('input', 'utf8'));
    attachment.resize(120, 40);
    expect(factory.records[0]!.written.map((b) => b.toString('utf8'))).toEqual([
      'input',
    ]);
    expect(factory.records[0]!.resizes).toEqual([{ cols: 120, rows: 40 }]);

    await attachment.close('shutdown');
    expect(factory.records[0]!.closed).toBe(true);
    expect(factory.records[0]!.closeReason).toBe('shutdown');
  });

  it('close emits a synthetic exit event', async () => {
    const factory = createMockAttachmentFactory();
    const attachment = await factory.open({
      sessionId: 's1',
      command: 'bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    let exited = false;
    attachment.onExit(() => {
      exited = true;
    });
    await attachment.close();
    expect(exited).toBe(true);
  });
});
