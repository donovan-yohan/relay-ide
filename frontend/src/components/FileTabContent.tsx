import React, { useCallback, useEffect, useState } from 'react';
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
  content?: string;
  binary?: boolean;
  truncated?: boolean;
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
  refreshVersion,
  diff,
  content,
  binary,
  truncated,
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
  const viewMode: 'html' | 'diff' | 'code' =
    tabType === 'html' ? 'html' : tabType === 'diff' ? 'diff' : 'code';
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
    if (viewMode === 'html' && token) {
      return (
        <HtmlTabView
          filePath={filePath}
          fileName={fileName}
          token={token}
          refreshVersion={refreshVersion}
        />
      );
    }
    if (viewMode === 'diff') {
      if (!diff) {
        return <div className="empty-viewer">no changes</div>;
      }
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
    if (binary) {
      return <div className="empty-viewer">binary file — cannot display</div>;
    }
    if (truncated) {
      return (
        <div className="empty-viewer">file too large to display inline</div>
      );
    }
    const code = content ?? '';
    return (
      <div
        className={['raw-file', wordWrap ? 'word-wrap' : '']
          .filter(Boolean)
          .join(' ')}
      >
        {renderCode ? (
          renderCode({ code, language: languageFromPath(filePath) })
        ) : (
          <CodeBlock code={code} language={languageFromPath(filePath)} />
        )}
      </div>
    );
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
