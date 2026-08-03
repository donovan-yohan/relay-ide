// @vitest-environment happy-dom
// #1308 slice 5 item 2 — the whole delivery path, end to end in one process:
// a `/channels` summary row (or a `channel-agent-status` edge) → item 1's
// derivation + gate → the OS Notification API and the badge store.
//
// The Notification API is stubbed on `globalThis`; everything else is the real
// module graph, including the real ui/activity stores, so the read gate and the
// click routing are exercised as shipped rather than mocked around.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  notifyChannelIndex,
  notifyFromAgentStatus,
  notifyFromChannelSummaries,
  type NotifySummaryRow,
  type NotifyTopicRecord,
} from '../../frontend/src/lib/notify/producers.js';
import { resetNotifyRuntime } from '../../frontend/src/lib/notify/runtime.js';
import { useChannelActivityStore } from '../../frontend/src/lib/stores/channel-activity.js';
import {
  countAttentionChannels,
  useNotifyBadgeStore,
} from '../../frontend/src/lib/stores/notify-badge.js';
import { useNotifySettingsStore } from '../../frontend/src/lib/stores/notify-settings.js';
import { useUiStore } from '../../frontend/src/lib/stores/ui.js';
import { dmChannelTopicId } from '../../shared/dm-channels.js';

const CLAUDE_PROFILE = 'agent-profile:claude:default';
const IMPL_ID = 'topic:impl-1308';
const DM_ID = dmChannelTopicId('claude', null);
const NOW = 1_800_000_000_000;

interface Shown {
  title: string;
  options: { body?: string; tag?: string; data?: unknown } | undefined;
  onclick: ((event?: unknown) => void) | null;
}
const shown: Shown[] = [];

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  readonly record: Shown;
  constructor(title: string, options?: Shown['options']) {
    this.record = { title, options, onclick: null };
    Object.defineProperty(this, 'onclick', {
      get: () => this.record.onclick,
      set: (handler) => {
        this.record.onclick = handler;
      },
    });
    shown.push(this.record);
  }
  close(): void {}
}

function topic(
  id: string,
  title: string,
  routing?: { providerId: string }
): NotifyTopicRecord {
  return {
    id,
    display: { title },
    workspaceId: null,
    ...(routing ? { routingDefaults: routing } : {}),
  } as unknown as NotifyTopicRecord;
}

const channels = notifyChannelIndex([
  topic(IMPL_ID, 'impl 1308'),
  topic(DM_ID, 'claude', { providerId: 'claude' }),
]);

function summaryRow(
  id: string,
  overrides: Partial<NonNullable<NotifySummaryRow['lastMessage']>> = {}
): NotifySummaryRow {
  return {
    id,
    lastMessage: {
      seq: 12,
      senderId: CLAUDE_PROFILE,
      senderKind: 'agent',
      senderDisplayName: 'claude',
      providerId: 'claude',
      preview: 'pushed the branch',
      ...overrides,
    },
  };
}

function attentionCount(): number {
  return countAttentionChannels(
    useNotifyBadgeStore.getState().flagByChannel,
    useChannelActivityStore.getState().lastReadByChannel
  );
}

/** Put the tab where OS notifications are allowed: hidden and unfocused. */
function backgroundTab(): void {
  Object.defineProperty(document, 'hidden', {
    value: true,
    configurable: true,
  });
  document.hasFocus = () => false;
}

function foregroundTab(): void {
  Object.defineProperty(document, 'hidden', {
    value: false,
    configurable: true,
  });
  document.hasFocus = () => true;
}

beforeEach(() => {
  shown.length = 0;
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission.mockClear();
  (globalThis as { Notification?: unknown }).Notification = FakeNotification;
  resetNotifyRuntime();
  useNotifySettingsStore.getState().resetNotifySettings();
  useChannelActivityStore.setState({ lastReadByChannel: {} });
  useUiStore.getState().setActiveChannelId(null);
  backgroundTab();
});

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe('mention and DM-reply from a /channels payload', () => {
  it('constructs the notification with the right payload and flags the badge', () => {
    const delivered = notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      reason: 'dm-reply',
      channelId: DM_ID,
      os: true,
      badge: true,
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('relay');
    expect(shown[0]?.options).toEqual({
      body: 'claude replied in claude',
      tag: `relay-channel:${DM_ID}`,
      data: { channelId: DM_ID },
    });
    expect(attentionCount()).toBe(1);
  });

  it('raises a mention in a non-DM channel from server-computed refs', () => {
    notifyFromChannelSummaries({
      rows: [summaryRow(IMPL_ID, { mentions: [{ raw: '@operator' }] })],
      channels,
      at: NOW,
    });
    expect(shown[0]?.options?.body).toBe('claude mentioned you in impl 1308');
    expect(attentionCount()).toBe(1);
  });

  it('stays silent for an ordinary agent message in a plain channel', () => {
    notifyFromChannelSummaries({
      rows: [summaryRow(IMPL_ID)],
      channels,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
    expect(attentionCount()).toBe(0);
  });

  it('never notifies twice for the same row across refetches', () => {
    const rows = [summaryRow(DM_ID)];
    notifyFromChannelSummaries({ rows, channels, at: NOW });
    notifyFromChannelSummaries({ rows, channels, at: NOW + 1 });
    notifyFromChannelSummaries({ rows, channels, at: NOW + 2 });
    expect(shown).toHaveLength(1);
  });

  it('respects a read mark set on another device', () => {
    useChannelActivityStore.setState({ lastReadByChannel: { [DM_ID]: 12 } });
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
    expect(attentionCount()).toBe(0);
  });

  it('drops the badge when the read mark catches up afterwards', () => {
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(attentionCount()).toBe(1);
    // The `channel-read-state` broadcast lands (another device read the DM).
    useChannelActivityStore.setState({ lastReadByChannel: { [DM_ID]: 12 } });
    expect(attentionCount()).toBe(0);
  });

  it('stays silent for the channel the operator is looking at', () => {
    foregroundTab();
    useUiStore.getState().setActiveChannelId(DM_ID);
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
    expect(attentionCount()).toBe(0);
  });

  it('badges but does not notify while the tab is visible', () => {
    foregroundTab();
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
    expect(attentionCount()).toBe(1);
  });

  it('badges the boot payload without firing a notification storm', () => {
    // A tab restored into the background: every unread DM in the seed payload
    // is genuinely unread, and none of it is news.
    notifyFromChannelSummaries({
      rows: [
        summaryRow(DM_ID),
        summaryRow(IMPL_ID, {
          mentions: [{ raw: '@operator' }],
        }),
      ],
      channels,
      osTier: false,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
    expect(attentionCount()).toBe(2);
    // And the rate-limit window was not burned: a real event straight after
    // still notifies.
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID, { seq: 13 })],
      channels,
      at: NOW + 1,
    });
    expect(shown).toHaveLength(1);
  });

  it('skips a channel with no cached topic rather than guessing at it', () => {
    notifyFromChannelSummaries({
      rows: [summaryRow('topic:unknown')],
      channels,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
  });

  it('ignores the operator own posts echoed back', () => {
    notifyFromChannelSummaries({
      rows: [
        summaryRow(DM_ID, {
          senderId: 'human:operator',
          senderKind: 'human',
          senderDisplayName: 'Operator',
        }),
      ],
      channels,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
  });

  it('honours the operator switching DM replies off', () => {
    useNotifySettingsStore.getState().setNotifySetting('dmReplies', false);
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(shown).toHaveLength(0);
    expect(attentionCount()).toBe(0);
  });
});

describe('turn complete from channel-agent-status', () => {
  const channel = channels.get(IMPL_ID);

  it('is off by default', () => {
    notifyFromAgentStatus({
      channel: channel!,
      agentId: CLAUDE_PROFILE,
      previous: 'thinking',
      next: 'idle',
      at: NOW,
    });
    expect(shown).toHaveLength(0);
  });

  it('fires on a busy→idle edge once the operator opts in', () => {
    useNotifySettingsStore.getState().setNotifySetting('turnComplete', true);
    notifyFromAgentStatus({
      channel: channel!,
      agentId: CLAUDE_PROFILE,
      previous: 'streaming',
      next: 'idle',
      at: NOW,
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]?.options?.body).toBe('claude finished in impl 1308');
    // A finished turn is not an unread DM/mention, so the tab stays clean.
    expect(attentionCount()).toBe(0);
  });

  it('ignores a runtime that never came up (spawning→idle)', () => {
    useNotifySettingsStore.getState().setNotifySetting('turnComplete', true);
    notifyFromAgentStatus({
      channel: channel!,
      agentId: CLAUDE_PROFILE,
      previous: 'spawning',
      next: 'idle',
      at: NOW,
    });
    expect(shown).toHaveLength(0);
  });
});

describe('click routing', () => {
  it('opens the notified channel', () => {
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(useUiStore.getState().activeChannelId).toBeNull();
    shown[0]?.onclick?.();
    expect(useUiStore.getState().activeChannelId).toBe(DM_ID);
  });
});

describe('permission', () => {
  it('is never requested just by running the producers', () => {
    FakeNotification.permission = 'granted';
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('is requested only once an eligible event actually reaches the OS tier', () => {
    FakeNotification.permission = 'default';
    // Visible tab: badge tier only, so nothing is eligible yet.
    foregroundTab();
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID)],
      channels,
      at: NOW,
    });
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    backgroundTab();
    notifyFromChannelSummaries({
      rows: [summaryRow(DM_ID, { seq: 13 })],
      channels,
      at: NOW + 1,
    });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});
