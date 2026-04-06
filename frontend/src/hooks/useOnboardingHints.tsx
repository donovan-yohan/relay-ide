import { useEffect, useRef } from 'react';
import { useHintsStore } from '../lib/stores/hints.js';
import {
  addNotification,
  removeNotification,
} from '../lib/stores/notifications.js';

// ── Hint IDs ──────────────────────────────────────────────────────────────────

export const HINT_NO_REPOS = 'onboarding-no-repos';
export const HINT_REPO_ADDED_NO_SESSIONS = 'onboarding-repo-added-no-sessions';
export const HINT_FIRST_SESSION_RUNNING = 'onboarding-first-session-running';
export const HINT_REMOTE_ACCESS = 'onboarding-remote-access';
export const HINT_COMMAND_PALETTE = 'onboarding-command-palette';

// ── Toast helper ─────────────────────────────────────────────────────────────
// Fires a hint toast via the notification system with proper decrement guards.

function fireHintToast(hintId: string, text: string): void {
  // Increment active count without updating lastShownAt so we don't trigger
  // the MIN_GAP_MS throttle that blocks other hint components.
  useHintsStore.setState((s) => ({ activeHintCount: s.activeHintCount + 1 }));

  const notifId = `hint-notif-${hintId}`;
  let decremented = false;
  const safeDecrement = () => {
    if (decremented) return;
    decremented = true;
    useHintsStore.getState().decrementActive();
  };

  addNotification({
    id: notifId,
    type: 'info',
    dismissible: true,
    content: () => (
      <div className="notification-card hint-toast">
        <span className="notification-card__text hint-toast__text">{text}</span>
        <button
          className="notification-card__dismiss"
          aria-label="dismiss hint"
          onClick={() => {
            useHintsStore.getState().markSeen(hintId);
            safeDecrement();
            removeNotification(notifId);
          }}
        >
          ×
        </button>
      </div>
    ),
    onDismiss: () => {
      useHintsStore.getState().markSeen(hintId);
      safeDecrement();
    },
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface OnboardingHintsOptions {
  hasRepos: boolean;
  hasActiveSessions: boolean;
  sessionJustStarted: boolean;
  commandPaletteJustOpened: boolean;
}

export function useOnboardingHints({
  hasRepos,
  hasActiveSessions,
  sessionJustStarted,
  commandPaletteJustOpened,
}: OnboardingHintsOptions) {
  const isHintSeen = useHintsStore((s) => s.isHintSeen);
  const markSeen = useHintsStore((s) => s.markSeen);

  const sessionToastFiredRef = useRef(false);
  const remoteToastFiredRef = useRef(false);

  // Step 3: session just started — fire two toasts (main + remote access)
  useEffect(() => {
    if (!sessionJustStarted) return;
    if (sessionToastFiredRef.current) return;
    if (isHintSeen(HINT_FIRST_SESSION_RUNNING)) return;

    let remoteTimerId: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      sessionToastFiredRef.current = true;
      fireHintToast(
        HINT_FIRST_SESSION_RUNNING,
        'session is live. try cmd+k for the command palette, or [+] in the tab bar.'
      );

      // Queue remote access toast after another gap
      if (!isHintSeen(HINT_REMOTE_ACCESS)) {
        remoteTimerId = setTimeout(() => {
          if (remoteToastFiredRef.current) return;
          remoteToastFiredRef.current = true;
          fireHintToast(
            HINT_REMOTE_ACCESS,
            'relay-ide is accessible from any device — see settings > advanced for the remote access url.'
          );
        }, 12_000);
      }
    }, 2_000);

    return () => {
      clearTimeout(timer);
      if (remoteTimerId !== null) clearTimeout(remoteTimerId);
    };
  }, [sessionJustStarted, isHintSeen]);

  // Step 4: command palette first open
  useEffect(() => {
    if (!commandPaletteJustOpened) return;
    if (isHintSeen(HINT_COMMAND_PALETTE)) return;
    markSeen(HINT_COMMAND_PALETTE);
  }, [commandPaletteJustOpened, isHintSeen, markSeen]);

  return {
    showNoReposHint: !hasRepos && !isHintSeen(HINT_NO_REPOS),
    showRepoAddedHint:
      hasRepos &&
      !hasActiveSessions &&
      !isHintSeen(HINT_REPO_ADDED_NO_SESSIONS),
    showCommandPaletteHint:
      commandPaletteJustOpened && !isHintSeen(HINT_COMMAND_PALETTE),
  };
}

export default useOnboardingHints;
