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
        ☰
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
