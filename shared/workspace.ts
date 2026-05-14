// View-spine data model (#444 Lane B): scaffold-only types + identity helpers.
// No wiring yet — Lane A migration, server CRUD, and frontend render in follow-ups.

export type WorkspaceId = string;

export interface Workspace {
  id: WorkspaceId;
  name: string;
  // Ordering within the workspace bar. Lower comes first. Float so reorder
  // without renumber is feasible — same pattern as Bench/Tab follow-ups will use.
  order: number;
  // Project membership is stored as an ordered list of ProjectIds rather than
  // an embedded Project[] so a Project can be referenced from a View without
  // duplicating Workspace state.
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
}

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

export function createWorkspaceId(localId: string): WorkspaceId {
  if (!hasValue(localId)) throw new Error('localId is required');
  return `ws:${encodeURIComponent(localId)}`;
}

export function parseWorkspaceId(id: WorkspaceId): { localId: string } | null {
  if (!id.startsWith('ws:')) return null;
  try {
    const localId = decodeURIComponent(id.slice('ws:'.length));
    if (!hasValue(localId)) return null;
    return { localId };
  } catch {
    return null;
  }
}
