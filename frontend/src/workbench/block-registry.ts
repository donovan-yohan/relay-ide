/**
 * Workbench block registry — slice 2 of epic #612.
 *
 * Single canonical registry mapping WorkbenchBlockKind → renderer factory.
 * All downstream callers must use getBlockRenderer() instead of maintaining
 * scattered switch statements over block kinds.
 *
 * First-party renderers are registered by calling initFirstPartyBlocks() once
 * at application startup. The function is async because block renderer modules
 * are loaded via dynamic import to avoid circular dependency issues at
 * type-checking time (renderer TSX files import React, which is not available
 * in pure-type-checking contexts). Last writer wins on duplicate registration.
 *
 * Extensibility (adding a new block kind):
 *   1. Add the new literal to WorkbenchBlockKind (shared/workbench-block-types.ts).
 *   2. Add a new variant to WorkbenchBlockDescriptor.
 *   3. Create a renderer under frontend/src/workbench/blocks/.
 *   4. Call registerBlockRenderer() from initFirstPartyBlocks() or from the
 *      owning plugin module.
 */

import type {
  WorkbenchBlockKind,
  WorkbenchBlockRenderer,
} from '../../../shared/workbench-block-types.js';

// ---------------------------------------------------------------------------
// Internal registry map
// ---------------------------------------------------------------------------

// The map stores renderers keyed by kind. We use `any` here because the map
// holds renderers for all K simultaneously; callers use the typed
// getBlockRenderer<K>() which restores the correct generic at the call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry = new Map<WorkbenchBlockKind, WorkbenchBlockRenderer<any>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a renderer for a given block kind.
 * Safe to call at module-level import time.
 * Warns on duplicate registration (last writer wins).
 */
export function registerBlockRenderer<K extends WorkbenchBlockKind>(
  kind: K,
  renderer: WorkbenchBlockRenderer<K>
): void {
  if (_registry.has(kind)) {
    // Warn in development to surface accidental double-registration early.
    // Last writer wins — this is intentional for hot-reload and test scenarios.
    // eslint-disable-next-line no-console -- intentional: surface duplicate renderer registration in devtools
    console.warn(
      `[block-registry] duplicate registration for kind "${kind}" — last writer wins`
    );
  }
  _registry.set(kind, renderer);
}

/**
 * Look up the renderer for a given block kind.
 * Returns undefined if no renderer is registered for that kind.
 * BlockHost uses this to implement the unknown-kind fallback.
 */
export function getBlockRenderer<K extends WorkbenchBlockKind>(
  kind: K
): WorkbenchBlockRenderer<K> | undefined {
  return _registry.get(kind) as WorkbenchBlockRenderer<K> | undefined;
}

/**
 * Return the set of currently registered kinds.
 * Primarily for inspection and testing.
 */
export function registeredKinds(): ReadonlySet<WorkbenchBlockKind> {
  return new Set(_registry.keys());
}

// ---------------------------------------------------------------------------
// First-party block registration
// ---------------------------------------------------------------------------

/**
 * Register all eight first-party block renderers.
 * Call once at application startup (e.g. before rendering the app root).
 * Safe to call multiple times — last writer wins on duplicate registration.
 *
 * Uses dynamic imports so renderer TSX files (which have React JSX) are only
 * loaded in browser/test environments where React is available, not during
 * server-side type-checking or shared module evaluation.
 */
export async function initFirstPartyBlocks(): Promise<void> {
  const [
    terminal,
    agent,
    promptFanout,
    workContext,
    file,
    artifact,
    markdown,
    custom,
  ] =
    await Promise.all([
      import('./blocks/terminal.js'),
      import('./blocks/agent.js'),
      import('./blocks/prompt-fanout.js'),
      import('./blocks/work-context.js'),
      import('./blocks/file.js'),
      import('./blocks/artifact.js'),
      import('./blocks/markdown.js'),
      import('./blocks/custom.js'),
    ]);

  registerBlockRenderer('terminal', terminal.TerminalBlock);
  registerBlockRenderer('agent', agent.AgentBlock);
  registerBlockRenderer('prompt-fanout', promptFanout.PromptFanoutBlock);
  registerBlockRenderer('work-context', workContext.WorkContextBlock);
  registerBlockRenderer('file', file.FileBlock);
  registerBlockRenderer('artifact', artifact.ArtifactBlock);
  registerBlockRenderer('markdown', markdown.MarkdownBlock);
  registerBlockRenderer('custom', custom.CustomBlock);
}
