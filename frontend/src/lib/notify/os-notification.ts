// OS Notification delivery for channel notify events (#1308 slice 5 item 2).
//
// PERMISSION IS REQUESTED LAZILY, NEVER ON LOAD. A permission prompt fired at
// boot is hostile: the operator has been shown nothing yet, so they have no way
// to judge the ask, and a reflexive "block" is unrecoverable from inside the
// page. Nothing here runs at import; the first request happens on the first
// event that would ACTUALLY have produced a notification (gate-approved, OS
// tier), and Settings › notifications offers the same grant behind an explicit
// button for the browsers that require a user gesture (Safari always; Firefox
// since it tied `requestPermission` to user activation).
//
// Deliberately independent of `lib/notifications.ts`, which owns the LEGACY
// per-session web-push lane (service worker + VAPID + `PUT /config`). Nothing
// here registers a service worker: this slice adds no push infrastructure.
import {
  NOTIFY_OS_OVERFLOW_KEY,
  NOTIFY_OS_TITLE,
  notifyOsBody,
  notifyOsOverflowBody,
} from './copy.js';
import type { NotifyEvent } from './signals.js';

/** Permission states, plus the browser that has no Notification API at all. */
export type NotifyPermissionState =
  | 'unsupported'
  | 'default'
  | 'granted'
  | 'denied';

/**
 * Structural stand-in for a live `Notification`.
 *
 * Written structurally rather than against the DOM lib type so a test can pass
 * a plain fake class, and so this module type-checks in a build that has no DOM
 * lib loaded. The only members the lane uses are the two below.
 */
export interface NotificationLike {
  onclick: ((event?: unknown) => void) | null;
  close: () => void;
}

/** Structural stand-in for the `Notification` constructor + its statics. */
export interface NotificationCtorLike {
  new (
    title: string,
    options?: {
      body?: string;
      tag?: string;
      data?: unknown;
      silent?: boolean;
    }
  ): NotificationLike;
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
}

/** The `Notification` constructor, or null where the API does not exist. */
export function resolveNotificationCtor(): NotificationCtorLike | null {
  const ctor = (globalThis as { Notification?: unknown }).Notification;
  return typeof ctor === 'function' ? (ctor as NotificationCtorLike) : null;
}

/** Current permission, treating an absent API as its own state. */
export function notifyPermissionState(
  ctor: NotificationCtorLike | null = resolveNotificationCtor()
): NotifyPermissionState {
  if (!ctor) return 'unsupported';
  const permission = ctor.permission;
  return permission === 'granted' || permission === 'denied'
    ? permission
    : 'default';
}

export interface OsNotifierDeps {
  /**
   * Resolved once per `deliver`, not captured at construction: a page can be
   * constructed before the API is patched in (tests), and re-reading costs a
   * property access.
   */
  resolveCtor?: () => NotificationCtorLike | null;
  /** Bring the tab forward on click. */
  focusWindow?: () => void;
  /** Route to the clicked channel. Called AFTER focus, so the surface is visible. */
  openChannel: (channelId: string) => void;
}

export interface OsNotifier {
  /**
   * Show `event` if the OS tier is reachable.
   *
   * Fire-and-forget for the CALLER — a permission round trip must never make a
   * socket handler async — but the returned promise reports whether a
   * `Notification` was actually constructed, so the gate can refund the
   * rate-limit slot it charged when nothing was shown. Resolves synchronously
   * (one microtask) on every path except the lazy permission request.
   */
  deliver: (event: NotifyEvent) => Promise<boolean>;
  /**
   * ONE collapsed notification for a burst the gate's global budget held back.
   * Carries a constant tag, so a growing overflow replaces its own line.
   */
  deliverOverflow: (channelCount: number) => void;
  /**
   * Arm the permission prompt from a moment the browser can actually raise it,
   * without showing anything.
   *
   * `deliver`'s lazy ask only fires for an OS-tier event, which by construction
   * only exists while `document.hidden` — precisely when Safari and Firefox
   * refuse to prompt at all (both tie `requestPermission` to user activation)
   * and when Chrome defers the prompt until the tab returns. A gate-approved
   * event on a VISIBLE, focused tab is the same "something worth telling you
   * about just happened" evidence, delivered where the ask can land.
   *
   * At most one request per notifier lifetime, and only from `default` — a
   * browser that refuses the ungestured ask must not be re-asked on every
   * subsequent event.
   */
  primePermission: () => void;
  /**
   * Ask for permission now, from an explicit operator action (the Settings
   * button). Same memoized request as the lazy path, so the two cannot race
   * into two prompts.
   */
  requestPermission: () => Promise<NotifyPermissionState>;
  /** Forget the in-flight request memo and the prime one-shot (sign-out, tests). */
  reset: () => void;
}

/**
 * Per-notifier state in a closure rather than module singletons, so one test
 * case cannot leak a granted permission memo into the next.
 */
export function createOsNotifier(deps: OsNotifierDeps): OsNotifier {
  const resolveCtor = deps.resolveCtor ?? resolveNotificationCtor;
  const focusWindow =
    deps.focusWindow ??
    (() => {
      if (typeof window !== 'undefined') window.focus();
    });
  /**
   * The one in-flight permission request. Chrome resolves a second concurrent
   * `requestPermission()` with the first prompt's answer, but Safari has
   * historically rejected it — and an event burst is exactly how two would be
   * issued at once.
   */
  let pendingRequest: Promise<NotifyPermissionState> | null = null;
  /** Whether the one gestureless prime has already been spent. */
  let primed = false;

  function requestPermission(): Promise<NotifyPermissionState> {
    const ctor = resolveCtor();
    if (!ctor) return Promise.resolve('unsupported');
    const current = notifyPermissionState(ctor);
    // 'denied' is terminal from inside the page — asking again is a no-op the
    // browser answers instantly, and treating it as askable would put the
    // Settings button in a state that can never change.
    if (current !== 'default') return Promise.resolve(current);
    if (pendingRequest) return pendingRequest;
    // An async IIFE, not `Promise.resolve().then(...)`: the prompt must be
    // raised SYNCHRONOUSLY inside the call that decided to raise it. Browsers
    // that require user activation lose the gesture across a microtask hop, so
    // deferring would break the one path (the Settings button) that is
    // guaranteed to work on Safari.
    pendingRequest = (async () => {
      try {
        const result = await ctor.requestPermission();
        return result === 'granted' || result === 'denied' ? result : 'default';
      } catch {
        // A browser that rejects (no user gesture, or a legacy callback-only
        // implementation) leaves the operator exactly where they were: no
        // notification, no crash, and the Settings button still offers a
        // gesture-backed retry.
        return notifyPermissionState(resolveCtor());
      } finally {
        pendingRequest = null;
      }
    })();
    return pendingRequest;
  }

  function show(event: NotifyEvent, ctor: NotificationCtorLike): boolean {
    let notification: NotificationLike;
    try {
      notification = new ctor(NOTIFY_OS_TITLE, {
        body: notifyOsBody(event),
        // One live notification per channel: a newer event REPLACES the
        // previous one in the notification centre instead of stacking, which is
        // the same coalescing promise `event.count` reports inside the body.
        tag: event.key,
        data: { channelId: event.channelId },
      });
    } catch {
      // Constructing a Notification throws on Android Chrome (service-worker
      // notifications only) and in a few embedded webviews. Nothing about the
      // in-app tier depends on this succeeding.
      return false;
    }
    notification.onclick = () => {
      focusWindow();
      deps.openChannel(event.channelId);
      notification.close();
    };
    return true;
  }

  /** The burst digest. No channel to route to, so a click only brings the tab up. */
  function showOverflow(
    channelCount: number,
    ctor: NotificationCtorLike
  ): boolean {
    let notification: NotificationLike;
    try {
      notification = new ctor(NOTIFY_OS_TITLE, {
        body: notifyOsOverflowBody(channelCount),
        tag: NOTIFY_OS_OVERFLOW_KEY,
      });
    } catch {
      return false;
    }
    notification.onclick = () => {
      focusWindow();
      notification.close();
    };
    return true;
  }

  /**
   * The permission dance every delivery path shares. Resolves TRUE only once
   * `build` has actually constructed a notification, which is what lets the
   * gate tell a shown event from a swallowed one.
   */
  function present(
    build: (ctor: NotificationCtorLike) => boolean
  ): Promise<boolean> {
    const ctor = resolveCtor();
    if (!ctor) return Promise.resolve(false);
    const permission = notifyPermissionState(ctor);
    if (permission === 'denied') return Promise.resolve(false);
    if (permission === 'granted') return Promise.resolve(build(ctor));
    // FIRST eligible event and no grant yet: arm the lazy prompt. The event is
    // shown once the grant lands, not dropped — the operator said yes to being
    // told about THIS.
    return requestPermission().then((result) => {
      if (result !== 'granted') return false;
      const grantedCtor = resolveCtor();
      return grantedCtor ? build(grantedCtor) : false;
    });
  }

  return {
    deliver: (event) => {
      if (!event.os) return Promise.resolve(false);
      return present((ctor) => show(event, ctor));
    },
    deliverOverflow: (channelCount) => {
      void present((ctor) => showOverflow(channelCount, ctor));
    },
    primePermission: () => {
      if (primed) return;
      const ctor = resolveCtor();
      if (!ctor) return;
      // `granted`/`denied` are both settled; neither spends the one shot, so a
      // browser that only gains the API later can still be primed.
      if (notifyPermissionState(ctor) !== 'default') return;
      primed = true;
      void requestPermission();
    },
    requestPermission,
    reset: () => {
      pendingRequest = null;
      primed = false;
    },
  };
}
