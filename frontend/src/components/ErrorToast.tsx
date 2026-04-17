import React from 'react';
import { useToastStore } from '../lib/stores/toasts.js';
import {
  addNotification,
  removeNotification,
} from '../lib/stores/notifications.js';
import './ErrorToast.css';

export const ErrorToast: React.FC = () => {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);
  const syncedIds = React.useRef(new Set<string>());

  React.useEffect(() => {
    toasts.forEach((toast) => {
      const id = `error-toast-${toast.id}`;
      if (syncedIds.current.has(id)) return;
      syncedIds.current.add(id);
      const onDismiss = () => {
        dismissToast(toast.id);
        removeNotification(id);
      };
      addNotification({
        id,
        type: toast.variant === 'error' ? 'error' : 'info',
        dismissible: true,
        content: (
          <ErrorToastContent
            message={toast.message}
            variant={toast.variant}
            onDismiss={onDismiss}
          />
        ),
        onDismiss,
      });
    });
  }, [toasts, dismissToast]);

  React.useEffect(() => {
    return useToastStore.subscribe((state, prev) => {
      const currentIds = new Set(state.toasts.map((t) => t.id));
      prev.toasts
        .filter((t) => !currentIds.has(t.id))
        .forEach((t) => {
          const id = `error-toast-${t.id}`;
          syncedIds.current.delete(id);
          removeNotification(id);
        });
    });
  }, []);

  return null;
};

interface ErrorToastContentProps {
  message: string;
  variant: 'error' | 'info';
  onDismiss: () => void;
}

const ErrorToastContent: React.FC<ErrorToastContentProps> = ({
  message,
  variant,
  onDismiss,
}) => (
  <div
    className={`notification-card${variant === 'error' ? ' notification-card--error' : ''}`}
  >
    <span className="notification-card__text error-toast-text">{message}</span>
    <button
      className="notification-card__dismiss"
      onClick={onDismiss}
      aria-label="Dismiss"
    >
      ×
    </button>
  </div>
);

export default ErrorToast;
