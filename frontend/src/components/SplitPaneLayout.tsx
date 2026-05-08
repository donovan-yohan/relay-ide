import React, { useCallback, useEffect, useRef, useState } from 'react';
import './SplitPaneLayout.css';

const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 600;

export interface SplitPaneLayoutProps {
  terminal: React.ReactNode;
  rightSidebar?: React.ReactNode;
  /** Whether the right sidebar is collapsed */
  rightSidebarCollapsed?: boolean;
  /** Current right sidebar width in px */
  rightSidebarWidth?: number;
  onRightSidebarWidthChange?: (width: number) => void;
  onRightSidebarResizeEnd?: (width: number) => void;
  onToggleRightSidebar?: () => void;
  rightSidebarResizable?: boolean;
  rightSidebarMinWidth?: number;
  rightSidebarMaxWidth?: number;
}

export function SplitPaneLayout({
  terminal,
  rightSidebar,
  rightSidebarCollapsed = false,
  rightSidebarWidth: externalRightSidebarWidth,
  onRightSidebarWidthChange,
  onRightSidebarResizeEnd,
  onToggleRightSidebar,
  rightSidebarResizable = true,
  rightSidebarMinWidth = MIN_RIGHT_SIDEBAR_WIDTH,
  rightSidebarMaxWidth = MAX_RIGHT_SIDEBAR_WIDTH,
}: SplitPaneLayoutProps) {
  const [internalRightSidebarWidth, setInternalRightSidebarWidth] =
    useState(320);
  const [dragging, setDragging] = useState(false);

  const rightSidebarWidthValue =
    externalRightSidebarWidth ?? internalRightSidebarWidth;

  const containerRef = useRef<HTMLDivElement>(null);

  // Use refs for values needed in document-level listeners
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const rightSidebarWidthValueRef = useRef(rightSidebarWidthValue);
  rightSidebarWidthValueRef.current = rightSidebarWidthValue;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (rightSidebarCollapsed) {
        onToggleRightSidebar?.();
      }
      setDragging(true);
    },
    [rightSidebarCollapsed, onToggleRightSidebar]
  );

  // Document-level listeners for drag — avoids pointer capture + React delegation issues
  useEffect(() => {
    if (!dragging) return;

    function onMove(e: PointerEvent) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (!draggingRef.current || !rightSidebarResizable) return;
      const newRightWidth = rect.right - e.clientX;
      const clamped = Math.max(
        rightSidebarMinWidth,
        Math.min(rightSidebarMaxWidth, newRightWidth)
      );
      setInternalRightSidebarWidth(clamped);
      rightSidebarWidthValueRef.current = clamped;
      onRightSidebarWidthChange?.(clamped);
    }

    function onUp() {
      if (draggingRef.current) {
        onRightSidebarResizeEnd?.(rightSidebarWidthValueRef.current);
      }
      setDragging(false);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [
    dragging,
    onRightSidebarWidthChange,
    onRightSidebarResizeEnd,
    rightSidebarMaxWidth,
    rightSidebarMinWidth,
    rightSidebarResizable,
  ]);

  return (
    <div className="split-pane-layout" ref={containerRef}>
      <div className="pane-terminal">
        {terminal}
      </div>

      {rightSidebar ? (
        <>
          <div
            className={[
              'resize-handle',
              'resize-handle-right',
              dragging && 'active',
              rightSidebarCollapsed && 'collapsed',
              !rightSidebarResizable && 'disabled',
            ]
              .filter(Boolean)
              .join(' ')}
            role="separator"
            aria-label="resize right sidebar"
            onPointerDown={(e) => {
              if (rightSidebarResizable)
                handlePointerDown(e);
            }}
          />
          <div
            className={[
              'pane-right-sidebar',
              rightSidebarCollapsed && 'collapsed',
              !rightSidebarCollapsed && 'mobile-open',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              width: rightSidebarCollapsed ? 0 : rightSidebarWidthValue,
            }}
          >
            <button
              className="mobile-sidebar-close-btn"
              aria-label="close file sidebar"
              onClick={onToggleRightSidebar}
              type="button"
            >
              x
            </button>
            {rightSidebar}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default SplitPaneLayout;
