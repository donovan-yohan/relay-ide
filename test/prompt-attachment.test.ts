import { describe, expect, it } from 'vitest';

import { createFileResourceRef } from '../shared/file-resource-ref.js';
import {
  MAX_PROMPT_ATTACHMENTS_PER_MESSAGE,
  PROMPT_ATTACHMENT_KINDS,
  createPromptAttachment,
  parsePromptAttachment,
  parsePromptAttachmentList,
  promptAttachmentToArtifactRef,
  type PromptAttachment,
  type PromptAttachmentFileRef,
} from '../shared/prompt-attachment.js';

function makeRef(
  overrides: Partial<Parameters<typeof createFileResourceRef>[0]> = {}
) {
  return createFileResourceRef({
    nodeId: 'mac-studio',
    path: '/Users/d/file.txt',
    intent: 'read',
    ...overrides,
  });
}

describe('createPromptAttachment', () => {
  it('mints a file-ref attachment carrying the normalized ref', () => {
    const ref = makeRef();
    const att = createPromptAttachment({
      kind: 'file-ref',
      ref,
      summary: 'short',
    }) as PromptAttachmentFileRef;
    expect(att.kind).toBe('file-ref');
    expect(att.ref.nodeId).toBe('mac-studio');
    expect(att.ref.path).toBe('/Users/d/file.txt');
    expect(att.summary).toBe('short');
  });

  it('drops empty summary rather than retaining an empty string', () => {
    const att = createPromptAttachment({
      kind: 'file-ref',
      ref: makeRef(),
      summary: '',
    });
    expect(att.summary).toBeUndefined();
  });

  it('re-normalizes a caller-provided ref through createFileResourceRef', () => {
    const ref = makeRef({ path: '/Users/d/file.txt' });
    // Construct an "un-normalized" ref by hand and ensure the constructor
    // re-runs validation/normalization.
    const att = createPromptAttachment({
      kind: 'file-ref',
      ref: { ...ref, path: '/Users/d//file.txt' },
    }) as PromptAttachmentFileRef;
    expect(att.ref.path).toBe('/Users/d/file.txt');
  });

  it('rejects unknown kinds', () => {
    expect(() =>
      createPromptAttachment({
        // @ts-expect-error: testing runtime guard
        kind: 'diff-ref',
        ref: makeRef(),
      })
    ).toThrow(/kind/);
  });

  it('rejects missing ref', () => {
    expect(() =>
      createPromptAttachment({
        kind: 'file-ref',
        // @ts-expect-error: testing runtime guard
        ref: undefined,
      })
    ).toThrow(/ref/);
  });

  it('exposes file-ref in PROMPT_ATTACHMENT_KINDS', () => {
    expect(PROMPT_ATTACHMENT_KINDS).toContain('file-ref');
  });
});

describe('parsePromptAttachment', () => {
  it('round-trips a valid attachment through JSON', () => {
    const original = createPromptAttachment({
      kind: 'file-ref',
      ref: makeRef({ size: 42, sha256: 'a'.repeat(64) }),
      summary: 'preview',
    });
    const parsed = parsePromptAttachment(
      JSON.parse(JSON.stringify(original))
    ) as PromptAttachmentFileRef | null;
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('file-ref');
    expect(parsed?.ref.path).toBe('/Users/d/file.txt');
    expect(parsed?.summary).toBe('preview');
  });

  it('returns null for non-objects', () => {
    expect(parsePromptAttachment(null)).toBeNull();
    expect(parsePromptAttachment('x')).toBeNull();
    expect(parsePromptAttachment(7)).toBeNull();
  });

  it('returns null on unknown kind', () => {
    expect(
      parsePromptAttachment({ kind: 'diff-ref', ref: makeRef() })
    ).toBeNull();
  });

  it('returns null on malformed inner ref', () => {
    expect(
      parsePromptAttachment({
        kind: 'file-ref',
        ref: { nodeId: 'n', path: '../x', intent: 'read' },
      })
    ).toBeNull();
  });
});

describe('parsePromptAttachmentList', () => {
  it('returns [] for non-array payload', () => {
    expect(parsePromptAttachmentList(null)).toEqual([]);
    expect(parsePromptAttachmentList('not-array')).toEqual([]);
    expect(parsePromptAttachmentList({})).toEqual([]);
  });

  it('drops malformed entries and keeps valid ones', () => {
    const valid = createPromptAttachment({ kind: 'file-ref', ref: makeRef() });
    const list = parsePromptAttachmentList([
      JSON.parse(JSON.stringify(valid)),
      { kind: 'file-ref', ref: { nodeId: 'n', path: 'bad', intent: 'read' } },
      null,
      'string',
      JSON.parse(JSON.stringify(valid)),
    ]);
    expect(list).toHaveLength(2);
    expect(list.every((a) => a.kind === 'file-ref')).toBe(true);
  });

  it('truncates at MAX_PROMPT_ATTACHMENTS_PER_MESSAGE', () => {
    const valid = createPromptAttachment({ kind: 'file-ref', ref: makeRef() });
    const oversized = Array.from(
      { length: MAX_PROMPT_ATTACHMENTS_PER_MESSAGE + 5 },
      () => JSON.parse(JSON.stringify(valid)) as unknown
    );
    const list = parsePromptAttachmentList(oversized);
    expect(list).toHaveLength(MAX_PROMPT_ATTACHMENTS_PER_MESSAGE);
  });
});

describe('promptAttachmentToArtifactRef', () => {
  function makeAtt(
    overrides: Partial<PromptAttachment & { summary: string }> = {}
  ) {
    return createPromptAttachment({
      kind: 'file-ref',
      ref: makeRef({ size: 100 }),
      ...(overrides.summary ? { summary: overrides.summary } : {}),
    });
  }

  it('produces a bounded ArtifactRef with rawPayloadStored=false', () => {
    const ref = promptAttachmentToArtifactRef(makeAtt(), { id: 'art_1' });
    expect(ref.kind).toBe('file');
    expect(ref.path).toBe('/Users/d/file.txt');
    expect(ref.privacy.rawPayloadStored).toBe(false);
    expect(ref.privacy.redaction.strategy).toBe('summary');
    expect(ref.privacy.redaction.classes).toContain('artifact');
    expect(ref.privacy.redaction.byteCount).toBe(100);
  });

  it("uses 'hash' redaction strategy when the ref carries a sha256", () => {
    const att = createPromptAttachment({
      kind: 'file-ref',
      ref: makeRef({ sha256: 'f'.repeat(64) }),
    });
    const ref = promptAttachmentToArtifactRef(att, { id: 'art_2' });
    expect(ref.privacy.redaction.strategy).toBe('hash');
    expect(ref.privacy.redaction.hashSha256).toBe('f'.repeat(64));
  });

  it('falls back to ref summary string when no summary is set', () => {
    const ref = promptAttachmentToArtifactRef(makeAtt(), { id: 'art_3' });
    expect(ref.title).toBe('mac-studio:/Users/d/file.txt');
    expect(ref.summary).toBeUndefined();
  });

  it('preserves caller-provided summary on the ArtifactRef', () => {
    const ref = promptAttachmentToArtifactRef(
      makeAtt({ summary: 'helpful note' }),
      {
        id: 'art_4',
      }
    );
    expect(ref.title).toBe('helpful note');
    expect(ref.summary).toBe('helpful note');
    expect(ref.privacy.redaction.preview).toBe('helpful note');
  });

  it('uses caller-provided producedAt when supplied', () => {
    const ts = '2026-05-20T00:00:00.000Z';
    const ref = promptAttachmentToArtifactRef(makeAtt(), {
      id: 'art_5',
      producedAt: ts,
      producedByActorId: 'actor_human_1',
    });
    expect(ref.producedAt).toBe(ts);
    expect(ref.producedByActorId).toBe('actor_human_1');
  });
});
