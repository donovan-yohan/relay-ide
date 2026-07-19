import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parse } from 'diff2html';
import type { DiffFile } from 'diff2html/lib/types';
import {
  tokenizeCode,
  detectLanguage,
  type ThemedToken,
} from '../lib/shiki.js';
import { useShikiGcStore } from '../lib/stores/shiki-gc.js';
import './DiffViewer.css';

export interface DiffViewerProps {
  diff: string;
  filePath: string;
  loading?: boolean;
  mode?: 'unified' | 'side-by-side';
  wordWrap?: boolean;
  onHunkCount?: (count: number) => void;
}

interface RawLine {
  type: 'add' | 'delete' | 'context';
  oldNumber?: number;
  newNumber?: number;
  content: string;
}

interface HighlightedLine extends RawLine {
  tokens: ThemedToken[] | null;
}

interface SbsHalf {
  number?: number;
  content: string;
  type: string;
  tokens: ThemedToken[] | null;
}

interface SideBySidePair {
  left: SbsHalf;
  right: SbsHalf;
  hunkHeader?: string;
}

const TRUNCATION_LIMIT = 5000;
const EMPTY_HALF: SbsHalf = { content: '', type: 'empty', tokens: null };

function parseDiff(
  diff: string,
  filePath: string
): { rawLines: RawLine[]; hunkHeaderMap: Map<number, string>; lang: string } {
  if (!diff)
    return { rawLines: [], hunkHeaderMap: new Map(), lang: 'javascript' };
  const files: DiffFile[] = parse(diff);
  if (files.length === 0)
    return { rawLines: [], hunkHeaderMap: new Map(), lang: 'javascript' };

  const file = files[0]!;
  const lang = detectLanguage(filePath);
  const rawLines: RawLine[] = [];
  const hunkHeaderMap = new Map<number, string>();

  for (const block of file.blocks) {
    hunkHeaderMap.set(rawLines.length, block.header);
    for (const line of block.lines) {
      const type =
        line.type === 'insert'
          ? ('add' as const)
          : line.type === 'delete'
            ? ('delete' as const)
            : ('context' as const);
      const rawLine: RawLine = { type, content: line.content.slice(1) };
      if (line.oldNumber !== undefined) rawLine.oldNumber = line.oldNumber;
      if (line.newNumber !== undefined) rawLine.newNumber = line.newNumber;
      rawLines.push(rawLine);
    }
  }
  return { rawLines, hunkHeaderMap, lang };
}

function lineToHalf(line: HighlightedLine, side: 'left' | 'right'): SbsHalf {
  const num = side === 'left' ? line.oldNumber : line.newNumber;
  return {
    ...(num !== undefined ? { number: num } : {}),
    content: line.content,
    type: line.type,
    tokens: line.tokens,
  };
}

function consumeChangePairs(
  hlines: HighlightedLine[],
  start: number
): { pairs: SideBySidePair[]; end: number } {
  const pairs: SideBySidePair[] = [];
  let i = start;
  const deletes: HighlightedLine[] = [];
  const inserts: HighlightedLine[] = [];
  while (i < hlines.length && hlines[i]!.type === 'delete') {
    deletes.push(hlines[i]!);
    i++;
  }
  while (i < hlines.length && hlines[i]!.type === 'add') {
    inserts.push(hlines[i]!);
    i++;
  }
  const max = Math.max(deletes.length, inserts.length);
  for (let j = 0; j < max; j++) {
    const del = deletes[j];
    const ins = inserts[j];
    pairs.push({
      left: del ? lineToHalf(del, 'left') : EMPTY_HALF,
      right: ins ? lineToHalf(ins, 'right') : EMPTY_HALF,
    });
  }
  return { pairs, end: i };
}

function buildPairs(
  hlines: HighlightedLine[],
  hunkHeaders?: Map<number, string>
): SideBySidePair[] {
  const result: SideBySidePair[] = [];
  let i = 0;
  while (i < hlines.length) {
    const header = hunkHeaders?.get(i);
    if (header)
      result.push({ left: EMPTY_HALF, right: EMPTY_HALF, hunkHeader: header });
    const line = hlines[i]!;
    if (line.type === 'context') {
      result.push({
        left: lineToHalf(line, 'left'),
        right: lineToHalf(line, 'right'),
      });
      i++;
    } else {
      const { pairs, end } = consumeChangePairs(hlines, i);
      result.push(...pairs);
      i = end;
    }
  }
  return result;
}

function renderTokens(
  tokens: ThemedToken[] | null,
  fallback: string
): React.ReactNode {
  if (!tokens) return fallback;
  return tokens.map((tok, j) => (
    <span key={j} style={{ color: tok.color ?? '#e0e0e0' }}>
      {tok.content}
    </span>
  ));
}

function UnifiedLine({
  line,
  index,
  hunkHeaderMap,
}: {
  line: HighlightedLine;
  index: number;
  hunkHeaderMap: Map<number, string>;
}) {
  return (
    <React.Fragment>
      {hunkHeaderMap.has(index) && (
        <div className="hunk-header" id={`hunk-${index}`}>
          {hunkHeaderMap.get(index) ?? ''}
        </div>
      )}
      <div
        className={`diff-line ${line.type}`}
        data-old={line.oldNumber ?? ''}
        data-new={line.newNumber ?? ''}
      >
        <span className="line-number old">{line.oldNumber ?? ''}</span>
        <span className="line-number new">{line.newNumber ?? ''}</span>
        <span className="line-prefix">
          {line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}
        </span>
        <span className="line-content">
          {renderTokens(line.tokens, line.content)}
        </span>
      </div>
    </React.Fragment>
  );
}

function SbsRow({ pair, index }: { pair: SideBySidePair; index: number }) {
  if (pair.hunkHeader)
    return (
      <div className="hunk-header sbs-hunk" id={`sbs-hunk-${index}`}>
        {pair.hunkHeader}
      </div>
    );
  const leftPrefix =
    pair.left.type === 'delete' ? '-' : pair.left.type === 'context' ? ' ' : '';
  const rightPrefix =
    pair.right.type === 'add' ? '+' : pair.right.type === 'context' ? ' ' : '';
  return (
    <div className="sbs-row">
      <div className={`sbs-half ${pair.left.type}`}>
        <span className="line-number">{pair.left.number ?? ''}</span>
        <span className="line-prefix">{leftPrefix}</span>
        <span className="line-content">
          {renderTokens(pair.left.tokens, pair.left.content)}
        </span>
      </div>
      <div className={`sbs-half ${pair.right.type}`}>
        <span className="line-number">{pair.right.number ?? ''}</span>
        <span className="line-prefix">{rightPrefix}</span>
        <span className="line-content">
          {renderTokens(pair.right.tokens, pair.right.content)}
        </span>
      </div>
    </div>
  );
}

function TruncationNotice({
  shown,
  total,
  onShowAll,
}: {
  shown: number;
  total: number;
  onShowAll: () => void;
}) {
  return (
    <div className="truncation-notice">
      <span>
        showing {shown} of {total} lines
      </span>
      <button className="show-more-btn" onClick={onShowAll}>
        [show all]
      </button>
    </div>
  );
}

interface DiffContentProps {
  mode: 'unified' | 'side-by-side';
  lines: HighlightedLine[];
  pairedLines: SideBySidePair[];
  hunkHeaderMap: Map<number, string>;
  showAll: boolean;
  onShowAll: () => void;
}

function DiffContent({
  mode,
  lines,
  pairedLines,
  hunkHeaderMap,
  showAll,
  onShowAll,
}: DiffContentProps) {
  const isSbs = mode === 'side-by-side';
  const displayLines =
    !showAll && lines.length > TRUNCATION_LIMIT
      ? lines.slice(0, TRUNCATION_LIMIT)
      : lines;
  const displayPairs =
    !showAll && pairedLines.length > TRUNCATION_LIMIT
      ? pairedLines.slice(0, TRUNCATION_LIMIT)
      : pairedLines;
  const totalCount = isSbs ? pairedLines.length : lines.length;
  const displayCount = isSbs ? displayPairs.length : displayLines.length;
  const isTruncated = !showAll && totalCount > TRUNCATION_LIMIT;

  return (
    <>
      {isSbs ? (
        <div className="diff-content-sbs">
          {displayPairs.map((pair, i) => (
            <SbsRow key={i} pair={pair} index={i} />
          ))}
        </div>
      ) : (
        <div className="diff-content">
          {displayLines.map((line, i) => (
            <UnifiedLine
              key={i}
              line={line}
              index={i}
              hunkHeaderMap={hunkHeaderMap}
            />
          ))}
        </div>
      )}
      {isTruncated && (
        <TruncationNotice
          shown={displayCount}
          total={totalCount}
          onShowAll={onShowAll}
        />
      )}
    </>
  );
}

function useDiffTokenizer(
  parsed: ReturnType<typeof parseDiff>,
  cacheKey: string,
  onHunkCount?: (n: number) => void
) {
  const [lines, setLines] = useState<HighlightedLine[]>([]);
  const [pairedLines, setPairedLines] = useState<SideBySidePair[]>([]);
  const [showAll, setShowAll] = useState(false);
  const genRef = useRef(0);

  const setEntry = useShikiGcStore((s) => s.setEntry);
  const setHighlightOutput = useShikiGcStore((s) => s.setHighlightOutput);
  const touchTab = useShikiGcStore((s) => s.touchTab);
  const gcEntry = useShikiGcStore((s) => s.entries.get(cacheKey));

  // Refresh last-viewed timestamp on mount and whenever the cache key changes.
  // No dep-less effect — that would re-run on every render triggered by
  // touchTab's own store mutation, causing an infinite loop.
  useEffect(() => {
    touchTab(cacheKey);
  }, [cacheKey, touchTab]);

  useEffect(() => {
    const { rawLines, hunkHeaderMap, lang } = parsed;
    const gen = ++genRef.current;
    setShowAll(false);
    const plain = rawLines.map((l) => ({
      ...l,
      tokens: null as ThemedToken[] | null,
    }));
    setLines(plain);
    setPairedLines(buildPairs(plain, hunkHeaderMap));
    if (onHunkCount) onHunkCount(hunkHeaderMap.size);
    if (rawLines.length === 0) return;

    // Check if we have a valid cached highlight for this exact source.
    const sourceKey = rawLines.map((l) => l.content).join('\n');
    const cached = gcEntry;
    if (
      cached &&
      cached.source === sourceKey &&
      cached.language === lang &&
      cached.highlightOutput !== null
    ) {
      const tokenLines = cached.highlightOutput as ThemedToken[][];
      const highlighted = rawLines.map((line, i) => ({
        ...line,
        tokens: tokenLines[i] ?? null,
      }));
      setLines(highlighted);
      setPairedLines(buildPairs(highlighted, hunkHeaderMap));
      return;
    }

    const subset =
      rawLines.length > TRUNCATION_LIMIT
        ? rawLines.slice(0, TRUNCATION_LIMIT)
        : rawLines;
    const subsetSource = subset.map((l) => l.content).join('\n');
    // Register source in GC store immediately (null output until async completes).
    setEntry(cacheKey, subsetSource, lang, null);

    tokenizeCode(subsetSource, lang)
      .then((tokenLines) => {
        if (gen !== genRef.current) return;
        setHighlightOutput(cacheKey, tokenLines, {
          source: subsetSource,
          language: lang,
        });
        const highlighted = rawLines.map((line, i) => ({
          ...line,
          tokens: tokenLines[i] ?? null,
        }));
        setLines(highlighted);
        setPairedLines(buildPairs(highlighted, hunkHeaderMap));
      })
      .catch(() => {
        /* tokenization failure is non-fatal — plain text already shown */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, onHunkCount, cacheKey]);

  // Re-apply highlights from cache when GC evicts and re-highlights externally.
  useEffect(() => {
    if (gcEntry?.highlightOutput === null) {
      // GC evicted — clear our local highlight state; lines stay plain text.
      setLines((prev) => prev.map((l) => ({ ...l, tokens: null })));
    }
  }, [gcEntry?.highlightOutput]);

  return { lines, pairedLines, showAll, setShowAll };
}

export function DiffViewer({
  diff,
  filePath,
  loading = false,
  mode = 'unified',
  wordWrap = false,
  onHunkCount,
}: DiffViewerProps) {
  const parsed = useMemo(() => parseDiff(diff, filePath), [diff, filePath]);
  const cacheKey = `diff:${filePath}`;
  const { lines, pairedLines, showAll, setShowAll } = useDiffTokenizer(
    parsed,
    cacheKey,
    onHunkCount
  );

  return (
    <div
      className={['diff-viewer', wordWrap && 'word-wrap']
        .filter(Boolean)
        .join(' ')}
      role="region"
      aria-label="File diff"
    >
      {loading && <div className="diff-loading">loading diff...</div>}
      {!loading && lines.length === 0 && (
        <div className="diff-empty">no changes</div>
      )}
      {!loading && lines.length > 0 && (
        <DiffContent
          mode={mode}
          lines={lines}
          pairedLines={pairedLines}
          hunkHeaderMap={parsed.hunkHeaderMap}
          showAll={showAll}
          onShowAll={() => setShowAll(true)}
        />
      )}
    </div>
  );
}

export default DiffViewer;
