import webpush from 'web-push';
import type { Config } from './types.js';

interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface SubscriptionEntry {
  subscription: PushSubscriptionData;
  sessionIds: Set<string>;
}

let vapidPublicKey: string | null = null;

const subscriptions = new Map<string, SubscriptionEntry>();

const MAX_PAYLOAD_SIZE = 4 * 1024; // 4KB

export function ensureVapidKeys(
  config: Config,
  configPath: string,
  save: (path: string, config: Config) => void
): void {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    vapidPublicKey = config.vapidPublicKey;
    webpush.setVapidDetails(
      'mailto:noreply@claude-remote-cli.local',
      config.vapidPublicKey,
      config.vapidPrivateKey
    );
    return;
  }

  try {
    const keys = webpush.generateVAPIDKeys();
    config.vapidPublicKey = keys.publicKey;
    config.vapidPrivateKey = keys.privateKey;
    save(configPath, config);

    vapidPublicKey = keys.publicKey;
    webpush.setVapidDetails(
      'mailto:noreply@claude-remote-cli.local',
      keys.publicKey,
      keys.privateKey
    );
  } catch {
    // VAPID key generation failed — push will be unavailable
    vapidPublicKey = null;
  }
}

export function getVapidPublicKey(): string | null {
  return vapidPublicKey;
}

export function subscribe(
  subscription: PushSubscriptionData,
  sessionIds: string[]
): void {
  // Replace the full session list for this endpoint — the client sends
  // the complete set of sessions it wants notifications for.
  subscriptions.set(subscription.endpoint, {
    subscription,
    sessionIds: new Set(sessionIds),
  });
}

export function unsubscribe(endpoint: string): void {
  subscriptions.delete(endpoint);
}

export function removeSession(sessionId: string): void {
  for (const entry of subscriptions.values()) {
    entry.sessionIds.delete(sessionId);
  }
}

function truncatePayload(payload: string): string {
  if (payload.length <= MAX_PAYLOAD_SIZE) return payload;
  // Try to parse, truncate text fields, and re-serialize
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    if (
      typeof obj.enrichedMessage === 'string' &&
      obj.enrichedMessage.length > 100
    ) {
      obj.enrichedMessage =
        (obj.enrichedMessage as string).slice(0, 100) + '...';
    }
    const truncated = JSON.stringify(obj);
    if (truncated.length <= MAX_PAYLOAD_SIZE) return truncated;
  } catch {
    // fall through
  }
  return payload.slice(0, MAX_PAYLOAD_SIZE);
}

export function notifySessionAttention(
  sessionId: string,
  session: { displayName: string; type: string }
): void {
  if (!vapidPublicKey) return;

  const payloadObj: Record<string, unknown> = {
    type: 'session-attention',
    sessionId,
    displayName: session.displayName,
    sessionType: session.type,
  };

  const payload = truncatePayload(JSON.stringify(payloadObj));

  for (const [endpoint, entry] of subscriptions) {
    if (!entry.sessionIds.has(sessionId)) continue;

    webpush
      .sendNotification(entry.subscription, payload)
      .catch((err: { statusCode?: number }) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          subscriptions.delete(endpoint);
        }
      });
  }
}
