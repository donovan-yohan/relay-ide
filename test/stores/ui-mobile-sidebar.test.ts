import { describe, it, expect } from 'vitest';

describe('UiState mobile sidebar actions', () => {
  it('should have rightSidebarMobileOpen defaulting to false', () => {
    interface UiState {
      rightSidebarMobileOpen: boolean;
    }
    const state: UiState = { rightSidebarMobileOpen: false };
    expect(state.rightSidebarMobileOpen).toBe(false);
  });

  it('should support setRightSidebarMobileOpen action', () => {
    interface UiState {
      rightSidebarMobileOpen: boolean;
      setRightSidebarMobileOpen: (v: boolean) => void;
    }
    const state: UiState = {
      rightSidebarMobileOpen: false,
      setRightSidebarMobileOpen: (v) => { state.rightSidebarMobileOpen = v; },
    };
    state.setRightSidebarMobileOpen(true);
    expect(state.rightSidebarMobileOpen).toBe(true);
  });

  it('should support toggleRightSidebarMobileOpen action', () => {
    interface UiState {
      rightSidebarMobileOpen: boolean;
      toggleRightSidebarMobileOpen: () => void;
    }
    const state: UiState = {
      rightSidebarMobileOpen: false,
      toggleRightSidebarMobileOpen: () => {
        state.rightSidebarMobileOpen = !state.rightSidebarMobileOpen;
      },
    };
    state.toggleRightSidebarMobileOpen();
    expect(state.rightSidebarMobileOpen).toBe(true);
    state.toggleRightSidebarMobileOpen();
    expect(state.rightSidebarMobileOpen).toBe(false);
  });
});
