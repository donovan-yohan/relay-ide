import { describe, expect, it } from 'vitest';

import {
  groupBenchOverlaysByInstance,
  mergeInstanceBenches,
  type BenchOverlayInput,
  type ViewTreeBench,
} from '../frontend/src/lib/state/view-tree.js';

// Minimal `ViewTreeBench` builder. The merge keys on `path` and reads
// `label`/`branch`/`isGit`/`tab`, so build a focused shape (cast through unknown
// for the branded `BenchId`).
function bench(
  path: string,
  opts: Partial<Pick<ViewTreeBench, 'label' | 'branch' | 'isGit'>> = {}
): ViewTreeBench {
  const label = opts.label ?? path.split('/').pop() ?? path;
  return {
    id: `bench:${path}`,
    path,
    repoPath: '/repo',
    label,
    branch: opts.branch ?? 'main',
    isGit: opts.isGit ?? true,
    tab: { count: 0 },
    lastActivity: null,
  } as unknown as ViewTreeBench;
}

function overlay(
  cwd: string,
  opts: Partial<Omit<BenchOverlayInput, 'cwd'>> = {}
): BenchOverlayInput {
  return {
    id: opts.id ?? `ov:${cwd}`,
    instanceId: opts.instanceId ?? 'inst-1',
    cwd,
    label: opts.label ?? null,
    envOverrides: opts.envOverrides ?? {},
  };
}

describe('mergeInstanceBenches (#773 dedup)', () => {
  it('renders ONE row when an overlay and a derived bench share a cwd', () => {
    const derived = [bench('/repo/wt-a', { label: 'wt-a', branch: 'feat/x' })];
    const overlays = [overlay('/repo/wt-a', { id: 'ov-a', label: 'My Bench' })];

    const merged = mergeInstanceBenches(derived, overlays);

    expect(merged).toHaveLength(1);
    const row = merged[0]!;
    expect(row.cwd).toBe('/repo/wt-a');
    // Overlay preferred: its label wins.
    expect(row.label).toBe('My Bench');
    expect(row.overlayId).toBe('ov-a');
    // Derived context inherited: branch + git bench retained for "+ tab".
    expect(row.bench).not.toBeNull();
    expect(row.bench!.branch).toBe('feat/x');
  });

  it('falls back to the derived label when the overlay has no label', () => {
    const derived = [bench('/repo/wt-a', { label: 'derived-label' })];
    const overlays = [overlay('/repo/wt-a', { label: null })];

    const merged = mergeInstanceBenches(derived, overlays);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.label).toBe('derived-label');
    expect(merged[0]!.overlayId).not.toBeNull();
  });

  it('keeps DISTINCT cwds as separate rows (one derived, one overlay-only)', () => {
    const derived = [bench('/repo/wt-a', { label: 'wt-a' })];
    const overlays = [overlay('/repo/wt-b', { id: 'ov-b', label: 'B' })];

    const merged = mergeInstanceBenches(derived, overlays);

    expect(merged).toHaveLength(2);
    const byCwd = new Map(merged.map((m) => [m.cwd, m]));
    // Derived-only row: no overlay backing, derived bench present.
    expect(byCwd.get('/repo/wt-a')!.overlayId).toBeNull();
    expect(byCwd.get('/repo/wt-a')!.bench).not.toBeNull();
    // Overlay-only row: overlay id set, no derived worktree (no "+ tab" anchor).
    expect(byCwd.get('/repo/wt-b')!.overlayId).toBe('ov-b');
    expect(byCwd.get('/repo/wt-b')!.bench).toBeNull();
  });

  it('carries the overlay env overrides onto the merged row', () => {
    const derived = [bench('/repo/wt-a')];
    const overlays = [
      overlay('/repo/wt-a', { envOverrides: { FOO: 'bar', BAZ: 'qux' } }),
    ];

    const merged = mergeInstanceBenches(derived, overlays);

    expect(merged[0]!.envOverrides).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('derived-only benches keep empty env + null overlayId', () => {
    const merged = mergeInstanceBenches([bench('/repo/wt-a')], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.overlayId).toBeNull();
    expect(merged[0]!.envOverrides).toEqual({});
    expect(merged[0]!.bench).not.toBeNull();
  });

  it('orders derived rows first, then overlay-only rows, preserving input order', () => {
    const derived = [bench('/repo/a'), bench('/repo/b')];
    const overlays = [
      overlay('/repo/b', { id: 'ov-b' }), // fuses with derived b
      overlay('/repo/z', { id: 'ov-z' }), // overlay-only
      overlay('/repo/y', { id: 'ov-y' }), // overlay-only
    ];

    const merged = mergeInstanceBenches(derived, overlays);

    expect(merged.map((m) => m.cwd)).toEqual([
      '/repo/a',
      '/repo/b',
      '/repo/z',
      '/repo/y',
    ]);
  });

  it('does NOT decode the cwd key (C1: verbatim path)', () => {
    const encoded = '/repo/wt%20with%20spaces';
    const derived = [bench(encoded)];
    const overlays = [overlay(encoded, { id: 'ov-enc', label: 'Encoded' })];

    const merged = mergeInstanceBenches(derived, overlays);

    // Same VERBATIM cwd → fused to one row; the key is never decoded.
    expect(merged).toHaveLength(1);
    expect(merged[0]!.cwd).toBe(encoded);
    expect(merged[0]!.overlayId).toBe('ov-enc');
  });
});

describe('groupBenchOverlaysByInstance (#773 fan-out)', () => {
  it('groups a flat overlay list by instanceId', () => {
    const overlays = [
      overlay('/a', { id: '1', instanceId: 'inst-1' }),
      overlay('/b', { id: '2', instanceId: 'inst-2' }),
      overlay('/c', { id: '3', instanceId: 'inst-1' }),
    ];

    const grouped = groupBenchOverlaysByInstance(overlays);

    expect([...grouped.keys()].sort()).toEqual(['inst-1', 'inst-2']);
    expect(grouped.get('inst-1')!.map((o) => o.id)).toEqual(['1', '3']);
    expect(grouped.get('inst-2')!.map((o) => o.id)).toEqual(['2']);
  });

  it('returns an empty map for no overlays', () => {
    expect(groupBenchOverlaysByInstance([]).size).toBe(0);
  });
});
