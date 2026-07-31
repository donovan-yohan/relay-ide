// #1287 slice 2 (workspace identity spine): guarantee that the hub always owns
// ONE real `ia_workspaces` row for local, unfiled work.
//
// Channel-create paths used to stamp free-string placeholders (`workspace:local`
// from the composer/DM builders, `ws:derived` from the derived read model). No
// `ia_workspaces` id can ever equal those — `upsertWorkspace` only accepts the
// `ws:<localId>` grammar — so the sidebar's `knownIds.has(workspaceId)` lookup
// was structurally always false and every channel rendered in the orphan lane.
// Selecting an orphan then wrote the placeholder back into `activeWorkspaceId`,
// which fed the next create: self-perpetuating.
//
// The fix needs a REAL workspace to fall back to. This module seeds it.
//
// ── SAFETY CONTRACT ────────────────────────────────────────────────────────
// 1. IDEMPOTENT BY LOOKUP, NOT BY MARKER. Runs on every boot and writes only
//    when `LOCAL_WORKSPACE_ID` is absent, so a lost/never-written marker can
//    never leave the hub without its fallback workspace. A user who renamed,
//    recolored, pinned, or archived the local workspace keeps those edits — we
//    never overwrite an existing row.
// 2. WRITES ONLY `ia.db`. No config writes, no session/PTY work, no topic-id
//    mutation of any kind.
// 3. BOOT-SAFE. A failure logs and returns null; the hub keeps booting.

import os from 'node:os';

import { createLogger } from './logger.js';
import type { IaStore } from './ia-store.js';
import type { Workspace } from '../shared/workspace.js';
import {
  LOCAL_WORKSPACE_FALLBACK_NAME,
  LOCAL_WORKSPACE_ID,
} from '../shared/workspace.js';

const logger = createLogger('local-workspace-seed');

/** Ordering slot for the seeded workspace. Negative so the always-present local
 *  lane sorts ahead of user-created workspaces (which mint from 0 upward)
 *  without needing a renumber pass. */
const LOCAL_WORKSPACE_ORDER = -1;

/** Trim a raw host name down to a presentable workspace label. Strips the
 *  `.local`/`.lan` suffixes macOS and consumer routers add, and falls back when
 *  the OS reports nothing useful. */
export function localWorkspaceName(
  hostname: string | null | undefined
): string {
  const raw = typeof hostname === 'string' ? hostname.trim() : '';
  if (!raw) return LOCAL_WORKSPACE_FALLBACK_NAME;
  const short = raw.split('.')[0]?.trim() ?? '';
  const name = short || raw;
  return name.slice(0, 64) || LOCAL_WORKSPACE_FALLBACK_NAME;
}

export interface EnsureLocalWorkspaceInput {
  /** The IA persistence handle (#737). `null` → seeding is skipped. */
  iaStore: IaStore | null;
  /** Host name source. Injected so tests never depend on the runner's host. */
  hostname?: () => string;
}

/**
 * Create the durable local workspace if it does not exist yet. Returns the
 * workspace (existing or freshly seeded), or `null` when there is no store.
 * Safe to call unconditionally on every boot.
 */
export function ensureLocalWorkspace(
  input: EnsureLocalWorkspaceInput
): Workspace | null {
  const { iaStore } = input;
  if (!iaStore) return null;
  // Include archived rows: a user who archived the local workspace must not get
  // a duplicate re-seeded underneath them on the next boot.
  const existing = iaStore.getWorkspace(LOCAL_WORKSPACE_ID);
  if (existing) return existing;
  const hostname = input.hostname ?? (() => os.hostname());
  let name = LOCAL_WORKSPACE_FALLBACK_NAME;
  try {
    name = localWorkspaceName(hostname());
  } catch {
    // A hostile/unavailable host name must not block the seed.
  }
  return iaStore.upsertWorkspace({
    id: LOCAL_WORKSPACE_ID,
    name,
    order: LOCAL_WORKSPACE_ORDER,
    projectIds: [],
  });
}

/**
 * Boot entry point: seed the local workspace and SWALLOW any failure (log +
 * continue). A seeding failure must never crash boot — worst case the sidebar
 * keeps rendering unfiled channels in the orphan lane, exactly as before.
 */
export function runBootLocalWorkspaceSeed(
  input: EnsureLocalWorkspaceInput
): void {
  try {
    ensureLocalWorkspace(input);
  } catch (err) {
    logger.warn(
      'Local workspace seed skipped (boot continues; channels stay unfiled): %s',
      err instanceof Error ? err.message : err
    );
  }
}
