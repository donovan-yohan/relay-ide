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
 * Run one signal through the gate and, if it survives, deliver it.
 *
 * Both tiers fire from here so they cannot disagree about what happened: the
 * in-app flag ALWAYS (an event only exists once it has passed the setting, the
 * replay guard, the read position, and the open-and-focused suppression), and
 * the OS notification only when the gate marked it `os`.
 *
 * Returns the delivered event so callers and tests can assert on it.
 */
export function deliverNotifySignal(
  signal: NotifySignal,
  options: DeliverNotifyOptions = {}
): NotifyEvent | null {
  const event = gate.evaluate(
    signal,
    gateContext(
      signal.channel.id,
      options.now ?? Date.now(),
      options.osTier ?? true
    )
  );
  if (!event) return null;
  useNotifyBadgeStore
    .getState()
    .flagChannel(event.channelId, { seq: event.seq, reason: event.reason });
  notifier.deliver(event);
  return event;
}

/**
 * Drop every ledger and rebuild the singletons.
 *
 * Used by tests, and on sign-out: a gate that remembers another account's seqs
 * would silence that account's first real message on this device.
 */
export function resetNotifyRuntime(): void {
  gate.reset();
  notifier.reset();
  gate = createNotifyGate();
  notifier = createOsNotifier({ openChannel: openChannelFromNotification });
  useNotifyBadgeStore.getState().reset();
}
