import { create } from 'zustand';
import * as api from '../api.js';

export interface ConfigState {
  defaultContinue: boolean;
  defaultYolo: boolean;
  launchInTmux: boolean;
  defaultAgent: string;
  defaultNotifications: boolean;
  claudeFullscreen: boolean;
  refreshConfig: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>()((set, get) => ({
  defaultContinue: true,
  defaultYolo: false,
  launchInTmux: false,
  defaultAgent: 'claude',
  defaultNotifications: true,
  claudeFullscreen: true,

  refreshConfig: async () => {
    const s = get();
    const [cont, yolo, tmux, agent, notif, fullscreen] = await Promise.all([
      api.fetchDefaultContinue().catch(() => s.defaultContinue),
      api.fetchDefaultYolo().catch(() => s.defaultYolo),
      api.fetchLaunchInTmux().catch(() => s.launchInTmux),
      api.fetchDefaultAgent().catch(() => s.defaultAgent),
      api.fetchDefaultNotifications().catch(() => s.defaultNotifications),
      api.fetchClaudeFullscreen().catch(() => s.claudeFullscreen),
    ]);
    set({
      defaultContinue: cont,
      defaultYolo: yolo,
      launchInTmux: tmux,
      defaultAgent: agent,
      defaultNotifications: notif,
      claudeFullscreen: fullscreen,
    });
  },
}));

export default useConfigStore;
