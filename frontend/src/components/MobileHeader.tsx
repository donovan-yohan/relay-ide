import './MobileHeader.css';

export interface MobileHeaderProps {
  title: string;
  onMenuClick: () => void;
  onRightSidebarClick?: () => void;
  onCommandClick: () => void;
  hidden?: boolean;
}

export function MobileHeader({
  title,
  onMenuClick,
  onRightSidebarClick,
  onCommandClick,
  hidden = false,
}: MobileHeaderProps) {
  return (
    <div className={`mobile-header${hidden ? ' hidden' : ''}`}>
      <button className="icon-btn" aria-label="Open sessions menu" onClick={onMenuClick}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" width="18" height="18">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <span className="mobile-title">{title}</span>
      {onRightSidebarClick && (
        <button
          className="right-sidebar-trigger"
          aria-label="Open files sidebar"
          onClick={onRightSidebarClick}
        >
          files
        </button>
      )}
      <button className="command-trigger" aria-label="Open command palette" onClick={onCommandClick}>
        {'> command'}
      </button>
    </div>
  );
}

export default MobileHeader;
