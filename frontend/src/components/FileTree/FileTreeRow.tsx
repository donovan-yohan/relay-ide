import React, { memo } from 'react';
import type { FileTreeNode } from '../../lib/file-tree-utils.js';
import { fileIconForName, folderIcon, GIT_CLASS, GIT_LETTER } from './icons.js';

export interface FileTreeRowProps {
  node: FileTreeNode;
  depth: number;
  selected: boolean;
  focused: boolean;
  staged?: boolean;
  onClick: (node: FileTreeNode) => void;
  style?: React.CSSProperties;
}

function FileTreeRowImpl({
  node,
  depth,
  selected,
  focused,
  staged,
  onClick,
  style,
}: FileTreeRowProps) {
  const icon = node.isDirectory
    ? folderIcon(node.expanded)
    : fileIconForName(node.name);
  const gitLetter = node.status ? GIT_LETTER[node.status] : '';
  const gitCls = node.status ? GIT_CLASS[node.status] : '';
  const stateAttr = node.status === 'deleted' ? 'deleted' : undefined;

  return (
    <button
      type="button"
      className={['fb-node', selected && 'selected', focused && 'focused']
        .filter(Boolean)
        .join(' ')}
      data-d={Math.min(depth, 5)}
      data-staged={staged ? 'true' : undefined}
      data-state={stateAttr}
      onClick={() => onClick(node)}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={node.isDirectory ? node.expanded : undefined}
      title={node.path || node.name}
      style={style}
    >
      <span
        className={['chev', !node.isDirectory && 'empty']
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
      >
        {node.isDirectory ? (node.expanded ? '▾' : '▸') : ''}
      </span>
      <span className={`icon ${icon.className}`} aria-hidden="true">
        {icon.glyph}
      </span>
      <span className={`git ${gitCls}`} aria-hidden="true">
        {gitLetter}
      </span>
      <span className="fb-node__name">
        {node.name}
        {(node.additions > 0 || node.deletions > 0) && !node.isDirectory && (
          <span className="stats">
            {node.additions > 0 && (
              <span className="add">+{node.additions}</span>
            )}
            {node.additions > 0 && node.deletions > 0 ? ' ' : ''}
            {node.deletions > 0 && (
              <span className="del">−{node.deletions}</span>
            )}
          </span>
        )}
      </span>
      {node.isDirectory && node.fileCount > 0 ? (
        <span className="fb-node__count">{node.fileCount}</span>
      ) : null}
    </button>
  );
}

export const FileTreeRow = memo(FileTreeRowImpl);
