import React from 'react';
import { FileTree, type FileTreeHandle } from './FileTree/index.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailFilesPanelProps {
  workspacePath: string;
  fileTreeSidebarRef?: React.RefObject<FileTreeHandle | null>;
}

export function UtilityRailFilesPanel({
  workspacePath,
  fileTreeSidebarRef,
}: UtilityRailFilesPanelProps) {
  return <FileTree ref={fileTreeSidebarRef} workspacePath={workspacePath} />;
}

export default UtilityRailFilesPanel;
