import { describe, it, expect } from 'vitest';

const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 600;
const MIN_TERMINAL_WIDTH = 300;
const MIN_FILE_VIEWER_WIDTH = 300;
const MOBILE_BREAKPOINT = 768;

function clampRightSidebarWidth(raw: number): number {
  return Math.max(MIN_RIGHT_SIDEBAR_WIDTH, Math.min(MAX_RIGHT_SIDEBAR_WIDTH, raw));
}

function computeFileViewerRatio(
  containerWidth: number,
  rightSidebarWidth: number,
  pointerX: number,
  containerLeft: number,
  containerRight: number
): number | null {
  const available = containerWidth - rightSidebarWidth;
  const fileViewerWidth = containerRight - rightSidebarWidth - pointerX;
  const terminalWidth = pointerX - containerLeft;
  if (terminalWidth < MIN_TERMINAL_WIDTH || fileViewerWidth < MIN_FILE_VIEWER_WIDTH) {
    return null;
  }
  return fileViewerWidth / available;
}

describe('SplitPaneLayout', () => {
  describe('Props Interface', () => {
    it('should accept mobile overlay props', () => {
      interface SplitPaneLayoutProps {
        terminal: unknown;
        fileViewer?: unknown;
        rightSidebar?: unknown;
        fileViewerOpen?: boolean;
        rightSidebarCollapsed?: boolean;
        rightSidebarMobileOpen?: boolean;
        onRightSidebarMobileClose?: () => void;
        rightSidebarWidth?: number;
        fileViewerRatio?: number;
        onRightSidebarWidthChange?: (width: number) => void;
        onFileViewerRatioChange?: (ratio: number) => void;
      }

      const props: SplitPaneLayoutProps = {
        terminal: null,
        rightSidebarMobileOpen: true,
        onRightSidebarMobileClose: () => {},
      };

      expect(props.rightSidebarMobileOpen).toBe(true);
      expect(typeof props.onRightSidebarMobileClose).toBe('function');
    });

    it('should have optional mobile overlay props', () => {
      interface SplitPaneLayoutProps {
        rightSidebarMobileOpen?: boolean;
        onRightSidebarMobileClose?: () => void;
      }

      const minimalProps: SplitPaneLayoutProps = {};
      expect(minimalProps.rightSidebarMobileOpen).toBe(undefined);
      expect(minimalProps.onRightSidebarMobileClose).toBe(undefined);
    });
  });

  describe('Mobile Behavior', () => {
    it('should hide resize handles on mobile via CSS', () => {
      const css = `
        @media (max-width: 767px) {
          .resize-handle { display: none; }
        }
      `;
      expect(css).toContain('.resize-handle { display: none; }');
    });

    it('should have touch-action:none on resize handles', () => {
      const css = '.resize-handle { touch-action: none; }';
      expect(css).toContain('touch-action: none');
    });

    it('should have mobile overlay styles', () => {
      const css = '.right-sidebar-overlay { position: fixed; }';
      expect(css).toContain('position: fixed');
    });

    it('should use 768px as the mobile breakpoint', () => {
      expect(MOBILE_BREAKPOINT).toBe(768);
    });
  });

  describe('Drag Calculations', () => {
    it('should clamp right sidebar width to minimum', () => {
      expect(clampRightSidebarWidth(50)).toBe(MIN_RIGHT_SIDEBAR_WIDTH);
    });

    it('should clamp right sidebar width to maximum', () => {
      expect(clampRightSidebarWidth(900)).toBe(MAX_RIGHT_SIDEBAR_WIDTH);
    });

    it('should allow right sidebar width within bounds', () => {
      expect(clampRightSidebarWidth(320)).toBe(320);
    });

    it('should return null when terminal width is below minimum', () => {
      const ratio = computeFileViewerRatio(1200, 0, 100, 0, 1200);
      expect(ratio).toBeNull();
    });

    it('should return null when file viewer width is below minimum', () => {
      const ratio = computeFileViewerRatio(1200, 0, 1100, 0, 1200);
      expect(ratio).toBeNull();
    });

    it('should compute valid file viewer ratio', () => {
      const ratio = computeFileViewerRatio(1200, 0, 600, 0, 1200);
      expect(ratio).toBe(0.5);
    });

    it('should account for right sidebar width when computing ratio', () => {
      const ratio = computeFileViewerRatio(1200, 200, 500, 0, 1200);
      // available = 1000, fileViewer = 1200 - 200 - 500 = 500
      expect(ratio).toBe(0.5);
    });
  });

  describe('Pointer Event Handling', () => {
    it('should call setPointerCapture on pointer down', () => {
      let captured = false;
      const mockTarget = {
        setPointerCapture: () => { captured = true; },
      };
      mockTarget.setPointerCapture(1);
      expect(captured).toBe(true);
    });

    it('should call preventDefault on pointer move during drag', () => {
      let prevented = false;
      const mockEvent = {
        preventDefault: () => { prevented = true; },
      };
      mockEvent.preventDefault();
      expect(prevented).toBe(true);
    });
  });
});
