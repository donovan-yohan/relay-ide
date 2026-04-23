import React, { useCallback, useEffect, useRef, useState } from 'react';
import './SplitPaneLayout.css';

const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 600;
const MIN_TERMINAL_WIDTH = 300;
const MIN_FILE_VIEWER_WIDTH = 300;
const MOBILE_BREAKPOINT = 768;

export interface SplitPaneLayoutProps {
  terminal: React.ReactNode;
  fileViewer?: React.ReactNode;
  rightSidebar?: React.ReactNode;
  /** Whether the file viewer pane is open (has content) */
  fileViewerOpen?: boolean;
  /** Whether the right sidebar is collapsed */
  rightSidebarCollapsed?: boolean;
  /** Whether the right sidebar mobile overlay is open */
  rightSidebarMobileOpen?: boolean;
  /** Called when the mobile overlay should close (backdrop click) */
  onRightSidebarMobileClose?: () => void;
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
  rightSidebarMobileOpen = false,
  onRightSidebarMobileClose,
  rightSidebarWidth: externalRightSidebarWidth,
  fileViewerRatio: externalFileViewerRatio,
  onRightSidebarWidthChange,
  onFileViewerRatioChange,
}: SplitPaneLayoutProps) {
  const [internalRightSidebarWidth, setInternalRightSidebarWidth] = useState(320);
  const [internalFileViewerRatio, setInternalFileViewerRatio] = useState(0.4);
  const [dragging, setDragging] = useState<'right-sidebar' | 'file-viewer' | null>(null);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < MOBILE_BREAKPOINT : false
  );

  const rightSidebarWidthValue = externalRightSidebarWidth ?? internalRightSidebarWidth;
  const fileViewerRatioValue = externalFileViewerRatio ?? internalFileViewerRatio;

  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);

  const rightSidebarEffectiveWidth = rightSidebarCollapsed ? 0 : rightSidebarWidthValue;

  // Use refs for values needed in document-level listeners
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const rightSidebarEffectiveWidthRef = useRef(rightSidebarEffectiveWidth);
  rightSidebarEffectiveWidthRef.current = rightSidebarEffectiveWidth;

  // Mobile resize listener
  useEffect(() => {
    function onResize() {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handlePointerDown = useCallback(
    (handle: 'right-sidebar' | 'file-viewer', e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      handleRef.current = target;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw if the pointer is already captured
      }
      setDragging(handle);
    },
    []
  );

  // Document-level listeners for drag — avoids pointer capture + React delegation issues
  useEffect(() => {
    if (!dragging) return;

    function onMove(e: PointerEvent) {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const currentDragging = draggingRef.current;

      if (currentDragging === 'right-sidebar') {
        const newRightWidth = rect.right - e.clientX;
        const clamped = Math.max(MIN_RIGHT_SIDEBAR_WIDTH, Math.min(MAX_RIGHT_SIDEBAR_WIDTH, newRightWidth));
        setInternalRightSidebarWidth(clamped);
        onRightSidebarWidthChange?.(clamped);
      } else if (currentDragging === 'file-viewer') {
        const rsw = rightSidebarEffectiveWidthRef.current;
        const available = rect.width - rsw;
        const fileViewerWidth = rect.right - rsw - e.clientX;
        const terminalWidth = e.clientX - rect.left;
        if (terminalWidth < MIN_TERMINAL_WIDTH || fileViewerWidth < MIN_FILE_VIEWER_WIDTH) return;
        const ratio = fileViewerWidth / available;
        setInternalFileViewerRatio(ratio);
        onFileViewerRatioChange?.(ratio);
      }
    }

    function onUp(e: PointerEvent) {
      setDragging(null);
      const target = handleRef.current;
      if (target) {
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          // releasePointerCapture can throw if the pointer is not captured
        }
        handleRef.current = null;
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [dragging, onRightSidebarWidthChange, onFileViewerRatioChange]);

  return (
    <>
      <div className="split-pane-layout" ref={containerRef}>
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

        {!rightSidebarCollapsed && !isMobile ? (
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

      {isMobile && rightSidebarMobileOpen ? (
        <div
          className="right-sidebar-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="right-sidebar-title"
        >
          <div
            className="right-sidebar-overlay-backdrop"
            onClick={onRightSidebarMobileClose}
            aria-hidden="true"
          />
          <div className="right-sidebar-overlay-panel">
            <div id="right-sidebar-title" className="visually-hidden">
              files and changes
            </div>
            {rightSidebar}
          </div>
        </div>
      ) : null}
    </>
  );
}

export default SplitPaneLayout;
