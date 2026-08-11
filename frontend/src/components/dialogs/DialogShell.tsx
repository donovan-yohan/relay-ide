import React, {
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react';
import './DialogShell.css';

export interface DialogShellHandle {
  open: () => void;
  close: () => void;
}

interface DialogShellProps {
  variant?: 'fullscreen' | 'compact';
  width?: string;
  title: string;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: (() => void) | undefined;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      width="14"
      height="14"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function useDialogControls(
  dialogRef: React.RefObject<HTMLDialogElement | null>,
  setScrolledBottom: (v: boolean) => void
) {
  const open = useCallback(() => {
    if (!dialogRef.current) return;
    dialogRef.current.showModal();
    requestAnimationFrame(() => {
      if (!dialogRef.current) return;
      // A dialog can be opened while an ancestor is scrolled. Focusing its
      // first control must not ask the browser to scroll every containing box
      // (including the dialog's clipping-only structural layers) in order to
      // reveal it.
      dialogRef.current
        .querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?.focus({ preventScroll: true });
      const body = dialogRef.current.querySelector('.dialog-shell__body');
      if (body) setScrolledBottom(body.scrollHeight <= body.clientHeight);
    });
  }, [dialogRef, setScrolledBottom]);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, [dialogRef]);

  return { open, close };
}

export const DialogShell = forwardRef<DialogShellHandle, DialogShellProps>(
  function DialogShell(
    {
      variant = 'compact',
      width = '460px',
      title,
      children,
      headerExtra,
      footer,
      onClose,
    },
    ref
  ) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const [scrolledBottom, setScrolledBottom] = useState(false);
    const { open, close } = useDialogControls(dialogRef, setScrolledBottom);

    useImperativeHandle(ref, () => ({ open, close }), [open, close]);

    const handleBodyScroll = (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setScrolledBottom(
        el.scrollHeight - el.scrollTop - el.clientHeight < 8 ||
          el.scrollHeight <= el.clientHeight
      );
    };

    const handleDialogClick = (e: React.MouseEvent<HTMLDialogElement>) => {
      if (e.target === dialogRef.current) dialogRef.current?.close();
    };

    const dialogClass = [
      'dialog-shell',
      variant === 'fullscreen' && 'dialog-shell--fullscreen',
      variant === 'compact' && 'dialog-shell--compact',
    ]
      .filter(Boolean)
      .join(' ');
    const bodyClass = [
      'dialog-shell__body',
      scrolledBottom && 'scrolled-bottom',
    ]
      .filter(Boolean)
      .join(' ');
    const dialogStyle =
      variant === 'compact'
        ? ({ '--dialog-width': width } as React.CSSProperties)
        : undefined;

    return (
      <dialog
        ref={dialogRef}
        className={dialogClass}
        style={dialogStyle}
        onClick={handleDialogClick}
        onClose={onClose ? () => onClose() : undefined}
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-shell__content">
          <header className="dialog-shell__header">
            <h2 className="dialog-shell__title">{title}</h2>
            {headerExtra && (
              <div className="dialog-shell__header-extra">{headerExtra}</div>
            )}
            <button
              className="dialog-shell__close"
              onClick={close}
              aria-label="Close"
              type="button"
            >
              <CloseIcon />
            </button>
          </header>
          <div className={bodyClass} onScroll={handleBodyScroll}>
            {children}
          </div>
          {footer && <footer className="dialog-shell__footer">{footer}</footer>}
        </div>
      </dialog>
    );
  }
);

export default DialogShell;
