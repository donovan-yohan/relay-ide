// View-spine Project + Instance scaffold (#444 Lane B). Pure types + identity
// helpers. Instance lives alongside Project because an Instance is a Project
// realized on a host — same identity equivalence, different layer.

import type { NodeId, RepoIdentity } from './identity.js';

export type ProjectId = string;
export type InstanceId = string;

export type ProjectIdentity =
  | { kind: 'repo'; remote: RepoIdentity }
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'agent'; providerId: string }
  | { kind: 'playbook'; playbookId: string };

export type ProjectIdentityKind = ProjectIdentity['kind'];

export interface Project {
  id: ProjectId;
  identity: ProjectIdentity;
  // User-facing display name. Falls back to derived label when blank; the
  // derivation rule lives at the UI layer, not here.
  name: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Instance {
  id: InstanceId;
  projectId: ProjectId;
  // The host this instance lives on. For a `node` project this equals the
  // identity's nodeId. For other kinds, host is the materialization site.
  host: NodeId;
  // Optional anchor path for repo-kind instances; null for agent/node/playbook.
  localPath: string | null;
  createdAt: string;
  updatedAt: string;
}

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

function encodeIdentity(identity: ProjectIdentity): string {
  switch (identity.kind) {
    case 'repo':
      if (!hasValue(identity.remote))
        throw new Error('identity.remote is required');
      return `repo:${encodeURIComponent(identity.remote)}`;
    case 'node':
      if (!hasValue(identity.nodeId))
        throw new Error('identity.nodeId is required');
      return `node:${encodeURIComponent(identity.nodeId)}`;
    case 'agent':
      if (!hasValue(identity.providerId))
        throw new Error('identity.providerId is required');
      return `agent:${encodeURIComponent(identity.providerId)}`;
    case 'playbook':
      if (!hasValue(identity.playbookId))
        throw new Error('identity.playbookId is required');
      return `playbook:${encodeURIComponent(identity.playbookId)}`;
  }
}

export function createProjectId(identity: ProjectIdentity): ProjectId {
  return `proj:${encodeIdentity(identity)}`;
}

export function parseProjectId(id: ProjectId): ProjectIdentity | null {
  if (!id.startsWith('proj:')) return null;
  const rest = id.slice('proj:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  const kind = rest.slice(0, sep);
  let payload: string;
  try {
    payload = decodeURIComponent(rest.slice(sep + 1));
  } catch {
    return null;
  }
  if (!hasValue(payload)) return null;
  switch (kind) {
    case 'repo':
      return { kind: 'repo', remote: payload };
    case 'node':
      return { kind: 'node', nodeId: payload };
    case 'agent':
      return { kind: 'agent', providerId: payload };
    case 'playbook':
      return { kind: 'playbook', playbookId: payload };
    default:
      return null;
  }
}

export function projectIdentityEquals(
  a: ProjectIdentity,
  b: ProjectIdentity
): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'repo':
      return (
        a.remote === (b as Extract<ProjectIdentity, { kind: 'repo' }>).remote
      );
    case 'node':
      return (
        a.nodeId === (b as Extract<ProjectIdentity, { kind: 'node' }>).nodeId
      );
    case 'agent':
      return (
        a.providerId ===
        (b as Extract<ProjectIdentity, { kind: 'agent' }>).providerId
      );
    case 'playbook':
      return (
        a.playbookId ===
        (b as Extract<ProjectIdentity, { kind: 'playbook' }>).playbookId
      );
  }
}

export function createInstanceId(
  projectId: ProjectId,
  host: NodeId
): InstanceId {
  if (!hasValue(projectId)) throw new Error('projectId is required');
  if (!hasValue(host)) throw new Error('host is required');
  return `inst:${encodeURIComponent(projectId)}:${encodeURIComponent(host)}`;
}

export function parseInstanceId(
  id: InstanceId
): { projectId: ProjectId; host: NodeId } | null {
  if (!id.startsWith('inst:')) return null;
  const rest = id.slice('inst:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  try {
    const projectId = decodeURIComponent(rest.slice(0, sep));
    const host = decodeURIComponent(rest.slice(sep + 1));
    if (!hasValue(projectId) || !hasValue(host)) return null;
    return { projectId, host };
  } catch {
    return null;
  }
}
