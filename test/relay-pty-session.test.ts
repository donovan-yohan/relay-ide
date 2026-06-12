import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import {
  createLibghosttyTerminalModelBackend,
  encodeTerminalInput,
  isTerminalInputKey,
} from '../server/terminal-model-backend.js';
import {
  buildRelayPtySessionEnv,
  createRelayPtySession,
} from '../server/relay-pty-session.js';

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
    return { dispose: () => undefined };
  }

  onExit(handler: ExitHandler): { dispose: () => void } {
    this.exitHandlers.push(handler);
    return { dispose: () => undefined };
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
    for (const handler of this.exitHandlers) handler({ exitCode: 0 });
  }

  emitData(chunk: string): void {
    for (const handler of this.dataHandlers) handler(chunk);
  }
}

describe('TerminalModelBackend — libghostty-vt', () => {
  it('models visible text, cursor, title, resize, and alt screen from terminal bytes', () => {
    const backend = createLibghosttyTerminalModelBackend({ cols: 20, rows: 5, scrollbackLimit: 10 });
    backend.feed('\x1b]2;relay-title\x07hello\r\nworld');

    const normal = backend.snapshot({ includeCells: true });
    expect(normal.backend).toBe('libghostty-vt');
    expect(normal.title).toBe('relay-title');
    expect(normal.visibleText).toContain('hello');
    expect(normal.visibleText).toContain('world');
    expect(normal.cursor.row).toBeGreaterThanOrEqual(0);
    expect(normal.modes.altScreen).toBe(false);
    expect(normal.cells?.length).toBeGreaterThan(0);

    backend.resize(40, 10);
    backend.feed('\x1b[?1049h\x1b[Halt-screen');
    const alt = backend.snapshot();
    expect(alt.cols).toBe(40);
    expect(alt.rows).toBe(10);
    expect(alt.modes.altScreen).toBe(true);
    expect(alt.visibleText).toContain('alt-screen');
    backend.dispose();
  });

  it('tracks OSC titles split across feed calls with BEL terminators', () => {
    const backend = createLibghosttyTerminalModelBackend({ cols: 20, rows: 5, scrollbackLimit: 10 });

    backend.feed('\x1b]2;spl');
    backend.feed('it-title\x07hello');

    const snapshot = backend.snapshot();
    expect(snapshot.title).toBe('split-title');
    expect(snapshot.visibleText).toContain('hello');
    backend.dispose();
  });

  it('tracks OSC titles split across feed calls with ST terminators', () => {
    const backend = createLibghosttyTerminalModelBackend({ cols: 20, rows: 5, scrollbackLimit: 10 });

    backend.feed('\x1b]0;st-title\x1b');
    backend.feed('\\hello');

    const snapshot = backend.snapshot();
    expect(snapshot.title).toBe('st-title');
    expect(snapshot.visibleText).toContain('hello');
    backend.dispose();
  });

  it('encodes typed input keys without tmux send-keys names', () => {
    expect(encodeTerminalInput({ type: 'text', text: 'abc' }).sequence).toBe('abc');
    expect(encodeTerminalInput({ type: 'key', key: 'Enter' }).bytes).toEqual(Buffer.from('\r'));
    expect(encodeTerminalInput({ type: 'key', key: 'Escape' }).sequence).toBe('\x1b');
    expect(encodeTerminalInput({ type: 'key', key: 'Tab' }).sequence).toBe('\t');
    expect(encodeTerminalInput({ type: 'key', key: 'ArrowUp' }).sequence).toBe('\x1b[A');
    expect(encodeTerminalInput({ type: 'key', key: 'ArrowDown' }).sequence).toBe('\x1b[B');
    expect(encodeTerminalInput({ type: 'key', key: 'ArrowLeft' }).sequence).toBe('\x1b[D');
    expect(encodeTerminalInput({ type: 'key', key: 'ArrowRight' }).sequence).toBe('\x1b[C');
    expect(encodeTerminalInput({ type: 'key', key: 'CtrlC' }).sequence).toBe('\x03');
  });

  it('rejects Object prototype names as terminal input keys', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isTerminalInputKey(key)).toBe(false);
      const invalidInput = { type: 'key' as const, key } as Parameters<typeof encodeTerminalInput>[0];
      expect(() => encodeTerminalInput(invalidInput)).toThrow(
        `Unsupported terminal input key: ${key}`
      );
    }
  });
});

describe('RelayPtySession prototype', () => {
  it('spawns the requested command directly, not through tmux, and feeds a terminal model', () => {
    let lastPty: FakePty | undefined;
    let spawnedCommand: string | undefined;
    let spawnedArgs: string[] | undefined;
    let spawnedEnv: Record<string, string | undefined> | undefined;

    const session = createRelayPtySession({
      id: 'relay-pty-test',
      command: 'fake-agent',
      args: ['--tui'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { CUSTOM_ENV: 'ok' },
      relayCliPath: '/tmp/relay-ide',
      workContextId: 'wc-1',
      taskRef: 'github:834',
      spawn: (command, args, options) => {
        spawnedCommand = command;
        spawnedArgs = args;
        spawnedEnv = options.env as Record<string, string>;
        lastPty = new FakePty(options.cols ?? 0, options.rows ?? 0);
        return lastPty as unknown as IPty;
      },
    });

    expect(spawnedCommand).toBe('fake-agent');
    expect(spawnedArgs).toEqual(['--tui']);
    expect(spawnedCommand).not.toBe('tmux');
    expect(spawnedEnv?.RELAY_IDE_SESSION_ID).toBe('relay-pty-test');
    expect(spawnedEnv?.RELAY_IDE_SESSION_RUNTIME).toBe('relay-pty/libghostty-vt');
    expect(spawnedEnv?.RELAY_IDE_CLI_PATH).toBe('/tmp/relay-ide');
    expect(spawnedEnv?.RELAY_IDE_WORK_CONTEXT_ID).toBe('wc-1');
    expect(spawnedEnv?.RELAY_IDE_TASK_REF).toBe('github:834');

    lastPty?.emitData('\x1b]2;agent\x07ready\r\n> ');
    session.sendText('hello');
    session.sendKey('Enter');
    session.sendKey('Escape');
    session.sendKey('Tab');
    session.sendKey('ArrowUp');
    session.sendKey('ArrowDown');
    session.sendKey('ArrowLeft');
    session.sendKey('ArrowRight');
    session.sendKey('CtrlC');
    session.resize(100, 30);

    expect(lastPty?.written).toEqual([
      'hello',
      '\r',
      '\x1b',
      '\t',
      '\x1b[A',
      '\x1b[B',
      '\x1b[D',
      '\x1b[C',
      '\x03',
    ]);
    expect(lastPty?.cols).toBe(100);
    expect(lastPty?.rows).toBe(30);

    const snapshot = session.snapshot({ includeCells: true });
    expect(snapshot.terminal.title).toBe('agent');
    expect(snapshot.terminal.visibleText).toContain('ready');
    expect(snapshot.timing.lastOutputAt).not.toBeNull();
    expect(snapshot.timing.lastInputAt).not.toBeNull();
    expect(snapshot.timing.lastResizeAt).not.toBeNull();

    session.close();
    expect(lastPty?.killed).toBe(true);
  });

  it('injects Relay identity env without preserving CLAUDECODE', () => {
    const env = buildRelayPtySessionEnv({
      id: 's1',
      env: { CLAUDECODE: 'bad', RELAY_IDE_TOKEN: 'allowed' },
      relayCliPath: '/bin/relay-ide',
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.RELAY_IDE_SESSION_ID).toBe('s1');
    expect(env.RELAY_IDE_SESSION_RUNTIME).toBe('relay-pty/libghostty-vt');
    expect(env.RELAY_IDE_CLI_PATH).toBe('/bin/relay-ide');
    expect(env.RELAY_IDE_TOKEN).toBe('allowed');
  });
});
