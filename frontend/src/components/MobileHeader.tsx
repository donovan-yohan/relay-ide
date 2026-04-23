import './MobileHeader.css';

export interface MobileHeaderProps {
  title: string;
  onMenuClick: () => void;
  onCommandClick: () => void;
  onRightSidebarClick?: () => void;
  hidden?: boolean;
}

export function MobileHeader({
  title,
  onMenuClick,
  onCommandClick,
  onRightSidebarClick,
  hidden = false,
}: MobileHeaderProps) {
  return (
    <div className={`mobile-header${hidden ? ' hidden' : ''}`}>
      <button className="icon-btn" aria-label="Open sessions menu" onClick={onMenuClick}>
        ☰
      </button>
      <span className="mobile-title">{title}</span>
      <div className="mobile-header-actions">
        {onRightSidebarClick && (
          <button
            className="right-sidebar-btn"
            aria-label="Open file sidebar"
            onClick={onRightSidebarClick}
          >
            files
          </button>
        )}
        <button className="command-trigger" aria-label="Open command palette" onClick={onCommandClick}>
          {'> command'}
        </button>
      </div>
    </div>
  );
}

export default MobileHeader;
