import React from 'react';
import { sendPtyData } from '../lib/ws.js';
import { TuiButton } from './TuiButton';
import './ImageToast.css';

export interface ImageToastHandle {
  show(toastText: string, withInsert: boolean, imagePath?: string): void;
  hide(): void;
  autoDismiss(ms: number): void;
}

export const ImageToast = React.forwardRef<ImageToastHandle>(function ImageToast(_, ref) {
  const [visible, setVisible] = React.useState(false);
  const [text, setText] = React.useState('');
  const [showInsert, setShowInsert] = React.useState(false);
  const pendingImagePathRef = React.useRef<string | null>(null);
  const autoDismissTimerRef = React.useRef<number | null>(null);

  const clearAutoDismissTimer = React.useCallback(() => {
    if (autoDismissTimerRef.current !== null) {
      window.clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }
  }, []);

  const hide = React.useCallback(() => {
    setVisible(false);
    pendingImagePathRef.current = null;
    clearAutoDismissTimer();
  }, [clearAutoDismissTimer]);

  const show = React.useCallback(
    (toastText: string, withInsert: boolean, imagePath?: string) => {
      clearAutoDismissTimer();
      setText(toastText);
      setShowInsert(withInsert);
      pendingImagePathRef.current = imagePath ?? null;
      setVisible(true);
    },
    [clearAutoDismissTimer]
  );

  const autoDismiss = React.useCallback(
    (ms: number) => {
      clearAutoDismissTimer();
      autoDismissTimerRef.current = window.setTimeout(() => {
        if (!pendingImagePathRef.current) {
          hide();
        }
      }, ms);
    },
    [clearAutoDismissTimer, hide]
  );

  React.useImperativeHandle(
    ref,
    () => ({
      show,
      hide,
      autoDismiss,
    }),
    [autoDismiss, hide, show]
  );

  React.useEffect(() => () => clearAutoDismissTimer(), [clearAutoDismissTimer]);

  const handleInsert = React.useCallback(() => {
    if (pendingImagePathRef.current) {
      sendPtyData(pendingImagePathRef.current);
    }
    hide();
  }, [hide]);

  if (!visible) return null;

  return (
    <div className="image-toast">
      <div className="image-toast-content">
        <span className="image-toast-text">{text}</span>
        <div className="image-toast-actions">
          {showInsert ? (
            <TuiButton variant="primary" size="sm" onClick={handleInsert}>
              Insert
            </TuiButton>
          ) : null}
          <button className="image-toast-dismiss" onClick={hide} aria-label="Dismiss">
            ×
          </button>
        </div>
      </div>
    </div>
  );
});

export default ImageToast;
