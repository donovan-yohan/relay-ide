import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UTILITY_RAIL_STATE,
  nextMobileUtilityRailAction,
  type WorkspaceUtilityRailState,
} from '../frontend/src/lib/stores/ui.js';

function railState(
  overrides: Partial<WorkspaceUtilityRailState> = {}
): WorkspaceUtilityRailState {
  return { ...DEFAULT_UTILITY_RAIL_STATE, ...overrides };
}

describe('nextMobileUtilityRailAction', () => {
  it('opens the files tab from the default fresh state (visible, no tab)', () => {
    // Regression (#1058): the default is { visible: true, selectedRailTab: null }
    // so the mobile overlay stays closed until a tab is selected — a plain
    // `visible` toggle left the "files" button dead.
    expect(nextMobileUtilityRailAction(railState())).toEqual({
      kind: 'open',
      tab: 'files',
    });
  });

  it('opens the files tab when no rail state exists yet', () => {
    expect(nextMobileUtilityRailAction(undefined)).toEqual({
      kind: 'open',
      tab: 'files',
    });
  });

  it('closes when the overlay is already open (visible + selected tab)', () => {
    expect(
      nextMobileUtilityRailAction(
        railState({ visible: true, selectedRailTab: 'files' })
      )
    ).toEqual({ kind: 'close' });
    expect(
      nextMobileUtilityRailAction(
        railState({ visible: true, selectedRailTab: 'changes' })
      )
    ).toEqual({ kind: 'close' });
  });

  it('reopens the last-selected tab after the overlay was closed', () => {
    expect(
      nextMobileUtilityRailAction(
        railState({ visible: false, selectedRailTab: 'changes' })
      )
    ).toEqual({ kind: 'open', tab: 'changes' });
  });

  it('treats visible-but-untabbed as closed (opens files)', () => {
    expect(
      nextMobileUtilityRailAction(
        railState({ visible: true, selectedRailTab: null })
      )
    ).toEqual({ kind: 'open', tab: 'files' });
  });
});
