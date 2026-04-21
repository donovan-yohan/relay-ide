import React, { useEffect, useMemo, useRef, useState } from 'react';
import './DataTable.css';

export interface Column {
  key: string;
  label: string;
  sortable?: boolean;
  width?: string;
}

interface Group<T> {
  key: string;
  items: T[];
}

export interface DataTableProps<T> {
  columns: Column[];
  rows: T[];
  groupBy?: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSort: (column: string) => void;
  loading?: boolean;
  error?: string | undefined;
  emptyMessage?: string;
  filteredEmptyMessage?: string;
  onClearFilters?: () => void;
  maxHeight?: string;
  onRowAction?: (item: T) => void;
  skeletonCount?: number;
  hasActiveFilters?: boolean;
  row: (item: T, index: number) => React.ReactNode;
  mobileCard: (item: T, index: number) => React.ReactNode;
}

function getAriaSort(col: Column, sortBy: string, sortDir: 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (sortBy !== col.key) return 'none';
  return sortDir === 'asc' ? 'ascending' : 'descending';
}

function buildGroups<T>(rows: T[], groupBy: string): Group<T>[] {
  const map = new Map<string, T[]>();
  for (const item of rows) {
    const val = String((item as Record<string, unknown>)[groupBy] ?? 'Other');
    const arr = map.get(val);
    if (arr) arr.push(item);
    else map.set(val, [item]);
  }
  const keys = [...map.keys()].sort();
  return keys.map((k) => ({ key: k, items: map.get(k)! }));
}

function getFlatIndex<T>(groups: Group<T>[], gi: number, ii: number): number {
  let idx = 0;
  for (let g = 0; g < gi; g++) idx += groups[g]!.items.length;
  return idx + ii;
}

function useTableState<T>(rows: T[], scrollContainerRef: React.RefObject<HTMLDivElement | null>) {
  const [isMobile, setIsMobile] = useState(false);
  const [isScrollable, setIsScrollable] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const prevRowsRef = useRef<T[]>(rows);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 600px)');
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (rows !== prevRowsRef.current) { prevRowsRef.current = rows; setFocusedIndex(0); }
  }, [rows]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const check = () => setIsScrollable(el.scrollHeight > el.clientHeight);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollContainerRef]);

  return { isMobile, isScrollable, focusedIndex, setFocusedIndex };
}

function TableHeader<T>({ columns, sortBy, sortDir, onSort }: Pick<DataTableProps<T>, 'columns' | 'sortBy' | 'sortDir' | 'onSort'>) {
  return (
    <div className="data-table-header">
      {columns.map((col) => (
        <div key={col.key} className="data-table-th" aria-sort={getAriaSort(col, sortBy, sortDir)} style={{ width: col.width, flex: col.width ? 'none' : '1' }}>
          {col.sortable
            ? <button className="sort-trigger" onClick={() => onSort(col.key)}>{col.label}{sortBy === col.key ? <span className="sort-indicator">{sortDir === 'asc' ? '▲' : '▼'}</span> : null}</button>
            : col.label}
        </div>
      ))}
    </div>
  );
}

function TableBody<T>({ loading, error, rows, hasActiveFilters, emptyMessage, filteredEmptyMessage, onClearFilters, columns, skeletonCount, isMobile, focusedIndex, groupBy, groups, collapsed, toggleGroup, row, mobileCard }: {
  loading: boolean; error?: string; rows: T[]; hasActiveFilters: boolean;
  emptyMessage: string; filteredEmptyMessage: string; onClearFilters?: () => void;
  columns: Column[]; skeletonCount: number; isMobile: boolean; focusedIndex: number;
  groupBy?: string; groups: Group<T>[]; collapsed: Record<string, boolean>;
  toggleGroup: (key: string) => void;
  row: (item: T, i: number) => React.ReactNode; mobileCard: (item: T, i: number) => React.ReactNode;
}) {
  if (loading) {
    return <>{Array.from({ length: skeletonCount }, (_, i) => (
      <div key={i} className="skeleton-row">
        {isMobile ? <div className="skeleton-card"><div className="skeleton-line" style={{ width: '60%', height: '13px' }} /><div className="skeleton-line" style={{ width: '40%', height: '10px' }} /></div>
          : columns.map((col) => <div key={col.key} className="skeleton-cell" style={{ width: col.width, flex: col.width ? 'none' : '1' }}><div className="skeleton-line" style={{ width: '70%', height: '12px' }} /></div>)}
      </div>
    ))}</>;
  }
  if (error) return <div className="state-message state-message--error"><span>{error}</span></div>;
  if (rows.length === 0) {
    return (
      <div className="state-message">
        {hasActiveFilters ? <><span>{filteredEmptyMessage}</span>{onClearFilters ? <button className="clear-filters-btn" onClick={onClearFilters}>Clear filters</button> : null}</> : <span>{emptyMessage}</span>}
      </div>
    );
  }
  if (groupBy && groups.length > 0) {
    return <>{groups.map((group, gi) => (
      <React.Fragment key={group.key}>
        <button className="group-header" onClick={() => toggleGroup(group.key)} aria-expanded={!collapsed[group.key]}>
          <span className={['group-chevron', collapsed[group.key] && 'collapsed'].filter(Boolean).join(' ')}>&#9654;</span>
          <span className="group-label">{group.key}</span>
          <span className="group-count">{group.items.length}</span>
        </button>
        {!collapsed[group.key] ? group.items.map((item, ii) => {
          const flatIdx = getFlatIndex(groups, gi, ii);
          return <div key={flatIdx} className={['data-table-row', focusedIndex === flatIdx && 'focused'].filter(Boolean).join(' ')} data-row-index={flatIdx} role="listitem" tabIndex={-1}>{isMobile ? mobileCard(item, flatIdx) : row(item, flatIdx)}</div>;
        }) : null}
      </React.Fragment>
    ))}</>;
  }
  return <>{rows.map((item, i) => <div key={i} className={['data-table-row', focusedIndex === i && 'focused'].filter(Boolean).join(' ')} data-row-index={i} role="listitem" tabIndex={-1}>{isMobile ? mobileCard(item, i) : row(item, i)}</div>)}</>;
}

export function DataTable<T>({
  columns, rows, groupBy, sortBy, sortDir, onSort,
  loading = false, error, emptyMessage = 'No data.',
  filteredEmptyMessage = 'No results match the current filters.',
  onClearFilters, maxHeight = '400px', onRowAction,
  skeletonCount = 3, hasActiveFilters = false, row, mobileCard,
}: DataTableProps<T>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { isMobile, isScrollable, focusedIndex, setFocusedIndex } = useTableState(rows, scrollContainerRef);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => (groupBy ? buildGroups(rows, groupBy) : []), [rows, groupBy]);

  function toggleGroup(key: string) { setCollapsed((prev) => ({ ...prev, [key]: !prev[key] })); setFocusedIndex(0); }

  function handleKeydown(e: React.KeyboardEvent) {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); const n = Math.min(focusedIndex + 1, rows.length - 1); setFocusedIndex(n); queueMicrotask(() => { scrollContainerRef.current?.querySelector(`[data-row-index="${n}"]`)?.scrollIntoView({ block: 'nearest' }); }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const n = Math.max(focusedIndex - 1, 0); setFocusedIndex(n); queueMicrotask(() => { scrollContainerRef.current?.querySelector(`[data-row-index="${n}"]`)?.scrollIntoView({ block: 'nearest' }); }); }
    else if (e.key === 'Enter') { e.preventDefault(); const focused = rows[focusedIndex]; if (onRowAction && focused !== undefined) onRowAction(focused); }
  }

  return (
    <div className="data-table-wrapper" role="list">
      {!isMobile ? <TableHeader columns={columns} sortBy={sortBy} sortDir={sortDir} onSort={onSort} /> : null}
      <div className="scroll-wrapper" style={{ maxHeight }}>
        <div className="scroll-container" ref={scrollContainerRef} tabIndex={0} onKeyDown={handleKeydown} aria-label="Table body">
          <TableBody loading={loading} {...(error ? { error } : {})} rows={rows} hasActiveFilters={hasActiveFilters} emptyMessage={emptyMessage} filteredEmptyMessage={filteredEmptyMessage} {...(onClearFilters ? { onClearFilters } : {})} columns={columns} skeletonCount={skeletonCount} isMobile={isMobile} focusedIndex={focusedIndex} {...(groupBy ? { groupBy } : {})} groups={groups} collapsed={collapsed} toggleGroup={toggleGroup} row={row} mobileCard={mobileCard} />
        </div>
        {isScrollable ? <div className="scroll-fade" /> : null}
      </div>
    </div>
  );
}

export default DataTable;
