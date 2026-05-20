// repo-to-environment (#630) — stopgap adapter that derives the env picker
// candidate list from the locally-known Repo projection. Verifies the
// invariants the dialog and downstream launch hook rely on.

import { describe, expect, it } from 'vitest';
import {
  repoToEnvironmentOption,
  reposToEnvironmentOptions,
} from '../../frontend/src/lib/repo-to-environment.js';
import type { Repo } from '../../frontend/src/lib/types.js';

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

function gitRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    path: '/Users/dev/repos/relay-ide',
    name: 'relay-ide',
    isGitRepo: true,
    defaultBranch: 'master',
    currentBranch: 'nightly',
    localPath: '/Users/dev/repos/relay-ide',
    nodeId: 'local',
    repoIdentity: 'github.com/donovan-yohan/relay-ide',
    repoInstanceId: 'local:/Users/dev/repos/relay-ide',
    ...overrides,
  };
}

describe('repoToEnvironmentOption', () => {
  it('maps a git repo to a repo-cwdMode option with the canonical repoIdentity', () => {
    const opt = repoToEnvironmentOption(gitRepo(), GENERATED_AT);
    expect(opt.cwdMode).toBe('repo');
    expect(opt.repoInstance?.repoIdentity).toBe(
      'github.com/donovan-yohan/relay-ide'
    );
    expect(opt.repoInstance?.localPath).toBe('/Users/dev/repos/relay-ide');
    expect(opt.freshness).toBe('fresh');
    expect(opt.node.nodeId).toBe('local');
  });

  it('maps a non-git directory to a free-cwd option with no repoInstance', () => {
    const opt = repoToEnvironmentOption(
      gitRepo({
        isGitRepo: false,
        name: 'scratch',
        path: '/tmp/scratch',
        localPath: '/tmp/scratch',
      }),
      GENERATED_AT
    );
    expect(opt.cwdMode).toBe('free');
    expect(opt.repoInstance).toBeUndefined();
  });

  it('defaults nodeId to DEFAULT_LOCAL_NODE_ID when missing', () => {
    const opt = repoToEnvironmentOption(
      gitRepo({ nodeId: undefined as unknown as Repo['nodeId'] }),
      GENERATED_AT
    );
    expect(opt.node.nodeId).toBe('local');
  });
});

describe('reposToEnvironmentOptions', () => {
  it('produces one option per repo + a trailing free home option', () => {
    const opts = reposToEnvironmentOptions(
      [gitRepo()],
      GENERATED_AT
    );
    expect(opts.length).toBe(2);
    expect(opts[1]?.cwdMode).toBe('free');
    expect(opts[1]?.cwd).toBe('~');
  });

  it('is deterministic for identical inputs (stable refs for React memoization)', () => {
    // Gemini PR #646: defaulting `generatedAt` to `new Date().toISOString()`
    // would re-stamp every option on every call and break memoization at
    // every call site. The signature now requires the timestamp, and the
    // resulting `generatedAt` field MUST be identical when the input is.
    const a = reposToEnvironmentOptions([gitRepo()], GENERATED_AT);
    const b = reposToEnvironmentOptions([gitRepo()], GENERATED_AT);
    expect(a).toEqual(b);
    expect(a.every((opt) => opt.generatedAt === GENERATED_AT)).toBe(true);
  });

  it('produces unique ids per option', () => {
    const opts = reposToEnvironmentOptions(
      [
        gitRepo({ repoInstanceId: 'a' }),
        gitRepo({
          repoInstanceId: 'b',
          path: '/Users/dev/other',
          localPath: '/Users/dev/other',
        }),
      ],
      GENERATED_AT
    );
    const ids = new Set(opts.map((o) => o.id));
    expect(ids.size).toBe(opts.length);
  });
});
