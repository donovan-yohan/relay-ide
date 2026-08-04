import { describe, expect, it } from 'vitest';
import { buildSessionPaletteResults } from '../frontend/src/lib/command-palette-session-results.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
import { makeSession } from './helpers/frontend-factories.js';

function makeTopic(overrides: Partial<WorkspaceTopic> = {}): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: 'topic:a',
    workspaceId: 'ws:a',
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: { title: 'auth channel' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: {},
    linkedRefs: {},
    state: { pinned: false, muted: false },
    privacy: {
      classification: 'internal',
      retention: 'project',
      redaction: 'summary',
      rawDefaultsStored: false,
    },
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function makeFreeSession(
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  const {
    repoName: _repoName,
    repoPath: _repoPath,
    worktreePath: _worktreePath,
    branchName: _branchName,
    ...session
  } = makeSession({
    id: 'free-session',
    cwd: '/tmp/free-shell',
    displayName: 'free shell',
    ...overrides,
  });
  return session;
}

describe('buildSessionPaletteResults', () => {
  it('filters and renders free sessions with omitted repo fields', () => {
    const freeSession = makeFreeSession();

    const results = buildSessionPaletteResults('free', [freeSession], 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'sess-free-session',
      label: 'free shell',
      sublabel: '',
      data: freeSession,
    });
  });

  it('preserves repo-bound branch and repo search behavior', () => {
    const repoSession = makeSession({
      id: 'repo-session',
      repoName: 'relay-ide',
      branchName: 'fix/null-repo',
      displayName: 'repo tab',
    });

    expect(
      buildSessionPaletteResults('null-repo', [repoSession], 5)
    ).toHaveLength(1);
    expect(buildSessionPaletteResults('relay', [repoSession], 5)).toHaveLength(
      1
    );
  });

  it('shows the parent channel as sublabel when a session matches a topic', () => {
    const session = makeSession({
      id: 'repo-session',
      repoName: 'relay-ide',
      repoPath: '/repo/relay',
      displayName: 'repo tab',
    });
    const topic = makeTopic({ routingDefaults: { repoPath: '/repo/relay' } });
    const results = buildSessionPaletteResults('repo', [session], 5, [topic]);
    expect(results[0]?.sublabel).toBe('auth channel');
  });

  it('falls back to the repo name when no topic matches', () => {
    const session = makeSession({
      id: 'repo-session',
      repoName: 'relay-ide',
      repoPath: '/repo/other',
      displayName: 'repo tab',
    });
    const topic = makeTopic({ routingDefaults: { repoPath: '/repo/relay' } });
    const results = buildSessionPaletteResults('repo', [session], 5, [topic]);
    expect(results[0]?.sublabel).toBe('relay-ide');
  });
});
