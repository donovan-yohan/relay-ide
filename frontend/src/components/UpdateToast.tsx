import React from 'react';
import * as api from '../lib/api.js';
import { TuiButton } from './TuiButton';
import {
  addNotification,
  removeNotification,
} from '../lib/stores/notifications.js';

const UPDATE_NOTIFICATION_ID = 'update-toast';

export const UpdateToast: React.FC = () => {
  const didInitRef = React.useRef(false);
  const reloadTimerRef = React.useRef<number | null>(null);

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
                reloadTimerRef={reloadTimerRef}
              />
            ),
            onDismiss: () => removeNotification(UPDATE_NOTIFICATION_ID),
          });
        }
      } catch {
        // expected: no update available or network error
      }
    })();

    return () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, []);

  return null;
};

interface UpdateToastContentProps {
  initialText: string;
  reloadTimerRef: React.RefObject<number | null>;
}

const UpdateToastContent: React.FC<UpdateToastContentProps> = ({
  initialText,
  reloadTimerRef,
}) => {
  const [text, setText] = React.useState(initialText);
  const [buttonText, setButtonText] = React.useState('Update Now');
  const [buttonDisabled, setButtonDisabled] = React.useState(false);
  const [showActions, setShowActions] = React.useState(true);

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
        reloadTimerRef.current = window.setTimeout(() => {
          window.location.reload();
        }, 5000);
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
  }, [reloadTimerRef]);

  const dismiss = React.useCallback(() => {
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
            onClick={triggerUpdate}
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
