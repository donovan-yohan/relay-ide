import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffFileSidebar } from './DiffFileSidebar.js';
import type { DiffFileSidebarHandle } from './DiffFileSidebar.js';
import { fetchChangedFiles, fetchFileDiff, fetchDefaultBranch } from '../lib/api.js';
import { generateFileSummary } from '../lib/diff-summary.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import type { ChangedFile, DiffSource } from '../lib/types.js';
import './FullPageDiff.css';

// Stub DiffViewer and DiffSourceToggle until they are migrated
const DiffViewer = React.lazy(() =>
  import('./DiffViewer.js').catch(() => ({
    default: () => <div className="fpd-empty">diff viewer not available</div>,
  }))
);

const DiffSourceToggle = React.lazy(() =>
  import('./DiffSourceToggle.js').catch(() => ({
    default: () => <></>,
  }))
);

export interface FullPageDiffProps {
  workspacePath: string;
  initialFile?: string;
  initialBase?: string;
  onClose: () => void;
}

function deriveInitialDiffSource(initialBase?: string): DiffSource {
  if (initialBase === 'cached') return 'staged';
  if (initialBase) return 'branch';
  return 'working';
}

function useFullPageDiffData(workspacePath: string, base: string) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [fileDiff, setFileDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [summary, setSummary] = useState('');

  const loadFiles = useCallback(
    async (activeFilePath: string | null, onFilesFetched: (files: ChangedFile[]) => void) => {
      setLoading(true);
      try {
        const data = await fetchChangedFiles(workspacePath, base);
        setFiles(data.files);
        onFilesFetched(data.files);
      } catch {
        setFiles([]);
        onFilesFetched([]);
      } finally {
        setLoading(false);
      }
    },
    [workspacePath, base]
  );

  const loadDiff = useCallback(
    async (filePath: string, currentFiles: ChangedFile[]) => {
      setDiffLoading(true);
      setSummary('');
      try {
        const data = await fetchFileDiff(workspacePath, filePath, base);
        setFileDiff(data.diff);
        const file = currentFiles.find((f) => f.path === filePath);
        if (file && data.diff) {
          setSummary(generateFileSummary(data.diff, filePath, file.status));
        }
      } catch {
        setFileDiff('');
      } finally {
        setDiffLoading(false);
      }
    },
    [workspacePath, base]
  );

  return { files, loading, fileDiff, diffLoading, summary, loadFiles, loadDiff };
}

// ── Main component ──

export function FullPageDiff({ workspacePath, initialFile, initialBase, onClose }: FullPageDiffProps) {
  const [diffSource, setDiffSource] = useState<DiffSource>(deriveInitialDiffSource(initialBase));
  const [defaultBranch, setDefaultBranch] = useState(
    initialBase && initialBase !== 'cached' ? initialBase : 'main'
  );
  const [diffMode, setDiffMode] = useState<'unified' | 'side-by-side'>('unified');
  const [activeFilePath, setActiveFilePath] = useState<string | null>(initialFile ?? null);
  const [hunkCount, setHunkCount] = useState(0);
  const [currentHunkIndex, setCurrentHunkIndex] = useState(-1);
  const sidebarRef = useRef<DiffFileSidebarHandle>(null);
  const filesRef = useRef<ChangedFile[]>([]);

  const base = useMemo(() => diffSourceToBase(diffSource, defaultBranch) ?? '', [diffSource, defaultBranch]);

  const { files, loading, fileDiff, diffLoading, summary, loadFiles, loadDiff } = useFullPageDiffData(
    workspacePath,
    base
  );

  filesRef.current = files;

  useEffect(() => {
    loadFiles(activeFilePath, (fetched) => {
      setActiveFilePath((prev) => {
        if (!prev || !fetched.some((f) => f.path === prev)) {
          return fetched.length > 0 ? fetched[0]!.path : null;
        }
        return prev;
      });
    });
  }, [base, loadFiles]);

  useEffect(() => {
    if (activeFilePath) loadDiff(activeFilePath, filesRef.current);
  }, [activeFilePath, base, loadDiff]);

  useEffect(() => {
    if (workspacePath && defaultBranch === 'main') {
      fetchDefaultBranch(workspacePath).then((b) => setDefaultBranch(b)).catch(() => undefined);
    }
  }, [workspacePath, defaultBranch]);

  const scrollToHunk = useCallback(
    (delta: number) => {
      const hunks = document.querySelectorAll('.fpd-main .hunk-header');
      const visibleCount = hunks.length;
      if (visibleCount === 0) return;
      const target = currentHunkIndex + delta;
      if (target < 0 || target >= visibleCount) return;
      setCurrentHunkIndex(target);
      hunks[target]!.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    [currentHunkIndex]
  );

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'j') { e.preventDefault(); sidebarRef.current?.moveFocus(1); }
      else if (e.key === 'k') { e.preventDefault(); sidebarRef.current?.moveFocus(-1); }
      else if (e.key === 'n') { e.preventDefault(); scrollToHunk(1); }
      else if (e.key === 'p') { e.preventDefault(); scrollToHunk(-1); }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [onClose, scrollToHunk]);

  const handleSelectFile = useCallback((file: ChangedFile) => setActiveFilePath(file.path), []);
  const handleHunkCount = useCallback((c: number) => { setHunkCount(c); setCurrentHunkIndex(-1); }, []);
  const handleModeToggle = useCallback(() => setDiffMode((m) => (m === 'unified' ? 'side-by-side' : 'unified')), []);

  return (
    <div className="full-page-diff">
      <div className="fpd-header">
        <button className="fpd-close-btn" onClick={onClose} aria-label="close diff view">
          [x] close
        </button>
        <span className="fpd-title">
          {activeFilePath ? (
            <>
              {activeFilePath}
              {summary && <span className="fpd-summary"> — {summary}</span>}
            </>
          ) : (
            'diff view'
          )}
        </span>
        <div className="fpd-controls">
          <React.Suspense fallback={null}>
            <DiffSourceToggle
              value={diffSource}
              onchange={(s: DiffSource) => setDiffSource(s)}
              defaultBranch={defaultBranch}
            />
          </React.Suspense>
          <button className="fpd-mode-toggle" onClick={handleModeToggle} title="toggle unified/side-by-side">
            {diffMode === 'unified' ? '[split]' : '[unified]'}
          </button>
        </div>
      </div>
      <div className="fpd-body">
        <DiffFileSidebar ref={sidebarRef} files={files} activeFile={activeFilePath} onSelectFile={handleSelectFile} />
        <div className="fpd-main">
          {activeFilePath ? (
            <React.Suspense fallback={<div className="fpd-empty">loading...</div>}>
              <DiffViewer
                diff={fileDiff}
                filePath={activeFilePath}
                loading={diffLoading}
                mode={diffMode}
                onHunkCount={handleHunkCount}
              />
            </React.Suspense>
          ) : loading ? (
            <div className="fpd-empty">loading files...</div>
          ) : (
            <div className="fpd-empty">no files changed</div>
          )}
        </div>
      </div>
      <div className="fpd-footer">
        <span className="fpd-hint">j/k navigate files</span>
        <span className="fpd-hint">n/p jump hunks</span>
        <span className="fpd-hint">esc close</span>
        <span style={{ display: 'none' }}>{hunkCount}</span>
      </div>
    </div>
  );
}

export default FullPageDiff;
