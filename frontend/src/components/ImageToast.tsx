import React from 'react';
import { sendPtyData } from '../lib/ws.js';
import { addNotification, removeNotification } from '../lib/stores/notifications.js';
import { TuiButton } from './TuiButton';
import './ImageToast.css';

const IMAGE_NOTIFICATION_ID = 'image-toast';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
let autoDismissTimer: number | null = null;

function clearAutoDismissTimer(): void {
  if (autoDismissTimer !== null) {
    window.clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

export function showImageToast(text: string, showInsert: boolean, path?: string): void {
  clearAutoDismissTimer();
  addNotification({
    id: IMAGE_NOTIFICATION_ID,
    type: 'image',
    dismissible: true,
    content: (
      <ImageToastContent text={text} showInsert={showInsert} imagePath={path ?? null} />
    ),
    onDismiss: hideImageToast,
  });

  if (!showInsert) {
    autoDismissTimer = window.setTimeout(hideImageToast, 3000);
  }
}

export function hideImageToast(): void {
  clearAutoDismissTimer();
  removeNotification(IMAGE_NOTIFICATION_ID);
}

interface ImageToastContentProps {
  text: string;
  showInsert: boolean;
  imagePath: string | null;
}

const ImageToastContent: React.FC<ImageToastContentProps> = ({ text, showInsert, imagePath }) => {
  const handleInsert = React.useCallback(() => {
    if (imagePath) {
      sendPtyData(`${BRACKETED_PASTE_START}${imagePath}${BRACKETED_PASTE_END}`);
    }
    hideImageToast();
  }, [imagePath]);

  return (
    <div className="notification-card">
      <span className="notification-card__text image-toast-text">{text}</span>
      <div className="notification-card__actions">
        {showInsert ? (
          <TuiButton variant="primary" size="sm" onClick={handleInsert}>
            Insert
          </TuiButton>
        ) : null}
        <button className="notification-card__dismiss" onClick={hideImageToast} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
};
