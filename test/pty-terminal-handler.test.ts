import { afterEach, describe, expect, it } from 'vitest';
import {
  createPtySession,
  handleTerminalAttentionUpdate,
} from '../server/pty-handler.js';
import * as sessions from '../server/sessions.js';
import type { PtySession, Session } from '../server/types.js';

const createdIds: string[] = [];

afterEach(() => {
  for (const id of createdIds.splice(0)) {
    if (sessions.get(id)) sessions.kill(id);
  }
});

describe('terminal-only PTY sessions', () => {
  it('creates an explicit terminal command in the public registry', () => {
    const result = sessions.create({
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });
    createdIds.push(result.id);

    expect(result).toMatchObject({
      type: 'terminal',
      mode: 'pty',
      terminalBackend: 'relay-pty',
    });
  });

  it('rejects a missing terminal command before spawning', () => {
    expect(() =>
      sessions.create({
        repoPath: '/tmp',
        worktreePath: null,
        cwd: '/tmp',
      })
    ).toThrow('require an explicit shell or command');
  });

  it('rejects the retired PTY agent type at the low-level spawn boundary', () => {
    expect(() =>
      createPtySession(
        {
          id: 'retired-agent',
          type: 'agent',
          cwd: '/tmp',
          command: '/bin/cat',
        } as never,
        new Map<string, Session>()
      )
    ).toThrow('PTY sessions only support terminals');
  });
});

describe('terminal attention detection', () => {
  function terminalWithVisibleText(text: string): PtySession {
    return {
      id: 'terminal-attention',
      type: 'terminal',
      activityState: 'idle',
      terminalModel: { getVisibleText: () => text },
    } as unknown as PtySession;
  }

  it('surfaces a visible approval prompt', () => {
    const session = terminalWithVisibleText('Allow this command? (y/n)');
    const states: string[] = [];

    handleTerminalAttentionUpdate(
      session,
      [(_id, state) => states.push(state)],
      undefined
    );

    expect(session.activityState).toBe('permission-prompt');
    expect(session.permissionType).toBe('approval');
    expect(states).toEqual(['permission-prompt']);
  });

  it('clears terminal-model attention after the prompt disappears', () => {
    const session = terminalWithVisibleText('');
    session.activityState = 'permission-prompt';
    session.permissionPromptSource = 'terminal-model';
    session.permissionType = 'approval';
    const states: string[] = [];

    handleTerminalAttentionUpdate(
      session,
      [(_id, state) => states.push(state)],
      undefined
    );

    expect(session.activityState).toBe('idle');
    expect(session.permissionType).toBeUndefined();
    expect(states).toEqual(['idle']);
  });
});
