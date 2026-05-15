import React from 'react';
import { FileTree, type FileTreeHandle } from './FileTree/index.js';
import type { UtilityRailDisabledReason } from '../lib/utility-rail-context.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailFilesPanelProps {
  workspacePath: string;
  stateKey?: string;
  gitWorkspacePath?: string;
  gitDisabledReason?: UtilityRailDisabledReason | null;
  fileTreeSidebarRef?: React.RefObject<FileTreeHandle | null>;
}

export function UtilityRailFilesPanel({
  workspacePath,
  stateKey,
  gitWorkspacePath,
  gitDisabledReason,
  fileTreeSidebarRef,
}: UtilityRailFilesPanelProps) {
  const stateKeyProps = stateKey === undefined ? {} : { stateKey };
  const gitWorkspacePathProps =
    gitWorkspacePath === undefined ? {} : { gitWorkspacePath };
  const gitDisabledReasonProps =
    gitDisabledReason === undefined ? {} : { gitDisabledReason };

  return (
    <FileTree
      ref={fileTreeSidebarRef}
      workspacePath={workspacePath}
      {...gitWorkspacePathProps}
      {...gitDisabledReasonProps}
      {...stateKeyProps}
    />
  );
}

export default UtilityRailFilesPanel;
