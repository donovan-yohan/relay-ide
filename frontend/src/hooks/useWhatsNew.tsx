import { useEffect, useRef } from 'react';
import { WHATS_NEW } from '../lib/whats-new.js';
import { addNotification, removeNotification } from '../lib/stores/notifications.js';
import { useHintsStore } from '../lib/stores/hints.js';

const WHATS_NEW_SEEN_KEY = 'relay-ide:whats-new-seen';
const MAX_TOASTS_PER_LOAD = 2;

function loadSeenVersion(): string | null {
  try {
    return localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return null;
  }
}

function saveSeenVersion(version: string): void {
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, version);
  } catch {
    /* unavailable */
  }
}

export function useWhatsNew(currentVersion: string) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;

    // Suppress during onboarding (if there are no seen hints yet, user is new)
    const { seenIds, canShowHint, incrementActive } = useHintsStore.getState();
    const isOnboarding = seenIds.size === 0;
    if (isOnboarding) return;

    const seenVersion = loadSeenVersion();

    // Only show for exact version match and only once per version
    if (seenVersion === currentVersion) return;
    const features = WHATS_NEW[currentVersion];
    if (!features) {
      saveSeenVersion(currentVersion);
      return;
    }

    firedRef.current = true;
    saveSeenVersion(currentVersion);

    const featureEntries = Object.entries(features).slice(0, MAX_TOASTS_PER_LOAD);
    let shown = 0;

    for (const [featureId, description] of featureEntries) {
      if (shown >= MAX_TOASTS_PER_LOAD) break;
      if (!canShowHint()) break;

      incrementActive();
      shown++;

      const notifId = `whats-new-${currentVersion}-${featureId}`;
      addNotification({
        id: notifId,
        type: 'info',
        dismissible: true,
        content: () => {
          const { decrementActive } = useHintsStore.getState();
          return (
            <div className="notification-card hint-toast">
              <span className="notification-card__text hint-toast__text">
                {description}
              </span>
              <button
                className="notification-card__dismiss"
                aria-label="dismiss"
                onClick={() => {
                  decrementActive();
                  removeNotification(notifId);
                }}
              >
                ×
              </button>
            </div>
          );
        },
        onDismiss: () => {
          useHintsStore.getState().decrementActive();
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVersion]);
}

export default useWhatsNew;
