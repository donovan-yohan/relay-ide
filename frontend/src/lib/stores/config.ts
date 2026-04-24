import { create } from 'zustand';
import * as api from '../api.js';
import type { FrameworkInfo } from '../types.js';

export interface ConfigState {
  defaultContinue: boolean;
  defaultYolo: boolean;
  defaultAgent: string;
  defaultNotifications: boolean;
  claudeFullscreen: boolean;
  frameworks: FrameworkInfo[];
  refreshConfig: () => Promise<void>;
  loadFrameworks: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>()((set, get) => ({
  defaultContinue: true,
  defaultYolo: false,
  defaultAgent: 'claude',
  defaultNotifications: true,
  claudeFullscreen: true,
  frameworks: [],

  refreshConfig: async () => {
    const s = get();
    const [cont, yolo, agent, notif, fullscreen] = await Promise.all([
      api.fetchDefaultContinue().catch(() => s.defaultContinue),
      api.fetchDefaultYolo().catch(() => s.defaultYolo),
      api.fetchDefaultAgent().catch(() => s.defaultAgent),
      api.fetchDefaultNotifications().catch(() => s.defaultNotifications),
      api.fetchClaudeFullscreen().catch(() => s.claudeFullscreen),
    ]);
    set({
      defaultContinue: cont,
      defaultYolo: yolo,
      defaultAgent: agent,
      defaultNotifications: notif,
      claudeFullscreen: fullscreen,
    });
  },

  loadFrameworks: async () => {
    const frameworks = await api.fetchFrameworks().catch(() => []);
    set({ frameworks });
  },
}));
