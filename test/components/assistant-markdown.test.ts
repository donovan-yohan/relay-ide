// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { AssistantMarkdown } from '../../frontend/src/components/chat/AssistantMarkdown.js';

// Agent rows collapse fenced code blocks into cards; inline spans must stay
// inline. react-markdown wraps block code in a `<pre>` while inline spans are
// not wrapped, so classification keys off that wrapper rather than source line
// positions — a CommonMark inline span can legally span source lines.
describe('AssistantMarkdown code classification', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (text: string): Promise<void> => {
    await act(async () => {
      root.render(
        React.createElement(AssistantMarkdown, {
          text,
          keyPrefix: 'test',
          codeBlockPresentation: 'card',
        })
      );
    });
  };

  it('keeps a multi-line-source inline code span inline, not a block card', async () => {
    // The backtick span straddles a soft line break, so its source position
    // spans two lines even though the rendered content is a single inline span.
    await render('prefix `foo\nbar` suffix');
    const inline = container.querySelector('.tl-md-code');
    expect(inline).not.toBeNull();
    expect(inline?.textContent).toContain('foo');
    expect(inline?.textContent).toContain('bar');
    expect(container.querySelector('.ch-agent-card')).toBeNull();
  });

  it('promotes a single-line fence without a language to a block card', async () => {
    await render('```\nplain fence\n```');
    expect(container.querySelector('.ch-agent-card')).not.toBeNull();
    expect(container.querySelector('.tl-md-code')).toBeNull();
  });

  it('promotes a fenced block with a language to a block card', async () => {
    await render('```ts\nconst x = 1;\n```');
    const card = container.querySelector('.ch-agent-card');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-agent-card-kind')).toBe('output');
    expect(container.querySelector('.tl-md-code')).toBeNull();
  });
});
