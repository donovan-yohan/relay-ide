import { describe, expect, it, vi } from 'vitest';

import {
  createContextPacketId,
  type AnchorRef,
  type ContextPacket,
} from '../shared/context-packet.js';
import { createFileResourceRef } from '../shared/file-resource-ref.js';
import type { ResolveAnchorOutcome } from '../server/anchor-resolution.js';
import {
  FILE_RANGE_MAX_EXPANDED_LINES,
  decoratePacketAnchorState,
  decoratePacketsAnchorState,
  expandFileRange,
  sliceLineRange,
  type FileRangeContentFetcher,
  type FileRangeContentResult,
  type FileRangeContentTarget,
} from '../server/context-adapters/file-range.js';

const NODE = 'node-alpha';
const PATH = '/repo/src/index.ts';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

// 12-line fixture; the anchor selects lines 3..5.
const FILE_CONTENT = [
  'line one',
  'line two',
  'line three',
  'line four',
  'line five',
  'line six',
  'line seven',
  'line eight',
  'line nine',
  'line ten',
  'line eleven',
  'line twelve',
].join('\n');

function anchor(overrides: Partial<AnchorRef> = {}): AnchorRef {
  return {
    ref: createFileResourceRef({
      nodeId: NODE,
      path: PATH,
      intent: 'read',
      sha256: SHA_A,
      mtimeMs: 1_000,
      size: FILE_CONTENT.length,
    }),
    lineRange: { startLine: 3, endLine: 5 },
    quote: 'line three\nline four\nline five',
    ...overrides,
  };
}

function fileAnchorPacket(a: AnchorRef = anchor()): ContextPacket {
  return {
    id: createContextPacketId('test'),
    kind: 'file-anchor',
    anchor: a,
    createdBy: 'agent_1',
    createdAt: new Date().toISOString(),
  };
}

function contentFetcher(
  result: FileRangeContentResult | null
): { fn: FileRangeContentFetcher; calls: FileRangeContentTarget[] } {
  const calls: FileRangeContentTarget[] = [];
  const fn = vi.fn(async (target: FileRangeContentTarget) => {
    calls.push(target);
    return result;
  });
  return { fn, calls };
}

describe('sliceLineRange (pure)', () => {
  it('extracts the 1-based inclusive line range', () => {
    const { slice, truncated } = sliceLineRange(FILE_CONTENT, { startLine: 3, endLine: 5 });
    expect(slice).toBe('line three\nline four\nline five');
    expect(truncated).toBe(false);
  });

  it('clamps a single line', () => {
    const { slice } = sliceLineRange(FILE_CONTENT, { startLine: 1, endLine: 1 });
    expect(slice).toBe('line one');
  });

  it('clamps when the range runs past EOF (returns available lines only)', () => {
    const { slice } = sliceLineRange(FILE_CONTENT, { startLine: 11, endLine: 99 });
    expect(slice).toBe('line eleven\nline twelve');
  });

  it('returns empty when the range starts past EOF', () => {
    const { slice } = sliceLineRange(FILE_CONTENT, { startLine: 50, endLine: 60 });
    expect(slice).toBe('');
  });

  it('flags truncation when the requested line count exceeds the hard cap', () => {
    const huge = Array.from({ length: FILE_RANGE_MAX_EXPANDED_LINES + 50 }, (_, i) => `L${i}`).join('\n');
    const { slice, truncated } = sliceLineRange(huge, {
      startLine: 1,
      endLine: FILE_RANGE_MAX_EXPANDED_LINES + 50,
    });
    expect(truncated).toBe(true);
    expect(slice.split('\n')).toHaveLength(FILE_RANGE_MAX_EXPANDED_LINES);
  });
});

describe('expandFileRange', () => {
  it('expands the correct slice when the anchor is unchanged (sha matches)', async () => {
    const captured = anchor({ sha256: SHA_A } as Partial<AnchorRef>);
    const { fn, calls } = contentFetcher({
      found: true,
      grantedCapability: 'rpc:fs:read',
      content: FILE_CONTENT,
      contentSha256: SHA_A,
      mtimeMs: 1_000,
      size: FILE_CONTENT.length,
    });
    const result = await expandFileRange(captured, { fetchContent: fn });
    expect(result.state).toBe('unchanged');
    expect(result.content).toBe('line three\nline four\nline five');
    expect(result.lineRange).toEqual({ startLine: 3, endLine: 5 });
    // C1: the stored path is passed verbatim to the fetcher.
    expect(calls[0]?.path).toBe(PATH);
  });

  it('surfaces "stale" and NO current content when the file content drifted', async () => {
    // Captured sha is SHA_A; the re-read content hashes to SHA_B (file edited).
    const { fn } = contentFetcher({
      found: true,
      grantedCapability: 'rpc:fs:read',
      content: 'totally different content now',
      contentSha256: SHA_B,
      mtimeMs: 2_000,
      size: 29,
    });
    const result = await expandFileRange(anchor(), { fetchContent: fn });
    expect(result.state).toBe('stale');
    // CRITICAL: a stale anchor must NOT serve the freshly-read bytes as current.
    expect(result.content).toBeUndefined();
    // The advisory captured quote is echoed (clearly NOT current content).
    expect(result.capturedQuote).toBe('line three\nline four\nline five');
  });

  it('surfaces "missing" when the node reports the file gone', async () => {
    const { fn } = contentFetcher({ found: false, grantedCapability: 'rpc:fs:read' });
    const result = await expandFileRange(anchor(), { fetchContent: fn });
    expect(result.state).toBe('missing');
    expect(result.content).toBeUndefined();
  });

  it('surfaces "unavailable" (never local fallback) when the fetch is unauthorized', async () => {
    const { fn } = contentFetcher(null);
    const result = await expandFileRange(anchor(), { fetchContent: fn });
    expect(result.state).toBe('unavailable');
    expect(result.content).toBeUndefined();
  });

  it('throws if the content fetch was authorized for the wrong capability (C1)', async () => {
    const { fn } = contentFetcher({
      found: true,
      grantedCapability: 'rpc:fs:list' as never,
      content: FILE_CONTENT,
      contentSha256: SHA_A,
    });
    await expect(expandFileRange(anchor(), { fetchContent: fn })).rejects.toThrow(/rpc:fs:read/);
  });

  it('honors the byte size cap on the read target', async () => {
    const captured = anchor({
      ref: createFileResourceRef({
        nodeId: NODE,
        path: PATH,
        intent: 'read',
        sha256: SHA_A,
        mtimeMs: 1_000,
        maxBytes: 4096,
      }),
    });
    const { fn, calls } = contentFetcher({ found: false, grantedCapability: 'rpc:fs:read' });
    await expandFileRange(captured, { fetchContent: fn });
    expect(calls[0]?.maxBytes).toBe(4096);
  });

  it('uses an injected state resolver (authoritative sha resolution) when provided', async () => {
    const { fn } = contentFetcher({
      found: true,
      grantedCapability: 'rpc:fs:read',
      content: FILE_CONTENT,
      // No sha on the read (truncated); the injected resolver decides state.
      mtimeMs: 1_000,
    });
    const resolveState = vi.fn(
      async (): Promise<ResolveAnchorOutcome> => ({ state: 'unchanged', current: null })
    );
    const result = await expandFileRange(anchor(), { fetchContent: fn, resolveState });
    expect(resolveState).toHaveBeenCalledOnce();
    expect(result.state).toBe('unchanged');
    expect(result.content).toBe('line three\nline four\nline five');
  });

  it('treats a null injected-resolver outcome as unavailable', async () => {
    const { fn } = contentFetcher({
      found: true,
      grantedCapability: 'rpc:fs:read',
      content: FILE_CONTENT,
      mtimeMs: 1_000,
    });
    const resolveState = vi.fn(async (): Promise<ResolveAnchorOutcome | null> => null);
    const result = await expandFileRange(anchor(), { fetchContent: fn, resolveState });
    expect(result.state).toBe('unavailable');
    expect(result.content).toBeUndefined();
  });
});

describe('decoratePacketAnchorState (runtime consumer of #766)', () => {
  it('attaches the derived AnchorState to a file-anchor packet', async () => {
    const packet = fileAnchorPacket();
    const resolve = vi.fn(async (): Promise<ResolveAnchorOutcome> => ({ state: 'unchanged', current: null }));
    const decorated = await decoratePacketAnchorState(packet, resolve);
    expect(decorated.anchorState).toBe('unchanged');
    // Does not mutate the input.
    expect((packet as { anchorState?: unknown }).anchorState).toBeUndefined();
  });

  it('surfaces "stale" on the decorated packet (derived, never stored)', async () => {
    const packet = fileAnchorPacket();
    const resolve = vi.fn(async (): Promise<ResolveAnchorOutcome> => ({ state: 'stale', current: null }));
    const decorated = await decoratePacketAnchorState(packet, resolve);
    expect(decorated.anchorState).toBe('stale');
  });

  it('leaves the packet UNDECORATED when resolution is unavailable (null)', async () => {
    const packet = fileAnchorPacket();
    const resolve = vi.fn(async (): Promise<ResolveAnchorOutcome | null> => null);
    const decorated = await decoratePacketAnchorState(packet, resolve);
    expect(decorated.anchorState).toBeUndefined();
  });

  it('passes non-file-anchor packets through unchanged (no resolver call)', async () => {
    const note: ContextPacket = {
      id: createContextPacketId('note'),
      kind: 'note',
      note: 'remember this',
      createdBy: 'agent_1',
      createdAt: new Date().toISOString(),
    };
    const resolve = vi.fn(async (): Promise<ResolveAnchorOutcome> => ({ state: 'unchanged', current: null }));
    const decorated = await decoratePacketAnchorState(note, resolve);
    expect(decorated).toBe(note);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('decorates many packets order-preserving', async () => {
    const a = fileAnchorPacket();
    const b = fileAnchorPacket();
    let n = 0;
    const states: ('unchanged' | 'stale')[] = ['unchanged', 'stale'];
    const resolve = vi.fn(
      async (): Promise<ResolveAnchorOutcome> => ({ state: states[n++]!, current: null })
    );
    const decorated = await decoratePacketsAnchorState([a, b], resolve);
    expect(decorated[0]?.anchorState).toBe('unchanged');
    expect(decorated[1]?.anchorState).toBe('stale');
  });
});
