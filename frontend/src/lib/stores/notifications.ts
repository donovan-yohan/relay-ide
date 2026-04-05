import { create } from 'zustand';
import React from 'react';

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
  content: React.ReactNode | (() => React.ReactNode);
  dismissible: boolean;
  onDismiss?: () => void;
}

interface NotificationState {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'priority'> & { priority?: number }) => void;
  removeNotification: (id: string) => void;
}

let counter = 0;

export function generateNotificationId(prefix: string = 'notif'): string {
  return `${prefix}-${++counter}`;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],

  addNotification: (notification) => {
    const priority = notification.priority ?? PRIORITY[notification.type] ?? 99;
    const entry: Notification = { ...notification, priority };
    set((state) => {
      // Replace existing notification with same id if present
      const filtered = state.notifications.filter((n) => n.id !== entry.id);
      const inserted = [...filtered, entry].sort((a, b) => a.priority - b.priority);
      return { notifications: inserted };
    });
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },
}));

export function addNotification(
  notification: Omit<Notification, 'priority'> & { priority?: number }
): void {
  useNotificationStore.getState().addNotification(notification);
}

export function removeNotification(id: string): void {
  useNotificationStore.getState().removeNotification(id);
}
