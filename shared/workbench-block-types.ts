/**
 * Workbench Block contracts — slice 1 of epic #612.
 *
 * This module defines the shared TypeScript contracts every Workbench block
 * implements. No runtime, no registry, no React component bodies — only types
 * and the supporting machinery needed to type-check and test them.
 *
 * Extensibility seam (adding a new block kind):
 *   1. Add the new literal to `WorkbenchBlockKind`.
 *   2. Add a new variant to `WorkbenchBlockDescriptor` discriminated union with
 *      `kind: '<new-kind>'` and the appropriate `meta` shape.
 *   3. In slice 2 (registry), add a registry entry mapping the new kind to its
 *      renderer. The generic constraint on `WorkbenchBlockRenderer<K>` ensures
 *      the registration is type-safe at compile time.
 *
 * Ref conventions — descriptors reference *scoped resource refs*, never raw
 * global filesystem paths. Each ref shape follows the existing `shared/`
 * pattern: an opaque `kind` discriminant plus a stable `id`. For types that
 * already exist in `shared/work-context.ts` (SessionRef, ArtifactRef,
 * WorkContextRef) we reuse them directly. For types that don't yet exist
 * (ActorRef, FileRef) we define minimal opaque shapes here and note them.
 */

import type { JSX } from 'react';

import type { RelayCapabilityBit } from './security-policy.js';
import type {
  ArtifactRef,
  CapabilityGrantRef,
  NodeRef,
  SessionRef,
  WorkContext,
  WorkContextRef,
} from './work-context.js';
import type { WorkbenchBlockEnvironmentRef } from './workbench-block-environment.js';
import type { FileResourceRef } from './file-resource-ref.js';
import type { PromptFanoutFixtureKey } from './prompt-fanout-fixtures.js';
import type { PromptFanoutRun } from './prompt-fanout-run.js';

// ---------------------------------------------------------------------------
// Re-exported re-used types for convenience
// ---------------------------------------------------------------------------

export type {
  ArtifactRef,
  CapabilityGrantRef,
  FileResourceRef,
  NodeRef,
  SessionRef,
  WorkContext,
  WorkContextRef,
};

/**
 * Discriminate a `FileRef | FileResourceRef` union at runtime.
 *
 * A `FileResourceRef` always carries `capturedAt` and `intent` (both present
 * on every minted ref) and never carries the legacy `id` field that `FileRef`
 * uses as its opaque stable identifier.  Checking for the absence of `id`
 * guards against accidentally treating a legacy ref as a new ref.
 */
export function isFileResourceRef(
  ref: FileRef | FileResourceRef
): ref is FileResourceRef {
  return 'capturedAt' in ref && 'intent' in ref && !('id' in ref);
}

// ---------------------------------------------------------------------------
// Placeholder ref types (not yet defined elsewhere in shared/)
// ---------------------------------------------------------------------------

/**
 * ActorRef — opaque reference to a WorkContextActor.
 * TODO(slice-2+): promote to shared/work-context.ts once the actor
 * persistence layer is wired. For now, an id scoped to the owning WorkContext.
 */
export interface ActorRef {
  kind: 'actor';
  id: string;
  /** Optional human-readable label for debugging / UI display. */
  displayName?: string;
  /**
   * The live session backing this actor, if one exists.
   * AgentBlock uses sessionRef.sessionId (and sessionRef.globalSessionId when
   * available) to connect ChatView to the correct WebSocket endpoint.
   * Optional because not every actor has an attached live session at all times.
   */
  sessionRef?: SessionRef;
}

/**
 * FileRef — opaque reference to a file within a node's filesystem.
 * Raw filesystem paths must never escape the node boundary; a FileRef carries
 * a node-scoped id that the hub resolves via the `rpc:fs:*` capability.
 * TODO(slice-2+): promote to shared/file-rpc.ts once the FS-RPC surface
 * formalises the ref shape.
 */
export interface FileRef {
  kind: 'file';
  /** Node-scoped stable id, e.g. `"rpc:fs:<nodeId>:<encodedPath>"`. */
  id: string;
  /** Hint for display; NOT a resolvable path — the hub owns resolution. */
  displayName?: string;
}

// ---------------------------------------------------------------------------
// JsonValue — used in custom block meta props
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// WorkbenchBlockKind
// ---------------------------------------------------------------------------

/**
 * String-literal union of every supported Workbench block kind.
 *
 * To add a new kind:
 *   1. Add the literal here.
 *   2. Add the corresponding `WorkbenchBlockDescriptor` variant below.
 *   3. Add a registry entry in the slice-2 `WorkbenchBlockRegistry`.
 */
export type WorkbenchBlockKind =
  | 'terminal'
  | 'agent'
  | 'prompt-fanout'
  | 'work-context'
  | 'file'
  | 'artifact'
  | 'markdown'
  | 'custom';

// ---------------------------------------------------------------------------
// WorkbenchBlockDescriptor — discriminated union on `kind`
// ---------------------------------------------------------------------------

/**
 * Common fields present on every descriptor variant.
 * Descriptors are inert data — no methods, no class instances — so they
 * round-trip cleanly through JSON.stringify/parse.
 */
interface WorkbenchBlockDescriptorBase {
  /** Stable opaque identifier for this block instance. */
  id: string;
  /** User-visible title shown in the block's title bar. */
  title: string;
  /**
   * Capability bits the block requires before it may render.
   * Evaluated against `WorkbenchBlockContext.capabilityGrants` by the
   * renderer host (slice 2).  Examples: `'session:attach'`, `'rpc:fs:read'`.
   * Typed as `RelayCapabilityBit` (closed enum) to prevent invalid bit strings.
   */
  capabilityRequirements: ReadonlyArray<RelayCapabilityBit>;
  /**
   * Typed environment metadata captured at block create time (#631).
   *
   * Optional for backward compatibility — blocks persisted before #631 landed
   * have no `environment` field and the resume path treats them as legacy
   * (see `resolveBlockEnvironment` in `shared/workbench-block-environment.ts`).
   * Any new block created through the create dialog MUST set this field; the
   * picker is the only blessed source.
   *
   * Stores typed IDs (nodeId, repoIdentity, repoInstanceId, worktreeInstanceId,
   * cwd, cwdMode, capabilities). Never free-form path strings beyond `cwd`,
   * which is node-scoped and resolved by the hub at attach time.
   */
  environment?: WorkbenchBlockEnvironmentRef;
}

/** Renders a PTY-backed terminal session. */
export interface TerminalBlockDescriptor extends WorkbenchBlockDescriptorBase {
  kind: 'terminal';
  meta: {
    /**
     * Reference to the live session driving this terminal.
     * Reuses `SessionRef` from shared/work-context.ts (nodeId + sessionId +
     * tabKind + cwd, etc.).
     */
    sessionRef: SessionRef;
  };
}

/** Renders an agent session (Claude Code, Codex, OpenCode, Hermes, custom). */
export interface AgentBlockDescriptor extends WorkbenchBlockDescriptorBase {
  kind: 'agent';
  meta: {
    /**
     * Reference to the actor driving this agent session.
     * Uses the local `ActorRef` placeholder — see note above.
     */
    actorRef: ActorRef;
  };
}

/** Renders a mock PromptFanoutRun comparison across selected targets. */
export interface PromptFanoutBlockDescriptor
  extends WorkbenchBlockDescriptorBase {
  kind: 'prompt-fanout';
  meta: {
    /** Inline run payload for mock/API-backed shells. */
    run?: PromptFanoutRun;
    /** Fixture key used when no inline run is supplied. */
    fixture?: PromptFanoutFixtureKey;
    /** Force the renderer's loading state for testable shell coverage. */
    loading?: boolean;
    /** Explicitly marks this block as dry-run only; no terminal send path. */
    dryRunOnly?: boolean;
  };
}

/** Renders a WorkContext envelope (task / repo / session summary). */
export interface WorkContextBlockDescriptor extends WorkbenchBlockDescriptorBase {
  kind: 'work-context';
  meta: {
    /**
     * Opaque WorkContext reference string.
     * `WorkContextRef` in shared/work-context.ts is typed as `string`; the
     * hub resolves it to a full `WorkContext` via the work-context store.
     */
    workContextRef: WorkContextRef;
  };
}

/** Renders a file viewer or diff panel. */
export interface FileBlockDescriptor extends WorkbenchBlockDescriptorBase {
  kind: 'file';
  meta: {
    /**
     * Node-scoped file reference.
     *
     * Two shapes are valid:
     *   - `FileRef` (legacy) — opaque id-based placeholder shape.
     *   - `FileResourceRef` (slice 2+) — addressable handle with `nodeId`,
     *     `path`, `capturedAt`, and `intent`. The FileBlock renderer narrows
     *     using `isFileResourceRef` to decide whether to attempt an RPC fetch.
     *
     * Consumers should call `isFileResourceRef(ref)` before reading
     * `ref.nodeId` or `ref.path`.
     */
    fileRef: FileRef | FileResourceRef;
    /**
     * `'read'` = viewer; `'diff'` = inline diff against HEAD or base;
     * `'edit'` = editable textarea + diff confirmation + fs.write (slice 4).
     * Edit mode is gated server-side via `rpc:fs:write`; the renderer hides
     * the save affordance when the bit is not granted.
     */
    mode?: 'read' | 'edit' | 'diff';
  };
}

/** Renders a produced artifact (log, screenshot, report, diff, etc.). */
export interface ArtifactBlockDescriptor extends WorkbenchBlockDescriptorBase {
  kind: 'artifact';
  meta: {
    /**
     * Reuses `ArtifactRef` from shared/work-context.ts (id, kind, title,
     * uri, mediaType, privacy metadata, etc.).
     */
    artifactRef: ArtifactRef;
  };
}

/** Renders a markdown document inline. */
export interface MarkdownBlockDescriptor extends WorkbenchBlockDescriptorBase {
  kind: 'markdown';
  meta: {
    /** Full markdown content string rendered directly — no external fetch. */
    content: string;
  };
}

/**
 * Extensibility escape-hatch for blocks not covered by built-in kinds.
 * A custom block delegates rendering to an externally registered renderer
 * looked up by `rendererId`.
 */
export interface CustomBlockDescriptor extends WorkbenchBlockDescriptorBase {
  kind: 'custom';
  meta: {
    /** Stable renderer identifier used to look up the renderer in the registry. */
    rendererId: string;
    /** Opaque data refs passed to the renderer (resolved by the hub). */
    dataRefs?: ReadonlyArray<string>;
    /** Arbitrary JSON props forwarded verbatim to the renderer component. */
    props?: Record<string, JsonValue>;
  };
}

/**
 * Discriminated union of all block descriptor variants.
 * Narrow on `kind` to get the correct `meta` shape:
 *
 * ```ts
 * if (descriptor.kind === 'terminal') {
 *   // descriptor.meta.sessionRef is SessionRef
 * }
 * ```
 */
export type WorkbenchBlockDescriptor =
  | TerminalBlockDescriptor
  | AgentBlockDescriptor
  | PromptFanoutBlockDescriptor
  | WorkContextBlockDescriptor
  | FileBlockDescriptor
  | ArtifactBlockDescriptor
  | MarkdownBlockDescriptor
  | CustomBlockDescriptor;

// ---------------------------------------------------------------------------
// WorkbenchBlockContext — runtime context handed to renderers
// ---------------------------------------------------------------------------

/**
 * Audit/event emit hook signature.
 * The implementation lives in the renderer host (slice 2); blocks call this
 * to emit structured audit events without taking a direct dependency on the
 * audit log machinery.
 *
 * NOT implemented in this slice — type definition only.
 */
export type WorkbenchBlockAuditEmitter = (event: {
  type: string;
  payload?: Record<string, JsonValue>;
}) => void;

/**
 * Runtime context provided by the Workbench host to every block renderer.
 *
 * Field optionality:
 *   - Optional (`?`): resource refs that depend on which context shape is
 *     active — `workContext`, `session`, `node`, `artifact`. A block may
 *     render before these are hydrated (e.g. the node is offline, or the
 *     WorkContext hasn't loaded yet).
 *   - Always present (required): host-provided service helpers —
 *     `capabilityGrants` (non-null, at least an empty array),
 *     `requestCapability`, `close`, and `emitAuditEvent`. The host always
 *     supplies these regardless of hydration state.
 */
export interface WorkbenchBlockContext {
  /** The active WorkContext envelope for this block, if one is bound. */
  workContext?: WorkContext;
  /**
   * The session reference for the block's primary session, if applicable.
   * Reuses `SessionRef` from shared/work-context.ts.
   */
  session?: SessionRef;
  /**
   * The node this block is executing on, if known.
   * Reuses `NodeRef` from shared/work-context.ts.
   */
  node?: NodeRef;
  /**
   * Whether File RPC is available on the node this block runs on.
   * `undefined` means the host has not supplied manifest data (pre-#651 node
   * or an unhydrated context). Consumers should treat `undefined` as unknown,
   * NOT as unavailable — only explicit `false` means degraded.
   *
   * Used by BlockHost to render a distinct "node-degraded" card for file/artifact
   * blocks when the helper can't satisfy file-rpc requests (#654).
   */
  nodeFileRpcAvailable?: boolean;
  /**
   * The primary artifact produced or consumed by this block, if any.
   * Reuses `ArtifactRef` from shared/work-context.ts.
   */
  artifact?: ArtifactRef;
  /**
   * Scoped capability grants authorising this block's operations.
   * Always present (may be empty). Evaluated by the renderer host before
   * mounting the component.
   * Reuses `CapabilityGrantRef` from shared/work-context.ts.
   */
  capabilityGrants: ReadonlyArray<CapabilityGrantRef>;

  // ---- Typed helpers (definitions only — no implementations in slice 1) ----

  /**
   * Request a capability at runtime.  Returns `true` if the grant is
   * allowed (either silently or after user confirmation), `false` if denied.
   * Accepts only known `RelayCapabilityBit` values (closed enum) to prevent
   * requesting non-existent capabilities.
   *
   * NOT implemented in this slice — type definition only.
   */
  requestCapability: (name: RelayCapabilityBit) => Promise<boolean>;

  /**
   * Signal to the Workbench host that this block should be closed and
   * removed from the layout.
   *
   * NOT implemented in this slice — type definition only.
   */
  close: () => void;

  /**
   * Emit a structured audit event from inside a block.
   * The host attaches the block id, timestamp, and chain hash before
   * forwarding to the audit log.
   *
   * NOT implemented in this slice — type definition only.
   */
  emitAuditEvent: WorkbenchBlockAuditEmitter;
}

// ---------------------------------------------------------------------------
// WorkbenchBlockRenderer<K> — React component contract
// ---------------------------------------------------------------------------

/**
 * Props for a Workbench block renderer component.
 * The generic `K` constraint narrows `descriptor` to the variant matching the
 * registered kind, enabling type-safe registration in slice 2.
 *
 * Renderers signal close via `context.close()` — there is no separate `onClose`
 * prop. Consolidating onto `context.close` keeps the close signal in the
 * environmental service alongside the other host-provided helpers, avoiding
 * a redundant prop with identical semantics.
 */
export interface WorkbenchBlockRendererProps<K extends WorkbenchBlockKind> {
  descriptor: Extract<WorkbenchBlockDescriptor, { kind: K }>;
  context: WorkbenchBlockContext;
}

/**
 * React component type for a Workbench block renderer.
 *
 * Usage:
 * ```ts
 * const TerminalBlock: WorkbenchBlockRenderer<'terminal'> = ({ descriptor, context }) => {
 *   // descriptor.meta.sessionRef is SessionRef
 *   // Call context.close() to signal the host to remove this block.
 *   return <XtermRenderer session={descriptor.meta.sessionRef} />;
 * };
 * ```
 *
 * The generic constraint ensures a renderer registered for `'terminal'`
 * cannot accidentally receive a `'file'` descriptor.
 */
export type WorkbenchBlockRenderer<K extends WorkbenchBlockKind> = (
  props: WorkbenchBlockRendererProps<K>
) => JSX.Element | null;
