/**
 * Workbench layout persistence contracts — slice 3 of epic #612.
 *
 * Defines the serialized layout model for the Workbench canvas: block
 * placement (position + size + minimized state), per-workspace scope, and
 * the envelope that owns the schema version.
 *
 * Design notes
 * ────────────
 * Coordinate model: freeform pixel coordinates. The Workbench canvas hosts
 * independently draggable/resizable blocks — not a split-pane layout. The
 * existing `react-resizable-panels` / percentage-split model is scoped to
 * the SessionPane workspace; the Workbench canvas is a separate surface.
 *
 * Forward compatibility: unknown block `kind` values MUST survive a
 * serialize→deserialize round-trip. The server accepts and returns unknown
 * kinds verbatim; the renderer falls back to the UnknownKindCard from
 * slice 2. Unknown extra fields on `WorkbenchBlockPlacement` are preserved
 * under `_unknown` to avoid silent data loss.
 *
 * WorkspaceScopeRef: a lightweight reference to an existing workspace from
 * server/types.ts `Workspace`. We reuse the `id` field directly — no new
 * opaque type needed. The `displayName` is a denormalised hint for debug
 * only and is not authoritative.
 */

import type { WorkbenchBlockDescriptor } from './workbench-block-types.js';

// ---------------------------------------------------------------------------
// WorkspaceScopeRef
// ---------------------------------------------------------------------------

/**
 * Reference to the workspace scope that owns this layout.
 * `id` corresponds to `Workspace.id` in server/types.ts — the stable opaque
 * workspace identifier (`ws:<encoded-name>` shape, but the shape is not
 * enforced here to avoid a server→shared import cycle).
 */
export interface WorkspaceScopeRef {
  /** Stable workspace id. Matches `Workspace.id` from server/types.ts. */
  id: string;
  /** Human-readable hint for debugging. Not authoritative. */
  displayName?: string;
}

// ---------------------------------------------------------------------------
// WorkbenchBlockPlacement
// ---------------------------------------------------------------------------

/**
 * Placement record for a single block on the canvas.
 *
 * `descriptor` is a full `WorkbenchBlockDescriptor` (discriminated union on
 * `kind`). When a future kind is added server-side, older clients receive it
 * with `kind` set to the new literal; `getBlockRenderer` returns `undefined`
 * and `BlockHost` renders the UnknownKindCard safe fallback.
 *
 * The `_unknown` bag captures any extra JSON fields from the server that the
 * current client does not recognise — they are round-tripped back to the
 * server on the next PUT so future state is not silently dropped.
 */
export interface WorkbenchBlockPlacement {
  /** Full block descriptor — includes kind, id, title, capabilityRequirements, meta. */
  descriptor: WorkbenchBlockDescriptor;
  /**
   * Top-left corner of the block on the canvas in CSS pixels.
   * Stored as pixel values so the layout is stable across viewport sizes.
   * The canvas component clamps values to the visible area on mount.
   */
  position: { x: number; y: number };
  /**
   * Block dimensions in CSS pixels.
   * Minimum size enforcement is the responsibility of the canvas component.
   */
  size: { width: number; height: number };
  /** When true, the block body is collapsed; only the title bar is visible. */
  minimized: boolean;
  /**
   * Forward-compat bag: extra fields from the server not recognised by this
   * client version are stashed here and round-tripped unchanged.
   * Not rendered or interpreted — purely a persistence fidelity mechanism.
   */
  _unknown?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// WorkbenchLayout
// ---------------------------------------------------------------------------

/**
 * The full persisted layout for one workspace.
 * Stored server-side as a JSON document keyed by workspace id.
 */
export interface WorkbenchLayout {
  /**
   * Schema version for forward compat.
   * Current: 1.
   * Increment when a breaking change is made to the layout shape.
   * The server validates that it understands `schemaVersion` before accepting.
   */
  schemaVersion: number;
  /** Workspace that owns this layout. */
  workspaceScope: WorkspaceScopeRef;
  /** Ordered placement list. Order determines z-stacking (last = front). */
  blocks: ReadonlyArray<WorkbenchBlockPlacement>;
}

// ---------------------------------------------------------------------------
// Current schema version constant
// ---------------------------------------------------------------------------

export const WORKBENCH_LAYOUT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialise a `WorkbenchLayout` to a plain JSON-compatible object.
 * `ReadonlyArray` fields are cast to `unknown[]` so `JSON.stringify` can
 * handle them without extra conversion at the call site.
 */
export function serialiseWorkbenchLayout(layout: WorkbenchLayout): unknown {
  return JSON.parse(JSON.stringify(layout));
}

/**
 * Deserialise a raw JSON value into a `WorkbenchLayout`.
 *
 * Forward-compat contract:
 *   - Unknown block `kind` values are accepted and round-tripped.
 *   - Extra fields on placement objects are stashed in `_unknown`.
 *   - Missing optional fields receive safe defaults.
 *
 * Returns `null` for null/undefined input (no layout stored yet).
 * Throws `Error` for structurally invalid data (not an object, missing
 * required fields, unrecognised schemaVersion).
 */
export function deserialiseWorkbenchLayout(
  raw: unknown
): WorkbenchLayout | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('workbench layout: expected object at root');
  }
  const obj = raw as Record<string, unknown>;

  const schemaVersion = obj['schemaVersion'];
  if (typeof schemaVersion !== 'number') {
    throw new Error('workbench layout: schemaVersion must be a number');
  }
  if (schemaVersion !== WORKBENCH_LAYOUT_SCHEMA_VERSION) {
    throw new Error(
      `workbench layout: unsupported schemaVersion ${schemaVersion} (expected ${WORKBENCH_LAYOUT_SCHEMA_VERSION})`
    );
  }

  const workspaceScope = obj['workspaceScope'];
  if (
    typeof workspaceScope !== 'object' ||
    workspaceScope === null ||
    typeof (workspaceScope as Record<string, unknown>)['id'] !== 'string'
  ) {
    throw new Error('workbench layout: workspaceScope.id must be a string');
  }

  const rawBlocks = obj['blocks'];
  if (!Array.isArray(rawBlocks)) {
    throw new Error('workbench layout: blocks must be an array');
  }

  const blocks: WorkbenchBlockPlacement[] = rawBlocks.map((rawBlock, i) =>
    deserialiseBlockPlacement(rawBlock, i)
  );

  return {
    schemaVersion,
    workspaceScope: workspaceScope as WorkspaceScopeRef,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Internal: block placement deserialisation
// ---------------------------------------------------------------------------

function deserialiseBlockPlacement(
  raw: unknown,
  index: number
): WorkbenchBlockPlacement {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`workbench layout: blocks[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  const descriptor = obj['descriptor'];
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    typeof (descriptor as Record<string, unknown>)['kind'] !== 'string' ||
    typeof (descriptor as Record<string, unknown>)['id'] !== 'string'
  ) {
    throw new Error(
      `workbench layout: blocks[${index}].descriptor must have kind and id`
    );
  }

  const position = obj['position'];
  if (
    typeof position !== 'object' ||
    position === null ||
    typeof (position as Record<string, unknown>)['x'] !== 'number' ||
    typeof (position as Record<string, unknown>)['y'] !== 'number'
  ) {
    throw new Error(
      `workbench layout: blocks[${index}].position must have x and y numbers`
    );
  }

  const size = obj['size'];
  if (
    typeof size !== 'object' ||
    size === null ||
    typeof (size as Record<string, unknown>)['width'] !== 'number' ||
    typeof (size as Record<string, unknown>)['height'] !== 'number'
  ) {
    throw new Error(
      `workbench layout: blocks[${index}].size must have width and height numbers`
    );
  }

  const minimized =
    typeof obj['minimized'] === 'boolean' ? obj['minimized'] : false;

  // Collect any extra fields into _unknown for round-trip fidelity
  const knownKeys = new Set([
    'descriptor',
    'position',
    'size',
    'minimized',
    '_unknown',
  ]);
  const extraKeys = Object.keys(obj).filter((k) => !knownKeys.has(k));
  const _unknown: Record<string, unknown> | undefined =
    extraKeys.length > 0
      ? Object.fromEntries(extraKeys.map((k) => [k, obj[k]]))
      : undefined;

  return {
    descriptor: descriptor as WorkbenchBlockDescriptor,
    position: position as { x: number; y: number },
    size: size as { width: number; height: number },
    minimized,
    ...(_unknown !== undefined ? { _unknown } : {}),
  };
}
