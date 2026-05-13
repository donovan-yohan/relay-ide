import { describe, expect, it } from 'vitest';

import { createBenchId, parseBenchId } from '../shared/bench.js';
import {
  createInstanceId,
  createProjectId,
  parseInstanceId,
  parseProjectId,
  projectIdentityEquals,
  type ProjectIdentity,
} from '../shared/project.js';
import { createWorkspaceId, parseWorkspaceId } from '../shared/workspace.js';

describe('workspace id helpers', () => {
  it('round-trips ids with delimiters in the local part', () => {
    const id = createWorkspaceId('Mt. Rainier: tier/1');
    expect(id).toBe('ws:Mt.%20Rainier%3A%20tier%2F1');
    expect(parseWorkspaceId(id)).toEqual({ localId: 'Mt. Rainier: tier/1' });
  });

  it('rejects malformed workspace ids', () => {
    expect(parseWorkspaceId('not-prefixed')).toBeNull();
    expect(parseWorkspaceId('ws:')).toBeNull();
    expect(parseWorkspaceId('ws:%')).toBeNull();
  });

  it('throws when local id is blank', () => {
    expect(() => createWorkspaceId('')).toThrow('localId is required');
    expect(() => createWorkspaceId('   ')).toThrow('localId is required');
  });
});

describe('project id helpers', () => {
  it('encodes each identity kind under its own tag', () => {
    expect(
      createProjectId({ kind: 'repo', remote: 'github.com/foo/bar' })
    ).toBe('proj:repo:github.com%2Ffoo%2Fbar');
    expect(createProjectId({ kind: 'node', nodeId: 'macbook' })).toBe(
      'proj:node:macbook'
    );
    expect(createProjectId({ kind: 'agent', providerId: 'claude:opus' })).toBe(
      'proj:agent:claude%3Aopus'
    );
    expect(createProjectId({ kind: 'playbook', playbookId: 'pb/42' })).toBe(
      'proj:playbook:pb%2F42'
    );
  });

  it('round-trips identity through parseProjectId', () => {
    const identities: ProjectIdentity[] = [
      { kind: 'repo', remote: 'github.com/donovan-yohan/relay-ide' },
      { kind: 'node', nodeId: 'wsl: ubuntu' },
      { kind: 'agent', providerId: 'opencode' },
      { kind: 'playbook', playbookId: 'pb/release' },
    ];
    for (const identity of identities) {
      expect(parseProjectId(createProjectId(identity))).toEqual(identity);
    }
  });

  it('rejects malformed or unknown-kind project ids', () => {
    expect(parseProjectId('not-prefixed')).toBeNull();
    expect(parseProjectId('proj:')).toBeNull();
    expect(parseProjectId('proj:repo:')).toBeNull();
    expect(parseProjectId('proj:unknown:foo')).toBeNull();
    expect(parseProjectId('proj:repo:%')).toBeNull();
  });

  it('throws when identity payload is blank', () => {
    expect(() => createProjectId({ kind: 'repo', remote: '' })).toThrow(
      'identity.remote is required'
    );
    expect(() => createProjectId({ kind: 'node', nodeId: '   ' })).toThrow(
      'identity.nodeId is required'
    );
    expect(() => createProjectId({ kind: 'agent', providerId: '' })).toThrow(
      'identity.providerId is required'
    );
    expect(() => createProjectId({ kind: 'playbook', playbookId: '' })).toThrow(
      'identity.playbookId is required'
    );
  });

  it('compares identities by kind+payload', () => {
    expect(
      projectIdentityEquals(
        { kind: 'repo', remote: 'github.com/foo/bar' },
        { kind: 'repo', remote: 'github.com/foo/bar' }
      )
    ).toBe(true);
    expect(
      projectIdentityEquals(
        { kind: 'repo', remote: 'github.com/foo/bar' },
        { kind: 'repo', remote: 'github.com/foo/baz' }
      )
    ).toBe(false);
    expect(
      projectIdentityEquals(
        { kind: 'repo', remote: 'github.com/foo/bar' },
        { kind: 'node', nodeId: 'github.com/foo/bar' }
      )
    ).toBe(false);
    expect(
      projectIdentityEquals(
        { kind: 'node', nodeId: 'macbook' },
        { kind: 'node', nodeId: 'macbook' }
      )
    ).toBe(true);
    expect(
      projectIdentityEquals(
        { kind: 'agent', providerId: 'claude' },
        { kind: 'playbook', playbookId: 'claude' }
      )
    ).toBe(false);
  });
});

describe('instance id helpers', () => {
  it('round-trips projectId + host through createInstanceId', () => {
    const projectId = createProjectId({
      kind: 'repo',
      remote: 'github.com/foo/bar',
    });
    const id = createInstanceId(projectId, 'macbook:dev');
    expect(parseInstanceId(id)).toEqual({ projectId, host: 'macbook:dev' });
  });

  it('rejects malformed instance ids', () => {
    expect(parseInstanceId('not-prefixed')).toBeNull();
    expect(parseInstanceId('inst:')).toBeNull();
    expect(parseInstanceId('inst::host')).toBeNull();
    expect(parseInstanceId('inst:proj:%')).toBeNull();
  });

  it('throws when projectId or host is blank', () => {
    expect(() => createInstanceId('', 'macbook')).toThrow(
      'projectId is required'
    );
    expect(() => createInstanceId('proj:node:macbook', '')).toThrow(
      'host is required'
    );
  });
});

describe('bench id helpers', () => {
  it('round-trips instanceId + cwd', () => {
    const instanceId = createInstanceId('proj:node:macbook', 'macbook');
    const cwd = '/Users/me/repo/.worktrees/feature: one';
    const id = createBenchId(instanceId, cwd);
    expect(parseBenchId(id)).toEqual({ instanceId, cwd });
  });

  it('rejects malformed bench ids', () => {
    expect(parseBenchId('not-prefixed')).toBeNull();
    expect(parseBenchId('bench:')).toBeNull();
    expect(parseBenchId('bench::/cwd')).toBeNull();
    expect(parseBenchId('bench:inst%3Afoo:%')).toBeNull();
  });

  it('throws when instanceId or cwd is blank', () => {
    expect(() => createBenchId('', '/tmp')).toThrow('instanceId is required');
    expect(() => createBenchId('inst:foo:bar', '')).toThrow('cwd is required');
  });
});
