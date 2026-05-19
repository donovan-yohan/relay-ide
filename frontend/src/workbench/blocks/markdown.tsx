/**
 * MarkdownBlock — Workbench slice 2 of epic #612.
 *
 * Renders static markdown content inline. No external fetch — content is
 * embedded directly in the descriptor meta (descriptor.meta.content).
 *
 * Rendering approach: uses the existing CodeBlock component with language
 * 'markdown', which applies shiki syntax highlighting to the raw source.
 * This matches the codebase's established pattern (FileTabContent uses the
 * same CodeBlock for `.md` files).
 *
 * A dedicated markdown-to-HTML renderer (react-markdown, marked, etc.) is not
 * yet a project dependency. If prose rendering is added in a future slice,
 * the renderer can be upgraded here without touching the descriptor contract.
 */

import React from 'react';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import CodeBlock from '../../components/CodeBlock.js';

import './markdown.css';

export const MarkdownBlock: WorkbenchBlockRenderer<'markdown'> = ({
  descriptor,
  context: _context,
}) => {
  const { content } = descriptor.meta;

  return (
    <div
      className="block-markdown"
      aria-label={`markdown: ${descriptor.title}`}
    >
      <div className="block-markdown__header">
        <div className="block-markdown__kind">markdown</div>
        <div className="block-markdown__title">{descriptor.title}</div>
      </div>
      <div className="block-markdown__body">
        <CodeBlock
          code={content}
          language="markdown"
          showLineNumbers={false}
          cacheKey={`block:markdown:${descriptor.id}`}
        />
      </div>
    </div>
  );
};

export default MarkdownBlock;
