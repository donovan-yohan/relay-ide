import React, {
  useRef,
  useState,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react';
import { TuiMenuItem } from './TuiMenuItem.js';
import { TuiMenuPanel } from './TuiMenuPanel.js';
import './ContextMenu.css';

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuHandle {
  openAt: (anchor: HTMLElement) => void;
}

interface ContextMenuProps {
  items: MenuItem[];
  hideTrigger?: boolean;
}

function useMenuPositioning(
  menuRef: React.RefObject<HTMLDivElement | null>,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  anchorRect: DOMRect | null
) {
  const positionMenu = useCallback(() => {
    if (!menuRef.current) return;
    const rect = anchorRect ?? triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuRect = menuRef.current.getBoundingClientRect();

    let top = rect.bottom + 4;
    let left = rect.right - menuRect.width;

    if (top + menuRect.height > window.innerHeight - 8) {
      top = rect.top - menuRect.height - 4;
    }
    if (left < 8) left = 8;

    menuRef.current.style.top = top + 'px';
    menuRef.current.style.left = left + 'px';
  }, [menuRef, triggerRef, anchorRect]);

  return positionMenu;
}

export const ContextMenu = forwardRef<ContextMenuHandle, ContextMenuProps>(
  function ContextMenu({ items, hideTrigger = false }, ref) {
    const [open, setOpen] = useState(false);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const positionMenu = useMenuPositioning(menuRef, triggerRef, anchorRect);

    const close = useCallback(() => {
      setOpen(false);
      setAnchorRect(null);
    }, []);

    const openAt = useCallback((anchor: HTMLElement) => {
      setAnchorRect(anchor.getBoundingClientRect());
      setOpen(true);
    }, []);

    useImperativeHandle(ref, () => ({ openAt }), [openAt]);

    useEffect(() => {
      if (!open) return;
      requestAnimationFrame(positionMenu);
    }, [open, positionMenu]);

    useEffect(() => {
      const handleKeydown = (e: KeyboardEvent) => {
        if (!open || e.key !== 'Escape') return;
        e.stopPropagation();
        close();
      };
      document.addEventListener('keydown', handleKeydown);
      return () => document.removeEventListener('keydown', handleKeydown);
    }, [open, close]);

    const handleToggle = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (open) {
        close();
      } else {
        setOpen(true);
      }
    };

    const handleItemSelect = (item: MenuItem, e: React.MouseEvent) => {
      e.stopPropagation();
      if (item.disabled) return;
      close();
      item.action();
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      close();
    };

    return (
      <>
        {!hideTrigger && (
          <button
            className="context-menu-trigger"
            ref={triggerRef}
            data-track="context-menu.open"
            onClick={handleToggle}
            aria-label="Actions"
            aria-haspopup="true"
            aria-expanded={open}
          >
            &middot;&middot;&middot;
          </button>
        )}

        {open && (
          <>
            <div
              className="context-menu-backdrop"
              onClick={handleBackdropClick}
            />
            <div
              className="context-menu"
              role="menu"
              ref={menuRef}
              onClick={(e) => e.stopPropagation()}
            >
              <TuiMenuPanel>
                {items.map((item, i) => (
                  <TuiMenuItem
                    key={i}
                    danger={item.danger ?? false}
                    disabled={item.disabled ?? false}
                    onClick={(e) => handleItemSelect(item, e)}
                  >
                    {item.label}
                  </TuiMenuItem>
                ))}
              </TuiMenuPanel>
            </div>
          </>
        )}
      </>
    );
  }
);

export default ContextMenu;
