/**
 * AssistantMarkdown — renders assistant message text as markdown.
 *
 * Uses react-markdown with default settings (no raw-HTML passthrough — the
 * underlying HTML string is never parsed as elements, so this is safe against
 * markup injection from agent output) plus remark-gfm for tables/strikethrough.
 * Code fences (with or without a language) reuse the shared `CodeBlock`
 * component (shiki highlighting, same GC-aware cache as elsewhere in the
 * app); inline code and prose stay plain monospace text matching the TUI
 * aesthetic. Markdown images render as a click-to-load link rather than a
 * live `<img>` so agent-supplied URLs never auto-fetch from the operator's
 * browser.
 */

import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '../CodeBlock.js';

interface MarkdownCodeNode {
  position?: { start?: { offset?: number } };
}

function buildComponents(keyPrefix: string): Components {
  return {
    a: ({ href, children, ...rest }) => (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    // Fenced code blocks render their own <pre> inside the `code` renderer
    // below (so shiki tokens can be laid out per-line); avoid double-wrapping.
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, node, ...rest }) => {
      const match = /language-(\S+)/.exec(className ?? '');
      const codeText = String(children).replace(/\n$/, '');
      // A fenced code block only carries a `language-*` class when a
      // language is specified after the ```. Language-less fences and
      // 4-space-indented blocks still render as block-level `<pre><code>`
      // with no className, so fall back to a newline check: anything with
      // an embedded newline is a block, not inline code, and must go
      // through CodeBlock (which preserves whitespace) rather than the
      // plain inline `<code>` path (which inherits `white-space: normal`
      // from `.tl-markdown` and collapses newlines to spaces).
      const isBlock = Boolean(match) || codeText.includes('\n');
      if (!isBlock) {
        return (
          <code className="tl-md-code" {...rest}>
            {children}
          </code>
        );
      }
      const language = match?.[1] ?? 'text';
      const offset =
        (node as MarkdownCodeNode | undefined)?.position?.start?.offset ??
        codeText.length;
      return (
        <div className="tl-md-pre">
          <CodeBlock
            code={codeText}
            language={language}
            showLineNumbers={false}
            cacheKey={`${keyPrefix}:${offset}`}
          />
        </div>
      );
    },
    // Markdown images auto-fetch their remote `src` the instant the message
    // renders (React 19 also emits a `<link rel=preload as=image>`) — a
    // network request to whatever host the agent/tool/web output happened to
    // embed, leaking viewer IP/timing before the operator chooses to look at
    // anything. Render a click-to-load link instead of a live `<img>` so
    // nothing is fetched unless the operator explicitly opens it.
    img: ({ src, alt }) => (
      <a
        className="tl-md-img-link"
        href={typeof src === 'string' ? src : undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        [image{alt ? `: ${alt}` : ''}]
      </a>
    ),
  };
}

interface AssistantMarkdownProps {
  text: string;
  /** Stable id used to scope syntax-highlight cache keys for code fences in this message. */
  keyPrefix: string;
}

export const AssistantMarkdown: React.FC<AssistantMarkdownProps> = ({
  text,
  keyPrefix,
}) => {
  const components = React.useMemo(
    () => buildComponents(keyPrefix),
    [keyPrefix]
  );
  return (
    <div className="tl-text tl-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

export default AssistantMarkdown;
