import { describe, expect, it } from 'vitest';

import {
  AGENT_ROLES,
  DEFAULT_AGENT_ROLE_MAP,
  collaborationPromptAppendix,
  deriveRosterAttention,
  projectRosterEntry,
  roleForAgent,
  type RosterSessionInput,
} from '../shared/agent-roster.js';

describe('roleForAgent', () => {
  it('maps known providers to default roles', () => {
    expect(roleForAgent('claude')).toBe('implementer');
    expect(roleForAgent('codex')).toBe('reviewer');
    expect(roleForAgent('hermes')).toBe('orchestrator');
    expect(roleForAgent('ebi')).toBe('orchestrator');
    expect(roleForAgent('opencode')).toBe('implementer');
  });

  it('normalizes case/whitespace and falls back to collaborator', () => {
    expect(roleForAgent('  Claude  ')).toBe('implementer');
    expect(roleForAgent('CODEX')).toBe('reviewer');
    expect(roleForAgent('some-unknown-agent')).toBe('collaborator');
    expect(roleForAgent('')).toBe('collaborator');
    expect(roleForAgent(undefined)).toBe('collaborator');
  });

  it('honors per-call overrides without mutating the default map', () => {
    expect(roleForAgent('claude', { claude: 'reviewer' })).toBe('reviewer');
    expect(DEFAULT_AGENT_ROLE_MAP['claude']).toBe('implementer');
    expect(AGENT_ROLES).toContain('collaborator');
  });
});

describe('deriveRosterAttention', () => {
  it('flags permission prompts and waiting-for-input', () => {
    expect(
      deriveRosterAttention({ agentState: 'permission-prompt' })
    ).toMatchObject({
      needsAttention: true,
      reasons: ['permission-prompt'],
    });
    expect(
      deriveRosterAttention({ agentState: 'waiting-for-input' }).reasons
    ).toEqual(['waiting-for-input']);
  });

  it('folds pending inbox backlog into attention', () => {
    const attention = deriveRosterAttention({
      agentState: 'idle',
      pendingInboxCount: 3,
    });
    expect(attention).toMatchObject({
      needsAttention: true,
      pendingInboxCount: 3,
    });
    expect(attention.reasons).toEqual(['pending-inbox']);
  });

  it('is quiet for an idle session with no backlog', () => {
    expect(deriveRosterAttention({ agentState: 'idle' })).toEqual({
      needsAttention: false,
      reasons: [],
      pendingInboxCount: 0,
    });
  });

  it('clamps negative/fractional inbox counts', () => {
    expect(
      deriveRosterAttention({ pendingInboxCount: -5 }).pendingInboxCount
    ).toBe(0);
    expect(
      deriveRosterAttention({ pendingInboxCount: 2.9 }).pendingInboxCount
    ).toBe(2);
  });

  it('guards non-finite inbox counts before JSON projection', () => {
    expect(
      deriveRosterAttention({ pendingInboxCount: Number.NaN }).pendingInboxCount
    ).toBe(0);
    expect(
      deriveRosterAttention({ pendingInboxCount: Number.POSITIVE_INFINITY })
        .pendingInboxCount
    ).toBe(0);
  });
});

describe('projectRosterEntry', () => {
  const session: RosterSessionInput = {
    id: 'sess-1',
    globalSessionId: 'node-a:sess-1',
    nodeId: 'node-a',
    agent: 'claude',
    type: 'agent',
    displayName: 'Implementer A',
    repoPath: '/home/u/relay-ide',
    repoName: 'relay-ide',
    branchName: 'feat/x',
    cwd: '/home/u/relay-ide',
    workContextId: 'wc:1',
    controlMode: 'agent-driven',
    status: 'active',
    agentState: 'permission-prompt',
    activeActors: [{ kind: 'agent', id: 'a1', displayName: 'Claude' }],
    lastActivity: '2026-06-13T00:00:00.000Z',
    createdAt: '2026-06-12T00:00:00.000Z',
  };

  it('projects identity, role, and derived attention', () => {
    const entry = projectRosterEntry(session, {
      capabilities: ['hooks', 'continue'],
      pendingInboxCount: 1,
    });
    expect(entry).toMatchObject({
      sessionId: 'sess-1',
      globalSessionId: 'node-a:sess-1',
      provider: 'claude',
      role: 'implementer',
      sessionType: 'agent',
      workContextId: 'wc:1',
      controlMode: 'agent-driven',
      capabilities: ['hooks', 'continue'],
    });
    expect(entry.attention.needsAttention).toBe(true);
    expect(entry.attention.reasons).toContain('permission-prompt');
    expect(entry.attention.reasons).toContain('pending-inbox');
    expect(entry.activeActors).toEqual([
      { kind: 'agent', id: 'a1', displayName: 'Claude' },
    ]);
  });

  it('is redaction-safe — never carries transcript/prompt/env/token fields', () => {
    const entry = projectRosterEntry(
      {
        ...session,
        // Simulate a session record that (hypothetically) carried sensitive fields.
        ...({
          transcript: 'secret',
          prompt: 'do x',
          env: { TOKEN: 'abc' },
          apiKey: 'k',
        } as object),
      } as RosterSessionInput,
      { capabilities: ['hooks'] }
    );
    const serialized = JSON.stringify(entry);
    // Forbidden keys (quoted to avoid matching values like "permission-prompt")
    // and the injected secret values must never survive projection.
    for (const forbidden of [
      '"transcript"',
      '"prompt"',
      '"env"',
      '"apiKey"',
      'secret',
      'do x',
      'abc',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('defaults role to collaborator and sessionType to agent for sparse input', () => {
    const entry = projectRosterEntry({ id: 'sess-2' });
    expect(entry).toMatchObject({
      sessionId: 'sess-2',
      provider: '',
      role: 'collaborator',
      sessionType: 'agent',
      displayName: 'sess-2',
      capabilities: [],
    });
    expect(entry.attention.needsAttention).toBe(false);
  });
});

describe('collaborationPromptAppendix', () => {
  it('names the role and references Relay-owned collaboration verbs (not raw tmux/PTY)', () => {
    const text = collaborationPromptAppendix({ provider: 'codex' });
    expect(text).toContain('role: reviewer');
    expect(text).toContain('relay-ide v1 roster list');
    // #964: external agents are told how to self-declare + heartbeat presence.
    expect(text).toContain('relay-ide v1 roster register');
    expect(text).toContain('roster update-self');
    expect(text).toContain('relay-ide v1 inbox');
    expect(text).toContain('events subscribe --topic inbox');
    expect(text).toContain('events subscribe --topic attention');
    expect(text.toLowerCase()).not.toContain('tmux');
    expect(text.toLowerCase()).not.toContain('pty');
  });
});
