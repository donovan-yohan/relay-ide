/**
 * CHOREOGRAPHY: reading untrusted wire values (see AGENTS.md).
 *
 * Every adapter parses JSON it did not author, so every adapter grew the same
 * five-line coercions — `nowIso`, an is-it-a-record guard, a string field
 * reader, a JSON stringifier that cannot throw. They were byte-identical in
 * four adapters (claude, codex-native, pi-agent, prime-agent) modulo the local
 * alias each file happened to pick (`record`/`objectField`, `string`/
 * `stringField`), which is exactly the "same dance, hand-copied" the layer
 * charter forbids. They live here once.
 *
 * These are PURE: no adapter state, no patches, no provider vocabulary. A
 * helper that has to know what a provider calls something is a quirk and stays
 * in its adapter — `hermes.parseToolArguments` (whitespace-guarded) and
 * `pi.toolArguments` (not) read the same-looking field with different
 * semantics, so they deliberately did NOT unify here.
 */

/** Wall-clock stamp for a patch. Single definition so tests can find one seam. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** True for a plain JSON object — arrays and `null` are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record field, or `{}` when the wire sent something else. */
export function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A string field, or `fallback` (default `''`) when the wire sent something else. */
export function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * `JSON.stringify` that cannot throw. Cyclic or otherwise unserializable input
 * becomes a marker string rather than an exception in a patch-emitting path.
 */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** A finite number field, or `fallback`. Rejects `NaN`/`Infinity`. */
export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A queue depth off the wire: a safe non-negative integer, or `0`. Stricter
 * than `numberOr` on purpose — a fractional or negative depth is nonsense, and
 * the reduced session renders this number.
 */
export function queueCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * Added/removed line counts for a unified diff. `+++`/`---` file headers are
 * not content lines. Identical in codex-native and hermes before this moved.
 */
export function diffCounts(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}
