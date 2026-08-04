// @vitest-environment happy-dom
// #1308 slice 5 item 2 — the two in-app delivery surfaces: the favicon dot and
// the title count, driven through their update AND clear cycles.
//
// The canvas compositor is injected. happy-dom has no 2D context, and the real
// renderer's contract ("produce a data URL or null") is exactly the seam a test
// should stand at: what matters is that the link href moves to the badged icon
// and comes BACK to the original byte-for-byte.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFaviconBadge } from '../../frontend/src/lib/notify/favicon-badge.js';
import { createTitleBadge } from '../../frontend/src/lib/notify/title-badge.js';

const BASE_ICON = '/icon.svg';
const BADGED = 'data:image/png;base64,BADGED';

function resetDocument(): void {
  document.head.innerHTML = `<link rel="icon" href="${BASE_ICON}" type="image/svg+xml" />`;
  document.title = 'Relay';
}

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

function iconHref(): string | null {
  return iconLink()?.getAttribute('href') ?? null;
}

function iconType(): string | null {
  return iconLink()?.getAttribute('type') ?? null;
}

beforeEach(() => {
  resetDocument();
});

describe('favicon badge', () => {
  it('overlays the EXISTING icon and restores it byte-for-byte', async () => {
    const render = vi.fn(async () => BADGED);
    const badge = createFaviconBadge({ render });

    badge.set(true);
    await vi.waitFor(() => expect(iconHref()).toBe(BADGED));
    // Identity preserved: the base was read from the document, not hard-coded.
    expect(render).toHaveBeenCalledWith(BASE_ICON);

    badge.set(false);
    expect(iconHref()).toBe(BASE_ICON);
  });

  it('rewrites the MIME type with the href and restores it', async () => {
    // The document ships `type="image/svg+xml"` and the composite is a PNG data
    // URL. `type` is a support hint browsers are entitled to act on, so leaving
    // it stale can cost the tab its icon exactly when the dot should appear.
    const badge = createFaviconBadge({ render: async () => BADGED });
    expect(iconType()).toBe('image/svg+xml');

    badge.set(true);
    await vi.waitFor(() => expect(iconHref()).toBe(BADGED));
    expect(iconType()).toBe('image/png');

    badge.set(false);
    expect(iconHref()).toBe(BASE_ICON);
    expect(iconType()).toBe('image/svg+xml');
  });

  it('invents no MIME type for a link that shipped none', async () => {
    document.head.innerHTML = `<link rel="icon" href="${BASE_ICON}" />`;
    const badge = createFaviconBadge({ render: async () => BADGED });
    badge.set(true);
    await vi.waitFor(() => expect(iconHref()).toBe(BADGED));
    expect(iconType()).toBe('image/png');
    badge.set(false);
    expect(iconType()).toBeNull();
  });

  it('renders the composite once across many update cycles', async () => {
    const render = vi.fn(async () => BADGED);
    const badge = createFaviconBadge({ render });
    badge.set(true);
    await vi.waitFor(() => expect(iconHref()).toBe(BADGED));
    badge.set(false);
    badge.set(true);
    badge.set(false);
    badge.set(true);
    await vi.waitFor(() => expect(iconHref()).toBe(BADGED));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('does not paint a dot onto a tab that was read while the icon decoded', async () => {
    let resolveRender: (value: string) => void = () => {};
    const render = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRender = resolve;
        })
    );
    const badge = createFaviconBadge({ render });
    badge.set(true);
    // The operator reads the channel before the composite lands.
    badge.set(false);
    resolveRender(BADGED);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    expect(iconHref()).toBe(BASE_ICON);
  });

  it('degrades to the base icon when the composite cannot be produced', async () => {
    const badge = createFaviconBadge({ render: async () => null });
    badge.set(true);
    await Promise.resolve();
    expect(iconHref()).toBe(BASE_ICON);
  });

  it('survives a renderer that rejects', async () => {
    const badge = createFaviconBadge({
      render: async () => {
        throw new Error('canvas unavailable');
      },
    });
    expect(() => badge.set(true)).not.toThrow();
    await vi.waitFor(() => expect(iconHref()).toBe(BASE_ICON));
  });

  it('is inert with no document', () => {
    const badge = createFaviconBadge({ doc: null, render: async () => BADGED });
    expect(() => {
      badge.set(true);
      badge.set(false);
      badge.reset();
    }).not.toThrow();
  });

  it('mints no icon link for a document that ships none', async () => {
    document.head.innerHTML = '';
    const render = vi.fn(async () => BADGED);
    const badge = createFaviconBadge({ render });
    badge.set(true);
    await Promise.resolve();
    // An empty `<link rel="icon">` would suppress the browser's own
    // `/favicon.ico` probe, so the lane stays inert instead.
    expect(document.querySelector('link[rel~="icon"]')).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });
});

describe('title count', () => {
  it('prefixes the count and restores the clean title at zero', () => {
    const badge = createTitleBadge();
    badge.set(3);
    expect(document.title).toBe('(3) Relay');
    badge.set(1);
    expect(document.title).toBe('(1) Relay');
    badge.set(0);
    expect(document.title).toBe('Relay');
  });

  it('restores the clean title on reset (unmount)', () => {
    const badge = createTitleBadge();
    badge.set(5);
    badge.reset();
    expect(document.title).toBe('Relay');
  });

  it('cannot compound its own prefix across a remount', () => {
    createTitleBadge().set(2);
    expect(document.title).toBe('(2) Relay');
    // A second badger constructed over the already-badged document (hot reload,
    // StrictMode double-mount) must capture `Relay`, not `(2) Relay`.
    const second = createTitleBadge();
    second.set(3);
    expect(document.title).toBe('(3) Relay');
    second.set(0);
    expect(document.title).toBe('Relay');
  });

  it('is inert with no document', () => {
    const badge = createTitleBadge({ doc: null });
    expect(() => {
      badge.set(4);
      badge.reset();
    }).not.toThrow();
  });
});
