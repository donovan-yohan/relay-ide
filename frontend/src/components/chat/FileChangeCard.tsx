import React from 'react';
import './FileChangeCard.css';
import type { FileChangeEvent } from '../../../../server/chat-events.js';

interface FileChangeCardProps {
  event: FileChangeEvent;
}

export const FileChangeCard: React.FC<FileChangeCardProps> = ({ event }) => {
  const displayPath =
    event.kind === 'renamed' && event.oldPath
      ? `${event.oldPath} -> ${event.path}`
      : event.path;

  return (
    <div className="file-change-card">
      <span className="file-change-card__path">{displayPath}</span>
      <span className="file-change-card__stats">
        {event.additions > 0 && (
          <span className="file-change-card__additions">
            +{event.additions}
          </span>
        )}
        {event.deletions > 0 && (
          <span className="file-change-card__deletions">
            -{event.deletions}
          </span>
        )}
      </span>
      <span className="file-change-card__kind">{event.kind}</span>
    </div>
  );
};

export default FileChangeCard;
