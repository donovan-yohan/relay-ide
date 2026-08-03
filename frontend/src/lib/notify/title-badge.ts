// Document-title unread count (#1308 slice 5 item 2).
//
// `(3) Relay` while unread DM/mention CHANNELS exist, and the exact original
// title back at zero. The base is captured once from the live document rather
// than hard-coded, so the tab keeps whatever `index.html` shipped.
import { formatNotifyTitle, stripNotifyTitlePrefix } from './copy.js';

export interface TitleBadgeOptions {
  /** Defaults to the ambient document; null disables the lane entirely. */
  doc?: Document | null;
}

export interface TitleBadge {
  /** Apply a count. Idempotent; 0 restores the captured base title. */
  set: (count: number) => void;
  /** Restore the base title. */
  reset: () => void;
}

export function createTitleBadge(options: TitleBadgeOptions = {}): TitleBadge {
  const doc =
    options.doc === undefined
      ? typeof document === 'undefined'
        ? null
        : document
      : options.doc;
  // Stripped on capture: a hot reload constructs a second badger over a
  // document this lane may already have prefixed, and `(2) Relay` captured as
  // the base compounds to `(3) (2) Relay` forever after.
  const base = doc ? stripNotifyTitlePrefix(doc.title) : '';

  function apply(count: number): void {
    if (!doc) return;
    const next = formatNotifyTitle(base, Math.max(0, Math.trunc(count)));
    if (doc.title === next) return;
    doc.title = next;
  }

  return {
    set: (count) => apply(count),
    reset: () => apply(0),
  };
}
