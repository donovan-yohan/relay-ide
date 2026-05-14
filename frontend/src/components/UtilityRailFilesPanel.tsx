import React from 'react';
import { FileTree, type FileTreeHandle } from './FileTree/index.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailFilesPanelProps {
  workspacePath: string;
  stateKey?: string;
  fileTreeSidebarRef?: React.RefObject<FileTreeHandle | null>;
}

export function UtilityRailFilesPanel({
  workspacePath,
  stateKey,
  fileTreeSidebarRef,
}: UtilityRailFilesPanelProps) {
  return (
    <FileTree
      ref={fileTreeSidebarRef}
      workspacePath={workspacePath}
      stateKey={stateKey}
    />
  );
}

export default UtilityRailFilesPanel;
