import React from 'react';
import type { WorkspaceEvidenceEntry } from '../../../shared/workspace-evidence.js';
import { fileIconForName, folderIcon } from './FileTree/icons.js';
import './AllFilesTree.css';

export interface AllFilesTreeProps {
  entries: WorkspaceEvidenceEntry[];
  childrenByPath: Map<string, WorkspaceEvidenceEntry[]>;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  onFileClick: (path: string) => void;
  onDirToggle: (path: string) => void;
}

function renderNodes(
  entries: WorkspaceEvidenceEntry[],
  depth: number,
  props: AllFilesTreeProps
): React.ReactNode {
  const {
    childrenByPath,
    expandedPaths,
    selectedPath,
    onFileClick,
    onDirToggle,
  } = props;
  return entries.map((entry) => {
    const isDirectory = entry.type === 'directory';
    const expanded = expandedPaths.has(entry.path);
    const icon = isDirectory
      ? folderIcon(expanded)
      : fileIconForName(entry.name);
    return (
      <React.Fragment key={entry.path}>
        <button
          type="button"
          className="fb-node fb-node--browse"
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDirectory ? expanded : undefined}
          aria-selected={!isDirectory && selectedPath === entry.path}
          data-d={Math.min(depth, 5)}
          onClick={() =>
            isDirectory ? onDirToggle(entry.path) : onFileClick(entry.path)
          }
          title={entry.path}
        >
          <span
            className={['chev', !isDirectory && 'empty']
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            {isDirectory ? (expanded ? '▾' : '▸') : ''}
          </span>
          <span className={`icon ${icon.className}`} aria-hidden="true">
            {icon.glyph}
          </span>
          <span className="fb-node__name">{entry.name}</span>
        </button>
        {isDirectory && expanded && childrenByPath.has(entry.path)
          ? renderNodes(childrenByPath.get(entry.path) ?? [], depth + 1, props)
          : null}
      </React.Fragment>
    );
  });
}

export function AllFilesTree(props: AllFilesTreeProps) {
  if (props.entries.length === 0) {
    return <div className="fb__empty">empty directory</div>;
  }
  return (
    <div className="aft" role="tree">
      {renderNodes(props.entries, 0, props)}
    </div>
  );
}

export default AllFilesTree;
