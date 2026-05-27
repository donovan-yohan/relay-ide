import type { ArtifactId, ArtifactKind, ArtifactRef } from './work-context.js';
import { createWorkContextPrivacyMetadata } from './work-context.js';
import {
  createFileResourceRef,
  parseFileResourceRef,
  fileResourceRefSummary,
  type FileResourceRef,
} from './file-resource-ref.js';
import type { AnchorRef } from './context-packet.js';
import { parseAnchorRef, anchorRefSummary } from './context-packet.js';

/**
 * `PromptAttachment` is the typed shape an agent or human attaches to an
 * outgoing prompt (or to a `WorkContext`). It is **ref-only by default**:
 * the attachment carries a pointer + advisory metadata, not raw bytes.
 *
 * Consumers (adapters, WorkContext store) may expand a ref into content
 * only when they hold the right capability grant and the expansion is
 * size-bounded.
 *
 * The discriminated union is intentionally open — `'diff-ref'` and
 * `'log-ref'` kinds will land in follow-on #616 slices. ADR-019 (#758) adds
 * the `'file-anchor'` sibling kind (a `FileResourceRef` + range + captured
 * quote) for anchored context packets rather than threading a `range?` onto
 * the existing `'file-ref'` path — see `shared/context-packet.ts`.
 */
export type PromptAttachment =
  | PromptAttachmentFileRef
  | PromptAttachmentFileAnchor;

export interface PromptAttachmentFileRef {
  kind: 'file-ref';
  ref: FileResourceRef;
  /** Optional short human-readable summary for chips/audit rows. */
  summary?: string;
}

/**
 * A ranged file attachment: the `AnchorRef` (file pointer + line/byte range +
 * captured quote) from `shared/context-packet.ts`. Distinct identity from
 * `file-ref`: a whole-file ref and a ranged ref are different attachments,
 * not the same one with an optional field (ADR-019 D2).
 */
export interface PromptAttachmentFileAnchor {
  kind: 'file-anchor';
  anchor: AnchorRef;
  /** Optional short human-readable summary for chips/audit rows. */
  summary?: string;
}

export const PROMPT_ATTACHMENT_KINDS: readonly PromptAttachment['kind'][] = [
  'file-ref',
  'file-anchor',
] as const;

/**
 * Soft cap on the number of attachments a single prompt may carry. Server
 * `agent-send-message-v2` handler enforces this; `parsePromptAttachmentList`
 * truncates beyond this bound rather than dropping the whole list (the
 * accepted prefix is preferable to silent total loss on a single bad entry).
 */
export const MAX_PROMPT_ATTACHMENTS_PER_MESSAGE = 16;

export interface CreatePromptAttachmentFileRefArgs {
  kind: 'file-ref';
  ref: FileResourceRef;
  summary?: string;
}

export interface CreatePromptAttachmentFileAnchorArgs {
  kind: 'file-anchor';
  anchor: AnchorRef;
  summary?: string;
}

export type CreatePromptAttachmentArgs =
  | CreatePromptAttachmentFileRefArgs
  | CreatePromptAttachmentFileAnchorArgs;

export function createPromptAttachment(
  args: CreatePromptAttachmentArgs
): PromptAttachment {
  if (args.kind === 'file-anchor') {
    // Re-validate through the canonical anchor parser so a caller-built
    // anchor is normalized (range checked, quote byte-bounded) here too.
    const anchor = parseAnchorRef(args.anchor);
    if (!anchor) {
      throw new Error('PromptAttachment.anchor is invalid for kind=file-anchor');
    }
    const out: PromptAttachmentFileAnchor = {
      kind: 'file-anchor',
      anchor,
    };
    if (typeof args.summary === 'string' && args.summary.length > 0) {
      out.summary = args.summary;
    }
    return out;
  }
  if (args.kind !== 'file-ref') {
    throw new Error(
      `PromptAttachment.kind must be one of ${PROMPT_ATTACHMENT_KINDS.join('|')}, got: ${String((args as { kind?: unknown }).kind)}`
    );
  }
  if (!args.ref || typeof args.ref !== 'object') {
    throw new Error('PromptAttachment.ref is required for kind=file-ref');
  }
  // Re-mint through `createFileResourceRef` so any caller-built ref is
  // normalized + validated by the canonical constructor. `FileResourceRef`
  // is a structural supertype of `CreateFileResourceRefArgs`, so the ref
  // can be passed through directly.
  const normalizedRef = createFileResourceRef(args.ref);
  const out: PromptAttachmentFileRef = {
    kind: 'file-ref',
    ref: normalizedRef,
  };
  if (typeof args.summary === 'string' && args.summary.length > 0) {
    out.summary = args.summary;
  }
  return out;
}

/**
 * Parse an unknown payload into a `PromptAttachment`. Returns `null` on
 * any validation failure so callers can drop the single bad entry without
 * tearing down the whole prompt.
 */
export function parsePromptAttachment(
  payload: unknown
): PromptAttachment | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p['kind'] === 'file-anchor') {
    const anchor = parseAnchorRef(p['anchor']);
    if (!anchor) return null;
    try {
      return createPromptAttachment({
        kind: 'file-anchor',
        anchor,
        ...(typeof p['summary'] === 'string' ? { summary: p['summary'] } : {}),
      });
    } catch {
      return null;
    }
  }
  if (p['kind'] !== 'file-ref') return null;
  const ref = parseFileResourceRef(p['ref']);
  if (!ref) return null;
  try {
    return createPromptAttachment({
      kind: 'file-ref',
      ref,
      ...(typeof p['summary'] === 'string' ? { summary: p['summary'] } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * Parse an array of unknown attachment payloads, dropping malformed
 * entries and truncating at `MAX_PROMPT_ATTACHMENTS_PER_MESSAGE`. Returns
 * an empty array if `payload` is not an array.
 */
export function parsePromptAttachmentList(
  payload: unknown
): PromptAttachment[] {
  if (!Array.isArray(payload)) return [];
  const out: PromptAttachment[] = [];
  for (const entry of payload) {
    if (out.length >= MAX_PROMPT_ATTACHMENTS_PER_MESSAGE) break;
    const parsed = parsePromptAttachment(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface PromptAttachmentToArtifactRefArgs {
  /** Stable artifact id (caller-owned — typically UUID or content hash). */
  id: ArtifactId;
  /** Actor that produced the attachment (human user id, agent id, etc.). */
  producedByActorId?: string;
  /** Override `producedAt`; defaults to `new Date().toISOString()`. */
  producedAt?: string;
}

/**
 * Bridge a `PromptAttachment` to a `WorkContext.ArtifactRef`. The produced
 * ref is bounded by default: `privacy.rawPayloadStored = false`,
 * `redaction.strategy = 'hash'` when the source ref carries a sha256,
 * else `'summary'`. Callers that expand content into the work context
 * (with capability) must construct their own `ArtifactRef` with
 * `rawPayloadStored: true` — this bridge will not produce that shape.
 */
export function promptAttachmentToArtifactRef(
  attachment: PromptAttachment,
  args: PromptAttachmentToArtifactRefArgs
): ArtifactRef {
  if (attachment.kind === 'file-anchor') {
    // Anchored attachment: bridge the underlying FileResourceRef + range to a
    // bounded `file` artifact. The range rides the summary/title (the #763 pin
    // path), never expanding the captured quote into a raw payload.
    const aref = attachment.anchor.ref;
    const aHasHash =
      typeof aref.sha256 === 'string' && aref.sha256.length === 64;
    const aSummary = attachment.summary ?? anchorRefSummary(attachment.anchor);
    const aPrivacy = createWorkContextPrivacyMetadata({
      classification: 'internal',
      retention: 'session',
      rawPayloadStored: false,
      redaction: {
        redacted: false,
        strategy: aHasHash ? 'hash' : 'summary',
        classes: ['artifact'],
        ...(typeof aref.size === 'number' ? { byteCount: aref.size } : {}),
        ...(aHasHash ? { hashSha256: aref.sha256 } : {}),
        preview: aSummary,
      },
    });
    const aOut: ArtifactRef = {
      id: args.id,
      kind: 'file',
      title: aSummary,
      path: aref.path,
      summary: aSummary,
      producedAt: args.producedAt ?? new Date().toISOString(),
      privacy: aPrivacy,
    };
    if (args.producedByActorId) aOut.producedByActorId = args.producedByActorId;
    return aOut;
  }
  if (attachment.kind !== 'file-ref') {
    throw new Error(
      `promptAttachmentToArtifactRef: unsupported kind ${String((attachment as { kind?: unknown }).kind)}`
    );
  }
  const ref = attachment.ref;
  const kind: ArtifactKind = 'file';
  const hasHash = typeof ref.sha256 === 'string' && ref.sha256.length === 64;
  const privacy = createWorkContextPrivacyMetadata({
    classification: 'internal',
    retention: 'session',
    rawPayloadStored: false,
    redaction: {
      redacted: false,
      strategy: hasHash ? 'hash' : 'summary',
      classes: ['artifact'],
      ...(typeof ref.size === 'number' ? { byteCount: ref.size } : {}),
      ...(hasHash ? { hashSha256: ref.sha256 } : {}),
      ...(attachment.summary ? { preview: attachment.summary } : {}),
    },
  });
  const out: ArtifactRef = {
    id: args.id,
    kind,
    title: attachment.summary ?? fileResourceRefSummary(ref),
    path: ref.path,
    producedAt: args.producedAt ?? new Date().toISOString(),
    privacy,
  };
  if (args.producedByActorId) out.producedByActorId = args.producedByActorId;
  if (attachment.summary) out.summary = attachment.summary;
  return out;
}
