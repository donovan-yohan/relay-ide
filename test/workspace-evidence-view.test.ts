import { describe, expect, it } from 'vitest';
import {
  mapPreviewToRenderKind,
  resolveWorkContextIdsForRepo,
  resolveWorkspaceEvidenceRoot,
  workspaceEvidenceSectionState,
} from '../frontend/src/lib/workspace-evidence-view.js';
import type {
  WorkspaceEvidenceBackingKind,
  WorkspaceEvidencePreview,
  WorkspaceEvidenceRoot,
} from '../shared/workspace-evidence.js';
import type {
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from '../frontend/src/lib/types.js';
import type {
  WorkContext,
  WorkContextAnchors,
} from '../shared/work-context.js';

function makeRoot(
  overrides: Partial<WorkspaceEvidenceRoot> & { path?: string | null } = {}
): WorkspaceEvidenceRoot {
  const backing: WorkspaceEvidenceBackingKind = overrides.backing ?? 'directory';
  return {
    ref: {
      id: overrides.ref?.id ?? `wer:local:${overrides.path ?? 'x'}`,
      nodeId: 'local',
      kind: overrides.kind ?? 'directory',
      ...(overrides.ref ?? {}),
    },
    name: overrides.name ?? 'root',
    path: overrides.path ?? '/repo',
    nodeId: 'local',
    kind: overrides.kind ?? 'directory',
    backing,
    status: overrides.status ?? 'available',
    capabilities: overrides.capabilities ?? {
      list: true,
      stat: true,
      read: true,
      preview: true,
      write: false,
    },
    ...(overrides.repo ? { repo: overrides.repo } : {}),
    ...(overrides.worktree ? { worktree: overrides.worktree } : {}),
    ...(overrides.unavailableReason
      ? { unavailableReason: overrides.unavailableReason }
      : {}),
  };
}

function makePreview(
  overrides: Partial<WorkspaceEvidencePreview> = {}
): WorkspaceEvidencePreview {
  return {
    state: 'available',
    kind: 'text',
    encoding: 'utf8',
    bytesRead: 0,
    maxBytes: 32768,
    truncated: false,
    ...overrides,
  };
}

describe('resolveWorkspaceEvidenceRoot', () => {
  it('picks the repo-backed root matching repoPath', () => {
    const repoRoot = makeRoot({
      path: '/repo',
      backing: 'repo',
      kind: 'repo',
      repo: { repoPath: '/repo', isGitRepo: true },
    });
    const root = resolveWorkspaceEvidenceRoot([repoRoot], {
      repoPath: '/repo',
    });
    expect(root).toBe(repoRoot);
  });

  it('returns null for artifact-only / no path match', () => {
    const other = makeRoot({ path: '/other', backing: 'repo' });
    expect(
      resolveWorkspaceEvidenceRoot([other], { repoPath: '/repo' })
    ).toBeNull();
  });

  it('prefers the most specific backing when multiple match (worktree > repo > directory)', () => {
    const dir = makeRoot({
      path: '/repo',
      backing: 'directory',
      ref: { id: 'a', nodeId: 'local', kind: 'directory' },
    });
    const repo = makeRoot({
      path: '/repo',
      backing: 'repo',
      ref: { id: 'b', nodeId: 'local', kind: 'repo' },
    });
    const worktree = makeRoot({
      path: '/repo',
      backing: 'worktree',
      ref: { id: 'c', nodeId: 'local', kind: 'worktree' },
      worktree: { worktreePath: '/repo' },
    });
    const resolved = resolveWorkspaceEvidenceRoot([dir, repo, worktree], {
      repoPath: '/repo',
    });
    expect(resolved?.ref.id).toBe('c');
  });

  it('never returns a different workspace root (stale-leak regression)', () => {
    const rootA = makeRoot({
      path: '/repo-a',
      backing: 'repo',
      ref: { id: 'a', nodeId: 'local', kind: 'repo' },
      repo: { repoPath: '/repo-a', isGitRepo: true, currentBranch: 'main' },
    });
    const rootB = makeRoot({
      path: '/repo-b',
      backing: 'repo',
      ref: { id: 'b', nodeId: 'local', kind: 'repo' },
      repo: { repoPath: '/repo-b', isGitRepo: true, currentBranch: 'dev' },
    });
    const resolved = resolveWorkspaceEvidenceRoot([rootA, rootB], {
      repoPath: '/repo-b',
    });
    expect(resolved?.ref.id).toBe('b');
    expect(resolved?.repo?.currentBranch).toBe('dev');
  });
});

describe('workspaceEvidenceSectionState', () => {
  const ctx = { hasWorkspaceSelected: true, backendConnected: true };

  it('returns no-root for a null root', () => {
    expect(workspaceEvidenceSectionState(null, ctx)).toBe('no-root');
  });

  it('returns offline for status offline', () => {
    expect(
      workspaceEvidenceSectionState(makeRoot({ status: 'offline' }), ctx)
    ).toBe('offline');
  });

  it('returns permission-denied for status permission-denied', () => {
    expect(
      workspaceEvidenceSectionState(
        makeRoot({ status: 'permission-denied' }),
        ctx
      )
    ).toBe('permission-denied');
  });

  it('returns offline when backend is disconnected', () => {
    expect(
      workspaceEvidenceSectionState(makeRoot(), {
        hasWorkspaceSelected: true,
        backendConnected: false,
      })
    ).toBe('offline');
  });

  it('returns ready for available root with list capability', () => {
    expect(workspaceEvidenceSectionState(makeRoot(), ctx)).toBe('ready');
  });

  it('returns missing-root for WORKSPACE_EVIDENCE_ROOT_NOT_FOUND', () => {
    expect(
      workspaceEvidenceSectionState(
        makeRoot({ unavailableReason: 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND' }),
        ctx
      )
    ).toBe('missing-root');
  });

  it('prioritizes missing-root over offline for a deleted root path (live payload)', () => {
    // Exactly what the server returns when a configured root path no longer
    // exists on disk: status='unavailable' AND the NOT_FOUND reason.
    expect(
      workspaceEvidenceSectionState(
        makeRoot({
          status: 'unavailable',
          unavailableReason: 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND',
        }),
        ctx
      )
    ).toBe('missing-root');
  });

  it('still returns offline for a genuinely offline node (no NOT_FOUND reason)', () => {
    expect(
      workspaceEvidenceSectionState(
        makeRoot({
          status: 'offline',
          unavailableReason: 'WORKSPACE_EVIDENCE_NODE_OFFLINE',
        }),
        ctx
      )
    ).toBe('offline');
  });
});

describe('mapPreviewToRenderKind', () => {
  it('maps markdown', () => {
    expect(mapPreviewToRenderKind(makePreview({ kind: 'markdown' }))).toEqual({
      mode: 'markdown',
      language: 'markdown',
    });
  });

  it('maps json with language json', () => {
    expect(mapPreviewToRenderKind(makePreview({ kind: 'json' }))).toEqual({
      mode: 'json',
      language: 'json',
    });
  });

  it('maps diff', () => {
    expect(mapPreviewToRenderKind(makePreview({ kind: 'diff' }))).toEqual({
      mode: 'diff',
    });
  });

  it('maps log', () => {
    expect(mapPreviewToRenderKind(makePreview({ kind: 'log' }))).toEqual({
      mode: 'log',
      language: 'log',
    });
  });

  it('maps oversized state', () => {
    expect(mapPreviewToRenderKind(makePreview({ state: 'oversized' }))).toEqual({
      mode: 'oversized',
    });
  });

  it('maps binary state', () => {
    expect(mapPreviewToRenderKind(makePreview({ state: 'binary' }))).toEqual({
      mode: 'binary',
    });
  });

  it('maps available base64 image kind to image mode', () => {
    expect(
      mapPreviewToRenderKind(
        makePreview({ state: 'available', kind: 'image', encoding: 'base64' })
      )
    ).toEqual({ mode: 'image' });
  });

  it('maps an image kind without base64 encoding to binary mode', () => {
    expect(
      mapPreviewToRenderKind(
        makePreview({ state: 'available', kind: 'image', encoding: 'none' })
      )
    ).toEqual({ mode: 'binary' });
  });

  it('maps html-source to unsupported', () => {
    expect(
      mapPreviewToRenderKind(makePreview({ kind: 'html-source' }))
    ).toEqual({ mode: 'unsupported' });
  });

  it('maps sandboxRequired to unsupported', () => {
    expect(
      mapPreviewToRenderKind(makePreview({ sandboxRequired: true }))
    ).toEqual({ mode: 'unsupported' });
  });

  it('maps not-found state to error', () => {
    expect(mapPreviewToRenderKind(makePreview({ state: 'not-found' }))).toEqual({
      mode: 'error',
    });
  });
});

describe('resolveWorkContextIdsForRepo (#898)', () => {
  function makeGroup(
    id: string,
    contextId: string | null,
    opts: {
      anchors?: Partial<WorkContextAnchors>;
      sessions?: Partial<WorkContextSessionSummary>[];
    } = {}
  ): WorkContextActiveGroup {
    const context =
      contextId === null
        ? null
        : ({
            id: contextId,
            anchors: (opts.anchors ?? {}) as WorkContextAnchors,
          } as unknown as WorkContext);
    return {
      id,
      context,
      node: { nodeId: 'local', status: 'unknown' },
      sessions: (opts.sessions ?? []) as WorkContextSessionSummary[],
      staleReadModel: false,
    };
  }

  it('matches via anchors.repo.localPath', () => {
    const group = makeGroup('g1', 'wc-1', {
      anchors: { repo: { localPath: '/repo' } },
    });
    expect(resolveWorkContextIdsForRepo([group], '/repo')).toEqual(['wc-1']);
  });

  it('matches via anchors.worktree.localPath', () => {
    const group = makeGroup('g1', 'wc-1', {
      anchors: { worktree: { localPath: '/repo/wt' } },
    });
    expect(resolveWorkContextIdsForRepo([group], '/repo/wt')).toEqual([
      'wc-1',
    ]);
  });

  it('matches via a session repoPath', () => {
    const group = makeGroup('g1', 'wc-1', {
      sessions: [{ repoPath: '/repo' }],
    });
    expect(resolveWorkContextIdsForRepo([group], '/repo')).toEqual(['wc-1']);
  });

  it('matches via a session worktreePath', () => {
    const group = makeGroup('g1', 'wc-1', {
      sessions: [{ worktreePath: '/repo/wt' }],
    });
    expect(resolveWorkContextIdsForRepo([group], '/repo/wt')).toEqual([
      'wc-1',
    ]);
  });

  it('matches via a session cwd', () => {
    const group = makeGroup('g1', 'wc-1', {
      sessions: [{ cwd: '/repo' }],
    });
    expect(resolveWorkContextIdsForRepo([group], '/repo')).toEqual(['wc-1']);
  });

  it('dedups multiple matching groups sharing a context id, preserving order', () => {
    const groups = [
      makeGroup('g1', 'wc-1', { anchors: { repo: { localPath: '/repo' } } }),
      makeGroup('g2', 'wc-2', { sessions: [{ cwd: '/repo' }] }),
      makeGroup('g3', 'wc-1', { sessions: [{ repoPath: '/repo' }] }),
    ];
    expect(resolveWorkContextIdsForRepo(groups, '/repo')).toEqual([
      'wc-1',
      'wc-2',
    ]);
  });

  it('returns [] when no group matches the repo path', () => {
    const groups = [
      makeGroup('g1', 'wc-1', { anchors: { repo: { localPath: '/other' } } }),
      makeGroup('g2', 'wc-2', { sessions: [{ cwd: '/elsewhere' }] }),
    ];
    expect(resolveWorkContextIdsForRepo(groups, '/repo')).toEqual([]);
  });

  it('returns [] for an empty repoPath', () => {
    const group = makeGroup('g1', 'wc-1', {
      anchors: { repo: { localPath: '/repo' } },
    });
    expect(resolveWorkContextIdsForRepo([group], '')).toEqual([]);
  });

  it('skips groups with a null context even when sessions match', () => {
    const group = makeGroup('g1', null, { sessions: [{ cwd: '/repo' }] });
    expect(resolveWorkContextIdsForRepo([group], '/repo')).toEqual([]);
  });
});
