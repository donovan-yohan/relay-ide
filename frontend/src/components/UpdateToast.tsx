import React from 'react';
import * as api from '../lib/api.js';
import { TuiButton } from './TuiButton';
import { addNotification, removeNotification } from '../lib/stores/notifications.js';
import './UpdateToast.css';

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
          showUpdateNotification(
            `Update available: v${data.current} → v${data.latest}`,
            'Update Now',
            false,
            reloadTimerRef
          );
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

function showUpdateNotification(
  text: string,
  buttonText: string,
  buttonDisabled: boolean,
  reloadTimerRef: React.RefObject<number | null>
): void {
  addNotification({
    id: UPDATE_NOTIFICATION_ID,
    type: 'update',
    dismissible: true,
    content: (
      <UpdateToastContent
        initialText={text}
        initialButtonText={buttonText}
        initialButtonDisabled={buttonDisabled}
        reloadTimerRef={reloadTimerRef}
      />
    ),
    onDismiss: () => removeNotification(UPDATE_NOTIFICATION_ID),
  });
}

interface UpdateToastContentProps {
  initialText: string;
  initialButtonText: string;
  initialButtonDisabled: boolean;
  reloadTimerRef: React.RefObject<number | null>;
}

const UpdateToastContent: React.FC<UpdateToastContentProps> = ({
  initialText,
  initialButtonText,
  initialButtonDisabled,
  reloadTimerRef,
}) => {
  const [text, setText] = React.useState(initialText);
  const [buttonText, setButtonText] = React.useState(initialButtonText);
  const [buttonDisabled, setButtonDisabled] = React.useState(initialButtonDisabled);
  const [showActions, setShowActions] = React.useState(true);

  const triggerUpdate = React.useCallback(async () => {
    setButtonDisabled(true);
    setButtonText('Updating…');

    try {
      const result = await api.triggerUpdate();
      if (result.restarting) {
        setText('Updated! Restarting server…');
        setShowActions(false);
        reloadTimerRef.current = window.setTimeout(() => {
          window.location.reload();
        }, 5000);
      } else {
        setText('Updated! Please restart the server manually.');
        setShowActions(false);
      }
    } catch {
      setText('Update failed. Please try again.');
      setButtonDisabled(false);
      setButtonText('Retry');
      setShowActions(true);
    }
  }, [reloadTimerRef]);

  const dismiss = React.useCallback(() => {
    removeNotification(UPDATE_NOTIFICATION_ID);
  }, []);

  return (
    <div className="update-toast-content">
      <span className="update-toast-text">{text}</span>
      {showActions ? (
        <div className="update-toast-actions">
          <TuiButton
            variant="primary"
            size="sm"
            onClick={triggerUpdate}
            disabled={buttonDisabled}
          >
            {buttonText}
          </TuiButton>
          <button className="update-toast-dismiss" onClick={dismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default UpdateToast;
