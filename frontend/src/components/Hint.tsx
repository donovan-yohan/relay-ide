import React, { useEffect, useRef } from 'react';
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
  // Track whether this instance has already decremented to avoid double-decrement
  const decrementedRef = useRef(false);

  useEffect(() => {
    if (isHintSeen(id) || !canShowHint()) return;

    incrementActive();

    const safeDecrement = () => {
      if (!decrementedRef.current) {
        decrementedRef.current = true;
        decrementActive();
      }
    };

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
              safeDecrement();
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
        safeDecrement();
        onDismiss?.();
      },
    });

    return () => {
      // If the component unmounts without explicit dismiss, clean up
      removeNotification(notifId);
      safeDecrement();
    };
  }, [id, isHintSeen, canShowHint, incrementActive, decrementActive, markSeen, onDismiss]);

  return null;
}

// ── Border variant ────────────────────────────────────────────────────────────

function HintBorder({ id, children, onDismiss }: Omit<HintProps, 'variant'>) {
  const markSeen = useHintsStore((s) => s.markSeen);
  const isHintSeen = useHintsStore((s) => s.isHintSeen);
  const canShowHint = useHintsStore((s) => s.canShowHint);
  const incrementActive = useHintsStore((s) => s.incrementActive);
  const decrementActive = useHintsStore((s) => s.decrementActive);
  // Track whether incrementActive was called so we only decrement if we incremented
  const incrementedRef = useRef(false);

  useEffect(() => {
    if (!isHintSeen(id) && canShowHint()) {
      incrementedRef.current = true;
      incrementActive();
    }
    return () => {
      if (incrementedRef.current) {
        incrementedRef.current = false;
        decrementActive();
      }
    };
  }, [id, isHintSeen, canShowHint, incrementActive, decrementActive]);

  if (isHintSeen(id)) return null;
  // Don't render if the throttle prevented incrementing (hint was not shown)
  if (!incrementedRef.current) return null;

  function handleDismiss() {
    markSeen(id);
    if (incrementedRef.current) {
      incrementedRef.current = false;
      decrementActive();
    }
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
  const props = { id, children, ...(onDismiss ? { onDismiss } : {}) };
  if (variant === 'toast') return <HintToast {...props} />;
  if (variant === 'border') return <HintBorder {...props} />;
  return <HintInlineText {...props} />;
}

export default Hint;
