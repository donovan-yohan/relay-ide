import { create } from 'zustand';
import * as api from '../api.js';
import type { FrameworkInfo } from '../types.js';

export interface ConfigState {
  defaultAgent: string;
  defaultNotifications: boolean;
  frameworks: FrameworkInfo[];
  refreshConfig: () => Promise<void>;
  loadFrameworks: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>()((set, get) => ({
  defaultAgent: 'claude',
  defaultNotifications: true,
  frameworks: [],

  refreshConfig: async () => {
    const s = get();
    const [agent, notif] = await Promise.all([
      api.fetchDefaultAgent().catch(() => s.defaultAgent),
      api.fetchDefaultNotifications().catch(() => s.defaultNotifications),
    ]);
    set({
      defaultAgent: agent,
      defaultNotifications: notif,
    });
  },

  loadFrameworks: async () => {
    const frameworks = await api.fetchFrameworks().catch(() => []);
    set({ frameworks });
  },
}));
