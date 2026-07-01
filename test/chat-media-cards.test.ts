// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentImageGenerationItemV2,
  AgentImageViewItemV2,
  AgentWebSearchItemV2,
} from '../shared/agent-chat-protocol-v2.js';
import {
  ImageGenerationCard,
  ImageViewCard,
  WebSearchCard,
} from '../frontend/src/components/chat/MediaCard.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(node: React.ReactElement): void {
  act(() => root.render(node));
}

function webSearch(
  overrides: Partial<AgentWebSearchItemV2> = {}
): AgentWebSearchItemV2 {
  return {
    type: 'webSearch',
    id: 'search-1',
    query: 'relay ide',
    ...overrides,
  };
}

function imageView(
  overrides: Partial<AgentImageViewItemV2> = {}
): AgentImageViewItemV2 {
  return {
    type: 'imageView',
    id: 'image-1',
    source: '/tmp/screenshot.png',
    ...overrides,
  };
}

function imageGeneration(
  overrides: Partial<AgentImageGenerationItemV2> = {}
): AgentImageGenerationItemV2 {
  return {
    type: 'imageGeneration',
    id: 'gen-1',
    prompt: 'a red terminal',
    ...overrides,
  };
}

describe('WebSearchCard', () => {
  it('renders a labeled card with the query, not raw text', () => {
    render(React.createElement(WebSearchCard, { item: webSearch() }));
    const card = container.querySelector('.mcard--search');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('aria-label')).toBe('web search');
    expect(container.querySelector('.mcard__label')?.textContent).toBe(
      'web search'
    );
    expect(container.querySelector('.mcard__query')?.textContent).toBe(
      'relay ide'
    );
    expect(container.querySelector('pre')).toBeNull();
  });

  it('shows the action when present', () => {
    render(
      React.createElement(WebSearchCard, {
        item: webSearch({ action: 'open' }),
      })
    );
    expect(container.querySelector('.mcard__meta')?.textContent).toBe('open');
  });
});

describe('ImageViewCard', () => {
  it('renders a file-path source as a chip, not an <img>', () => {
    render(React.createElement(ImageViewCard, { item: imageView() }));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.mcard__src')?.textContent).toBe(
      '/tmp/screenshot.png'
    );
  });

  it('renders an http(s) source as an inline <img> with alt text', () => {
    render(
      React.createElement(ImageViewCard, {
        item: imageView({
          source: 'https://example.com/a.png',
          description: 'a diagram',
        }),
      })
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img?.getAttribute('alt')).toBe('a diagram');
    expect(container.querySelector('.mcard__desc')?.textContent).toBe(
      'a diagram'
    );
  });
});

describe('ImageGenerationCard', () => {
  it('renders the prompt caption and no body without an imageUrl', () => {
    render(
      React.createElement(ImageGenerationCard, { item: imageGeneration() })
    );
    expect(container.querySelector('.mcard__label')?.textContent).toBe(
      'generated image'
    );
    expect(container.querySelector('.mcard__desc')?.textContent).toBe(
      'a red terminal'
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders an inline <img> when imageUrl is a data URI', () => {
    render(
      React.createElement(ImageGenerationCard, {
        item: imageGeneration({
          imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
        }),
      })
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('a red terminal');
  });

  it('ignores a non-renderable imageUrl scheme', () => {
    render(
      React.createElement(ImageGenerationCard, {
        item: imageGeneration({ imageUrl: 'file:///etc/passwd' }),
      })
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.mcard__body')).toBeNull();
  });
});
