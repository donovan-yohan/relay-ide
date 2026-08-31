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

export function ensureVapidKeys(
  config: Config,
  configPath: string,
  save: (path: string, config: Config) => void
): void {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    vapidPublicKey = config.vapidPublicKey;
    webpush.setVapidDetails(
      'mailto:noreply@relay-ide.local',
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
      'mailto:noreply@relay-ide.local',
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
