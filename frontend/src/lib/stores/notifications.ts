import { create } from 'zustand';
import type { ReactNode } from 'react';

export type NotificationType = 'update' | 'install' | 'error' | 'info' | 'image';

const PRIORITY: Record<NotificationType, number> = {
  update: 10,
  install: 20,
  error: 30,
  info: 40,
  image: 50,
};

export interface Notification {
  id: string;
  type: NotificationType;
  priority: number;
  content: ReactNode | (() => ReactNode);
  dismissible: boolean;
  onDismiss?: () => void;
}

type NotificationInput = Omit<Notification, 'priority'> & { priority?: number };

interface NotificationState {
  notifications: Notification[];
  addNotification: (notification: NotificationInput) => void;
  removeNotification: (id: string) => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],

  addNotification: (notification) => {
    const priority = notification.priority ?? PRIORITY[notification.type] ?? 99;
    set((state) => {
      if (state.notifications.some((n) => n.id === notification.id)) return state;
      const entry: Notification = { ...notification, priority };
      const inserted = [...state.notifications, entry].sort((a, b) => a.priority - b.priority);
      return { notifications: inserted };
    });
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },
}));

export function addNotification(notification: NotificationInput): void {
  useNotificationStore.getState().addNotification(notification);
}

export function removeNotification(id: string): void {
  useNotificationStore.getState().removeNotification(id);
}
