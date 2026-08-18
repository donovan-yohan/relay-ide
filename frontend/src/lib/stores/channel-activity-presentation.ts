import { create } from 'zustand';

export const CHANNEL_ACTIVITY_PRESENTATION_KEY =
  'relay-channel-activity-presentation';

export type ChannelActivityPresentation = 'shown' | 'collapsed';

function loadPresentation(): ChannelActivityPresentation {
  try {
    return localStorage.getItem(CHANNEL_ACTIVITY_PRESENTATION_KEY) ===
      'collapsed'
      ? 'collapsed'
      : 'shown';
  } catch {
    return 'shown';
  }
}

function persistPresentation(value: ChannelActivityPresentation): void {
  try {
    localStorage.setItem(CHANNEL_ACTIVITY_PRESENTATION_KEY, value);
  } catch {
    // Presentation preference is optional in restricted browser contexts.
  }
}

interface ChannelActivityPresentationState {
  presentation: ChannelActivityPresentation;
  setPresentation: (presentation: ChannelActivityPresentation) => void;
  togglePresentation: () => void;
}

export const useChannelActivityPresentationStore =
  create<ChannelActivityPresentationState>((set, get) => ({
    presentation: loadPresentation(),
    setPresentation: (presentation) => {
      if (get().presentation === presentation) return;
      persistPresentation(presentation);
      set({ presentation });
    },
    togglePresentation: () => {
      const presentation =
        get().presentation === 'shown' ? 'collapsed' : 'shown';
      persistPresentation(presentation);
      set({ presentation });
    },
  }));
