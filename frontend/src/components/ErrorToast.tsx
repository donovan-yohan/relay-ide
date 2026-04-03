import React from 'react';
import { useToastStore } from '../lib/state/toasts.store.js';
import './ErrorToast.css';

export const ErrorToast: React.FC = () => {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="error-toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`error-toast ${toast.variant === 'error' ? 'error-toast--error' : 'error-toast--info'}`}
        >
          <div className="error-toast-content">
            <span className="error-toast-text">{toast.message}</span>
            <button
              className="error-toast-dismiss"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ErrorToast;