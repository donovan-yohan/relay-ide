import React, { useCallback, useRef, useState } from 'react';
import './SplitPaneLayout.css';

const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 600;
const MIN_TERMINAL_WIDTH = 300;
const MIN_FILE_VIEWER_WIDTH = 300;

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
  onFileViewerRatioChange?: (ratio: number) => void;
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
  onFileViewerRatioChange,
}: SplitPaneLayoutProps) {
  const [internalRightSidebarWidth, setInternalRightSidebarWidth] = useState(320);
  const [internalFileViewerRatio, setInternalFileViewerRatio] = useState(0.4);
  const [dragging, setDragging] = useState<'right-sidebar' | 'file-viewer' | null>(null);

  const rightSidebarWidthValue = externalRightSidebarWidth ?? internalRightSidebarWidth;
  const fileViewerRatioValue = externalFileViewerRatio ?? internalFileViewerRatio;

  const containerRef = useRef<HTMLDivElement>(null);

  const rightSidebarEffectiveWidth = rightSidebarCollapsed ? 0 : rightSidebarWidthValue;

  const handlePointerDown = useCallback(
    (handle: 'right-sidebar' | 'file-viewer', e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(handle);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (dragging === 'right-sidebar') {
        const rightEdge = rect.right;
        const newRightWidth = rightEdge - e.clientX;
        const clamped = Math.max(MIN_RIGHT_SIDEBAR_WIDTH, Math.min(MAX_RIGHT_SIDEBAR_WIDTH, newRightWidth));
        setInternalRightSidebarWidth(clamped);
        onRightSidebarWidthChange?.(clamped);
      } else if (dragging === 'file-viewer') {
        const available = rect.width - rightSidebarEffectiveWidth;
        const fileViewerWidth = rect.right - rightSidebarEffectiveWidth - e.clientX;
        const terminalWidth = e.clientX - rect.left;
        if (terminalWidth < MIN_TERMINAL_WIDTH || fileViewerWidth < MIN_FILE_VIEWER_WIDTH) return;
        const ratio = fileViewerWidth / available;
        setInternalFileViewerRatio(ratio);
        onFileViewerRatioChange?.(ratio);
      }
    },
    [dragging, rightSidebarEffectiveWidth, onRightSidebarWidthChange, onFileViewerRatioChange]
  );

  const handlePointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  return (
    <div
      className="split-pane-layout"
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div
        className="pane-terminal"
        style={{ flex: fileViewerOpen ? String(1 - fileViewerRatioValue) : '1' }}
      >
        {terminal}
      </div>

      {fileViewerOpen ? (
        <>
          <div
            className={['resize-handle', dragging === 'file-viewer' && 'active'].filter(Boolean).join(' ')}
            role="separator"
            aria-label="resize terminal and file viewer"
            onPointerDown={(e) => handlePointerDown('file-viewer', e)}
          />
          <div
            className="pane-file-viewer"
            style={{ flex: String(fileViewerRatioValue) }}
          >
            {fileViewer}
          </div>
        </>
      ) : null}

      {!rightSidebarCollapsed ? (
        <>
          <div
            className={['resize-handle', dragging === 'right-sidebar' && 'active'].filter(Boolean).join(' ')}
            role="separator"
            aria-label="resize right sidebar"
            onPointerDown={(e) => handlePointerDown('right-sidebar', e)}
          />
          <div
            className="pane-right-sidebar"
            style={{ width: rightSidebarWidthValue }}
          >
            {rightSidebar}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default SplitPaneLayout;
