import React from 'react';
import * as api from '../lib/api.js';
import { TuiButton } from './TuiButton';
import './UpdateToast.css';

export const UpdateToast: React.FC = () => {
  const [visible, setVisible] = React.useState(false);
  const [text, setText] = React.useState('');
  const [buttonText, setButtonText] = React.useState('Update Now');
  const [buttonDisabled, setButtonDisabled] = React.useState(false);
  const [showActions, setShowActions] = React.useState(true);
  const didInitRef = React.useRef(false);
  const reloadTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    void (async () => {
      try {
        const data = await api.checkVersion();
        if (data.updateAvailable) {
          setText(`Update available: v${data.current} → v${data.latest}`);
          setButtonText('Update Now');
          setButtonDisabled(false);
          setShowActions(true);
          setVisible(true);
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
  }, []);

  const dismiss = React.useCallback(() => {
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div className="update-toast">
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
    </div>
  );
};

export default UpdateToast;
