import React from 'react';
import {
  FileTreeSidebar,
  type FileTreeSidebarHandle,
} from './FileTreeSidebar.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailFilesPanelProps {
  workspacePath: string;
  changedFilesData: string[];
  onFileSelect: (filePath: string, isChanged: boolean) => void;
  fileTreeSidebarRef?: React.RefObject<FileTreeSidebarHandle | null>;
}

export function UtilityRailFilesPanel({
  workspacePath,
  changedFilesData,
  onFileSelect,
  fileTreeSidebarRef,
}: UtilityRailFilesPanelProps) {
  return (
    <FileTreeSidebar
      ref={fileTreeSidebarRef}
      workspacePath={workspacePath}
      changedFilesData={changedFilesData}
      onFileSelect={onFileSelect}
    />
  );
}

export default UtilityRailFilesPanel;
