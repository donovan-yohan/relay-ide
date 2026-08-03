// #1308 slice 5 item 2 — OS Notification delivery.
//
// The Notification API is stubbed with a plain class, so every case is
// deterministic and nothing here depends on a real browser permission.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOsNotifier,
  notifyPermissionState,
  type NotificationCtorLike,
} from '../../frontend/src/lib/notify/os-notification.js';
import type { NotifyEvent } from '../../frontend/src/lib/notify/signals.js';

interface FakeInstance {
  index: number;
  title: string;
  options: { body?: string; tag?: string; data?: unknown } | undefined;
  onclick: ((event?: unknown) => void) | null;
  closed: boolean;
}

/** Every notification the lane constructed, in order. */
const shown: FakeInstance[] = [];

function makeCtor(
  permission: NotificationPermission,
  requestResult: NotificationPermission | Error = 'granted'
): { ctor: NotificationCtorLike; requestPermission: ReturnType<typeof vi.fn> } {
  const requestPermission = vi.fn(async () => {
    if (requestResult instanceof Error) throw requestResult;
    FakeNotification.permission = requestResult;
    return requestResult;
  });
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
    readonly self: FakeInstance;
    onclick: ((event?: unknown) => void) | null = null;
    constructor(title: string, options?: FakeInstance['options']) {
      this.self = {
        index: shown.length,
        title,
        options,
        onclick: null,
        closed: false,
      };
      // Mirror assignments onto the record so a test can fire the click.
      Object.defineProperty(this, 'onclick', {
        get: () => this.self.onclick,
        set: (handler) => {
          this.self.onclick = handler;
        },
      });
      shown.push(this.self);
    }
    close(): void {
      this.self.closed = true;
    }
  }
  return {
    ctor: FakeNotification as unknown as NotificationCtorLike,
    requestPermission,
  };
}

function osEvent(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    key: 'relay-channel:topic:impl-1308',
    reason: 'dm-reply',
    channelId: 'topic:impl-1308',
    channelTitle: 'impl 1308',
    badge: true,
    os: true,
    count: 1,
    osOverflow: 0,
    senderLabel: 'claude',
    seq: 12,
    at: 1_800_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  shown.length = 0;
});

describe('permission', () => {
  it('reports unsupported when the API is absent', () => {
    expect(notifyPermissionState(null)).toBe('unsupported');
  });

  it('is NEVER requested by constructing the notifier', () => {
    // The whole "no prompt on load" contract: building the lane — which is what
    // App does on mount — must not touch `requestPermission`.
    const { ctor, requestPermission } = makeCtor('default');
    createOsNotifier({ resolveCtor: () => ctor, openChannel: vi.fn() });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('is NEVER requested for an event that is not on the OS tier', () => {
    // A gate-approved badge-only event (visible tab) is not an eligible event.
    const { ctor, requestPermission } = makeCtor('default');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent({ os: false }));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it('is requested lazily on the FIRST eligible event, then shows it', async () => {
    const { ctor, requestPermission } = makeCtor('default', 'granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent());
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
  });

  it('prompts once across a burst of eligible events', async () => {
    const { ctor, requestPermission } = makeCtor('default', 'granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent({ seq: 1 }));
    void notifier.deliver(osEvent({ seq: 2 }));
    void notifier.deliver(osEvent({ seq: 3 }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(shown).toHaveLength(3));
  });

  it('shows nothing when the operator refuses the prompt', async () => {
    const { ctor } = makeCtor('default', 'denied');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent());
    await expect(notifier.requestPermission()).resolves.toBe('denied');
    expect(shown).toHaveLength(0);
  });

  it('no-ops when denied, and never asks again', () => {
    const { ctor, requestPermission } = makeCtor('denied');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it('no-ops when the API is unsupported', () => {
    const notifier = createOsNotifier({
      resolveCtor: () => null,
      openChannel: vi.fn(),
    });
    expect(() => notifier.deliver(osEvent())).not.toThrow();
    expect(shown).toHaveLength(0);
  });

  it('degrades to the current state when the request is refused', async () => {
    // Safari/Firefox reject `requestPermission` without a user gesture.
    const { ctor } = makeCtor('default', new Error('user gesture required'));
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    await expect(notifier.requestPermission()).resolves.toBe('default');
    expect(shown).toHaveLength(0);
  });
});

describe('notification payload', () => {
  it('is constructed with the relay title, composed body, and per-channel tag', () => {
    const { ctor } = makeCtor('granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent());
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('relay');
    expect(shown[0]?.options).toEqual({
      body: 'claude replied in impl 1308',
      // Per-channel tag: a newer notification replaces the previous one instead
      // of stacking, which is the promise `count` reports inside the body.
      tag: 'relay-channel:topic:impl-1308',
      data: { channelId: 'topic:impl-1308' },
    });
  });

  it('renders a coalesced mention run', () => {
    const { ctor } = makeCtor('granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent({ reason: 'mention', count: 4 }));
    expect(shown[0]?.options?.body).toBe(
      'claude mentioned you in impl 1308 · 4 new'
    );
  });

  it('never carries transcript text', () => {
    const { ctor } = makeCtor('granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    void notifier.deliver(osEvent());
    expect(JSON.stringify(shown[0])).not.toContain('pushed the branch');
  });

  it('survives a constructor that throws (android chrome, webviews)', () => {
    class ThrowingNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn();
      constructor() {
        throw new TypeError('illegal constructor');
      }
    }
    const notifier = createOsNotifier({
      resolveCtor: () =>
        ThrowingNotification as unknown as NotificationCtorLike,
      openChannel: vi.fn(),
    });
    expect(() => notifier.deliver(osEvent())).not.toThrow();
  });
});

describe('delivery reporting', () => {
  // The gate charges a 60s per-channel slot at DECISION time, so it needs to
  // know when nothing was actually shown or the next real message is swallowed.
  it('reports true only once a notification was constructed', async () => {
    const { ctor } = makeCtor('granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    await expect(notifier.deliver(osEvent())).resolves.toBe(true);
  });

  it('reports false when the tier was never eligible', async () => {
    const { ctor } = makeCtor('granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    await expect(notifier.deliver(osEvent({ os: false }))).resolves.toBe(false);
  });

  it('reports false when permission is denied or the API is absent', async () => {
    const { ctor } = makeCtor('denied');
    const denied = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    await expect(denied.deliver(osEvent())).resolves.toBe(false);
    const unsupported = createOsNotifier({
      resolveCtor: () => null,
      openChannel: vi.fn(),
    });
    await expect(unsupported.deliver(osEvent())).resolves.toBe(false);
  });

  it('reports false when the operator dismisses the prompt', async () => {
    const { ctor } = makeCtor('default', 'denied');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    await expect(notifier.deliver(osEvent())).resolves.toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('reports false when the constructor throws', async () => {
    class ThrowingNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn();
      constructor() {
        throw new TypeError('illegal constructor');
      }
    }
    const notifier = createOsNotifier({
      resolveCtor: () =>
        ThrowingNotification as unknown as NotificationCtorLike,
      openChannel: vi.fn(),
    });
    await expect(notifier.deliver(osEvent())).resolves.toBe(false);
  });
});

describe('burst digest', () => {
  it('collapses the held-back run into one notification', () => {
    const { ctor } = makeCtor('granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    notifier.deliverOverflow(12);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('relay');
    expect(shown[0]?.options).toEqual({
      body: '12 channels have new messages',
      // Constant tag: a growing overflow replaces its own line rather than
      // stacking one entry per held-back channel.
      tag: 'relay-channels',
    });
  });

  it('names no channel and routes nowhere but the tab', () => {
    const { ctor } = makeCtor('granted');
    const openChannel = vi.fn();
    const focusWindow = vi.fn();
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      focusWindow,
      openChannel,
    });
    notifier.deliverOverflow(1);
    expect(shown[0]?.options?.body).toBe('1 channel has new messages');
    shown[0]?.onclick?.();
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(openChannel).not.toHaveBeenCalled();
    expect(shown[0]?.closed).toBe(true);
  });

  it('no-ops when denied', () => {
    const { ctor } = makeCtor('denied');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    notifier.deliverOverflow(5);
    expect(shown).toHaveLength(0);
  });
});

describe('permission prime', () => {
  it('asks once and shows nothing', () => {
    const { ctor, requestPermission } = makeCtor('default', 'granted');
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    notifier.primePermission();
    notifier.primePermission();
    notifier.primePermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(0);
  });

  it('does not re-ask after a browser that refuses the ungestured call', async () => {
    // Safari always, Firefox since 72: the reject must not turn every later
    // event into another attempt.
    const { ctor, requestPermission } = makeCtor(
      'default',
      new Error('user gesture required')
    );
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      openChannel: vi.fn(),
    });
    notifier.primePermission();
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    notifier.primePermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('never asks from a settled state', () => {
    for (const state of ['granted', 'denied'] as const) {
      const { ctor, requestPermission } = makeCtor(state);
      const notifier = createOsNotifier({
        resolveCtor: () => ctor,
        openChannel: vi.fn(),
      });
      notifier.primePermission();
      expect(requestPermission).not.toHaveBeenCalled();
    }
  });

  it('does not spend its one shot while the API is absent', () => {
    const { ctor, requestPermission } = makeCtor('default', 'granted');
    let live: NotificationCtorLike | null = null;
    const notifier = createOsNotifier({
      resolveCtor: () => live,
      openChannel: vi.fn(),
    });
    notifier.primePermission();
    expect(requestPermission).not.toHaveBeenCalled();
    live = ctor;
    notifier.primePermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('click routing', () => {
  it('focuses the tab, opens the channel, then closes the notification', () => {
    const { ctor } = makeCtor('granted');
    const focusWindow = vi.fn();
    const openChannel = vi.fn();
    const notifier = createOsNotifier({
      resolveCtor: () => ctor,
      focusWindow,
      openChannel,
    });
    void notifier.deliver(osEvent());
    const live = shown.at(-1);
    expect(live?.onclick).toBeTypeOf('function');
    live?.onclick?.();
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(openChannel).toHaveBeenCalledWith('topic:impl-1308');
    // Focus BEFORE routing: the surface must be visible when it changes.
    expect(focusWindow.mock.invocationCallOrder[0]).toBeLessThan(
      openChannel.mock.invocationCallOrder[0] as number
    );
    expect(live?.closed).toBe(true);
  });
});
