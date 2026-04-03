import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { scorePath } from '../lib/fuzzy-scorer.js';
import type { ScoredResult } from '../lib/fuzzy-scorer.js';
import { statusToBadge, statusToBadgeColor } from '../lib/file-tree-utils.js';
import { isMobileDevice } from '../lib/utils.js';
import type { FileChangeStatus } from '../lib/types.js';
import type { OpenFileTab } from '../lib/stores/ui.js';
import './FilePicker.css';

// ── Types ──

interface ScoredFile {
  path: string;
  filename: string;
  directory: string;
  result: ScoredResult;
  status?: FileChangeStatus | undefined;
}

interface Section {
  label: string;
  items: ScoredFile[];
}

interface FilesListResponse {
  files: string[];
  truncated: boolean;
  total: number;
  error?: string;
}

// ── Fetch ──

async function fetchFilesList(workspacePath: string): Promise<FilesListResponse> {
  const params = new URLSearchParams({ path: workspacePath });
  const res = await fetch('/workspaces/files-list?' + params.toString());
  if (!res.ok) throw new Error(`files-list failed: ${res.status}`);
  return res.json();
}

// ── Scoring helpers ──

const MAX_NEUTRAL = 64;

function addUnique(paths: string[], seen: Set<string>, candidates: string[], limit: number) {
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
    if (paths.length >= limit) return;
  }
}

function buildNeutralCandidates(
  fileSet: Set<string>,
  allFiles: string[],
  recentFiles: OpenFileTab[],
  changedFiles: string[]
): { path: string; result: ScoredResult }[] {
  const seen = new Set<string>();
  const orderedPaths: string[] = [];
  addUnique(orderedPaths, seen, recentFiles.filter((t) => fileSet.has(t.filePath)).map((t) => t.filePath), MAX_NEUTRAL);
  addUnique(orderedPaths, seen, changedFiles.filter((p) => fileSet.has(p)), MAX_NEUTRAL);
  addUnique(orderedPaths, seen, allFiles, MAX_NEUTRAL);
  return orderedPaths.map((p) => ({ path: p, result: { score: 0, matches: [] as [number, number][] } }));
}

function buildScoredResults(
  debouncedQuery: string,
  allFiles: string[],
  recentFiles: OpenFileTab[],
  changedFiles: string[]
): ScoredFile[] {
  const fileSet = new Set(allFiles);
  const q = debouncedQuery.trim();
  let candidates: { path: string; result: ScoredResult }[];

  if (!q) {
    candidates = buildNeutralCandidates(fileSet, allFiles, recentFiles, changedFiles);
  } else {
    candidates = allFiles.flatMap((p) => { const r = scorePath(q, p); return r ? [{ path: p, result: r }] : []; });
    candidates.sort((a, b) => b.result.score - a.result.score);
  }

  return candidates.map((c) => {
    const lastSep = c.path.lastIndexOf('/');
    const item: ScoredFile = {
      path: c.path,
      filename: lastSep >= 0 ? c.path.slice(lastSep + 1) : c.path,
      directory: lastSep >= 0 ? c.path.slice(0, lastSep + 1) : '',
      result: c.result,
    };
    return item;
  });
}

function buildSections(scoredResults: ScoredFile[], recentFiles: OpenFileTab[], changedFiles: string[]): Section[] {
  const recentSet = new Set(recentFiles.map((t) => t.filePath));
  const changedSet = new Set(changedFiles);

  const recentSection = scoredResults.filter((f) => recentSet.has(f.path)).slice(0, 5);
  const recentPaths = new Set(recentSection.map((f) => f.path));

  const changedSection = scoredResults.filter((f) => changedSet.has(f.path) && !recentPaths.has(f.path)).slice(0, 10);
  const changedPaths = new Set(changedSection.map((f) => f.path));

  const allSection = scoredResults.filter((f) => !recentPaths.has(f.path) && !changedPaths.has(f.path)).slice(0, 20);

  const result: Section[] = [];
  if (recentSection.length > 0) result.push({ label: 'recent', items: recentSection });
  if (changedSection.length > 0) result.push({ label: 'changed', items: changedSection });
  if (allSection.length > 0) result.push({ label: 'files', items: allSection });
  return result;
}

// ── Highlight rendering ──

function highlightMatches(
  text: string,
  matches: [number, number][],
  offset: number
): Array<{ text: string; highlight: boolean }> {
  if (matches.length === 0) return [{ text, highlight: false }];
  const segments: Array<{ text: string; highlight: boolean }> = [];
  let pos = 0;
  for (const [start, end] of matches) {
    const localStart = start - offset;
    const localEnd = end - offset;
    if (localEnd <= 0 || localStart >= text.length) continue;
    const clampedStart = Math.max(0, localStart);
    const clampedEnd = Math.min(text.length, localEnd);
    if (clampedStart > pos) segments.push({ text: text.slice(pos, clampedStart), highlight: false });
    segments.push({ text: text.slice(clampedStart, clampedEnd), highlight: true });
    pos = clampedEnd;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), highlight: false });
  return segments.length > 0 ? segments : [{ text, highlight: false }];
}

// ── Sub-component: file item ──

interface FileItemProps {
  item: ScoredFile;
  globalIndex: number;
  focusedIndex: number;
  changedSet: Set<string>;
  onSelect: (path: string, isChanged: boolean) => void;
  onHover: (idx: number) => void;
}

function FileItem({ item, globalIndex, focusedIndex, changedSet, onSelect, onHover }: FileItemProps) {
  const isFocused = globalIndex === focusedIndex;
  const dirOffset = 0;
  const fileOffset = item.path.length - item.filename.length;

  return (
    <div
      className={['file-picker-item', isFocused ? 'focused' : ''].filter(Boolean).join(' ')}
      role="option"
      tabIndex={-1}
      aria-selected={isFocused}
      onClick={() => onSelect(item.path, changedSet.has(item.path))}
      onMouseEnter={() => onHover(globalIndex)}
    >
      <span className={['fp-item-cursor', isFocused ? 'visible' : ''].filter(Boolean).join(' ')}>&gt;</span>
      <span className="fp-item-filename">
        {highlightMatches(item.filename, item.result.matches, fileOffset).map((seg, i) =>
          seg.highlight ? <span key={i} className="fp-match">{seg.text}</span> : seg.text
        )}
      </span>
      <span className="fp-item-directory">
        {highlightMatches(item.directory, item.result.matches, dirOffset).map((seg, i) =>
          seg.highlight ? <span key={i} className="fp-match">{seg.text}</span> : seg.text
        )}
      </span>
      {item.status && (
        <span className="fp-item-badge" style={{ color: statusToBadgeColor(item.status) }}>
          {statusToBadge(item.status)}
        </span>
      )}
    </div>
  );
}

function useMobileDrag(onClose: () => void) {
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartY = useRef(0);
  const dragging = useRef(false);

  const handleDragStart = useCallback((e: React.TouchEvent, resultsScrollTop: number) => {
    if (!isMobileDevice) return;
    const target = e.target as HTMLElement;
    const isHandle = target.classList.contains('fp-drag-handle') || target.classList.contains('fp-drag-bar');
    if (!isHandle && resultsScrollTop > 0) return;
    dragStartY.current = e.touches[0]!.clientY;
    dragging.current = true;
  }, []);

  const handleDragMove = useCallback((e: React.TouchEvent) => {
    if (!dragging.current) return;
    const delta = e.touches[0]!.clientY - dragStartY.current;
    if (delta > 0) setDragOffset(delta);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    if (dragOffset > 100) onClose();
    setDragOffset(0);
  }, [dragOffset, onClose]);

  return { dragOffset, handleDragStart, handleDragMove, handleDragEnd };
}

// ── Results / footer helpers ──

interface ResultsBodyProps {
  isError: boolean;
  fetchError: string | undefined;
  isLoading: boolean;
  flatItems: ScoredFile[];
  debouncedQuery: string;
  sections: Section[];
  focusedIndex: number;
  changedSet: Set<string>;
  onSelect: (path: string, isChanged: boolean) => void;
  setFocusedIndex: (idx: number) => void;
}

function ResultsBody({ isError, fetchError, isLoading, flatItems, debouncedQuery, sections, focusedIndex, changedSet, onSelect, setFocusedIndex }: ResultsBodyProps) {
  if (isError) return <div className="file-picker-empty">failed to load files</div>;
  if (fetchError) return <div className="file-picker-empty">no files found — {fetchError}</div>;
  if (isLoading) return <div className="file-picker-empty">loading...</div>;
  if (flatItems.length === 0 && debouncedQuery.trim()) return <div className="file-picker-empty">no results for &quot;{debouncedQuery}&quot;</div>;
  if (flatItems.length === 0) return <div className="file-picker-empty">no files</div>;
  return (
    <>
      {sections.map((section, si) => {
        const offset = sections.slice(0, si).reduce((acc, s) => acc + s.items.length, 0);
        return (
          <React.Fragment key={section.label}>
            <div className="file-picker-section" role="presentation">{section.label}</div>
            {section.items.map((item, i) => (
              <FileItem key={item.path} item={item} globalIndex={offset + i} focusedIndex={focusedIndex} changedSet={changedSet} onSelect={onSelect} onHover={setFocusedIndex} />
            ))}
          </React.Fragment>
        );
      })}
    </>
  );
}

interface FooterProps {
  truncated: boolean;
  allFilesCount: number;
  total: number;
}

function Footer({ truncated, allFilesCount, total }: FooterProps) {
  if (truncated) {
    return <div className="file-picker-footer"><span className="fp-hint truncated">showing {allFilesCount} of {total} files — type to filter</span></div>;
  }
  if (isMobileDevice) {
    return <div className="file-picker-footer" />;
  }
  return (
    <div className="file-picker-footer">
      <span className="fp-hint">&#x2191;&#x2193; navigate</span>
      <span className="fp-hint">tab section</span>
      <span className="fp-hint">&#x21B5; open</span>
      <span className="fp-hint">esc close</span>
    </div>
  );
}

// ── Main component ──

export interface FilePickerProps {
  open: boolean;
  workspacePath: string;
  changedFiles?: string[];
  recentFiles?: OpenFileTab[];
  onClose: () => void;
  onSelect: (filePath: string, isChanged: boolean) => void;
}

export function FilePicker({
  open, workspacePath, changedFiles = [], recentFiles = [], onClose, onSelect,
}: FilePickerProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { dragOffset, handleDragStart, handleDragMove, handleDragEnd } = useMobileDrag(onClose);

  const { data, isError, isLoading } = useQuery<FilesListResponse>({
    queryKey: ['files-list', workspacePath],
    queryFn: () => fetchFilesList(workspacePath),
    staleTime: 30_000,
    enabled: open && !!workspacePath,
  });

  const allFiles = data?.files ?? [];
  const truncated = data?.truncated ?? false;
  const total = data?.total ?? 0;
  const fetchError = data?.error;
  const changedSet = useMemo(() => new Set(changedFiles), [changedFiles]);

  const scoredResults = useMemo(
    () => buildScoredResults(debouncedQuery, allFiles, recentFiles, changedFiles),
    [debouncedQuery, allFiles, recentFiles, changedFiles]
  );

  const sections = useMemo(
    () => buildSections(scoredResults, recentFiles, changedFiles),
    [scoredResults, recentFiles, changedFiles]
  );

  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const sectionStarts = useMemo(() => {
    const starts: number[] = [];
    let offset = 0;
    for (const s of sections) {
      starts.push(offset);
      offset += s.items.length;
    }
    return starts;
  }, [sections]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebouncedQuery('');
      setFocusedIndex(0);
    }
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [open]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(val);
      setFocusedIndex(0);
    }, 100);
  }, []);

  const scrollFocusedIntoView = useCallback(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector('.file-picker-item.focused');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  const handleTabKey = useCallback((e: React.KeyboardEvent) => {
    if (flatItems.length === 0 || sectionStarts.length === 0) return;
    e.preventDefault();
    let currentSection = 0;
    for (let i = sectionStarts.length - 1; i >= 0; i--) {
      if (focusedIndex >= (sectionStarts[i] ?? 0)) { currentSection = i; break; }
    }
    const nextSection = e.shiftKey
      ? (currentSection - 1 + sectionStarts.length) % sectionStarts.length
      : (currentSection + 1) % sectionStarts.length;
    setFocusedIndex(sectionStarts[nextSection] ?? 0);
    scrollFocusedIntoView();
  }, [flatItems.length, focusedIndex, sectionStarts, scrollFocusedIntoView]);

  const handleKeydown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Tab') { handleTabKey(e); return; }
      e.preventDefault();
      const hasItems = flatItems.length > 0;
      if (!hasItems) return;
      if (e.key === 'ArrowDown') {
        setFocusedIndex((prev) => { scrollFocusedIntoView(); return Math.min(prev + 1, flatItems.length - 1); });
      } else if (e.key === 'ArrowUp') {
        setFocusedIndex((prev) => { scrollFocusedIntoView(); return Math.max(prev - 1, 0); });
      } else if (e.key === 'Enter') {
        const item = flatItems[focusedIndex];
        if (item) onSelect(item.path, changedSet.has(item.path));
      }
    },
    [flatItems, focusedIndex, changedSet, onClose, onSelect, scrollFocusedIntoView, handleTabKey]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('file-picker-overlay')) onClose();
    },
    [onClose]
  );

  if (!open) return null;

  const mobileTransform = isMobileDevice && dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined;

  return (
    <div
      className={['file-picker-overlay', isMobileDevice ? 'mobile' : ''].filter(Boolean).join(' ')}
      onClick={handleBackdropClick}
    >
      <div
        className={['file-picker', isMobileDevice ? 'mobile' : ''].filter(Boolean).join(' ')}
        role="dialog" tabIndex={-1} aria-modal="true" aria-label="open file"
        style={mobileTransform ? { transform: mobileTransform } : undefined}
        onTouchStart={(e) => handleDragStart(e, resultsRef.current?.scrollTop ?? 0)}
        onTouchMove={handleDragMove} onTouchEnd={handleDragEnd} onTouchCancel={handleDragEnd}
      >
        {isMobileDevice && <div className="fp-drag-handle"><span className="fp-drag-bar" /></div>}
        <div className="file-picker-input-row">
          <span className="file-picker-prompt">&gt;</span>
          <input
            className="tui-input" value={query} placeholder="search files..."
            onChange={handleInput} onKeyDown={handleKeydown}
            autoComplete="off" spellCheck={false}
            role="combobox" aria-expanded={flatItems.length > 0} aria-controls="file-picker-results"
          />
        </div>
        <div className="file-picker-results" id="file-picker-results" role="listbox" ref={resultsRef}>
          <ResultsBody
            isError={isError} fetchError={fetchError} isLoading={isLoading}
            flatItems={flatItems} debouncedQuery={debouncedQuery} sections={sections}
            focusedIndex={focusedIndex} changedSet={changedSet} onSelect={onSelect} setFocusedIndex={setFocusedIndex}
          />
        </div>
        <Footer truncated={truncated} allFilesCount={allFiles.length} total={total} />
      </div>
    </div>
  );
}

export default FilePicker;
