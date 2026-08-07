import './MobileHeader.css';

export interface MobileHeaderProps {
  title: string;
  onMenuClick: () => void;
  onNewChatClick?: () => void;
  onCommandClick: () => void;
  onRightSidebarClick?: () => void;
  hidden?: boolean;
}

export function MobileHeader({
  title,
  onMenuClick,
  onNewChatClick,
  onCommandClick,
  onRightSidebarClick,
  hidden = false,
}: MobileHeaderProps) {
  return (
    <div className={`mobile-header${hidden ? ' hidden' : ''}`}>
      <button
        className="icon-btn"
        aria-label="open chats switcher"
        onClick={onMenuClick}
      >
        chats
      </button>
      <span className="mobile-title">{title}</span>
      <div className="mobile-header-actions">
        {onRightSidebarClick && (
          <button
            className="right-sidebar-btn"
            aria-label="open file sidebar"
            onClick={onRightSidebarClick}
          >
            files
          </button>
        )}
        {onNewChatClick && (
          <button
            className="mobile-new-chat"
            aria-label="new chat"
            onClick={onNewChatClick}
          >
            new
          </button>
        )}
        <button
          className="command-trigger"
          aria-label="open command palette"
          onClick={onCommandClick}
        >
          {'> command'}
        </button>
      </div>
    </div>
  );
}

export default MobileHeader;
