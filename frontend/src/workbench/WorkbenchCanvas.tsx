/**
 * WorkbenchCanvas — slice 3 of epic #612.
 *
 * Renders all Workbench blocks in a freeform pixel-positioned canvas.
 * Each block can be:
 *   - dragged via its title bar (uses @dnd-kit/core — already a project dep)
 *   - resized via a bottom-right resize handle (mouse drag)
 *   - minimized/restored via the title bar button
 *
 * Layout state is fetched via TanStack Query and persisted via a debounced
 * PUT mutation on every change. No refetchInterval — mutations drive cache
 * invalidation per the project's anti-polling convention.
 *
 * This component does NOT wire into App.tsx or the sidebar — it is
 * self-contained for now (slice 3 boundary, per #621 scope).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragCancelEvent,
} from '@dnd-kit/core';
import { useDraggable } from '@dnd-kit/core';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  WorkbenchLayout,
  WorkbenchBlockPlacement,
} from '../../../shared/workbench-layout-types.js';
import { WORKBENCH_LAYOUT_SCHEMA_VERSION } from '../../../shared/workbench-layout-types.js';
import type { WorkbenchBlockContext } from '../../../shared/workbench-block-types.js';
import { fetchWorkbenchLayout, putWorkbenchLayout } from '../lib/api.js';
import { BlockHost } from './BlockHost.js';
import './workbench-canvas.css';

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export const workbenchLayoutQueryKey = (workspaceId: string) =>
  ['workbench-layout', workspaceId] as const;

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number
): (...args: T) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  return useCallback(
    (...args: T) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        fnRef.current(...args);
      }, delay);
    },
    [delay]
  );
}

// ---------------------------------------------------------------------------
// Minimal WorkbenchBlockContext factory
// ---------------------------------------------------------------------------

const NOOP_EMIT: WorkbenchBlockContext['emitAuditEvent'] = () => undefined;
const NOOP_REQUEST_CAP: WorkbenchBlockContext['requestCapability'] = () =>
  Promise.resolve(false);

function makeBlockContext(onClose: () => void): WorkbenchBlockContext {
  return {
    capabilityGrants: [],
    requestCapability: NOOP_REQUEST_CAP,
    close: onClose,
    emitAuditEvent: NOOP_EMIT,
  };
}

// ---------------------------------------------------------------------------
// Resize hook — bottom-right corner drag
// ---------------------------------------------------------------------------

interface ResizeState {
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

function useBlockResize(
  blockId: string,
  currentSize: { width: number; height: number },
  onResize: (blockId: string, size: { width: number; height: number }) => void
) {
  const resizeRef = useRef<ResizeState | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startWidth: currentSize.width,
        startHeight: currentSize.height,
      };

      function onMouseMove(ev: MouseEvent) {
        if (!resizeRef.current) return;
        const dx = ev.clientX - resizeRef.current.startX;
        const dy = ev.clientY - resizeRef.current.startY;
        onResize(blockId, {
          width: Math.max(200, resizeRef.current.startWidth + dx),
          height: Math.max(80, resizeRef.current.startHeight + dy),
        });
      }

      function onMouseUp() {
        resizeRef.current = null;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      }

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [blockId, currentSize.width, currentSize.height, onResize]
  );

  return { onMouseDown };
}

// ---------------------------------------------------------------------------
// CanvasBlock — one block on the canvas
// ---------------------------------------------------------------------------

interface CanvasBlockProps {
  placement: WorkbenchBlockPlacement;
  onMinimizeToggle: (blockId: string) => void;
  onResize: (blockId: string, size: { width: number; height: number }) => void;
  onClose: (blockId: string) => void;
}

function CanvasBlock({
  placement,
  onMinimizeToggle,
  onResize,
  onClose,
}: CanvasBlockProps): React.ReactElement {
  const { descriptor, position, size, minimized } = placement;
  const blockId = descriptor.id;

  // dnd-kit draggable — title bar is the handle
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: blockId,
  });

  const { onMouseDown: onResizeMouseDown } = useBlockResize(
    blockId,
    size,
    onResize
  );

  const context = React.useMemo(
    () => makeBlockContext(() => onClose(blockId)),
    [blockId, onClose]
  );

  return (
    <div
      ref={setNodeRef}
      className={[
        'canvas-block',
        minimized ? 'canvas-block--minimized' : '',
        isDragging ? 'canvas-block--dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: position.x,
        top: position.y,
        width: minimized ? size.width : size.width,
        height: minimized ? 'auto' : size.height,
      }}
    >
      {/* Title bar — drag handle */}
      <div className="canvas-block__titlebar" {...listeners} {...attributes}>
        <span className="canvas-block__kind">{descriptor.kind}</span>
        <span className="canvas-block__title">{descriptor.title}</span>
        <button
          type="button"
          className="canvas-block__minimize-btn"
          onClick={(e) => {
            e.stopPropagation();
            onMinimizeToggle(blockId);
          }}
          aria-label={minimized ? 'restore' : 'minimize'}
        >
          {minimized ? '+' : '−'}
        </button>
      </div>

      {/* Block content */}
      {!minimized && (
        <div className="canvas-block__body">
          <BlockHost descriptor={descriptor} context={context} />
        </div>
      )}

      {/* Resize handle */}
      {!minimized && (
        <div
          className="canvas-block__resize-handle"
          onMouseDown={onResizeMouseDown}
          aria-label="resize block"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkbenchCanvas
// ---------------------------------------------------------------------------

export interface WorkbenchCanvasProps {
  workspaceId: string;
}

/**
 * WorkbenchCanvas renders all blocks for a workspace in a freeform
 * pixel-positioned canvas. Layout is loaded via TanStack Query and
 * persisted via a debounced PUT mutation.
 *
 * Grid vs freeform decision: freeform pixel coordinates.
 * The Workbench is a floating-block surface analogous to a virtual desktop,
 * not a split-pane editor. The existing react-resizable-panels split model
 * is scoped to the SessionPane workspace; Workbench blocks are independently
 * draggable overlays.
 *
 * Reused primitives:
 *   - @dnd-kit/core (PointerSensor, useDraggable, DndContext) — same lib
 *     used by WorkspaceLayout for tab drag.
 *   - Mouse-event resize — lightweight custom hook; react-resizable-panels
 *     is percentage-split oriented and not suitable for freeform block resize.
 */
export function WorkbenchCanvas({
  workspaceId,
}: WorkbenchCanvasProps): React.ReactElement {
  const queryClient = useQueryClient();
  const queryKey = workbenchLayoutQueryKey(workspaceId);

  // Fetch persisted layout
  const { data: serverLayout, isLoading } = useQuery<WorkbenchLayout | null>({
    queryKey,
    queryFn: () => fetchWorkbenchLayout(workspaceId),
    // No refetchInterval — mutation-driven invalidation only
    staleTime: Infinity,
  });

  // Local layout state — optimistically updated on user interaction
  const [layout, setLayout] = useState<WorkbenchLayout | null>(null);

  // Sync server layout into local state on initial load
  useEffect(() => {
    if (serverLayout !== undefined) {
      setLayout(serverLayout);
    }
  }, [serverLayout]);

  // Persist mutation
  const { mutate: persistLayout } = useMutation({
    mutationFn: (next: WorkbenchLayout) =>
      putWorkbenchLayout(workspaceId, next),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey, saved);
    },
  });

  // Debounce the persist call (300ms) to avoid hammering the server
  // during continuous drag/resize
  const debouncedPersist = useDebouncedCallback(
    (next: WorkbenchLayout) => persistLayout(next),
    300
  );

  // Apply a layout mutation locally + schedule persist
  const applyUpdate = useCallback(
    (updater: (prev: WorkbenchLayout) => WorkbenchLayout) => {
      setLayout((prev) => {
        if (!prev) return prev;
        const next = updater(prev);
        debouncedPersist(next);
        return next;
      });
    },
    [debouncedPersist]
  );

  // ---------------------------------------------------------------------------
  // DnD — drag block positions
  // ---------------------------------------------------------------------------

  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Track the position at drag-start so we can compute delta on drag-end.
  // @dnd-kit reports the total delta from the initial pointer-down position.
  const dragStartPositionRef = useRef<{ x: number; y: number } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const handleDragStart = useCallback(
    (evt: DragStartEvent) => {
      const id = String(evt.active.id);
      setDraggingId(id);
      const block = layout?.blocks.find((b) => b.descriptor.id === id);
      if (block) {
        dragStartPositionRef.current = { ...block.position };
      }
    },
    [layout]
  );

  const handleDragCancel = useCallback((_evt: DragCancelEvent) => {
    setDraggingId(null);
    dragStartPositionRef.current = null;
  }, []);

  const handleDragEnd = useCallback(
    (evt: DragEndEvent) => {
      setDraggingId(null);
      if (!dragStartPositionRef.current) return;
      const delta = evt.delta;
      const startPos = dragStartPositionRef.current;
      dragStartPositionRef.current = null;
      const id = String(evt.active.id);

      applyUpdate((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.descriptor.id === id
            ? {
                ...b,
                position: {
                  x: Math.max(0, startPos.x + delta.x),
                  y: Math.max(0, startPos.y + delta.y),
                },
              }
            : b
        ),
      }));
    },
    [applyUpdate]
  );

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------

  const handleResize = useCallback(
    (blockId: string, size: { width: number; height: number }) => {
      applyUpdate((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.descriptor.id === blockId ? { ...b, size } : b
        ),
      }));
    },
    [applyUpdate]
  );

  // ---------------------------------------------------------------------------
  // Minimize toggle
  // ---------------------------------------------------------------------------

  const handleMinimizeToggle = useCallback(
    (blockId: string) => {
      applyUpdate((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.descriptor.id === blockId ? { ...b, minimized: !b.minimized } : b
        ),
      }));
    },
    [applyUpdate]
  );

  // ---------------------------------------------------------------------------
  // Close (remove from layout)
  // ---------------------------------------------------------------------------

  const handleClose = useCallback(
    (blockId: string) => {
      applyUpdate((prev) => ({
        ...prev,
        blocks: prev.blocks.filter((b) => b.descriptor.id !== blockId),
      }));
    },
    [applyUpdate]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="workbench-canvas">
        <div className="workbench-canvas__loading">loading workbench…</div>
      </div>
    );
  }

  if (!layout || layout.blocks.length === 0) {
    return (
      <div className="workbench-canvas">
        <div className="workbench-canvas__empty">
          no blocks in this workspace
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className={[
          'workbench-canvas',
          draggingId ? 'workbench-canvas--dragging' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {layout.blocks.map((placement) => (
          <CanvasBlock
            key={placement.descriptor.id}
            placement={placement}
            onMinimizeToggle={handleMinimizeToggle}
            onResize={handleResize}
            onClose={handleClose}
          />
        ))}
      </div>
    </DndContext>
  );
}

// ---------------------------------------------------------------------------
// Factory helper — create an empty layout for a workspace
// ---------------------------------------------------------------------------

export function createEmptyWorkbenchLayout(
  workspaceId: string,
  displayName?: string
): WorkbenchLayout {
  const scope =
    displayName !== undefined
      ? { id: workspaceId, displayName }
      : { id: workspaceId };
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    workspaceScope: scope,
    blocks: [],
  };
}

export default WorkbenchCanvas;
