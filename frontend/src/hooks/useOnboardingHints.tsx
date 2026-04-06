import { useEffect, useRef } from 'react';
import { useHintsStore } from '../lib/stores/hints.js';
import { addNotification, removeNotification } from '../lib/stores/notifications.js';

// ── Hint IDs ──────────────────────────────────────────────────────────────────

export const HINT_NO_REPOS = 'onboarding-no-repos';
export const HINT_REPO_ADDED_NO_SESSIONS = 'onboarding-repo-added-no-sessions';
export const HINT_FIRST_SESSION_RUNNING = 'onboarding-first-session-running';
export const HINT_REMOTE_ACCESS = 'onboarding-remote-access';
export const HINT_COMMAND_PALETTE = 'onboarding-command-palette';

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
  const { isHintSeen, markSeen, canShowHint, incrementActive, decrementActive } =
    useHintsStore.getState();

  const sessionToastFiredRef = useRef(false);
  const remoteToastFiredRef = useRef(false);

  // Step 3: session just started — fire two toasts (main + remote access)
  useEffect(() => {
    if (!sessionJustStarted) return;
    if (sessionToastFiredRef.current) return;
    if (isHintSeen(HINT_FIRST_SESSION_RUNNING)) return;

    // Store the remote timer ID so we can clear it on unmount
    let remoteTimerId: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      // Bypass canShowHint() for onboarding toasts — the throttle is meant for
      // visual border hints, not toasts that go through the notification system.
      sessionToastFiredRef.current = true;
      incrementActive();

      const notifId = `hint-notif-${HINT_FIRST_SESSION_RUNNING}`;
      addNotification({
        id: notifId,
        type: 'info',
        dismissible: true,
        content: () => {
          const { markSeen: ms, decrementActive: da } = useHintsStore.getState();
          return (
            <div className="notification-card hint-toast">
              <span className="notification-card__text hint-toast__text">
                session is live. try cmd+k for the command palette, or [+] in the tab bar.
              </span>
              <button
                className="notification-card__dismiss"
                aria-label="dismiss hint"
                onClick={() => {
                  ms(HINT_FIRST_SESSION_RUNNING);
                  da();
                  removeNotification(notifId);
                }}
              >
                ×
              </button>
            </div>
          );
        },
        onDismiss: () => {
          markSeen(HINT_FIRST_SESSION_RUNNING);
          decrementActive();
        },
      });

      // Queue remote access toast after another gap
      if (!isHintSeen(HINT_REMOTE_ACCESS)) {
        remoteTimerId = setTimeout(() => {
          if (remoteToastFiredRef.current) return;
          remoteToastFiredRef.current = true;
          incrementActive();
          const remoteNotifId = `hint-notif-${HINT_REMOTE_ACCESS}`;
          addNotification({
            id: remoteNotifId,
            type: 'info',
            dismissible: true,
            content: () => {
              const { markSeen: ms2, decrementActive: da2 } = useHintsStore.getState();
              return (
                <div className="notification-card hint-toast">
                  <span className="notification-card__text hint-toast__text">
                    relay-ide is accessible from any device — see settings &gt; advanced for the remote access url.
                  </span>
                  <button
                    className="notification-card__dismiss"
                    aria-label="dismiss hint"
                    onClick={() => {
                      ms2(HINT_REMOTE_ACCESS);
                      da2();
                      removeNotification(remoteNotifId);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            },
            onDismiss: () => {
              markSeen(HINT_REMOTE_ACCESS);
              decrementActive();
            },
          });
        }, 12_000);
      }
    }, 2_000);

    return () => {
      clearTimeout(timer);
      if (remoteTimerId !== null) clearTimeout(remoteTimerId);
    };
  }, [sessionJustStarted, isHintSeen, markSeen, canShowHint, incrementActive, decrementActive]);

  // Step 4: command palette first open
  useEffect(() => {
    if (!commandPaletteJustOpened) return;
    if (isHintSeen(HINT_COMMAND_PALETTE)) return;
    markSeen(HINT_COMMAND_PALETTE);
    // The inline hint in CommandPalette is handled by the Hint component directly
  }, [commandPaletteJustOpened, isHintSeen, markSeen]);

  return {
    showNoReposHint: !hasRepos && !isHintSeen(HINT_NO_REPOS),
    showRepoAddedHint:
      hasRepos && !hasActiveSessions && !isHintSeen(HINT_REPO_ADDED_NO_SESSIONS),
    showCommandPaletteHint:
      commandPaletteJustOpened && !isHintSeen(HINT_COMMAND_PALETTE),
  };
}

export default useOnboardingHints;
