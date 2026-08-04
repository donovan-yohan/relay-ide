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

// Sanitization coverage ported from the retired chat-v2-rendering.test.ts.
// AssistantMarkdown is the shared agent-markdown renderer on the primary
// channel timeline; these behaviors are the security guarantees against
// agent-supplied output (auto-fetching image beacons, dangerous-scheme links,
// and raw-HTML/markup injection), so they must be tested against the component
// directly rather than any one surface.
describe('AssistantMarkdown sanitization', () => {
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
        })
      );
    });
  };

  it('renders a markdown image as a click-to-load link, never an auto-fetching <img>', async () => {
    // A live `<img src>` would fetch the remote host the instant the message
    // renders, beaconing the viewer's IP/timing to whatever URL the agent
    // embedded. The component renders a link instead so nothing is fetched
    // until the operator explicitly opens it.
    await render('![a diagram](https://attacker.example/pixel.png)');

    expect(container.querySelector('.tl-markdown img')).toBeNull();
    const imgLink = container.querySelector<HTMLAnchorElement>(
      '.tl-markdown a.tl-md-img-link'
    );
    expect(imgLink).not.toBeNull();
    expect(imgLink?.getAttribute('href')).toBe(
      'https://attacker.example/pixel.png'
    );
    expect(imgLink?.getAttribute('target')).toBe('_blank');
    expect(imgLink?.getAttribute('rel')).toContain('noopener');
    expect(imgLink?.textContent).toContain('a diagram');
  });

  it('neutralizes a javascript: link so the dangerous scheme never reaches href', async () => {
    // react-markdown's default urlTransform strips non-safe protocols
    // (only http/https/ircs?/mailto/xmpp survive), so a `javascript:` href is
    // emptied before it can become a clickable script-execution vector.
    await render('[click me](javascript:window.__pwned=true)');

    const link = container.querySelector<HTMLAnchorElement>('.tl-markdown a');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('click me');
    expect(link?.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
    expect(link?.getAttribute('href')).toBe('');
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('treats raw HTML as inert text — no live element, no script execution', async () => {
    // react-markdown is used without rehype-raw, so an embedded HTML string is
    // shown as inert text rather than parsed into live DOM. An `onerror` image
    // must never fire.
    await render('<img src="x" onerror="window.__pwned = true">');

    expect(container.querySelector('.tl-markdown img')).toBeNull();
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
