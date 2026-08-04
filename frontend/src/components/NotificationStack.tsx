import React from 'react';
import { useNotificationStore } from '../lib/stores/notifications.js';
import './NotificationStack.css';

export const NotificationStack: React.FC = () => {
  const notifications = useNotificationStore((state) => state.notifications);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="notification-stack">
      {notifications.map((notification) => (
        <div key={notification.id} className="notification-stack__item">
          {typeof notification.content === 'function'
            ? notification.content()
            : notification.content}
        </div>
      ))}
    </div>
  );
};

export default NotificationStack;
