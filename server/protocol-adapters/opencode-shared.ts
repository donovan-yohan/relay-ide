/**
 * Wire vocabulary shared by the two OpenCode lanes, and by nothing else.
 *
 * Classification: QUIRK, deduplicated — not promoted to choreography. Nothing
 * here is provider-agnostic, so `adapter-utils.ts` is the wrong home: putting an
 * OpenCode encoding in the shared choreography layer would hand every other
 * harness a rule that is only true of this one, which is the "generalized quirk"
 * `AGENTS.md` rejects. But `OpenCodeProtocolAdapter` (Relay spawns
 * `opencode serve`) and `OpenCodeAttachedAdapter` (an operator's own
 * `opencode serve` / `opencode web`) consume the SAME server's SSE stream, so a
 * second hand-written copy of its decoding is drift waiting to happen — which is
 * exactly the #1412 defect: the attached lane compared `status === 'idle'` as a
 * bare string while the real server sends `{ type: 'idle' }`, so its turns never
 * ended at all.
 *
 * One provider, one decoder, two lanes. Anything a lane does NOT share — the
 * spawned adapter's `retry` message extraction, the attached adapter's
 * interrupt bookkeeping — stays in that adapter.
 */

/**
 * Decode `session.status` into its status name.
 *
 * The status rides the wire in two encodings: a bare string, and the nested
 * `{ type: 'idle' }` object the real server sends (see
 * `test/fixtures/opencode-serve-stub.cjs` `emitTurn()`). Both are accepted;
 * anything else decodes to `undefined` so the caller can log a gap instead of
 * guessing a lifecycle transition.
 */
export function openCodeStatusType(status: unknown): string | undefined {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object') {
    const type = (status as Record<string, unknown>)['type'];
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}
