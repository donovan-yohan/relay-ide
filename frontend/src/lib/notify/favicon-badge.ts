// Favicon dot-overlay for unread DM/mention channels (#1308 slice 5 item 2).
//
// The favicon IDENTITY does not change: the base image is whatever the document
// already points at (`/icon.svg`, the #1284-era mark), drawn into a canvas with
// a small accent dot composited over its bottom-right corner. Nothing here
// swaps in a different artwork, and clearing restores the ORIGINAL href — not a
// re-render of it — so a browser that had already cached the icon keeps it.
//
// Everything is best-effort. A canvas that will not give a 2D context
// (happy-dom, a locked-down webview), an icon that fails to decode, a document
// with no `<link rel="icon">` — each degrades to "no badge", never to a throw:
// the title count and the OS notification are separate surfaces and must not be
// taken down with it.
import { createLogger } from '../logger.js';

const logger = createLogger('notify-favicon');

/** Canvas edge in CSS pixels. 64 is the largest size browsers ask for. */
const FAVICON_CANVAS_SIZE = 64;
/** Dot radius, as a fraction of the canvas edge. */
const DOT_RADIUS_RATIO = 0.22;
/** Ring drawn under the dot so it reads against a light OR dark tab strip. */
const DOT_RING_RATIO = 0.05;
/** Terracotta — `--accent` in `App.css`, DESIGN.md's one brand colour. */
const DOT_COLOR = '#d97757';
/** Pure black — `--bg`. The ring is a cut-out, not a second colour. */
const DOT_RING_COLOR = '#000000';
/**
 * MIME type of the badged data URL, which `canvasFaviconRenderer` always
 * encodes as PNG.
 *
 * The document ships `<link rel="icon" href="/icon.svg" type="image/svg+xml">`.
 * Rewriting only `href` would leave a PNG payload advertised as SVG, and `type`
 * is a support HINT browsers are entitled to act on: an engine that honours it
 * can refuse to decode the resource, so the tab silently loses its icon (or
 * keeps the stale one) exactly when the badge is supposed to appear.
 */
const BADGED_ICON_TYPE = 'image/png';

/** Renders a badged data URL from a base icon href, or null if it cannot. */
export type FaviconRenderer = (baseHref: string) => Promise<string | null>;

export interface FaviconBadgeOptions {
  /** Defaults to the ambient document; null disables the lane entirely. */
  doc?: Document | null;
  /** Injectable so tests do not need a real canvas. */
  render?: FaviconRenderer;
}

export interface FaviconBadge {
  /** Show or hide the dot. Idempotent; safe to call on every render. */
  set: (active: boolean) => void;
  /** Restore the original href and drop the cached badge. */
  reset: () => void;
}

/**
 * Locate the icon link. NEVER creates one: this lane overlays the app's icon
 * and has no artwork of its own, so a document that ships no icon leaves it
 * inert rather than minting an empty `<link rel="icon">` that would suppress
 * the browser's own `/favicon.ico` probe.
 *
 * `rel~="icon"` matches `icon` and `shortcut icon` alike; the FIRST match wins
 * because that is the one the browser resolves.
 */
function findIconLink(doc: Document): HTMLLinkElement | null {
  return doc.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

/**
 * Default renderer: draw the base icon, then a ringed dot over its bottom-right.
 *
 * SVG sources work because `/icon.svg` carries intrinsic `width`/`height` —
 * without those, `drawImage` sizes an SVG inconsistently across engines. Same
 * origin throughout, so the canvas is never tainted and `toDataURL` is legal.
 */
export const canvasFaviconRenderer: FaviconRenderer = async (baseHref) => {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_CANVAS_SIZE;
  canvas.height = FAVICON_CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = await loadImage(baseHref);
  if (!image) return null;
  try {
    ctx.drawImage(image, 0, 0, FAVICON_CANVAS_SIZE, FAVICON_CANVAS_SIZE);
    const radius = FAVICON_CANVAS_SIZE * DOT_RADIUS_RATIO;
    const ring = FAVICON_CANVAS_SIZE * DOT_RING_RATIO;
    const cx = FAVICON_CANVAS_SIZE - radius - ring;
    const cy = FAVICON_CANVAS_SIZE - radius - ring;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + ring, 0, Math.PI * 2);
    ctx.fillStyle = DOT_RING_COLOR;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = DOT_COLOR;
    ctx.fill();
    return canvas.toDataURL('image/png');
  } catch (err) {
    logger.warn('favicon badge render failed', err);
    return null;
  }
};

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * Per-instance state in a closure (the `createNotifyGate` precedent): the base
 * href is captured ONCE, on construction, before anything can have badged it.
 */
export function createFaviconBadge(
  options: FaviconBadgeOptions = {}
): FaviconBadge {
  const doc =
    options.doc === undefined
      ? typeof document === 'undefined'
        ? null
        : document
      : options.doc;
  const render = options.render ?? canvasFaviconRenderer;
  const link = doc ? findIconLink(doc) : null;
  // `getAttribute`, not `.href`: the property resolves to an absolute URL, and
  // writing that back would silently rewrite a relative href the app ships.
  const baseHref = link?.getAttribute('href') ?? null;
  // Captured alongside the href and restored with it: the two attributes
  // describe ONE resource and must never be written apart.
  const baseType = link?.getAttribute('type') ?? null;
  let badgedHref: string | null = null;
  let rendering = false;
  /** What the operator last asked for; the async render checks it on landing. */
  let active = false;

  function apply(): void {
    if (!link || baseHref === null) return;
    const badged = active ? badgedHref : null;
    const nextHref = badged ?? baseHref;
    if (link.getAttribute('href') !== nextHref) {
      link.setAttribute('href', nextHref);
    }
    const nextType = badged === null ? baseType : BADGED_ICON_TYPE;
    if (nextType === null) {
      // The document shipped no `type`; badging must not invent a permanent one.
      link.removeAttribute('type');
    } else if (link.getAttribute('type') !== nextType) {
      link.setAttribute('type', nextType);
    }
  }

  return {
    set: (next) => {
      if (active === next) {
        // Still re-apply: a hot-reload or an unrelated writer may have reset
        // the href underneath us, and this call is cheap when it has not.
        apply();
        return;
      }
      active = next;
      if (!next || badgedHref || rendering || !baseHref) {
        apply();
        return;
      }
      rendering = true;
      void render(baseHref)
        .then((result) => {
          badgedHref = result;
        })
        .catch((err) => {
          logger.warn('favicon badge render rejected', err);
        })
        .finally(() => {
          rendering = false;
          // Re-read `active` rather than trusting the value at call time: the
          // operator may have read the channel while the icon was decoding, and
          // painting a dot onto an already-clear tab is the one visible bug
          // this lane can produce.
          apply();
        });
    },
    reset: () => {
      active = false;
      badgedHref = null;
      apply();
    },
  };
}
