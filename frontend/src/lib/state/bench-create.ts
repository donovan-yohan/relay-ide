// #730 (Epic #444 view-spine): PURE helpers for the Bench-creation flow wired to
// the #735 `/hub/ia/benches` CRUD API. A Bench is a cwd + env layered on an
// Instance; for a repo-instance the cwd defaults to a worktree path under the
// repo, for a node-instance it is an arbitrary absolute cwd.
//
// These helpers carry NO React, NO I/O. They MIRROR the server's structural
// validation (`validateBenchCwd` in `server/features/repo-router.ts`) so the
// client rejects bad input before a round-trip:
//   - cwd must be a non-blank absolute path (POSIX `/…` or Windows `X:\…`)
//   - no `..` traversal segment
//   - no NUL / control characters
//
// C1 (from #735 review): the cwd is sent VERBATIM. We never `decodeURIComponent`
// a cwd before sending or displaying it — the raw absolute path is the contract.

/** Why a cwd was rejected. `null` = valid. UI maps these to inline messages. */
export type BenchCwdError =
  | 'CWD_REQUIRED'
  | 'CWD_NOT_ABSOLUTE'
  | 'CWD_TRAVERSAL'
  | 'INVALID_CWD';

/** Validate a candidate bench cwd. Returns `null` when valid, else a reason
 *  code mirroring the server's `validateBenchCwd`. Operates on the RAW string —
 *  no decoding, no normalization (C1). */
export function validateBenchCwd(value: string): BenchCwdError | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'CWD_REQUIRED';
  }
  // NUL or other control chars never belong in a path.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return 'INVALID_CWD';
  }
  const isPosixAbs = value.startsWith('/');
  const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(value);
  if (!isPosixAbs && !isWindowsAbs) {
    return 'CWD_NOT_ABSOLUTE';
  }
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) {
    return 'CWD_TRAVERSAL';
  }
  return null;
}

/** Human-readable, lowercase TUI copy for a cwd rejection. */
export function benchCwdErrorMessage(error: BenchCwdError): string {
  switch (error) {
    case 'CWD_REQUIRED':
      return 'enter an absolute cwd';
    case 'CWD_NOT_ABSOLUTE':
      return 'cwd must be an absolute path';
    case 'CWD_TRAVERSAL':
      return 'cwd must not contain ".."';
    case 'INVALID_CWD':
      return 'cwd contains invalid characters';
  }
}

/** A single env override entry as edited in the UI (key=value pair). */
export interface EnvOverrideEntry {
  key: string;
  value: string;
}

/** The create payload `POST /hub/ia/benches` accepts. `cwd` is the RAW absolute
 *  path (C1: never decoded). `label`/`envOverrides` are omitted when empty so the
 *  server falls back to its defaults (derived label, no overrides). */
export interface CreateBenchPayload {
  instanceId: string;
  cwd: string;
  label?: string;
  envOverrides?: Record<string, string>;
}

/** Build the create payload from raw form fields. Trims the cwd of surrounding
 *  whitespace ONLY (interior bytes are the verbatim path). Drops blank-keyed env
 *  entries; a later entry with the same key wins (last-write). Omits `label` and
 *  `envOverrides` entirely when empty so the request stays minimal. PURE. */
export function buildBenchPayload(input: {
  instanceId: string;
  cwd: string;
  label?: string;
  envEntries?: ReadonlyArray<EnvOverrideEntry>;
}): CreateBenchPayload {
  const cwd = input.cwd.trim();
  const payload: CreateBenchPayload = {
    instanceId: input.instanceId,
    cwd,
  };
  const label = input.label?.trim();
  if (label) payload.label = label;

  const env: Record<string, string> = {};
  for (const entry of input.envEntries ?? []) {
    const key = entry.key.trim();
    if (key.length === 0) continue; // blank keys are dropped (server would too)
    env[key] = entry.value;
  }
  if (Object.keys(env).length > 0) payload.envOverrides = env;

  return payload;
}
