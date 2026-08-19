/**
 * The pi / prime-agent RPC dialect, stated once.
 *
 * pi and prime-agent are two providers, with two adapters, two registry lanes,
 * and two descriptors — and they are NOT being merged. But they speak the same
 * newline-delimited RPC dialect: the same `toolCallId`/`toolName`/`args` event
 * shape, the same `usage.{input,output,cacheRead,cacheWrite}` accounting, the
 * same image-attachment contract. The helpers below were byte-identical in both
 * adapters (verified by diff), differing only in the provider label inside a
 * few error strings, which is parameterized rather than duplicated.
 *
 * This is provider-scoped, exactly like `opencode-shared.ts` for the two
 * OpenCode lanes: a shared wire vocabulary belongs to the providers that speak
 * it, NOT in `adapter-utils.ts`, which is for choreography every adapter runs.
 * Nothing here may grow a third caller from a provider outside this dialect.
 *
 * What stays adapter-local: pi's `agent_settled` boundary versus prime's
 * `agent_end`, pi's empty-args guard and `/compact` interception, prime's
 * control discovery and retraction. Those are quirks and are not in this file.
 */

import * as fs from 'node:fs';
import type { AgentSendMessageInputV2 } from '../protocol-adapter-v2.js';
import type { AgentUsageV2 } from '../../shared/agent-chat-protocol-v2.js';
import { objectField as record, stringField as string } from './wire-values.js';

export type RpcRecord = Record<string, unknown>;

// ── Message and tool vocabulary ──────────────────────────────────────────────

/** Flatten a `{ content: [{ text }] }` result into text, tolerating a raw string. */
export function resultText(value: unknown): string {
  const content = record(value).content;
  if (!Array.isArray(content)) return typeof value === 'string' ? value : '';
  return content
    .map((part) => string(record(part).text))
    .filter(Boolean)
    .join('\n');
}

/**
 * Tool arguments off the wire. This dialect sends them as an object OR as a
 * JSON string; unparseable text is preserved under `raw` rather than dropped.
 *
 * NOT unified with hermes's `parseToolArguments`, which guards on whitespace
 * and therefore answers differently for the same input. Same-looking code,
 * different semantics — a quirk, per the layer charter.
 */
export function toolArguments(value: unknown): RpcRecord {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as RpcRecord;
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return { raw: value };
    }
  }
  return {};
}

/**
 * Order-independent serialization of a tool's arguments. Keys are sorted so two
 * structurally equal argument objects produce the same identity string
 * regardless of the order the provider happened to emit them in.
 */
export function stableToolArgs(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => stableToolArgs(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as RpcRecord;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableToolArgs(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Identity for a tool call the provider did not give an id: name + args. */
export function toolIdentityKey(name: string, args: RpcRecord): string {
  return `${name}\0${stableToolArgs(args)}`;
}

export function isCommandTool(name: string): boolean {
  return /^(bash|shell|exec|terminal)$/i.test(name);
}

export function isFileTool(name: string): boolean {
  return /^(edit|write|patch|apply_patch|create|delete|move)/i.test(name);
}

// ── Usage accounting ─────────────────────────────────────────────────────────

/**
 * Fold one assistant message's usage into the turn's running total.
 *
 * Returns the new total, or `previous` unchanged for a non-assistant message.
 * Absent fields stay absent rather than becoming `0`: the reduced session
 * renders these, and a reported zero is a different claim from "not reported".
 */
export function accumulateRpcUsage(
  previous: AgentUsageV2 | undefined,
  message: RpcRecord
): AgentUsageV2 | undefined {
  if (message.role !== 'assistant') return previous;
  const usage = record(message.usage);
  const cost = record(usage.cost);
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const inputTokens = number(usage.input);
  const outputTokens = number(usage.output);
  const cacheReadTokens = number(usage.cacheRead);
  const cacheWriteTokens = number(usage.cacheWrite);
  const costUsd = number(cost.total);
  const prior = previous ?? {};
  const add = (
    before: number | undefined,
    next: number | undefined
  ): number | undefined => (next === undefined ? before : (before ?? 0) + next);
  const accumulatedInput = add(prior.inputTokens, inputTokens);
  const accumulatedOutput = add(prior.outputTokens, outputTokens);
  const accumulatedCacheRead = add(prior.cacheReadTokens, cacheReadTokens);
  const accumulatedCacheWrite = add(prior.cacheWriteTokens, cacheWriteTokens);
  const accumulatedCost = add(prior.costUsd ?? undefined, costUsd);
  return {
    ...(accumulatedInput !== undefined
      ? { inputTokens: accumulatedInput }
      : {}),
    ...(accumulatedOutput !== undefined
      ? { outputTokens: accumulatedOutput }
      : {}),
    ...(accumulatedCacheRead !== undefined
      ? { cacheReadTokens: accumulatedCacheRead }
      : {}),
    ...(accumulatedCacheWrite !== undefined
      ? { cacheWriteTokens: accumulatedCacheWrite }
      : {}),
    ...(accumulatedCost !== undefined ? { costUsd: accumulatedCost } : {}),
  };
}

// ── Image attachments ────────────────────────────────────────────────────────

export const MAX_IMAGE_COUNT = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = MAX_IMAGE_COUNT * MAX_IMAGE_BYTES;
export const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Does the file's magic number match the MIME type it claims? A declared type
 * is caller-supplied metadata; the bytes are the evidence.
 */
export function matchesImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png')
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg')
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return (
    mimeType === 'image/webp' &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/**
 * Read and validate image attachments into this dialect's inline-image records.
 *
 * Every check is a refusal to hand the provider something it did not ask for:
 * a count cap, an allowlist of MIME types, a regular-file check that rejects
 * symlinks, a per-file and an aggregate byte budget, and a magic-number match
 * so a declared type cannot lie about its bytes. The size check runs against
 * `lstat` first and against the read bytes again, because the file can change
 * between the two.
 *
 * `providerLabel` appears verbatim in the thrown messages, which reach the user
 * — 'Pi' and 'Prime Agent' respectively.
 */
export function readValidatedImages(
  attachments: AgentSendMessageInputV2['attachments'] = [],
  options: { providerLabel: string }
): RpcRecord[] {
  const { providerLabel } = options;
  const imageAttachments = attachments.filter(
    (attachment) => attachment.type === 'image'
  );
  if (imageAttachments.length > MAX_IMAGE_COUNT) {
    throw new Error(`${providerLabel} accepts at most ${MAX_IMAGE_COUNT} images`);
  }
  const images: RpcRecord[] = [];
  let totalBytes = 0;
  for (const attachment of imageAttachments) {
    const mimeType = attachment.mimeType ?? '';
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Unsupported ${providerLabel} image MIME type: ${mimeType || 'missing'}`
      );
    }
    try {
      const stat = fs.lstatSync(attachment.path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('attachment must be a regular non-symlink file');
      if (stat.size > MAX_IMAGE_BYTES)
        throw new Error(`attachment exceeds ${MAX_IMAGE_BYTES} bytes`);
      totalBytes += stat.size;
      if (totalBytes > MAX_IMAGE_TOTAL_BYTES)
        throw new Error(
          `attachments exceed ${MAX_IMAGE_TOTAL_BYTES} aggregate bytes`
        );
      const bytes = fs.readFileSync(attachment.path);
      if (
        bytes.length > MAX_IMAGE_BYTES ||
        !matchesImageSignature(bytes, mimeType)
      ) {
        throw new Error('attachment bytes do not match the declared image');
      }
      images.push({
        type: 'image',
        data: bytes.toString('base64'),
        mimeType,
      });
    } catch (error) {
      throw new Error(
        `Cannot read ${providerLabel} image attachment ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  return images;
}

// ── Anonymous tool ids ───────────────────────────────────────────────────────

/** Turn-scoped values the tracker needs to mint ids. Read on every call. */
export interface AnonymousToolIdContext {
  /** The turn the ids belong to; part of every fallback id. */
  activeTurnId: () => string | null;
  /** The assistant message counter; part of every fallback id. */
  assistantSeq: () => number;
}

/**
 * Correlates tool events this dialect emitted WITHOUT a `toolCallId`.
 *
 * The provider may announce a tool call in a message preview before streaming
 * its start/update events, and may omit ids on any of them. Anonymous calls are
 * therefore matched on `name + stable(args)`: a preview reserves an id under
 * that key (`reserveForPreview`), the matching start claims it
 * (`idForStart`), and updates resolve to the same id (`idForUpdate`). When
 * args are absent, concurrent same-name calls are genuinely
 * indistinguishable on the wire and FIFO within the name is the only truthful
 * answer available.
 *
 * The minted id format is load-bearing: it reaches the transcript and must stay
 * stable across a turn and across resume.
 */
export class AnonymousToolIdTracker {
  private sequence = 0;
  private readonly claimed = new Map<string, string[]>();
  private readonly reserved = new Map<string, string[]>();

  constructor(private readonly context: AnonymousToolIdContext) {}

  /** Forget every anonymous id. Called on turn reset and transport switch. */
  clear(): void {
    this.claimed.clear();
    this.reserved.clear();
  }

  /** Also resets the fallback counter, for a full turn-state reset. */
  reset(): void {
    this.sequence = 0;
    this.clear();
  }

  /** Mint an id for a call the provider left unidentified. */
  fallbackId(index?: number): string {
    return `${this.context.activeTurnId()}-tool-fallback-${this.context.assistantSeq()}-${index ?? 'none'}-${++this.sequence}`;
  }

  /** Resolve the id for a `tool start` event, claiming any reservation. */
  idForStart(event: RpcRecord): string {
    const providerId = string(event.toolCallId).trim();
    if (providerId) return providerId;
    const name = string(event.toolName, 'tool');
    const key = toolIdentityKey(name, toolArguments(event.args));
    const pending = this.reserved.get(key);
    const id = pending?.shift() ?? this.fallbackId();
    if (pending?.length === 0) this.reserved.delete(key);
    this.claimed.set(key, [...(this.claimed.get(key) ?? []), id]);
    return id;
  }

  /** Resolve the id for a `tool update` event against an in-flight call. */
  idForUpdate(event: RpcRecord): string {
    const providerId = string(event.toolCallId).trim();
    if (providerId) return providerId;
    const name = string(event.toolName, 'tool');
    const args = toolArguments(event.args);
    const exact = this.claimed.get(toolIdentityKey(name, args))?.[0];
    if (exact) return exact;
    // If args are absent, concurrent same-name events are indistinguishable;
    // FIFO is the only truthful fallback available from the provider stream.
    if (Object.keys(args).length === 0) {
      for (const [key, ids] of this.claimed) {
        if (key.startsWith(`${name}\0`) && ids[0]) return ids[0];
      }
    }
    return this.idForStart(event);
  }

  /** Reserve an id for a tool call announced in a message preview. */
  reserveForPreview(toolCall: RpcRecord, index: number): string {
    const providerId = string(toolCall.id).trim();
    if (providerId) return providerId;
    const name = string(toolCall.name, 'tool');
    const key = toolIdentityKey(
      name,
      toolArguments(toolCall.arguments ?? toolCall.args)
    );
    const id = this.fallbackId(index);
    this.reserved.set(key, [...(this.reserved.get(key) ?? []), id]);
    return id;
  }

  /**
   * Release a finished anonymous id so a later same-name call does not resolve
   * to it. A no-op when the provider identified the call itself.
   */
  forget(event: RpcRecord, id: string): void {
    if (string(event.toolCallId).trim()) return;
    for (const [key, ids] of this.claimed) {
      const remaining = ids.filter((candidate) => candidate !== id);
      if (remaining.length !== ids.length) {
        if (remaining.length) this.claimed.set(key, remaining);
        else this.claimed.delete(key);
        return;
      }
    }
  }
}
