import React, { useEffect } from 'react';
import { useUiStore } from '../lib/stores/ui.js';
import UtilityRailReviewPanel from './UtilityRailReviewPanel.js';
import './FullPageDiff.css';

export interface FullPageDiffProps {
  workspacePath: string;
  initialFile?: string;
  initialBase?: string;
  onClose: () => void;
}

/**
 * Compatibility entry point for older diff deep links.
 * The real review state now lives in the workspace utility rail store and the
 * body reuses UtilityRailReviewPanel so there is only one review model.
 */
export function FullPageDiff({
  workspacePath,
  initialFile,
  initialBase,
  onClose,
}: FullPageDiffProps) {
  useEffect(() => {
    useUiStore.getState().openReviewWorkspace(workspacePath, {
      ...(initialFile ? { filePath: initialFile } : {}),
      ...(initialBase !== undefined ? { base: initialBase } : {}),
    });
  }, [initialBase, initialFile, workspacePath]);

  const reviewState = useUiStore(
    (s) => s.utilityRailByWorkspace[workspacePath]?.review
  );
  const title = reviewState?.activeFilePath ?? 'review workspace';

  return (
    <div className="full-page-diff full-page-diff--compat">
      <div className="fpd-header">
        <button className="fpd-close-btn" onClick={onClose} aria-label="close diff view">
          [x] close
        </button>
        <span className="fpd-title">{title}</span>
        <span className="fpd-summary">utility rail review workspace</span>
      </div>
      <div className="fpd-body">
        <div className="fpd-main fpd-main--review">
          <UtilityRailReviewPanel
            workspacePath={workspacePath}
            reviewState={reviewState}
            onRequestClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}

export default FullPageDiff;
