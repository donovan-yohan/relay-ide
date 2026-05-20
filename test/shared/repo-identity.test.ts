// #624 acceptance-criteria coverage for the canonical RepoIdentity
// normalizer. The general normalizer contract is exercised in
// test/repo-identity.test.ts; this file focuses on the edge cases the issue
// calls out explicitly so they cannot regress silently:
//
//   - trailing slash
//   - .git suffix (present or absent)
//   - mixed case host
//   - port-bearing ssh URLs (ssh://git@host:22/...)
//   - non-GitHub hosts (gitlab.com, bitbucket.org, custom self-hosted)
//   - bad inputs produce a typed warning, never throw
//   - JSON round-trip preserves all fields
//   - non-git cwd (resolveCanonicalRepoIdentity with no remotes) returns
//     identity: null, not an error

import { describe, expect, it } from 'vitest';

import {
  normalizeRemoteUrl,
  resolveCanonicalRepoIdentity,
  type NormalizedRemoteIdentity,
} from '../../shared/repo-identity.js';

const CANONICAL_GITHUB = 'github.com/owner/repo';

const GITHUB_EQUIVALENT_URLS: readonly string[] = [
  'https://github.com/owner/repo',
  'https://github.com/owner/repo/',
  'https://github.com/owner/repo.git',
  'https://github.com/owner/repo.git/',
  'https://github.com/Owner/Repo',
  'https://github.com/Owner/Repo.git',
  'https://GITHUB.com/owner/repo.git',
  'https://github.COM/Owner/Repo/',
  'https://github.com:443/owner/repo.git',
  'git@github.com:owner/repo.git',
  'git@github.com:owner/repo',
  'git@GitHub.com:Owner/Repo.git',
  'ssh://git@github.com/owner/repo.git',
  'ssh://git@github.com:22/owner/repo.git',
  'ssh://git@github.com:2222/Owner/Repo',
  'ssh://git@github.com:22/owner/repo.git/',
];

describe('normalizeRemoteUrl (#624 acceptance criteria)', () => {
  it.each(GITHUB_EQUIVALENT_URLS)(
    'collapses %s to the canonical github.com/owner/repo identity',
    (url) => {
      const result = normalizeRemoteUrl(url);
      expect(result.identity).toBe(CANONICAL_GITHUB);
      expect(result.provider).toBe('github');
      expect(result.host).toBe('github.com');
      expect(result.owner).toBe('owner');
      expect(result.name).toBe('repo');
      expect(result.warning).toBeUndefined();
    }
  );

  it('preserves host and path for non-GitHub providers (gitlab)', () => {
    const result = normalizeRemoteUrl(
      'git@gitlab.example.com:Team/Tools.git'
    );
    expect(result).toMatchObject({
      identity: 'gitlab.example.com/Team/Tools',
      provider: 'git',
      host: 'gitlab.example.com',
      path: 'Team/Tools',
      owner: 'Team',
      name: 'Tools',
    });
    expect(result.warning).toBeUndefined();
  });

  it('preserves host and path for non-GitHub providers (bitbucket)', () => {
    const result = normalizeRemoteUrl(
      'https://bitbucket.org/Team/repo.git'
    );
    expect(result).toMatchObject({
      identity: 'bitbucket.org/Team/repo',
      provider: 'git',
      host: 'bitbucket.org',
      path: 'Team/repo',
    });
  });

  it('preserves nested paths for self-hosted gitea/forgejo style remotes', () => {
    const result = normalizeRemoteUrl(
      'ssh://git@code.internal.example.com:2222/group/subgroup/repo.git'
    );
    expect(result).toMatchObject({
      identity: 'code.internal.example.com/group/subgroup/repo',
      provider: 'git',
      host: 'code.internal.example.com',
      path: 'group/subgroup/repo',
      owner: 'group',
      name: 'repo',
    });
  });

  it('lower-cases the host on non-GitHub remotes too', () => {
    const result = normalizeRemoteUrl(
      'https://Gitlab.Example.COM/Team/Repo.git'
    );
    expect(result.host).toBe('gitlab.example.com');
    expect(result.identity).toBe('gitlab.example.com/Team/Repo');
  });

  it('returns a typed warning rather than throwing on empty input', () => {
    expect(() => normalizeRemoteUrl('')).not.toThrow();
    const result = normalizeRemoteUrl('');
    expect(result.identity).toBeNull();
    expect(result.warning).toBe('malformed-remote-url');
  });

  it('returns a typed warning rather than throwing on whitespace-only input', () => {
    expect(() => normalizeRemoteUrl('   \t  ')).not.toThrow();
    expect(normalizeRemoteUrl('   \t  ').warning).toBe(
      'malformed-remote-url'
    );
  });

  it('returns a typed warning rather than throwing on malformed URLs', () => {
    for (const garbage of [
      'not a url',
      'http://',
      'github.com/no-owner',
      'ssh://',
      '://malformed',
    ]) {
      expect(() => normalizeRemoteUrl(garbage)).not.toThrow();
      expect(normalizeRemoteUrl(garbage).identity).toBeNull();
    }
  });

  it('rejects github URLs with extra path segments instead of inventing identity', () => {
    for (const url of [
      'https://github.com/owner/repo/tree/main',
      'https://github.com/owner/repo/pull/123',
      'git@github.com:owner/repo/extra.git',
    ]) {
      const result = normalizeRemoteUrl(url);
      expect(result.identity).toBeNull();
      expect(result.host).toBe('github.com');
      expect(result.warning).toBe('malformed-remote-url');
    }
  });

  it('preserves all fields across a JSON round-trip', () => {
    const original = normalizeRemoteUrl(
      'ssh://git@github.com:2222/Owner/Repo.git'
    );
    const restored: NormalizedRemoteIdentity = JSON.parse(
      JSON.stringify(original)
    );
    expect(restored).toEqual(original);
    expect(restored.identity).toBe(CANONICAL_GITHUB);
    expect(restored.provider).toBe('github');
  });

  it('preserves the malformed-warning discriminator across JSON round-trip', () => {
    const original = normalizeRemoteUrl('not a remote');
    const restored: NormalizedRemoteIdentity = JSON.parse(
      JSON.stringify(original)
    );
    expect(restored).toEqual(original);
    expect(restored.warning).toBe('malformed-remote-url');
    expect(restored.identity).toBeNull();
  });
});

describe('resolveCanonicalRepoIdentity (#624 acceptance criteria)', () => {
  it('returns identity: null for a non-git cwd (no remotes) without throwing', () => {
    expect(() => resolveCanonicalRepoIdentity([])).not.toThrow();
    const resolved = resolveCanonicalRepoIdentity([]);
    expect(resolved.identity).toBeNull();
    expect(resolved.selectedRemote).toBeNull();
    expect(resolved.warnings).toContain('missing-remotes');
  });

  it('treats https origin + ssh origin variants as the same canonical identity', () => {
    const httpsOrigin = resolveCanonicalRepoIdentity([
      { name: 'origin', url: 'https://github.com/owner/repo.git' },
    ]);
    const sshOrigin = resolveCanonicalRepoIdentity([
      { name: 'origin', url: 'git@github.com:owner/repo.git' },
    ]);
    const sshUrlOrigin = resolveCanonicalRepoIdentity([
      { name: 'origin', url: 'ssh://git@github.com:22/Owner/Repo' },
    ]);
    expect(httpsOrigin.identity).toBe(CANONICAL_GITHUB);
    expect(sshOrigin.identity).toBe(CANONICAL_GITHUB);
    expect(sshUrlOrigin.identity).toBe(CANONICAL_GITHUB);
  });

  it('round-trips the resolution result through JSON without dropping fields', () => {
    const original = resolveCanonicalRepoIdentity([
      { name: 'origin', url: 'https://github.com/owner/repo.git' },
      { name: 'upstream', url: 'git@github.com:upstream/repo.git' },
    ]);
    const restored = JSON.parse(JSON.stringify(original));
    expect(restored).toEqual(original);
    expect(restored.identity).toBe(CANONICAL_GITHUB);
    expect(restored.warnings).toEqual(
      expect.arrayContaining(['multiple-remotes', 'fork-upstream-ambiguity'])
    );
  });
});
