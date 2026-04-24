import React, { useCallback, useEffect, useRef, useState } from 'react';
import './SplitPaneLayout.css';

const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 600;
const MIN_TERMINAL_WIDTH = 300;
const MIN_FILE_VIEWER_WIDTH = 300;
const RIGHT_SIDEBAR_HANDLE = 'right-sidebar';
const FILE_VIEWER_HANDLE = 'file-viewer';

type DragHandle = typeof RIGHT_SIDEBAR_HANDLE | typeof FILE_VIEWER_HANDLE;

export interface SplitPaneLayoutProps {
  terminal: React.ReactNode;
  fileViewer?: React.ReactNode;
  rightSidebar?: React.ReactNode;
  /** Whether the file viewer pane is open (has content) */
  fileViewerOpen?: boolean;
  /** Whether the right sidebar is collapsed */
  rightSidebarCollapsed?: boolean;
  /** Current right sidebar width in px */
  rightSidebarWidth?: number;
  /** Current file viewer ratio (0-1) */
  fileViewerRatio?: number;
  onRightSidebarWidthChange?: (width: number) => void;
  onRightSidebarResizeEnd?: (width: number) => void;
  onFileViewerRatioChange?: (ratio: number) => void;
  onToggleRightSidebar?: () => void;
  rightSidebarResizable?: boolean;
  rightSidebarMinWidth?: number;
  rightSidebarMaxWidth?: number;
}

export function SplitPaneLayout({
  terminal,
  fileViewer,
  rightSidebar,
  fileViewerOpen = false,
  rightSidebarCollapsed = false,
  rightSidebarWidth: externalRightSidebarWidth,
  fileViewerRatio: externalFileViewerRatio,
  onRightSidebarWidthChange,
  onRightSidebarResizeEnd,
  onFileViewerRatioChange,
  onToggleRightSidebar,
  rightSidebarResizable = true,
  rightSidebarMinWidth = MIN_RIGHT_SIDEBAR_WIDTH,
  rightSidebarMaxWidth = MAX_RIGHT_SIDEBAR_WIDTH,
}: SplitPaneLayoutProps) {
  const [internalRightSidebarWidth, setInternalRightSidebarWidth] =
    useState(320);
  const [internalFileViewerRatio, setInternalFileViewerRatio] = useState(0.4);
  const [dragging, setDragging] = useState<DragHandle | null>(null);

  const rightSidebarWidthValue =
    externalRightSidebarWidth ?? internalRightSidebarWidth;
  const fileViewerRatioValue =
    externalFileViewerRatio ?? internalFileViewerRatio;

  const containerRef = useRef<HTMLDivElement>(null);

  const rightSidebarEffectiveWidth = rightSidebarCollapsed
    ? 0
    : rightSidebarWidthValue;

  // Use refs for values needed in document-level listeners
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const rightSidebarEffectiveWidthRef = useRef(rightSidebarEffectiveWidth);
  rightSidebarEffectiveWidthRef.current = rightSidebarEffectiveWidth;
  const rightSidebarWidthValueRef = useRef(rightSidebarWidthValue);
  rightSidebarWidthValueRef.current = rightSidebarWidthValue;

  const handlePointerDown = useCallback(
    (handle: DragHandle, e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (handle === RIGHT_SIDEBAR_HANDLE && rightSidebarCollapsed) {
        onToggleRightSidebar?.();
      }
      setDragging(handle);
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
      const currentDragging = draggingRef.current;

      if (currentDragging === RIGHT_SIDEBAR_HANDLE) {
        if (!rightSidebarResizable) return;
        const newRightWidth = rect.right - e.clientX;
        const clamped = Math.max(
          rightSidebarMinWidth,
          Math.min(rightSidebarMaxWidth, newRightWidth)
        );
        setInternalRightSidebarWidth(clamped);
        rightSidebarWidthValueRef.current = clamped;
        onRightSidebarWidthChange?.(clamped);
      } else if (currentDragging === FILE_VIEWER_HANDLE) {
        const rsw = rightSidebarEffectiveWidthRef.current;
        const available = rect.width - rsw;
        const fileViewerWidth = rect.right - rsw - e.clientX;
        const terminalWidth = e.clientX - rect.left;
        if (
          terminalWidth < MIN_TERMINAL_WIDTH ||
          fileViewerWidth < MIN_FILE_VIEWER_WIDTH
        )
          return;
        const ratio = fileViewerWidth / available;
        setInternalFileViewerRatio(ratio);
        onFileViewerRatioChange?.(ratio);
      }
    }

    function onUp() {
      if (draggingRef.current === RIGHT_SIDEBAR_HANDLE) {
        onRightSidebarResizeEnd?.(rightSidebarWidthValueRef.current);
      }
      setDragging(null);
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
    onFileViewerRatioChange,
    rightSidebarMaxWidth,
    rightSidebarMinWidth,
    rightSidebarResizable,
  ]);

  return (
    <div className="split-pane-layout" ref={containerRef}>
      <div
        className="pane-terminal"
        style={{
          flex: fileViewerOpen ? String(1 - fileViewerRatioValue) : '1',
        }}
      >
        {terminal}
      </div>

      {fileViewerOpen ? (
        <>
          <div
            className={[
              'resize-handle',
              dragging === FILE_VIEWER_HANDLE && 'active',
            ]
              .filter(Boolean)
              .join(' ')}
            role="separator"
            aria-label="resize terminal and file viewer"
            onPointerDown={(e) => handlePointerDown(FILE_VIEWER_HANDLE, e)}
          />
          <div
            className="pane-file-viewer"
            style={{ flex: String(fileViewerRatioValue) }}
          >
            {fileViewer}
          </div>
        </>
      ) : null}

      {rightSidebar ? (
        <>
          <div
            className={[
              'resize-handle',
              'resize-handle-right',
              dragging === RIGHT_SIDEBAR_HANDLE && 'active',
              rightSidebarCollapsed && 'collapsed',
              !rightSidebarResizable && 'disabled',
            ]
              .filter(Boolean)
              .join(' ')}
            role="separator"
            aria-label="resize right sidebar"
            onPointerDown={(e) => {
              if (rightSidebarResizable)
                handlePointerDown(RIGHT_SIDEBAR_HANDLE, e);
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
              aria-label="Close file sidebar"
              onClick={onToggleRightSidebar}
              type="button"
            >
              ✕
            </button>
            {rightSidebar}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default SplitPaneLayout;
