import React from 'react';
import { useToastStore } from '../lib/state/toasts.store.js';
import { addNotification, removeNotification } from '../lib/stores/notifications.js';
import './ErrorToast.css';

/**
 * ErrorToast bridges the existing toast store into the unified notification
 * stack. It renders nothing itself — it watches the toast store and
 * imperatively pushes/removes notifications from the notification store.
 *
 * addNotification replaces by id, so re-adding an existing toast is a no-op
 * in terms of visible change (content is stable per toast id).
 */
export const ErrorToast: React.FC = () => {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);

  // Push any new toasts into the notification store
  React.useEffect(() => {
    toasts.forEach((toast) => {
      const id = `error-toast-${toast.id}`;
      addNotification({
        id,
        type: toast.variant === 'error' ? 'error' : 'info',
        dismissible: true,
        content: (
          <ErrorToastContent
            message={toast.message}
            variant={toast.variant}
            onDismiss={() => {
              dismissToast(toast.id);
              removeNotification(id);
            }}
          />
        ),
        onDismiss: () => {
          dismissToast(toast.id);
          removeNotification(id);
        },
      });
    });
  }, [toasts, dismissToast]);

  // Remove notifications when toasts are dismissed from the store
  React.useEffect(() => {
    return useToastStore.subscribe((state, prev) => {
      prev.toasts
        .filter((t) => !state.toasts.find((s) => s.id === t.id))
        .forEach((t) => {
          removeNotification(`error-toast-${t.id}`);
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

const ErrorToastContent: React.FC<ErrorToastContentProps> = ({ message, variant, onDismiss }) => (
  <div
    className={`error-toast-content ${variant === 'error' ? 'error-toast-content--error' : 'error-toast-content--info'}`}
  >
    <span className="error-toast-text">{message}</span>
    <button className="error-toast-dismiss" onClick={onDismiss} aria-label="Dismiss">
      ×
    </button>
  </div>
);

export default ErrorToast;
