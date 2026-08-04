import React from 'react';
import * as api from '../lib/api.js';
import { TuiButton } from './TuiButton';
import {
  addNotification,
  removeNotification,
} from '../lib/stores/notifications.js';
import { reloadWhenServerReturns } from '../lib/server-restart.js';

const UPDATE_NOTIFICATION_ID = 'update-toast';

export const UpdateToast: React.FC = () => {
  const didInitRef = React.useRef(false);

  React.useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    void (async () => {
      try {
        const data = await api.checkVersion();
        if (data.updateAvailable) {
          addNotification({
            id: UPDATE_NOTIFICATION_ID,
            type: 'update',
            dismissible: true,
            content: (
              <UpdateToastContent
                initialText={`Update available: v${data.current} → v${data.latest}`}
              />
            ),
            onDismiss: () => removeNotification(UPDATE_NOTIFICATION_ID),
          });
        }
      } catch {
        // expected: no update available or network error
      }
    })();
  }, []);

  return null;
};

interface UpdateToastContentProps {
  initialText: string;
}

const UpdateToastContent: React.FC<UpdateToastContentProps> = ({
  initialText,
}) => {
  const [text, setText] = React.useState(initialText);
  const [buttonText, setButtonText] = React.useState('Update Now');
  const [buttonDisabled, setButtonDisabled] = React.useState(false);
  const [showActions, setShowActions] = React.useState(true);
  const [timedOut, setTimedOut] = React.useState(false);
  // The restart wait outlives a click by up to 90s. Dismissing the toast or
  // unmounting must stop it, or it reloads the page out from under whatever
  // the user did next and writes state into a dead tree.
  const waitAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => waitAbortRef.current?.abort(), []);

  const triggerUpdate = React.useCallback(async () => {
    setButtonDisabled(true);
    setButtonText('Updating…');

    try {
      const result = await api.triggerUpdate();
      if (result.verified === false) {
        setText(api.UPDATE_NO_CHANGE_TEXT);
        setShowActions(false);
        return;
      }
      const updated = result.version
        ? `Updated to v${result.version}!`
        : 'Updated!';
      if (result.restarting) {
        setText(`${updated} Restarting server…`);
        setShowActions(false);
        // Reload when the *new* server answers, not on a guessed timer —
        // restart time varies with host and supervisor, and the outgoing
        // process keeps answering for a moment after this response.
        const controller = new AbortController();
        waitAbortRef.current = controller;
        await reloadWhenServerReturns(
          (timeoutText) => {
            setText(timeoutText);
            // Dead copy with no affordance is a trap: give the reload back.
            setTimedOut(true);
            setButtonText('Reload');
            setButtonDisabled(false);
            setShowActions(true);
          },
          { previousBootId: result.bootId ?? null, signal: controller.signal }
        );
      } else {
        setText(`${updated} Please restart the server manually.`);
        setShowActions(false);
      }
    } catch (err) {
      setText(api.updateFailureText(err));
      setButtonDisabled(false);
      setButtonText('Retry');
      setShowActions(true);
    }
  }, []);

  const onPrimaryClick = React.useCallback(() => {
    if (timedOut) {
      window.location.reload();
      return;
    }
    void triggerUpdate();
  }, [timedOut, triggerUpdate]);

  const dismiss = React.useCallback(() => {
    waitAbortRef.current?.abort();
    removeNotification(UPDATE_NOTIFICATION_ID);
  }, []);

  return (
    <div className="notification-card">
      <span className="notification-card__text">{text}</span>
      {showActions ? (
        <div className="notification-card__actions">
          <TuiButton
            variant="primary"
            size="sm"
            onClick={onPrimaryClick}
            disabled={buttonDisabled}
          >
            {buttonText}
          </TuiButton>
          <button
            className="notification-card__dismiss"
            onClick={dismiss}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default UpdateToast;
