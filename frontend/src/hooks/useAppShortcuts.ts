import { useEffect } from 'react';
import type React from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { isMobileDevice, isMac } from '../lib/utils.js';
import { setupShortcutListener } from '../lib/actions/shortcuts.js';
import { getAllActions } from '../lib/actions/registry.js';
import type { ActionContext } from '../lib/actions/types.js';

export interface UseAppShortcutsParams {
  handleSelectSession: (id: string) => void;
  setSpotlightOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setFilePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mainAppRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<{ fitTerm: () => void } | null>;
  actionContextRef: React.RefObject<ActionContext>;
}

// ── Shortcut map types ───────────────────────────────────────────────────────

type ShortcutContext = {
  setSpotlightOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setFilePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleSelectSession: (id: string) => void;
};

// Returns true if the shortcut was handled (caller should return early).
type ShortcutHandler = (e: KeyboardEvent, ctx: ShortcutContext) => boolean;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isActiveElementInput(): boolean {
  const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
  return (
    activeTag === 'INPUT' ||
    activeTag === 'TEXTAREA' ||
    !!(document.activeElement as HTMLElement)?.isContentEditable
  );
}

function getActiveSession() {
  const { activeSessionId, sessions } = useSessionsStore.getState();
  return activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;
}

// Cmd/Ctrl+1-9: switch to the nth tab in the active workspace.
function handleTabSwitch(e: KeyboardEvent, handleSelectSession: (id: string) => void): boolean {
  if (e.shiftKey || e.key < '1' || e.key > '9') return false;

  const currentRepoPath = useUiStore.getState().activeRepoPath;
  const activeSession = getActiveSession();
  const allWs = currentRepoPath
    ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
    : [];
  const wsSessions = (
    activeSession ? allWs.filter((s) => s.cwd === activeSession.cwd) : allWs
  ).toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (wsSessions.length === 0) return false;

  e.preventDefault();
  const n = parseInt(e.key, 10);
  const target = n === 9 ? wsSessions[wsSessions.length - 1] : wsSessions[n - 1];
  if (target) handleSelectSession(target.id);
  return true;
}

// ── Shortcut map (mod-key shortcuts) ────────────────────────────────────────
//
// Each entry handles one mod+key combination. Handlers run before the
// isInInput guard (except tab switching), so they must opt in to that guard
// themselves when needed.

const modShortcuts: Record<string, ShortcutHandler> = {
  // Cmd/Ctrl+P — toggle command palette (works from input fields)
  p: (e, ctx) => {
    if (e.shiftKey) return false;
    e.preventDefault();
    ctx.setSpotlightOpen((v) => !v);
    return true;
  },

  // Cmd/Ctrl+K — toggle picker (works from input fields)
  k: (e, ctx) => {
    e.preventDefault();
    ctx.setPickerOpen((v) => !v);
    return true;
  },

  // Cmd/Ctrl+O — open file picker (only when a session with a cwd is active)
  o: (e, ctx) => {
    if (e.shiftKey) return false;
    const activeSession = getActiveSession();
    const cwd = activeSession?.worktreePath ?? activeSession?.repoPath ?? '';
    if (!activeSession || !cwd) return false;
    e.preventDefault();
    ctx.setFilePickerOpen((v) => !v);
    return true;
  },

  // Cmd/Ctrl+B — toggle right sidebar
  b: (e, _ctx) => {
    e.preventDefault();
    useUiStore.getState().toggleRightSidebarCollapsed();
    return true;
  },
};

// ── Keyboard shortcut setup ──────────────────────────────────────────────────

function setupKeyboardShortcuts(ctx: ShortcutContext, actionContextRef: React.RefObject<ActionContext>): () => void {
  const onSpecialKeydown = (e: KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;

    const handler = modShortcuts[e.key];
    if (handler && handler(e, ctx)) return;

    // Remaining shortcuts require focus to be outside text inputs.
    if (isActiveElementInput()) return;

    handleTabSwitch(e, ctx.handleSelectSession);
  };

  document.addEventListener('keydown', onSpecialKeydown);

  const cleanupRegistry = setupShortcutListener(
    () => getAllActions(),
    () => actionContextRef.current,
    isMac,
  );

  return () => {
    document.removeEventListener('keydown', onSpecialKeydown);
    cleanupRegistry();
  };
}

// ── Mobile viewport setup ────────────────────────────────────────────────────

function setupMobileViewport(
  mainAppRef: React.RefObject<HTMLDivElement | null>,
  terminalRef: React.RefObject<{ fitTerm: () => void } | null>,
): (() => void) | undefined {
  if (!isMobileDevice || !window.visualViewport) return undefined;

  const vv = window.visualViewport;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;

  const onViewportResize = () => {
    const kbHeight = window.innerHeight - vv.height;
    useUiStore.setState({ keyboardOpen: kbHeight > 50 });
    const el = mainAppRef.current;
    if (el) {
      el.style.height = kbHeight > 50 ? vv.height + 'px' : '';
    }
    window.scrollTo(0, 0);
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => terminalRef.current?.fitTerm(), 100);
  };

  vv.addEventListener('resize', onViewportResize);
  vv.addEventListener('scroll', onViewportResize);

  return () => {
    vv.removeEventListener('resize', onViewportResize);
    vv.removeEventListener('scroll', onViewportResize);
    if (fitTimer) clearTimeout(fitTimer);
  };
}

// ── Left edge swipe setup ────────────────────────────────────────────────────

function setupEdgeSwipe(): (() => void) | undefined {
  if (!isMobileDevice) return undefined;

  const EDGE_ZONE = 30;
  const SWIPE_THRESHOLD = 50;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeTracking = false;

  const onSwipeTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    if (touch.clientX <= EDGE_ZONE && !useUiStore.getState().sidebarOpen) {
      swipeStartX = touch.clientX;
      swipeStartY = touch.clientY;
      swipeTracking = true;
    }
  };

  const onSwipeTouchMove = (e: TouchEvent) => {
    if (!swipeTracking) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - swipeStartX;
    const dy = Math.abs(touch.clientY - swipeStartY);
    if (dy > dx && (dy > 8 || dx > 8)) {
      swipeTracking = false;
      return;
    }
    if (dx >= SWIPE_THRESHOLD) {
      swipeTracking = false;
      useUiStore.getState().openSidebar();
    }
  };

  const onSwipeTouchEnd = () => {
    swipeTracking = false;
  };

  document.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
  document.addEventListener('touchmove', onSwipeTouchMove, { passive: true });
  document.addEventListener('touchend', onSwipeTouchEnd);

  return () => {
    document.removeEventListener('touchstart', onSwipeTouchStart);
    document.removeEventListener('touchmove', onSwipeTouchMove);
    document.removeEventListener('touchend', onSwipeTouchEnd);
  };
}

// ── Right edge swipe setup ───────────────────────────────────────────────────

function setupRightEdgeSwipe(): (() => void) | undefined {
  if (!isMobileDevice) return undefined;

  const EDGE_ZONE = 30;
  const SWIPE_THRESHOLD = 50;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeTracking = false;

  const onSwipeTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    if (window.innerWidth - touch.clientX <= EDGE_ZONE && !useUiStore.getState().rightSidebarMobileOpen) {
      swipeStartX = touch.clientX;
      swipeStartY = touch.clientY;
      swipeTracking = true;
    }
  };

  const onSwipeTouchMove = (e: TouchEvent) => {
    if (!swipeTracking) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - swipeStartX;
    const dy = Math.abs(touch.clientY - swipeStartY);
    if (dy > Math.abs(dx) && (dy > 8 || Math.abs(dx) > 8)) {
      swipeTracking = false;
      return;
    }
    if (dx <= -SWIPE_THRESHOLD) {
      swipeTracking = false;
      useUiStore.getState().toggleRightSidebarMobileOpen();
    }
  };

  const onSwipeTouchEnd = () => {
    swipeTracking = false;
  };

  document.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
  document.addEventListener('touchmove', onSwipeTouchMove, { passive: true });
  document.addEventListener('touchend', onSwipeTouchEnd);

  return () => {
    document.removeEventListener('touchstart', onSwipeTouchStart);
    document.removeEventListener('touchmove', onSwipeTouchMove);
    document.removeEventListener('touchend', onSwipeTouchEnd);
  };
}

// ── Hardware keyboard detection ───────────────────────────────────────────────

function setupHardwareKeyboardDetection(): void {
  if (!isMobileDevice) return;

  const detectKeyboard = () => {
    useUiStore.setState({ hasHardwareKeyboard: true });
    document.removeEventListener('keydown', detectKeyboard);
  };
  document.addEventListener('keydown', detectKeyboard);
  // Self-removing: no explicit cleanup needed (listener unregisters on first keydown).
}

// ── Public hook ───────────────────────────────────────────────────────────────

export function useAppShortcuts(params: UseAppShortcutsParams): void {
  const {
    handleSelectSession,
    setSpotlightOpen,
    setPickerOpen,
    setFilePickerOpen,
    mainAppRef,
    terminalRef,
    actionContextRef,
  } = params;

  useEffect(() => {
    const shortcutCtx: ShortcutContext = {
      setSpotlightOpen,
      setPickerOpen,
      setFilePickerOpen,
      handleSelectSession,
    };

    const cleanupKeydown = setupKeyboardShortcuts(shortcutCtx, actionContextRef);
    const cleanupViewport = setupMobileViewport(mainAppRef, terminalRef);
    const cleanupSwipe = setupEdgeSwipe();
    const cleanupRightSwipe = setupRightEdgeSwipe();
    setupHardwareKeyboardDetection();

    return () => {
      cleanupKeydown();
      cleanupViewport?.();
      cleanupSwipe?.();
      cleanupRightSwipe?.();
    };

  }, []);
}
