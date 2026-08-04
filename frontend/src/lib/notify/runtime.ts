// The bridge between item 1's signal derivation and item 2's delivery surfaces
// (#1308 slice 5 item 2).
//
// One process-wide gate and one OS notifier, because both hold ledgers that
// MUST outlive any React tree: the gate's per-channel replay guard and
// rate-limit window, and the notifier's single in-flight permission request. A
// per-component instance would re-notify every row on remount and could prompt
// twice at once.
//
// Everything here reads stores non-reactively (`getState()`). Callers are socket
// handlers and query effects, not renders.
import { useChannelActivityStore } from '../stores/channel-activity.js';
import { useNotifyBadgeStore } from '../stores/notify-badge.js';
import { currentNotifySettings } from '../stores/notify-settings.js';
import { useUiStore } from '../stores/ui.js';
import { openChannelFromNotification } from '../topic-selection.js';
import { createNotifyLeader, type NotifyLeader } from './leader.js';
import { createOsNotifier, type OsNotifier } from './os-notification.js';
import {
  createNotifyGate,
  type NotifyEvent,
  type NotifyGate,
  type NotifyGateContext,
  type NotifySignal,
} from './signals.js';

let gate: NotifyGate = createNotifyGate();
let notifier: OsNotifier = createOsNotifier({
  openChannel: openChannelFromNotification,
});
// Constructed eagerly but INERT until claimed: nothing is read or written until
// an event actually reaches the OS tier, so importing this module costs nothing.
let leader: NotifyLeader = createNotifyLeader();

/** The shared OS notifier — Settings uses it for the explicit permission ask. */
export function notifyOsNotifier(): OsNotifier {
  return notifier;
}

/**
 * Ambient gate context: settings, the open channel, this tab's visibility, and
 * the read position the slice-3 stores already converge.
 *
 * `document.hasFocus()` is read defensively — a few embedded webviews do not
 * implement it. An absent probe degrades to FOCUSED, which is the conservative
 * direction: `document.hidden` is the stronger of the two signals and is
 * universally available, so a visible tab with the channel open is treated as
 * being watched rather than notified at.
 */
function gateContext(
  channelId: string,
  now: number,
  osTier: boolean
): NotifyGateContext {
  const doc = typeof document === 'undefined' ? null : document;
  const lastReadSeq =
    useChannelActivityStore.getState().lastReadByChannel[channelId];
  return {
    settings: currentNotifySettings(),
    activeChannelId: useUiStore.getState().activeChannelId,
    // `osTier: false` is reported to the gate as a VISIBLE tab rather than
    // handled after the fact, and that is the whole point: the gate charges its
    // per-channel rate-limit window when it grants the OS tier, so dropping the
    // notification downstream would burn a 60s slot the operator never got a
    // notification for and swallow the next real one.
    documentHidden: osTier && (doc?.hidden ?? false),
    windowFocused:
      typeof doc?.hasFocus === 'function' ? doc.hasFocus() : Boolean(doc),
    ...(lastReadSeq !== undefined ? { lastReadSeq } : {}),
    now,
  };
}

export interface DeliverNotifyOptions {
  now?: number;
  /**
   * Allow the OS tier. False for a BOOT SEED: the first `/channels` payload
   * describes everything that happened while this client was away, so a tab
   * restored into the background would otherwise fire one notification per
   * unread channel at once. Those rows still earn their in-app badge — they are
   * genuinely unread — they just are not news worth a notification centre entry.
   */
  osTier?: boolean;
}

/**
 * Arm the lazy permission prompt from a LIVE event on a tab the operator is
 * looking at.
 *
 * The OS-tier ask in `os-notification.ts` can only fire for an `os` event,
 * which by construction only exists while `document.hidden` — exactly when
 * Safari and Firefox refuse to raise a prompt (both tie `requestPermission` to
 * user activation) and Chrome defers it. So a fresh browser could reach the
 * documented lazy grant only by accident. A gate-approved event on a VISIBLE,
 * FOCUSED tab is the same evidence that something notification-worthy just
 * happened, delivered where the ask can actually land.
 *
 * The BOOT SEED is excluded (`osTier: false`): a prompt raised at page load,
 * before the operator has been shown anything, is the hostile ask this lane
 * refuses to make.
 */
function primePermissionIfWatching(osTier: boolean): void {
  if (!osTier) return;
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc || doc.hidden) return;
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return;
  notifier.primePermission();
}

/**
 * Run one signal through the gate and, if it survives, deliver it.
 *
 * Both tiers fire from here so they cannot disagree about what happened: the
 * in-app flag ALWAYS (an event only exists once it has passed the setting, the
 * replay guard, the read position, and the open-and-focused suppression), and
 * the OS notification only when the gate marked it `os` AND this tab holds the
 * cross-tab lease.
 *
 * Returns the delivered event so callers and tests can assert on it.
 */
export function deliverNotifySignal(
  signal: NotifySignal,
  options: DeliverNotifyOptions = {}
): NotifyEvent | null {
  // Captured, not re-read: `resetNotifyRuntime` can swap the singleton while a
  // permission request is in flight, and refunding a FRESH gate would poison a
  // ledger that never charged anything.
  const activeGate = gate;
  const now = options.now ?? Date.now();
  const osTier = options.osTier ?? true;
  const event = activeGate.evaluate(
    signal,
    gateContext(signal.channel.id, now, osTier)
  );
  if (!event) return null;
  useNotifyBadgeStore
    .getState()
    .flagChannel(event.channelId, { seq: event.seq, reason: event.reason });
  if (event.os) {
    // A tab that loses the lease reports its event as UNDELIVERED, so the gate
    // hands the window back: a follower that later becomes the leader must not
    // be sitting on rate-limit slots it never spent.
    const delivered = leader.claim(now)
      ? notifier.deliver(event)
      : Promise.resolve(false);
    void delivered.then((shown) => {
      if (!shown) activeGate.refundOs(event);
    });
  } else if (event.osOverflow > 0 && leader.claim(now)) {
    // Mutually exclusive with `os` by construction: overflow is only ever set
    // on an event the burst budget refused.
    //
    // Called once per HELD-BACK CHANNEL — the gate raises `osOverflow` on every
    // event that grows the set — so the notifier coalesces these into a single
    // digest at the end of the pass. Doing it there rather than here is what
    // makes a burst spread across the summary pass AND the status stream still
    // collapse to one notification.
    notifier.deliverOverflow(event.osOverflow);
  }
  primePermissionIfWatching(osTier);
  return event;
}

/**
 * Drop every ledger and rebuild the singletons.
 *
 * Called from `useNotifyDelivery` when the lane is disabled (sign-out, auth
 * expiry) and by tests. Stopping the watcher is NOT enough on its own: the
 * gate's per-channel seq ledger, the OS rate-limit windows and the badge flags
 * all outlive it, so after a re-auth every seq already recorded would be
 * permanently replay-suppressed and an unread message could never raise its
 * badge again on this tab.
 */
export function resetNotifyRuntime(): void {
  gate.reset();
  notifier.reset();
  // Released, not just dropped: a lease left behind under a discarded id would
  // lock this origin's OS tier out for its full duration.
  leader.release();
  gate = createNotifyGate();
  notifier = createOsNotifier({ openChannel: openChannelFromNotification });
  leader = createNotifyLeader();
  useNotifyBadgeStore.getState().reset();
}
