/**
 * AssistantMarkdown — renders assistant message text as markdown.
 *
 * Uses react-markdown with default settings (no raw-HTML passthrough — the
 * underlying HTML string is never parsed as elements, so this is safe against
 * markup injection from agent output) plus remark-gfm for tables/strikethrough.
 * Code fences reuse the shared `CodeBlock` component (shiki highlighting,
 * same GC-aware cache as elsewhere in the app); inline code and prose stay
 * plain monospace text matching the TUI aesthetic.
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
      if (!match) {
        return (
          <code className="tl-md-code" {...rest}>
            {children}
          </code>
        );
      }
      const language = match[1] ?? 'text';
      const codeText = String(children).replace(/\n$/, '');
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
