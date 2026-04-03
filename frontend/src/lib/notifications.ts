import { fetchVapidKey, pushSubscribe } from './api.js';
import { createLogger } from './logger.js';

type NotificationClickHandler = (
  sessionId: string,
  sessionType: string
) => void;

let clickHandler: NotificationClickHandler | null = null;
let swRegistration: ServiceWorkerRegistration | null = null;
const logger = createLogger('notifications');

export function initNotifications(
  onNotificationClick: NotificationClickHandler
): void {
  clickHandler = onNotificationClick;

  // Listen for messages from service worker (notification clicks)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data as {
        type?: string;
        sessionId?: string;
        sessionType?: string;
      };
      if (
        data.type === 'notification-click' &&
        data.sessionId &&
        clickHandler
      ) {
        clickHandler(data.sessionId, data.sessionType || 'repo');
      }
    });
  }
}

export function getPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

export function shouldFireNotification(): boolean {
  return document.hidden || !document.hasFocus();
}

export function fireNotification(session: {
  id: string;
  displayName: string;
  type: string;
}): void {
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  )
    return;

  const notification = new Notification(
    session.displayName || 'Claude Remote CLI',
    {
      body: 'Session needs your input',
      tag: 'session-' + session.id,
      data: { sessionId: session.id, sessionType: session.type },
    }
  );

  notification.onclick = () => {
    window.focus();
    if (clickHandler) {
      clickHandler(session.id, session.type);
    }
    notification.close();
  };
}

export function hasPushSupport(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function initPushNotifications(): Promise<void> {
  if (!hasPushSupport()) return;

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    logger.warn('Service worker registration failed', err);
    return;
  }
}

export async function syncPushSubscription(
  sessionIds: string[]
): Promise<void> {
  // Fall back to navigator.serviceWorker.ready if initPushNotifications hasn't completed yet
  if (!swRegistration) {
    if (!hasPushSupport()) return;
    swRegistration = await navigator.serviceWorker.ready;
  }

  try {
    let subscription = await swRegistration.pushManager.getSubscription();

    if (!subscription) {
      const vapidKey = await fetchVapidKey();
      if (!vapidKey) return;

      const applicationServerKey = urlBase64ToUint8Array(vapidKey)
        .buffer as ArrayBuffer;
      subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    await pushSubscribe(subscription.toJSON(), sessionIds);
  } catch (err) {
    logger.warn('Push subscription failed', err);
  }
}

export async function resubscribeIfNeeded(sessionIds: string[]): Promise<void> {
  if (!hasPushSupport()) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await pushSubscribe(subscription.toJSON(), sessionIds);
    }
  } catch (err) {
    logger.warn('Push re-subscription failed', err);
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
