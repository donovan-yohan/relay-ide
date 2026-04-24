import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChangedFile } from '../lib/types.js';
import {
  fetchChangedFiles,
  fetchDefaultBranch,
  fetchFileDiff,
} from '../lib/api.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import { generateFileSummary } from '../lib/diff-summary.js';
import { useUiStore } from '../lib/stores/ui.js';
import DiffSourceToggle from './DiffSourceToggle.js';
import DiffViewer from './DiffViewer.js';
import { DiffFileSidebar } from './DiffFileSidebar.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailReviewPanelProps {
  workspacePath: string;
  reviewFilePath?: string | undefined;
}

export function UtilityRailReviewPanel({
  workspacePath,
  reviewFilePath,
}: UtilityRailReviewPanelProps) {
  const fileDiffSource = useUiStore((s) => s.fileDiffSource);
  const fileDiffViewMode = useUiStore((s) => s.fileDiffViewMode);
  const setFileDiffSource = useUiStore((s) => s.setFileDiffSource);
  const setFileDiffViewMode = useUiStore((s) => s.setFileDiffViewMode);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(
    reviewFilePath ?? null
  );
  const [fileDiff, setFileDiff] = useState('');
  const [summary, setSummary] = useState('');
  const filesRef = useRef<ChangedFile[]>([]);

  const base = useMemo(
    () => diffSourceToBase(fileDiffSource, defaultBranch) ?? '',
    [fileDiffSource, defaultBranch]
  );

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    setActiveFilePath(reviewFilePath ?? null);
  }, [reviewFilePath, workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    setLoading(true);
    fetchChangedFiles(workspacePath, base)
      .then((data) => {
        if (cancelled) return;
        setFiles(data.files);
        setActiveFilePath((prev) => {
          if (prev && data.files.some((file) => file.path === prev))
            return prev;
          return data.files[0]?.path ?? null;
        });
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, base]);

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    setDefaultBranch('main');
    fetchDefaultBranch(workspacePath)
      .then((branch) => {
        if (!cancelled) setDefaultBranch(branch);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath || !activeFilePath) {
      setFileDiff('');
      setSummary('');
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setSummary('');
    fetchFileDiff(workspacePath, activeFilePath, base)
      .then((data) => {
        if (cancelled) return;
        setFileDiff(data.diff);
        const activeFile = filesRef.current.find(
          (file) => file.path === activeFilePath
        );
        if (activeFile && data.diff) {
          setSummary(
            generateFileSummary(data.diff, activeFilePath, activeFile.status)
          );
        }
      })
      .catch(() => {
        if (!cancelled) setFileDiff('');
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, activeFilePath, base]);

  const handleSelectFile = useCallback((file: ChangedFile) => {
    setActiveFilePath(file.path);
  }, []);

  const handleModeToggle = useCallback(() => {
    setFileDiffViewMode(
      fileDiffViewMode === 'unified' ? 'side-by-side' : 'unified'
    );
  }, [fileDiffViewMode, setFileDiffViewMode]);

  return (
    <div className="utility-review-panel">
      <div className="utility-panel-toolbar">
        <DiffSourceToggle
          value={fileDiffSource}
          onchange={setFileDiffSource}
          defaultBranch={defaultBranch}
        />
        <button
          className="utility-panel-btn"
          onClick={handleModeToggle}
          type="button"
        >
          {fileDiffViewMode === 'unified' ? '[split]' : '[unified]'}
        </button>
      </div>
      <div className="utility-review-body">
        <div className="utility-review-files">
          {loading ? (
            <div className="utility-empty">loading files...</div>
          ) : files.length === 0 ? (
            <div className="utility-empty">no changed files</div>
          ) : (
            <DiffFileSidebar
              files={files}
              activeFile={activeFilePath}
              onSelectFile={handleSelectFile}
            />
          )}
        </div>
        <div className="utility-review-diff">
          {activeFilePath ? (
            <>
              <div className="utility-review-title">
                <span>{activeFilePath}</span>
                {summary ? (
                  <span className="utility-muted">{summary}</span>
                ) : null}
              </div>
              <DiffViewer
                diff={fileDiff}
                filePath={activeFilePath}
                loading={diffLoading}
                mode={fileDiffViewMode}
              />
            </>
          ) : (
            <div className="utility-empty">select a file</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default UtilityRailReviewPanel;
