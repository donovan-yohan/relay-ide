import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  variant: 'error' | 'info';
}

interface ToastState {
  toasts: Toast[];
  showToast: (message: string, variant?: 'error' | 'info', durationMs?: number) => void;
  dismissToast: (id: number) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  showToast: (message, variant = 'error', durationMs = 5000) => {
    const id = nextId++;
    set((state) => ({
      toasts: [...state.toasts, { id, message, variant }],
    }));
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, durationMs);
  },
  dismissToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));

// Convenience functions that match the Svelte API
export function showToast(
  message: string,
  variant: 'error' | 'info' = 'error',
  durationMs = 5000
): void {
  useToastStore.getState().showToast(message, variant, durationMs);
}

export function dismissToast(id: number): void {
  useToastStore.getState().dismissToast(id);
}

export function getToasts(): Toast[] {
  return useToastStore.getState().toasts;
}