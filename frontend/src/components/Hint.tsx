import React, { useEffect } from 'react';
import { useHintsStore } from '../lib/stores/hints.js';
import { addNotification, removeNotification } from '../lib/stores/notifications.js';
import './Hint.css';

export type HintVariant = 'border' | 'toast' | 'inline-text';

export interface HintProps {
  id: string;
  variant: HintVariant;
  children: React.ReactNode;
  onDismiss?: () => void;
}

// ── Toast variant ─────────────────────────────────────────────────────────────

function HintToast({ id, children, onDismiss }: Omit<HintProps, 'variant'>) {
  const markSeen = useHintsStore((s) => s.markSeen);
  const isHintSeen = useHintsStore((s) => s.isHintSeen);
  const canShowHint = useHintsStore((s) => s.canShowHint);
  const incrementActive = useHintsStore((s) => s.incrementActive);
  const decrementActive = useHintsStore((s) => s.decrementActive);

  useEffect(() => {
    if (isHintSeen(id) || !canShowHint()) return;

    incrementActive();

    const notifId = `hint-toast-${id}`;
    addNotification({
      id: notifId,
      type: 'info',
      dismissible: true,
      content: () => (
        <div className="notification-card hint-toast">
          <span className="notification-card__text hint-toast__text">
            {children}
          </span>
          <button
            className="notification-card__dismiss hint-toast__dismiss"
            aria-label="dismiss hint"
            onClick={() => {
              markSeen(id);
              decrementActive();
              removeNotification(notifId);
              onDismiss?.();
            }}
          >
            ×
          </button>
        </div>
      ),
      onDismiss: () => {
        markSeen(id);
        decrementActive();
        onDismiss?.();
      },
    });

    return () => {
      // If the component unmounts without explicit dismiss, clean up
      removeNotification(notifId);
      decrementActive();
    };
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return null;
}

// ── Border variant ────────────────────────────────────────────────────────────

function HintBorder({ id, children, onDismiss }: Omit<HintProps, 'variant'>) {
  const markSeen = useHintsStore((s) => s.markSeen);
  const isHintSeen = useHintsStore((s) => s.isHintSeen);
  const canShowHint = useHintsStore((s) => s.canShowHint);
  const incrementActive = useHintsStore((s) => s.incrementActive);
  const decrementActive = useHintsStore((s) => s.decrementActive);

  useEffect(() => {
    if (!isHintSeen(id) && canShowHint()) {
      incrementActive();
    }
    return () => {
      if (!isHintSeen(id)) {
        decrementActive();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (isHintSeen(id)) return null;
  if (!canShowHint() && !isHintSeen(id)) {
    // Still render if already incremented (canShowHint changes after increment)
    // So we only gate on initial render before increment
  }

  function handleDismiss() {
    markSeen(id);
    decrementActive();
    onDismiss?.();
  }

  return (
    <div className="hint-border" role="status" aria-live="polite">
      <div className="hint-border__content">{children}</div>
      <button
        className="hint-border__dismiss"
        aria-label="dismiss hint"
        onClick={handleDismiss}
      >
        ×
      </button>
    </div>
  );
}

// ── Inline-text variant ───────────────────────────────────────────────────────

function HintInlineText({ id, children, onDismiss }: Omit<HintProps, 'variant'>) {
  const markSeen = useHintsStore((s) => s.markSeen);
  const isHintSeen = useHintsStore((s) => s.isHintSeen);

  if (isHintSeen(id)) return null;

  function handleDismiss() {
    markSeen(id);
    onDismiss?.();
  }

  return (
    <span className="hint-inline-text" role="status" aria-live="polite">
      <span className="hint-inline-text__content">{children}</span>
      <button
        className="hint-inline-text__dismiss"
        aria-label="dismiss hint"
        onClick={handleDismiss}
      >
        ×
      </button>
    </span>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function Hint({ id, variant, children, onDismiss }: HintProps) {
  if (variant === 'toast') {
    return <HintToast id={id} onDismiss={onDismiss}>{children}</HintToast>;
  }
  if (variant === 'border') {
    return <HintBorder id={id} onDismiss={onDismiss}>{children}</HintBorder>;
  }
  return <HintInlineText id={id} onDismiss={onDismiss}>{children}</HintInlineText>;
}

export default Hint;
