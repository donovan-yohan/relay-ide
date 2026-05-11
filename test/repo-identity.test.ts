import { describe, expect, it } from 'vitest';

import {
  normalizeRemoteUrl,
  resolveCanonicalRepoIdentity,
} from '../shared/repo-identity.js';

describe('canonical repo identity', () => {
  it('normalizes common GitHub SSH/HTTPS forms to the same stable identity', () => {
    for (const url of [
      'git@github.com:Owner/Repo.git',
      'https://github.com/Owner/Repo.git',
      'ssh://git@github.com/Owner/Repo.git',
    ]) {
      expect(normalizeRemoteUrl(url)).toMatchObject({
        identity: 'github.com/owner/repo',
        provider: 'github',
        host: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    }
  });

  it('keeps non-GitHub remote identity host/path based instead of basename based', () => {
    expect(normalizeRemoteUrl('git@gitlab.example.com:Team/Repo.git')).toMatchObject({
      identity: 'gitlab.example.com/Team/Repo',
      provider: 'git',
      host: 'gitlab.example.com',
      path: 'Team/Repo',
    });
  });

  it('returns a warning for malformed remote urls', () => {
    expect(normalizeRemoteUrl('not a remote url')).toMatchObject({
      identity: null,
      warning: 'malformed-remote-url',
    });
  });

  it('rejects GitHub remote urls with extra path segments', () => {
    for (const url of [
      'https://github.com/Owner/Repo/extra',
      'https://github.com/Owner/Repo/tree/main',
      'git@github.com:Owner/Repo/extra.git',
    ]) {
      expect(normalizeRemoteUrl(url)).toMatchObject({
        identity: null,
        provider: null,
        host: 'github.com',
        warning: 'malformed-remote-url',
      });
    }
  });

  it('selects origin as primary and warns when upstream differs', () => {
    const resolved = resolveCanonicalRepoIdentity([
      { name: 'upstream', url: 'https://github.com/upstream/relay-ide.git' },
      { name: 'origin', url: 'git@github.com:fork/relay-ide.git' },
    ]);

    expect(resolved.identity).toBe('github.com/fork/relay-ide');
    expect(resolved.selectedRemote?.name).toBe('origin');
    expect(resolved.warnings).toContain('multiple-remotes');
    expect(resolved.warnings).toContain('fork-upstream-ambiguity');
  });

  it('falls back to a non-origin remote with an explicit warning', () => {
    const resolved = resolveCanonicalRepoIdentity([
      { name: 'upstream', url: 'https://github.com/acme/project.git' },
    ]);

    expect(resolved.identity).toBe('github.com/acme/project');
    expect(resolved.selectedRemote?.name).toBe('upstream');
    expect(resolved.warnings).toContain('selected-non-origin-remote');
  });

  it('reports missing remotes without inventing a basename identity', () => {
    const resolved = resolveCanonicalRepoIdentity([]);

    expect(resolved.identity).toBeNull();
    expect(resolved.selectedRemote).toBeNull();
    expect(resolved.warnings).toContain('missing-remotes');
  });
});
