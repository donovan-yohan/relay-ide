import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ChangedFile, DiffSource } from '../lib/types.js';
import { fetchChangedFiles, fetchFileDiff, fetchDefaultBranch } from '../lib/api.js';
import { generateFileSummary } from '../lib/diff-summary.js';
import { statusIcon, statusColor, diffSourceToBase } from '../lib/diff-utils.js';
import { rootShortName } from '../lib/utils.js';
import { DiffViewer } from './DiffViewer.js';
import './ChangedFiles.css';

export interface ChangedFilesHandle {
  refresh: (force?: boolean) => Promise<void>;
}

export interface ChangedFilesProps {
  workspacePath: string;
  onExpandFile?: (file: ChangedFile, base: string | undefined) => void;
}

interface AggregateStats { additions: number; deletions: number; fileCount: number; }

const DIFF_SOURCES: { value: DiffSource; label: string }[] = [
  { value: 'working', label: 'working tree' },
  { value: 'staged', label: 'staged' },
  { value: 'branch', label: 'branch' },
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 600px)');
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

interface FileRowProps { file: ChangedFile; summary: string | undefined; expanded: boolean; fileDiff: string; diffLoading: boolean; diffError: string | undefined; onExpandFile?: (file: ChangedFile, base: string | undefined) => void; base: string | undefined; onClick: () => void; }

function FileRow({ file, summary, expanded, fileDiff, diffLoading, diffError, onExpandFile, base, onClick }: FileRowProps) {
  return (
    <button className="table-row" onClick={onClick}>
      <span className="cell cell--status" style={{ color: statusColor[file.status] ?? 'var(--text-muted)' }}>{statusIcon[file.status] ?? '?'}</span>
      <span className="cell cell--path" title={file.path}>{rootShortName(file.path)}{summary && <span className="file-summary">{summary}</span>}</span>
      <span className="cell cell--stat stat-add">+{file.additions}</span>
      <span className="cell cell--stat stat-del">-{file.deletions}</span>
      {onExpandFile && <button className="expand-btn" title="open full diff" onClick={(e) => { e.stopPropagation(); onExpandFile(file, base); }} aria-label={`expand diff for ${file.path}`}>[↗]</button>}
      {expanded && (
        <div className="inline-diff" onClick={(e) => e.stopPropagation()}>
          {diffError ? <div className="diff-error">{diffError}</div> : <DiffViewer diff={fileDiff} filePath={file.path} loading={diffLoading} />}
        </div>
      )}
    </button>
  );
}

function MobileCard({ file, summary, expanded, fileDiff, diffLoading, diffError, onClick }: Omit<FileRowProps, 'onExpandFile' | 'base'>) {
  return (
    <button className="mobile-file-card" onClick={onClick}>
      <div className="card-header">
        <span style={{ color: statusColor[file.status] ?? 'var(--text-muted)' }}>{statusIcon[file.status] ?? '?'}</span>
        <span>{rootShortName(file.path)}</span>
        <span className="card-stats"><span className="stat-add">+{file.additions}</span><span className="stat-del">-{file.deletions}</span></span>
      </div>
      {summary && <div className="card-summary">{summary}</div>}
      {expanded && (
        <div className="inline-diff" onClick={(e) => e.stopPropagation()}>
          {diffError ? <div className="diff-error">{diffError}</div> : <DiffViewer diff={fileDiff} filePath={file.path} loading={diffLoading} />}
        </div>
      )}
    </button>
  );
}

const COLUMNS = [
  { key: 'status', label: '', width: '24px' },
  { key: 'path', label: 'file', sortable: true },
  { key: 'additions', label: '+', sortable: true, width: '50px' },
  { key: 'deletions', label: '-', sortable: true, width: '50px' },
];

function useChangedFilesData(workspacePath: string, base: string | undefined) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [aggregate, setAggregate] = useState<AggregateStats>({ additions: 0, deletions: 0, fileCount: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const filesRef = useRef(files);
  const errorRef = useRef(error);
  filesRef.current = files;
  errorRef.current = error;

  const refresh = useCallback(async (force = false, expanded = true) => {
    if (!workspacePath || (!force && !expanded)) return;
    const showLoading = filesRef.current.length === 0 && !errorRef.current;
    if (showLoading) setLoading(true);
    try {
      const data = await fetchChangedFiles(workspacePath, base);
      setFiles(data.files);
      setAggregate(data.aggregate);
      setError(data.error);
    } catch {
      setError('Failed to fetch changed files');
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, base]);

  return { files, setFiles, aggregate, loading, error, refresh };
}

function useFileDiff(workspacePath: string, base: string | undefined, summaries: Map<string, string>, setSummaries: React.Dispatch<React.SetStateAction<Map<string, string>>>) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | undefined>(undefined);

  const handleRowAction = useCallback(async (file: ChangedFile) => {
    if (expandedFile === file.path) { setExpandedFile(null); setFileDiff(''); return; }
    const targetPath = file.path;
    setExpandedFile(targetPath);
    setDiffLoading(true);
    setDiffError(undefined);
    try {
      const data = await fetchFileDiff(workspacePath, file.path, base);
      if (expandedFile !== targetPath) return;
      if (data.error) { setDiffError(data.error); setFileDiff(''); return; }
      setFileDiff(data.diff);
      if (!summaries.get(file.path) && data.diff) {
        setSummaries((prev) => new Map([...prev, [file.path, generateFileSummary(data.diff, file.path, file.status)]]));
      }
    } catch (err: unknown) {
      if (expandedFile !== targetPath) return;
      setDiffError(`failed to load diff: ${err instanceof Error ? err.message : 'unknown error'}`);
      setFileDiff('');
    } finally {
      setDiffLoading(false);
    }
  }, [expandedFile, workspacePath, base, summaries, setSummaries]);

  return { expandedFile, fileDiff, diffLoading, diffError, handleRowAction };
}

export const ChangedFiles = forwardRef<ChangedFilesHandle, ChangedFilesProps>(
  function ChangedFiles({ workspacePath, onExpandFile }, ref) {
    const [expanded, setExpanded] = useState(false);
    const [summaries, setSummaries] = useState(new Map<string, string>());
    const [sortBy, setSortBy] = useState('path');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
    const [diffSource, setDiffSource] = useState<DiffSource>('working');
    const [defaultBranch, setDefaultBranch] = useState('main');
    const isMobile = useIsMobile();
    const base = useMemo(() => diffSourceToBase(diffSource, defaultBranch), [diffSource, defaultBranch]);

    const { files, aggregate, loading, error, refresh } = useChangedFilesData(workspacePath, base);
    const { expandedFile, fileDiff, diffLoading, diffError, handleRowAction } = useFileDiff(workspacePath, base, summaries, setSummaries);

    const publicRefresh = useCallback((force = false) => refresh(force, expanded), [refresh, expanded]);
    useImperativeHandle(ref, () => ({ refresh: publicRefresh }), [publicRefresh]);

    useEffect(() => { if (workspacePath) void refresh(true, true); }, [workspacePath, base, refresh]);
    useEffect(() => {
      if (workspacePath) fetchDefaultBranch(workspacePath).then((b) => setDefaultBranch(b)).catch(() => {});
    }, [workspacePath]);

    const sortedFiles = useMemo(() => {
      const sorted = [...files];
      sorted.sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[sortBy];
        const bv = (b as unknown as Record<string, unknown>)[sortBy];
        if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
        return sortDir === 'asc' ? String(av ?? '').localeCompare(String(bv ?? '')) : String(bv ?? '').localeCompare(String(av ?? ''));
      });
      return sorted;
    }, [files, sortBy, sortDir]);

    const handleSort = useCallback((col: string) => {
      if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else { setSortBy(col); setSortDir('asc'); }
    }, [sortBy]);

    const handleToggle = useCallback(() => {
      setExpanded((prev) => { if (!prev && files.length === 0) void refresh(); return !prev; });
    }, [files.length, refresh]);

    return (
      <div className="changed-files-panel">
        <button className="summary-bar" onClick={handleToggle} aria-expanded={expanded}>
          <span className="summary-label">changed files</span>
          {aggregate.fileCount > 0 ? (
            <span className="summary-stats">{aggregate.fileCount} file{aggregate.fileCount !== 1 ? 's' : ''}{' '}<span className="stat-add">+{aggregate.additions}</span>{' '}<span className="stat-del">-{aggregate.deletions}</span></span>
          ) : loading ? (
            <span className="summary-stats loading-text">scanning...</span>
          ) : (
            <span className="summary-stats muted">no changes</span>
          )}
          <span className="expand-indicator">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <div className="files-content">
            <div className="files-toolbar">
              <div className="diff-source-toggle" role="radiogroup" aria-label="diff source">
                {DIFF_SOURCES.map((opt) => (
                  <button key={opt.value} className={['toggle-option', diffSource === opt.value && 'active'].filter(Boolean).join(' ')} role="radio" aria-checked={diffSource === opt.value} onClick={() => setDiffSource(opt.value)}>
                    {opt.value === 'branch' ? `vs ${defaultBranch}` : opt.label}
                  </button>
                ))}
              </div>
            </div>
            {!isMobile && (
              <div className="data-table-header">
                {COLUMNS.map((col) => (
                  <div key={col.key} className="data-table-th" style={{ width: col.width, flex: col.width ? 'none' : '1' }}>
                    {col.sortable ? <button className="sort-trigger" onClick={() => handleSort(col.key)}>{col.label}{sortBy === col.key && <span>{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}</button> : col.label}
                  </div>
                ))}
              </div>
            )}
            <div className="scroll-container" style={{ maxHeight: '300px' }}>
              {loading && <div className="state-message">scanning...</div>}
              {error && <div className="state-message state-message--error">{error}</div>}
              {!loading && !error && sortedFiles.length === 0 && <div className="state-message">no changes detected</div>}
              {sortedFiles.map((file) => isMobile ? (
                <MobileCard key={file.path} file={file} summary={summaries.get(file.path)} expanded={expandedFile === file.path} fileDiff={fileDiff} diffLoading={diffLoading} diffError={diffError} onClick={() => void handleRowAction(file)} />
              ) : (
                <FileRow key={file.path} file={file} summary={summaries.get(file.path)} expanded={expandedFile === file.path} fileDiff={fileDiff} diffLoading={diffLoading} diffError={diffError} {...(onExpandFile ? { onExpandFile } : {})} base={base} onClick={() => void handleRowAction(file)} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
);

export default ChangedFiles;
