import { create } from 'zustand';
import {
  authenticate as apiAuth,
  checkAuth,
  checkAuthStatus,
  setupPin as apiSetupPin,
} from '../api.js';

export interface AuthState {
  authenticated: boolean;
  pinError: string | null;
  checking: boolean;
  needsSetup: boolean;
  checkExistingAuth: () => Promise<void>;
  submitPin: (pin: string) => Promise<void>;
  setupNewPin: (pin: string, confirm: string) => Promise<void>;
  deauthenticate: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  authenticated: false,
  pinError: null,
  checking: true,
  needsSetup: false,

  checkExistingAuth: async () => {
    set({ checking: true });
    try {
      const status = await checkAuthStatus();
      if (!status.hasPIN) {
        set({ needsSetup: true, checking: false });
        return;
      }
      const authenticated = await checkAuth();
      set({ needsSetup: false, authenticated });
    } catch {
      set({ authenticated: false });
    } finally {
      set({ checking: false });
    }
  },

  submitPin: async (pin: string) => {
    set({ pinError: null });
    try {
      await apiAuth(pin);
      set({ authenticated: true });
    } catch (err) {
      const pinError = err instanceof Error ? err.message : 'Authentication failed';
      set({ pinError });
    }
  },

  setupNewPin: async (pin: string, confirm: string) => {
    set({ pinError: null });
    try {
      await apiSetupPin(pin, confirm);
      set({ needsSetup: false, authenticated: true });
    } catch (err) {
      const pinError = err instanceof Error ? err.message : 'Failed to set PIN';
      set({ pinError });
    }
  },

  deauthenticate: () => {
    set({ authenticated: false, pinError: null, checking: false });
  },
}));

export default useAuthStore;
