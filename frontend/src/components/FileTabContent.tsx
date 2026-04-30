import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFileDiff } from '../lib/api.js';
import { parseLineReference } from '../lib/file-tree-utils.js';
import type { FileTabType } from '../lib/stores/ui.js';
import type { WorkspaceTabSummary } from '../lib/workspace-summary.js';
import CodeBlock from './CodeBlock.js';
import DiffViewer from './DiffViewer.js';
import './FileTabContent.css';

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  css: 'css',
  scss: 'scss',
  html: 'html',
  svelte: 'svelte',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  graphql: 'graphql',
};

export function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? 'text';
}

export function buildCacheKey(filePath: string, base: string | null): string {
  return `${filePath}::${base ?? 'working'}`;
}

interface DiffCache {
  diffCache: Map<string, string>;
  loadingPaths: Set<string>;
  errorPaths: Map<string, string>;
  fetchDiff: (filePath: string, base: string | null) => void;
  clearEntry: (key: string) => void;
}

export function useFileDiffCache(workspacePath: string): DiffCache {
  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(new Map());
  // Tracks keys with an in-flight or already-cached fetch. A ref avoids the
  // stale-closure dance of depending on `diffCache`/`loadingPaths` and stops
  // duplicate fetches even when several `fetchDiff` calls land in the same
  // microtask before state updates flush.
  const inFlightRef = useRef<Set<string>>(new Set());
  const cachedRef = useRef<Set<string>>(new Set());

  const fetchDiff = useCallback(
    (filePath: string, base: string | null) => {
      const key = buildCacheKey(filePath, base);
      if (cachedRef.current.has(key) || inFlightRef.current.has(key)) return;
      inFlightRef.current.add(key);
      setLoadingPaths((prev) => new Set([...prev, key]));
      fetchFileDiff(workspacePath, filePath, base ?? undefined)
        .then(
          (result) => {
            if (result.error) {
              setErrorPaths(
                (prev) => new Map([...prev, [key, result.error as string]])
              );
            } else {
              cachedRef.current.add(key);
              setDiffCache((prev) => new Map([...prev, [key, result.diff]]));
            }
          },
          (err: unknown) => {
            const msg =
              err instanceof Error ? err.message : 'failed to load diff';
            setErrorPaths((prev) => new Map([...prev, [key, msg]]));
          }
        )
        .finally(() => {
          inFlightRef.current.delete(key);
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        });
    },
    [workspacePath]
  );

  const clearEntry = useCallback((key: string) => {
    cachedRef.current.delete(key);
    setDiffCache((prev) => {
      const m = new Map(prev);
      m.delete(key);
      return m;
    });
    setErrorPaths((prev) => {
      const m = new Map(prev);
      m.delete(key);
      return m;
    });
  }, []);

  return { diffCache, loadingPaths, errorPaths, fetchDiff, clearEntry };
}

interface HtmlTabViewProps {
  filePath: string;
  fileName: string;
  token: string;
  refreshVersion?: number | undefined;
}

function HtmlTabView({
  filePath,
  fileName,
  token,
  refreshVersion,
}: HtmlTabViewProps) {
  const [sandboxDismissed, setSandboxDismissed] = useState(false);
  const [lastPath, setLastPath] = useState('');

  useEffect(() => {
    if (filePath !== lastPath) {
      setLastPath(filePath);
      setSandboxDismissed(false);
    }
  }, [filePath, lastPath]);

  useEffect(() => {
    if (!sandboxDismissed) {
      const timer = setTimeout(() => setSandboxDismissed(true), 4000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [sandboxDismissed]);

  const src = `/browser-content/${token}/${fileName}${refreshVersion ? `?v=${refreshVersion}` : ''}`;
  return (
    <div className="html-viewer">
      {!sandboxDismissed && (
        <div className="sandbox-notice">
          <span className="notice-text">
            rendered in sandbox · some web features may not work
          </span>
          <button
            className="notice-dismiss"
            onClick={() => setSandboxDismissed(true)}
            aria-label="dismiss notice"
          >
            ×
          </button>
        </div>
      )}
      <iframe
        src={src}
        sandbox="allow-scripts"
        title={`HTML preview: ${fileName}`}
        className="html-iframe"
      />
    </div>
  );
}

interface FileTabSummaryProps {
  summary: WorkspaceTabSummary;
}

function FileTabSummaryHeader({ summary }: FileTabSummaryProps) {
  const segments = summary.breadcrumb?.segments ?? [];
  return (
    <div className="file-tab-summary">
      <div className="file-tab-summary__crumb">
        {summary.breadcrumb?.repoLabel && (
          <span
            className="file-tab-summary__repo-badge"
            style={
              summary.breadcrumb.repoColor
                ? { background: summary.breadcrumb.repoColor }
                : undefined
            }
          >
            {summary.breadcrumb.repoLabel}
          </span>
        )}
        {segments.map((seg, i) => {
          const last = i === segments.length - 1;
          return (
            <React.Fragment key={`${seg}-${i}`}>
              <span
                className={[
                  'file-tab-summary__seg',
                  last ? 'file-tab-summary__seg--name' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {seg}
              </span>
              {!last && <span className="file-tab-summary__sep">/</span>}
            </React.Fragment>
          );
        })}
      </div>
      <div className="file-tab-summary__pills">
        {summary.pills.map((pill, i) => (
          <span
            key={`${pill.label}-${i}`}
            className={`file-tab-summary__pill file-tab-summary__pill--${pill.kind}`}
          >
            {pill.kind === 'dirty' && (
              <span className="file-tab-summary__pill-dot" />
            )}
            {pill.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface FileTabContentProps {
  filePath: string;
  fileName: string;
  tabType?: FileTabType | undefined;
  token?: string | undefined;
  isChanged: boolean;
  refreshVersion?: number | undefined;

  diff: string;
  loading: boolean;
  error: string | null;
  diffViewMode: 'unified' | 'side-by-side';
  wordWrap: boolean;

  hasActiveSession: boolean;
  onInjectReference?: ((reference: string) => void) | undefined;
  onRetry: () => void;
  onCloseTab: () => void;

  renderDiff?:
    | ((props: {
        diff: string;
        filePath: string;
        mode: 'unified' | 'side-by-side';
        wordWrap: boolean;
      }) => React.ReactNode)
    | undefined;
  renderCode?:
    | ((props: { code: string; language: string }) => React.ReactNode)
    | undefined;

  summary?: WorkspaceTabSummary | undefined;
  showSummary?: boolean;
}

export function FileTabContent({
  filePath,
  fileName,
  tabType,
  token,
  isChanged,
  refreshVersion,
  diff,
  loading,
  error,
  diffViewMode,
  wordWrap,
  hasActiveSession,
  onInjectReference,
  onRetry,
  onCloseTab,
  renderDiff,
  renderCode,
  summary,
  showSummary = true,
}: FileTabContentProps) {
  const handleDiffClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const lineEl = target.closest('.line-number, .d2h-code-linenumber');
      if (!lineEl || !hasActiveSession) return;
      const lineNum = parseInt(lineEl.textContent?.trim() ?? '', 10);
      if (!Number.isNaN(lineNum) && lineNum > 0) {
        onInjectReference?.(parseLineReference(filePath, lineNum));
      }
    },
    [filePath, hasActiveSession, onInjectReference]
  );

  const body = (() => {
    if (loading) {
      return (
        <div className="loading-viewer">
          <span className="spinner">&#x280B;</span> loading {fileName}...
        </div>
      );
    }
    if (error) {
      return (
        <div className="error-viewer">
          <div className="error-text">failed to load diff: {error}</div>
          <div className="error-actions">
            <button className="retry-btn" onClick={onRetry}>
              retry
            </button>
            <button className="close-btn" onClick={onCloseTab}>
              close tab
            </button>
          </div>
        </div>
      );
    }
    if (tabType === 'html' && token) {
      return (
        <HtmlTabView
          filePath={filePath}
          fileName={fileName}
          token={token}
          refreshVersion={refreshVersion}
        />
      );
    }
    if (isChanged && diff) {
      return (
        <div className="diff-wrapper" onClick={handleDiffClick}>
          {renderDiff ? (
            renderDiff({ diff, filePath, mode: diffViewMode, wordWrap })
          ) : (
            <DiffViewer
              diff={diff}
              filePath={filePath}
              mode={diffViewMode}
              wordWrap={wordWrap}
            />
          )}
        </div>
      );
    }
    if (!isChanged) {
      return (
        <div
          className={['raw-file', wordWrap ? 'word-wrap' : '']
            .filter(Boolean)
            .join(' ')}
        >
          {renderCode ? (
            renderCode({
              code: diff || '(empty file)',
              language: languageFromPath(filePath),
            })
          ) : (
            <CodeBlock
              code={diff || '(empty file)'}
              language={languageFromPath(filePath)}
            />
          )}
        </div>
      );
    }
    return <div className="empty-viewer">no diff available</div>;
  })();

  return (
    <div className="file-tab-content">
      {showSummary && summary && <FileTabSummaryHeader summary={summary} />}
      <div className="file-tab-content__body" role="tabpanel">
        {body}
      </div>
    </div>
  );
}

export default FileTabContent;
