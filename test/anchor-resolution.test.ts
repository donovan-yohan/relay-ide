import { describe, expect, it, vi } from 'vitest';

import {
  resolveAnchorState,
  type AnchorRef,
} from '../shared/context-packet.js';
import {
  createFileResourceRef,
  type FileResourceRef,
} from '../shared/file-resource-ref.js';
import {
  ANCHOR_RESOLUTION_CAPABILITY,
  hashAnchorContent,
  resolveAnchor,
  type AnchorFileFetchResult,
  type AnchorFileFetchTarget,
  type AnchorFileFetcher,
} from '../server/anchor-resolution.js';

const NODE = 'node-alpha';
const PATH = '/repo/src/index.ts';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function ref(overrides: Partial<FileResourceRef> = {}): FileResourceRef {
  return createFileResourceRef({
    nodeId: NODE,
    path: PATH,
    intent: 'read',
    sha256: SHA_A,
    mtimeMs: 1_000,
    size: 42,
    ...overrides,
  });
}

function anchor(refOverrides: Partial<FileResourceRef> = {}): AnchorRef {
  return {
    ref: ref(refOverrides),
    lineRange: { startLine: 10, endLine: 20 },
    quote: 'const answer = 42;',
  };
}

describe('resolveAnchorState (pure)', () => {
  it('returns "unchanged" when sha256 matches', () => {
    const captured = anchor();
    const current = ref({ mtimeMs: 9_999 }); // mtime can drift; sha is authoritative
    expect(resolveAnchorState(captured, current)).toBe('unchanged');
  });

  it('returns "stale" when sha256 differs (file edited)', () => {
    const captured = anchor({ sha256: SHA_A });
    const current = ref({ sha256: SHA_B });
    expect(resolveAnchorState(captured, current)).toBe('stale');
  });

  it('returns "missing" when current is null (deleted)', () => {
    expect(resolveAnchorState(anchor(), null)).toBe('missing');
  });

  it('returns "missing" when the file moved (path identity mismatch)', () => {
    const captured = anchor();
    const current = ref({ path: '/repo/src/renamed.ts', sha256: SHA_A });
    expect(resolveAnchorState(captured, current)).toBe('missing');
  });

  it('returns "missing" on node identity mismatch (wrong node)', () => {
    const captured = anchor();
    const current = ref({ nodeId: 'node-beta', sha256: SHA_A });
    expect(resolveAnchorState(captured, current)).toBe('missing');
  });

  it('returns "missing" on intent identity mismatch', () => {
    const captured = anchor();
    const current = ref({ intent: 'stat', sha256: SHA_A });
    expect(resolveAnchorState(captured, current)).toBe('missing');
  });

  it('falls back to mtime when neither side carries sha256: equal => unchanged', () => {
    const captured = anchor({ sha256: undefined, mtimeMs: 1_000 });
    const current = ref({ sha256: undefined, mtimeMs: 1_000 });
    expect(resolveAnchorState(captured, current)).toBe('unchanged');
  });

  it('falls back to mtime when neither side carries sha256: differ => stale', () => {
    const captured = anchor({ sha256: undefined, mtimeMs: 1_000 });
    const current = ref({ sha256: undefined, mtimeMs: 2_000 });
    expect(resolveAnchorState(captured, current)).toBe('stale');
  });

  // C3: captured without read-intent freshness and no comparable mtime.
  it('C3: returns conservative "stale" when freshness is unknowable (no sha, no comparable mtime)', () => {
    const captured = anchor({ sha256: undefined, mtimeMs: undefined });
    const current = ref({ sha256: undefined, mtimeMs: undefined });
    expect(resolveAnchorState(captured, current)).toBe('stale');
  });

  it('C3: returns conservative "stale" when only current has sha256 (captured stat-only)', () => {
    const captured = anchor({ sha256: undefined, mtimeMs: undefined });
    const current = ref({ sha256: SHA_A, mtimeMs: undefined });
    expect(resolveAnchorState(captured, current)).toBe('stale');
  });

  it('never silently returns "unchanged" when captured freshness is absent', () => {
    const captured = anchor({ sha256: undefined, mtimeMs: undefined });
    const current = ref({ sha256: SHA_A, mtimeMs: 1_000 });
    expect(resolveAnchorState(captured, current)).not.toBe('unchanged');
  });
});

describe('hashAnchorContent', () => {
  it('hashes content deterministically to sha256 hex', () => {
    const hex = hashAnchorContent('const answer = 42;\n');
    expect(hex).toMatch(/^[a-f0-9]{64}$/);
    expect(hex).toBe(hashAnchorContent(Buffer.from('const answer = 42;\n')));
  });
});

describe('resolveAnchor (impure caller via File RPC under capability)', () => {
  function fetcherReturning(
    result: AnchorFileFetchResult | null
  ): { fn: AnchorFileFetcher; calls: AnchorFileFetchTarget[] } {
    const calls: AnchorFileFetchTarget[] = [];
    const fn = vi.fn(async (target: AnchorFileFetchTarget) => {
      calls.push(target);
      return result;
    });
    return { fn, calls };
  }

  it('requires the rpc:fs:read capability', () => {
    expect(ANCHOR_RESOLUTION_CAPABILITY).toBe('rpc:fs:read');
  });

  it('routes the fetch through the injected File RPC fetcher with the anchor location', async () => {
    const captured = anchor();
    const { fn, calls } = fetcherReturning({
      found: true,
      grantedCapability: 'rpc:fs:read',
      contentSha256: SHA_A,
      mtimeMs: 1_000,
      size: 42,
    });
    const outcome = await resolveAnchor(captured, fn);
    expect(outcome.state).toBe('unchanged');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.nodeId).toBe(NODE);
    expect(calls[0]?.path).toBe(PATH);
    // captured carries sha256 → prefer a read so current also gets a sha256.
    expect(calls[0]?.preferRead).toBe(true);
  });

  it('reports "stale" when the re-read content sha differs', async () => {
    const captured = anchor({ sha256: SHA_A });
    const { fn } = fetcherReturning({
      found: true,
      grantedCapability: 'rpc:fs:read',
      contentSha256: SHA_B,
      mtimeMs: 2_000,
      size: 50,
    });
    const outcome = await resolveAnchor(captured, fn);
    expect(outcome.state).toBe('stale');
    expect(outcome.current?.sha256).toBe(SHA_B);
  });

  it('reports "missing" when the node says the file is gone', async () => {
    const { fn } = fetcherReturning({ found: false, grantedCapability: 'rpc:fs:read' });
    const outcome = await resolveAnchor(anchor(), fn);
    expect(outcome.state).toBe('missing');
    expect(outcome.current).toBeNull();
  });

  it('reports "missing" (never local fallback) when the fetch is unauthorized/unavailable', async () => {
    const { fn } = fetcherReturning(null);
    const outcome = await resolveAnchor(anchor(), fn);
    expect(outcome.state).toBe('missing');
    expect(outcome.current).toBeNull();
  });

  it('throws if the fetcher was authorized for the wrong capability (C1 defense in depth)', async () => {
    const { fn } = fetcherReturning({
      found: true,
      grantedCapability: 'rpc:fs:list' as never,
      contentSha256: SHA_A,
    });
    await expect(resolveAnchor(anchor(), fn)).rejects.toThrow(/rpc:fs:read/);
  });

  it('C3 end-to-end: captured stat-only anchor resolves conservatively "stale"', async () => {
    // Captured with stat intent and no sha256 (freshness not captured).
    const captured = anchor({ intent: 'stat', sha256: undefined, mtimeMs: undefined });
    // preferRead should be false because captured has no sha256.
    const { fn, calls } = fetcherReturning({
      found: true,
      grantedCapability: 'rpc:fs:read',
      mtimeMs: undefined,
      size: 42,
    });
    const outcome = await resolveAnchor(captured, fn);
    expect(calls[0]?.preferRead).toBe(false);
    expect(outcome.state).toBe('stale');
  });

  it('preserves maxBytes/repoBinding identity on the re-minted current ref', async () => {
    const captured = anchor({
      maxBytes: 8192,
      repoBinding: { repoPath: '/repo', worktreePath: '/repo', branch: 'main' },
    });
    const { fn } = fetcherReturning({
      found: true,
      grantedCapability: 'rpc:fs:read',
      contentSha256: SHA_A,
      mtimeMs: 1_000,
    });
    const outcome = await resolveAnchor(captured, fn);
    // Identity (incl. maxBytes/repoBinding) must match → unchanged, not missing.
    expect(outcome.state).toBe('unchanged');
    expect(outcome.current?.maxBytes).toBe(8192);
    expect(outcome.current?.repoBinding?.repoPath).toBe('/repo');
  });
});
