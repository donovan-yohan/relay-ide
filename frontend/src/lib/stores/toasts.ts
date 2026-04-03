import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  variant: 'error' | 'info';
}

export interface ToastOptions {
  variant?: 'error' | 'info';
  durationMs?: number;
}

interface ToastState {
  toasts: Toast[];
  showToast: (message: string, options?: ToastOptions) => void;
  dismissToast: (id: number) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],

  showToast: (message: string, options?: ToastOptions) => {
    const variant = options?.variant ?? 'error';
    const durationMs = options?.durationMs ?? 5000;
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { id, message, variant }] }));
    setTimeout(() => get().dismissToast(id), durationMs);
  },

  dismissToast: (id: number) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

export default useToastStore;
