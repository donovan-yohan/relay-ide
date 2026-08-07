import { create } from 'zustand';

/** Client-local presentation preference for newly mounted reasoning details. */
export const REASONING_DETAIL_SETTINGS_KEY = 'relay-reasoning-detail-settings';

export type ReasoningDetailDefault = 'collapsed' | 'expanded';

export interface ReasoningDetailSettings {
  defaultState: ReasoningDetailDefault;
}

export const DEFAULT_REASONING_DETAIL_SETTINGS: ReasoningDetailSettings =
  Object.freeze({ defaultState: 'collapsed' });

export function parseReasoningDetailSettings(
  raw: string | null
): ReasoningDetailSettings {
  if (!raw) return { ...DEFAULT_REASONING_DETAIL_SETTINGS };
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      ((value as Record<string, unknown>)['defaultState'] === 'collapsed' ||
        (value as Record<string, unknown>)['defaultState'] === 'expanded')
    ) {
      return {
        defaultState: (value as Record<string, unknown>)[
          'defaultState'
        ] as ReasoningDetailDefault,
      };
    }
  } catch {
    // A corrupt preference degrades to the product default.
  }
  return { ...DEFAULT_REASONING_DETAIL_SETTINGS };
}

function loadSettings(): ReasoningDetailSettings {
  try {
    return parseReasoningDetailSettings(
      localStorage.getItem(REASONING_DETAIL_SETTINGS_KEY)
    );
  } catch {
    return { ...DEFAULT_REASONING_DETAIL_SETTINGS };
  }
}

function persistSettings(settings: ReasoningDetailSettings): void {
  try {
    localStorage.setItem(
      REASONING_DETAIL_SETTINGS_KEY,
      JSON.stringify(settings)
    );
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

interface ReasoningDetailSettingsState {
  settings: ReasoningDetailSettings;
  setDefaultState: (defaultState: ReasoningDetailDefault) => void;
  reset: () => void;
}

export const useReasoningDetailSettingsStore =
  create<ReasoningDetailSettingsState>((set, get) => ({
    settings: loadSettings(),
    setDefaultState: (defaultState) => {
      if (get().settings.defaultState === defaultState) return;
      const settings = { defaultState };
      persistSettings(settings);
      set({ settings });
    },
    reset: () => {
      const settings = { ...DEFAULT_REASONING_DETAIL_SETTINGS };
      persistSettings(settings);
      set({ settings });
    },
  }));
