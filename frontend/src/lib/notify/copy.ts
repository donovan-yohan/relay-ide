// Notification copy (#1308 slice 5 item 2). PURE — no DOM, no stores.
//
// One source for every string the delivery surfaces render, so the OS body and
// any later in-app surface cannot drift into describing the same event two ways.
//
// DESIGN.md rules that bind here: lowercase prose, mono spirit, NO emoji —
// including in an OS notification body, which renders on a lock screen next to
// whatever else the operator has running.
//
// Two things deliberately never reach a notification:
//   * message text. A channel transcript is not lock-screen material, and the
//     row that triggered the signal is exactly the row most likely to be
//     sensitive.
//   * a raw sender/actor id. The label is `senderShortLabel`'s output, the same
//     one the rail renders (#1234: an actor id is not a name).
import type { NotifyEvent } from './signals.js';

/**
 * OS notification title.
 *
 * The product name, not the channel: the brief's body copy already carries
 * `in <channel>`, and an OS notification that says the channel twice reads as a
 * bug. Lowercase per DESIGN.md — the browser renders the origin next to it
 * anyway, so this is Relay's own label, not a proper noun.
 */
export const NOTIFY_OS_TITLE = 'relay';

/** The event fields the copy is composed from. */
export type NotifyCopyInput = Pick<
  NotifyEvent,
  'reason' | 'senderLabel' | 'channelTitle' | 'count'
>;

/**
 * OS notification body: `<agent> replied in <channel>`.
 *
 * The channel title is the operator's OWN text and is used VERBATIM — Relay
 * lowercases its own copy, not the operator's. Everything Relay authors around
 * it stays lowercase, which is what `notifyRelayCopyFragment` lets a test
 * assert without the operator's title fighting the invariant.
 *
 * A coalesced run (the gate held OS notifications back inside its rate-limit
 * window) is reported with the mono-spirit separator the rest of the UI uses:
 * `claude replied in impl 1308 · 3 new`.
 */
export function notifyOsBody(event: NotifyCopyInput): string {
  const base = `${notifyRelayCopyFragment(event)} in ${event.channelTitle}`;
  return event.count > 1 ? `${base} · ${event.count} new` : base;
}

/**
 * The Relay-authored half of the body — everything except the operator's own
 * channel title. Exported so the lowercase/no-emoji/no-transcript invariant is
 * testable on the fragment Relay actually controls.
 */
export function notifyRelayCopyFragment(
  event: Pick<NotifyCopyInput, 'reason' | 'senderLabel'>
): string {
  if (event.reason === 'mention') return `${event.senderLabel} mentioned you`;
  if (event.reason === 'dm-reply') return `${event.senderLabel} replied`;
  return `${event.senderLabel} finished`;
}

/**
 * Document title while unread DM/mention channels exist: `(3) Relay`.
 *
 * N counts CHANNELS, not messages — the tab title is a "where should I look"
 * signal, and a number that tracks raw message volume turns a single chatty
 * agent into a permanent alarm. `Relay` keeps its capital: it is the product
 * name the tab already showed, and the zero case must restore it byte-for-byte.
 */
export function formatNotifyTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

/**
 * Strip a count prefix this module may have written earlier.
 *
 * The base title is captured from the live document, and a hot reload (or a
 * second badger constructed over an already-badged document) would otherwise
 * capture `(2) Relay` as the base and compound it to `(3) (2) Relay`.
 */
export function stripNotifyTitlePrefix(title: string): string {
  return title.replace(/^\(\d+\)\s+/, '');
}
