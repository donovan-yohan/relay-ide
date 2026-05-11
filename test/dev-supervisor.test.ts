import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  BackendSupervisor,
  shouldWatchDevSourceFile,
} from '../scripts/dev-supervisor.js';

class FakeChild extends EventEmitter {
  killed = false;
  readonly killedWith: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killedWith.push(signal ?? 'SIGTERM');
    return true;
  }
}

function asChild(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

describe('BackendSupervisor', () => {
  it('rebuilds before restarting the backend child and leaves restart ownership to graceful SIGTERM shutdown', () => {
    const children: FakeChild[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];
    const supervisor = new BackendSupervisor({
      packageRoot: '/repo',
      backendScript: '/repo/dist/server/index.js',
      backendEnv: { RELAY_IDE_PORT: '4567', NO_PIN: '1' },
      spawn(command, args) {
        calls.push({ command, args });
        const child = new FakeChild();
        children.push(child);
        return asChild(child);
      },
      log() {},
      error() {},
    });

    supervisor.start();
    expect(calls).toEqual([
      { command: process.execPath, args: ['/repo/dist/server/index.js'] },
    ]);

    supervisor.requestRestart('server/index.ts');

    expect(calls.at(-1)).toEqual({
      command: 'npm',
      args: ['run', 'build:server'],
    });
    expect(children[0]!.killed).toBe(false);

    children[1]!.emit('exit', 0, null);

    expect(children[0]!.killedWith).toEqual(['SIGTERM']);
    expect(calls).toHaveLength(2);

    children[0]!.emit('exit', 0, 'SIGTERM');

    expect(calls.at(-1)).toEqual({
      command: process.execPath,
      args: ['/repo/dist/server/index.js'],
    });
    expect(calls).toHaveLength(3);
  });

  it('keeps the running backend alive when rebuild fails', () => {
    const children: FakeChild[] = [];
    const supervisor = new BackendSupervisor({
      packageRoot: '/repo',
      backendScript: '/repo/dist/server/index.js',
      backendEnv: {},
      spawn() {
        const child = new FakeChild();
        children.push(child);
        return asChild(child);
      },
      log() {},
      error() {},
    });

    supervisor.start();
    supervisor.requestRestart('server/index.ts');
    children[1]!.emit('exit', 2, null);

    expect(children[0]!.killed).toBe(false);
    expect(children).toHaveLength(2);
  });

  it('watches backend TypeScript sources but ignores generated output and frontend-only files', () => {
    expect(shouldWatchDevSourceFile('/repo/server/index.ts', '/repo')).toBe(
      true
    );
    expect(
      shouldWatchDevSourceFile('/repo/shared/chat-events.ts', '/repo')
    ).toBe(true);
    expect(
      shouldWatchDevSourceFile('/repo/dist/server/index.js', '/repo')
    ).toBe(false);
    expect(
      shouldWatchDevSourceFile('/repo/frontend/src/App.tsx', '/repo')
    ).toBe(false);
  });
});
