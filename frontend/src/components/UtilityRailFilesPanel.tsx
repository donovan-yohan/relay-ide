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
  nodeId?: string | null;
  sessionId?: string | null;
  root?: string | null;
}

export function UtilityRailFilesPanel({
  workspacePath,
  stateKey,
  gitWorkspacePath,
  gitDisabledReason,
  fileTreeSidebarRef,
  nodeId,
  sessionId,
  root,
}: UtilityRailFilesPanelProps) {
  const stateKeyProps = stateKey === undefined ? {} : { stateKey };
  const gitWorkspacePathProps =
    gitWorkspacePath === undefined ? {} : { gitWorkspacePath };
  const gitDisabledReasonProps =
    gitDisabledReason === undefined ? {} : { gitDisabledReason };
  const nodeIdProps = nodeId === undefined ? {} : { nodeId };
  const sessionIdProps = sessionId === undefined ? {} : { sessionId };
  const rootProps = root === undefined ? {} : { root };

  return (
    <FileTree
      ref={fileTreeSidebarRef}
      workspacePath={workspacePath}
      {...gitWorkspacePathProps}
      {...gitDisabledReasonProps}
      {...stateKeyProps}
      {...nodeIdProps}
      {...sessionIdProps}
      {...rootProps}
    />
  );
}

export default UtilityRailFilesPanel;
