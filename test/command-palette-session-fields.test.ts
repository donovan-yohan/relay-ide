import { describe, expect, it } from 'vitest';
import { buildSessionPaletteResults } from '../frontend/src/lib/command-palette-session-results.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import { makeSession } from './helpers/frontend-factories.js';

function makeFreeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
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

    expect(buildSessionPaletteResults('null-repo', [repoSession], 5)).toHaveLength(1);
    expect(buildSessionPaletteResults('relay', [repoSession], 5)).toHaveLength(1);
  });
});
