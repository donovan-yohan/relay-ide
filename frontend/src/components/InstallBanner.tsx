import React, { useEffect, useRef, useCallback } from 'react';
import {
  addNotification,
  removeNotification,
} from '../lib/stores/notifications.js';
import { TuiButton } from './TuiButton.js';
import './InstallBanner.css';

const INSTALL_NOTIFICATION_ID = 'pwa-install';
const DISMISS_KEY = 'relay-pwa-install-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const InstallBanner: React.FC = () => {
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  const dismiss = useCallback(() => {
    removeNotification(INSTALL_NOTIFICATION_ID);
    deferredPrompt.current = null;
    try {
      localStorage.setItem(DISMISS_KEY, Date.now().toString());
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  const install = useCallback(async () => {
    const prompt = deferredPrompt.current;
    if (!prompt) return;

    const result = await prompt.prompt();
    if (result.outcome === 'accepted') {
      removeNotification(INSTALL_NOTIFICATION_ID);
      deferredPrompt.current = null;
    }
  }, []);

  useEffect(() => {
    // check if already dismissed within the last 30 days
    try {
      const dismissed = localStorage.getItem(DISMISS_KEY);
      if (dismissed) {
        const dismissedAt = parseInt(dismissed, 10);
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        if (Date.now() - dismissedAt < thirtyDays) return;
      }
    } catch {
      // localStorage may be unavailable
    }

    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;

      addNotification({
        id: INSTALL_NOTIFICATION_ID,
        type: 'install',
        dismissible: true,
        onDismiss: dismiss,
        content: (
          <div className="install-banner">
            <span className="install-banner__text">
              install relay as an app for quick access
            </span>
            <div className="install-banner__actions">
              <TuiButton variant="primary" size="sm" onClick={install}>
                install
              </TuiButton>
              <button
                className="install-banner__dismiss"
                onClick={dismiss}
                aria-label="Dismiss"
              >
                &times;
              </button>
            </div>
          </div>
        ),
      });
    };

    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      removeNotification(INSTALL_NOTIFICATION_ID);
    };
  }, [dismiss, install]);

  // this component renders nothing directly — it pushes into NotificationStack
  return null;
};

export default InstallBanner;
