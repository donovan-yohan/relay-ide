import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragCancelEvent,
} from '@dnd-kit/core';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  type SplitDirection,
  type SplitPlacement,
  type WorkspaceLayoutNode,
  type WorkspaceTabId,
} from '../lib/workspace-layout.js';
import { useWorkspaceLayoutStore } from '../lib/stores/workspace-layout-store.js';
import type { SummaryContext } from '../lib/workspace-summary.js';
import { WorkspacePane } from './WorkspacePane.js';
import './WorkspaceLayout.css';

function useRafThrottle<Args extends unknown[]>(
  fn: (...args: Args) => void
): (...args: Args) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const rafId = useRef<number | null>(null);
  const lastArgs = useRef<Args | null>(null);

  useEffect(
    () => () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      rafId.current = null;
    },
    []
  );

  return useCallback((...args: Args) => {
    lastArgs.current = args;
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      const args2 = lastArgs.current;
      lastArgs.current = null;
      if (args2) fnRef.current(...args2);
    });
  }, []);
}

interface DragData {
  type: 'tab';
  tabId: WorkspaceTabId;
  sourcePaneId: string;
}

interface TabbarDropData {
  type: 'tabbar';
  paneId: string;
}

interface EdgeDropData {
  type: 'edge';
  paneId: string;
  direction: SplitDirection;
  placement: SplitPlacement;
}

type DropData = TabbarDropData | EdgeDropData;

function nodeKey(node: WorkspaceLayoutNode): string {
  if (node.type === 'pane') return `pane:${node.id}`;
  return `split:${node.id}`;
}

interface RenderNodeProps {
  node: WorkspaceLayoutNode;
  activePaneId: string | null;
  isDragActive: boolean;
  summaryContext: SummaryContext;
  splitSizes: Record<string, number[]>;
  onAddTabRequest?: (paneId: string) => void;
  onSplitLayout: (splitId: string, sizes: number[]) => void;
}

function RenderNode({
  node,
  activePaneId,
  isDragActive,
  summaryContext,
  splitSizes,
  onAddTabRequest,
  onSplitLayout,
}: RenderNodeProps): React.ReactElement {
  if (node.type === 'pane') {
    return (
      <WorkspacePane
        pane={node}
        isActive={activePaneId === node.id}
        isDragActive={isDragActive}
        summaryContext={summaryContext}
        {...(onAddTabRequest ? { onAddTabRequest } : {})}
      />
    );
  }
  const fallbackSize = 100 / node.children.length;
  const persistedSizes = splitSizes[node.id];
  return (
    <PanelGroup
      direction={node.direction}
      onLayout={(sizes) => onSplitLayout(node.id, sizes)}
      autoSaveId={undefined}
    >
      {node.children.map((child, i) => {
        const size = persistedSizes?.[i] ?? fallbackSize;
        return (
          <React.Fragment key={nodeKey(child)}>
            {i > 0 && (
              <PanelResizeHandle
                className={`ws-resize-handle ws-resize-handle--${node.direction}`}
              />
            )}
            <Panel defaultSize={size} minSize={10}>
              <RenderNode
                node={child}
                activePaneId={activePaneId}
                isDragActive={isDragActive}
                summaryContext={summaryContext}
                splitSizes={splitSizes}
                {...(onAddTabRequest ? { onAddTabRequest } : {})}
                onSplitLayout={onSplitLayout}
              />
            </Panel>
          </React.Fragment>
        );
      })}
    </PanelGroup>
  );
}

export interface WorkspaceLayoutProps {
  summaryContext: SummaryContext;
  onAddTabRequest?: (paneId: string) => void;
}

export function WorkspaceLayout({
  summaryContext,
  onAddTabRequest,
}: WorkspaceLayoutProps): React.ReactElement {
  const layout = useWorkspaceLayoutStore((s) => s.layout);
  const activePaneId = useWorkspaceLayoutStore((s) => s.activePaneId);
  const splitSizes = useWorkspaceLayoutStore((s) => s.splitSizes);
  const moveTab = useWorkspaceLayoutStore((s) => s.moveTab);
  const splitWithTab = useWorkspaceLayoutStore((s) => s.splitWithTab);
  const setSplitSizes = useWorkspaceLayoutStore((s) => s.setSplitSizes);

  const [isDragActive, setDragActive] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<WorkspaceTabId | null>(
    null
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor)
  );

  const handleDragStart = useCallback((evt: DragStartEvent) => {
    setDragActive(true);
    setDraggingTabId(String(evt.active.id));
  }, []);

  const handleDragCancel = useCallback((_evt: DragCancelEvent) => {
    setDragActive(false);
    setDraggingTabId(null);
  }, []);

  const handleDragEnd = useCallback(
    (evt: DragEndEvent) => {
      setDragActive(false);
      setDraggingTabId(null);
      const active = evt.active;
      const over = evt.over;
      if (!over || !active) return;
      const dragData = active.data.current as DragData | undefined;
      const dropData = over.data.current as DropData | undefined;
      if (!dragData || dragData.type !== 'tab' || !dropData) return;

      if (dropData.type === 'tabbar') {
        if (dropData.paneId === dragData.sourcePaneId) return;
        moveTab(dragData.tabId, dropData.paneId);
        return;
      }
      if (dropData.type === 'edge') {
        splitWithTab(
          dropData.paneId,
          dragData.tabId,
          dropData.direction,
          dropData.placement
        );
      }
    },
    [moveTab, splitWithTab]
  );

  const onSplitLayout = useRafThrottle(
    useCallback(
      (splitId: string, sizes: number[]) => {
        setSplitSizes(splitId, sizes);
      },
      [setSplitSizes]
    )
  );

  const dragContext = useMemo(
    () => ({ isDragActive, draggingTabId }),
    [isDragActive, draggingTabId]
  );

  return (
    <div
      className={[
        'ws-layout',
        dragContext.isDragActive ? 'ws-layout--dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <RenderNode
          node={layout}
          activePaneId={activePaneId}
          isDragActive={isDragActive}
          summaryContext={summaryContext}
          splitSizes={splitSizes}
          {...(onAddTabRequest ? { onAddTabRequest } : {})}
          onSplitLayout={onSplitLayout}
        />
      </DndContext>
    </div>
  );
}

export default WorkspaceLayout;
