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
import type { RelayCapabilityBit } from './security-policy.js';

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

// ---------------------------------------------------------------------------
// WorkbenchBlockPlacementDescriptor — forward-compat widened type
// ---------------------------------------------------------------------------

/**
 * An "unknown-capable" descriptor shape used inside `WorkbenchBlockPlacement`.
 *
 * Widened beyond `WorkbenchBlockDescriptor` (the closed discriminated union)
 * so that placement records storing future block kinds (not yet in the client's
 * union) can round-trip without requiring unsafe casts. The concrete known kinds
 * narrow normally; unknown kinds fall into the catch-all branch that preserves
 * the raw `kind` string and arbitrary `meta`.
 *
 * `BlockHost` (slice 2) already handles unknown kinds via `getBlockRenderer`
 * returning `undefined` → `UnknownKindCard`. This type widens the container to
 * match that runtime reality at the type level.
 */
export type WorkbenchBlockPlacementDescriptor =
  | WorkbenchBlockDescriptor
  // Unknown future kind — forward-compat catch-all (not in the closed union).
  // `meta` is intentionally `unknown` because the client cannot validate it.
  // `_unknown` stashes any extra descriptor fields for round-trip fidelity.
  | {
      kind: string;
      id: string;
      title: string;
      capabilityRequirements: ReadonlyArray<RelayCapabilityBit | string>;
      meta?: unknown;
      _unknown?: Record<string, unknown>;
    };

/**
 * Placement record for a single block on the canvas.
 *
 * `descriptor` is typed as `WorkbenchBlockPlacementDescriptor` — a widened
 * union that includes both the known `WorkbenchBlockDescriptor` variants and
 * an unknown-kind catch-all. When a future kind is added server-side, older
 * clients receive it in the catch-all branch; `getBlockRenderer` returns
 * `undefined` and `BlockHost` renders the UnknownKindCard safe fallback.
 *
 * The `_unknown` bag captures any extra JSON fields on the placement object
 * from the server that the current client does not recognise — they are
 * round-tripped back to the server on the next PUT so future state is not
 * silently dropped.
 */
export interface WorkbenchBlockPlacement {
  /** Full block descriptor — includes kind, id, title, capabilityRequirements, meta. */
  descriptor: WorkbenchBlockPlacementDescriptor;
  /**
   * Top-left corner of the block on the canvas in CSS pixels.
   * Stored as pixel values so the layout is stable across viewport sizes.
   * The canvas component clamps x/y to >= 0 on drag end.
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
// Serialised shape (JSON-safe)
// ---------------------------------------------------------------------------

/**
 * JSON-safe representation of a `WorkbenchLayout`.
 * Structurally identical to `WorkbenchLayout` but with all `ReadonlyArray`
 * fields widened to plain `unknown[]` so the value is directly passable to
 * `res.json()` or `JSON.stringify` without extra conversion.
 *
 * Use `serialiseWorkbenchLayout` to produce this shape — do NOT use
 * `JSON.parse(JSON.stringify(...))` which performs unnecessary double work.
 */
export type SerializedWorkbenchLayout = {
  schemaVersion: number;
  workspaceScope: {
    id: string;
    displayName?: string;
  };
  blocks: unknown[];
};

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialise a `WorkbenchLayout` to a plain JSON-compatible object.
 *
 * Builds the output object directly — no `JSON.parse(JSON.stringify(...))`
 * round-trip. The server can pass the result directly to `res.json()`.
 *
 * Unknown fields stored in `_unknown` on each block placement are merged back
 * into the serialised block so they survive round-trips to the server.
 */
export function serialiseWorkbenchLayout(
  layout: WorkbenchLayout
): SerializedWorkbenchLayout {
  const blocks = layout.blocks.map((placement) => {
    const { _unknown, ...knownFields } = placement;
    // Merge _unknown back into the serialised object (known fields win on
    // conflict so we don't accidentally overwrite typed fields with stale data).
    return _unknown !== undefined
      ? { ..._unknown, ...knownFields }
      : knownFields;
  });
  return {
    schemaVersion: layout.schemaVersion,
    workspaceScope: { ...layout.workspaceScope },
    blocks,
  };
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
    Array.isArray(descriptor)
  ) {
    throw new Error(
      `workbench layout: blocks[${index}].descriptor must be an object`
    );
  }
  const d = descriptor as Record<string, unknown>;

  if (typeof d['kind'] !== 'string') {
    throw new Error(
      `workbench layout: blocks[${index}].descriptor.kind must be a string`
    );
  }
  if (typeof d['id'] !== 'string') {
    throw new Error(
      `workbench layout: blocks[${index}].descriptor.id must be a string`
    );
  }
  // Bug 3 fix: validate title and capabilityRequirements so that
  // missingCapabilities() cannot crash on undefined later.
  if (typeof d['title'] !== 'string') {
    throw new Error(
      `workbench layout: blocks[${index}].descriptor.title must be a string`
    );
  }
  if (!Array.isArray(d['capabilityRequirements'])) {
    throw new Error(
      `workbench layout: blocks[${index}].descriptor.capabilityRequirements must be an array`
    );
  }
  // Each entry in capabilityRequirements must be a string.
  const capReqs = d['capabilityRequirements'] as unknown[];
  for (let j = 0; j < capReqs.length; j++) {
    if (typeof capReqs[j] !== 'string') {
      throw new Error(
        `workbench layout: blocks[${index}].descriptor.capabilityRequirements[${j}] must be a string`
      );
    }
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

  // Bug 4 fix: merge existing _unknown (from a prior deserialization round-trip)
  // with newly-discovered extra fields. Newly-discovered extras win on conflict
  // so we don't silently drop fields added by future schema versions.
  const existingUnknown: Record<string, unknown> =
    typeof obj['_unknown'] === 'object' &&
    obj['_unknown'] !== null &&
    !Array.isArray(obj['_unknown'])
      ? (obj['_unknown'] as Record<string, unknown>)
      : {};

  const knownKeys = new Set([
    'descriptor',
    'position',
    'size',
    'minimized',
    '_unknown',
  ]);
  const extraKeys = Object.keys(obj).filter((k) => !knownKeys.has(k));
  const newExtras: Record<string, unknown> =
    extraKeys.length > 0
      ? Object.fromEntries(extraKeys.map((k) => [k, obj[k]]))
      : {};

  // Merge: existing _unknown first, then new extras on top (extras win).
  const merged = { ...existingUnknown, ...newExtras };
  const _unknown: Record<string, unknown> | undefined =
    Object.keys(merged).length > 0 ? merged : undefined;

  return {
    descriptor: descriptor as WorkbenchBlockPlacementDescriptor,
    position: position as { x: number; y: number },
    size: size as { width: number; height: number },
    minimized,
    ...(_unknown !== undefined ? { _unknown } : {}),
  };
}
