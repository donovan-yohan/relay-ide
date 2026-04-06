import { describe, it, beforeEach, expect } from 'vitest';

import { useNotificationStore } from '../../frontend/src/lib/stores/notifications.js';

function resetStore() {
  useNotificationStore.setState({ notifications: [] });
}

describe('notifications Zustand store', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('addNotification', () => {
    it('adds a notification to the list', () => {
      useNotificationStore.getState().addNotification({
        id: 'n1',
        type: 'error',
        content: 'Something went wrong',
        dismissible: true,
      });
      const { notifications } = useNotificationStore.getState();
      expect(notifications.length).toBe(1);
      expect(notifications[0]!.id).toBe('n1');
    });

    it('assigns priority from type when not provided', () => {
      useNotificationStore.getState().addNotification({
        id: 'n1',
        type: 'error',
        content: 'Error message',
        dismissible: true,
      });
      expect(useNotificationStore.getState().notifications[0]!.priority).toBe(30);
    });

    it('accepts custom priority', () => {
      useNotificationStore.getState().addNotification({
        id: 'n1',
        type: 'info',
        content: 'Info message',
        dismissible: true,
        priority: 5,
      });
      expect(useNotificationStore.getState().notifications[0]!.priority).toBe(5);
    });

    it('deduplicates by id', () => {
      useNotificationStore.getState().addNotification({
        id: 'dup',
        type: 'error',
        content: 'First',
        dismissible: true,
      });
      useNotificationStore.getState().addNotification({
        id: 'dup',
        type: 'error',
        content: 'Second',
        dismissible: true,
      });
      expect(useNotificationStore.getState().notifications.length).toBe(1);
    });

    it('accumulates multiple notifications', () => {
      useNotificationStore.getState().addNotification({
        id: 'a',
        type: 'error',
        content: 'A',
        dismissible: true,
      });
      useNotificationStore.getState().addNotification({
        id: 'b',
        type: 'info',
        content: 'B',
        dismissible: true,
      });
      useNotificationStore.getState().addNotification({
        id: 'c',
        type: 'update',
        content: 'C',
        dismissible: true,
      });
      expect(useNotificationStore.getState().notifications.length).toBe(3);
    });

    it('sorts notifications by priority', () => {
      useNotificationStore.getState().addNotification({
        id: 'info',
        type: 'info',
        content: 'Info',
        dismissible: true,
      });
      useNotificationStore.getState().addNotification({
        id: 'update',
        type: 'update',
        content: 'Update',
        dismissible: true,
      });
      const { notifications } = useNotificationStore.getState();
      expect(notifications[0]!.id).toBe('update');
      expect(notifications[1]!.id).toBe('info');
    });
  });

  describe('removeNotification', () => {
    it('removes a notification by id', () => {
      useNotificationStore.getState().addNotification({
        id: 'keep',
        type: 'info',
        content: 'Keep',
        dismissible: true,
      });
      useNotificationStore.getState().addNotification({
        id: 'remove',
        type: 'error',
        content: 'Remove',
        dismissible: true,
      });
      useNotificationStore.getState().removeNotification('remove');
      const { notifications } = useNotificationStore.getState();
      expect(notifications.length).toBe(1);
      expect(notifications[0]!.id).toBe('keep');
    });

    it('is a no-op for unknown id', () => {
      useNotificationStore.getState().addNotification({
        id: 'only',
        type: 'info',
        content: 'Only one',
        dismissible: true,
      });
      useNotificationStore.getState().removeNotification('nonexistent');
      expect(useNotificationStore.getState().notifications.length).toBe(1);
    });

    it('can remove all notifications one by one', () => {
      useNotificationStore.getState().addNotification({
        id: 'a',
        type: 'error',
        content: 'A',
        dismissible: true,
      });
      useNotificationStore.getState().addNotification({
        id: 'b',
        type: 'info',
        content: 'B',
        dismissible: true,
      });
      const ids = useNotificationStore.getState().notifications.map((n) => n.id);
      for (const id of ids) {
        useNotificationStore.getState().removeNotification(id);
      }
      expect(useNotificationStore.getState().notifications.length).toBe(0);
    });
  });
});
