import { describe, expect, it } from 'vitest';

import {
  groupProjectsByWorkspace,
  type PersistedWorkspaceInput,
  type ViewTreeProject,
} from '../frontend/src/lib/state/view-tree.js';

// `groupProjectsByWorkspace` only reads `id` + `label` off a project; build a
// minimal shape (cast through unknown) so the test stays focused on the pure
// grouping logic, not the full derived-project anatomy.
function project(id: string, label = id): ViewTreeProject {
  return {
    id,
    label,
    identity: { kind: 'directory', nodeId: 'local', localPath: `/p/${id}` },
    kind: 'directory',
    colorSeed: label,
    instances: [],
    lastActivity: null,
  } as unknown as ViewTreeProject;
}

function ws(
  id: string,
  order: number,
  projectIds: string[],
  name = id
): PersistedWorkspaceInput {
  return { id, name, order, projectIds };
}

describe('groupProjectsByWorkspace (#728)', () => {
  it('returns all projects ungrouped when there are no workspaces', () => {
    const projects = [project('b'), project('a')];
    const result = groupProjectsByWorkspace(projects, []);
    expect(result.workspaces).toEqual([]);
    // Ungrouped is sorted by label for determinism.
    expect(result.ungroupedProjects.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('groups assigned projects and leaves unassigned ones ungrouped', () => {
    const projects = [project('a'), project('b'), project('c')];
    const result = groupProjectsByWorkspace(projects, [ws('w1', 0, ['a', 'c'])]);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(['a', 'c']);
    expect(result.ungroupedProjects.map((p) => p.id)).toEqual(['b']);
  });

  it('renders projects in the membership order, not project order', () => {
    const projects = [project('a'), project('b'), project('c')];
    const result = groupProjectsByWorkspace(projects, [
      ws('w1', 0, ['c', 'a', 'b']),
    ]);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(result.ungroupedProjects).toEqual([]);
  });

  it('orders workspaces by order asc then id, regardless of input order', () => {
    const projects = [project('a'), project('b')];
    const result = groupProjectsByWorkspace(projects, [
      ws('later', 5, ['b']),
      ws('first', 1, ['a']),
    ]);
    expect(result.workspaces.map((w) => w.id)).toEqual(['first', 'later']);
  });

  it('breaks order ties by id ascending', () => {
    const result = groupProjectsByWorkspace(
      [project('a'), project('b')],
      [ws('beta', 0, ['b']), ws('alpha', 0, ['a'])]
    );
    expect(result.workspaces.map((w) => w.id)).toEqual(['alpha', 'beta']);
  });

  it('skips membership ids that do not resolve to a derived project', () => {
    const projects = [project('a')];
    const result = groupProjectsByWorkspace(projects, [
      ws('w1', 0, ['a', 'ghost']),
    ]);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(['a']);
    expect(result.ungroupedProjects).toEqual([]);
  });

  it('claims a project for the FIRST workspace (by order) when duplicated', () => {
    const projects = [project('a')];
    const result = groupProjectsByWorkspace(projects, [
      ws('w2', 1, ['a']),
      ws('w1', 0, ['a']),
    ]);
    // w1 (order 0) wins; w2 renders empty.
    expect(result.workspaces[0]!.id).toBe('w1');
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(['a']);
    expect(result.workspaces[1]!.id).toBe('w2');
    expect(result.workspaces[1]!.projects).toEqual([]);
    expect(result.ungroupedProjects).toEqual([]);
  });

  it('dedups a repeated project id within a single workspace', () => {
    const projects = [project('a')];
    const result = groupProjectsByWorkspace(projects, [
      ws('w1', 0, ['a', 'a']),
    ]);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(['a']);
  });

  it('tolerates a workspace with a missing/non-array projectIds', () => {
    const projects = [project('a')];
    const malformed = {
      id: 'w1',
      name: 'w1',
      order: 0,
    } as unknown as PersistedWorkspaceInput;
    const result = groupProjectsByWorkspace(projects, [malformed]);
    expect(result.workspaces[0]!.projects).toEqual([]);
    expect(result.ungroupedProjects.map((p) => p.id)).toEqual(['a']);
  });

  it('preserves projects that are not referenced by any workspace', () => {
    const projects = [project('a'), project('b'), project('c')];
    const result = groupProjectsByWorkspace(projects, [
      ws('w1', 0, ['b']),
      ws('w2', 1, []),
    ]);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(['b']);
    expect(result.workspaces[1]!.projects).toEqual([]);
    expect(result.ungroupedProjects.map((p) => p.id)).toEqual(['a', 'c']);
  });
});
