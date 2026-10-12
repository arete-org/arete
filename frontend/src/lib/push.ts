import { notificationsApi } from './api';

/**
 * Web Push on this device. The service worker (src/sw.ts) shows the messages;
 * this module asks permission and keeps the server's subscription list in step.
 */
export type PushState =
  /** No service worker, PushManager or Notification API in this browser. */
  | 'unsupported'
  /** iOS only delivers push to the PWA added to the home screen (iOS 16.4+). */
  | 'ios-not-installed'
  /** Supported, but no worker registered (the dev server does not register one). */
  | 'no-worker'
  | 'denied'
  | 'subscribed'
  | 'unsubscribed';

export function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function isIos(): boolean {
  const { userAgent, maxTouchPoints } = navigator;
  // iPadOS reports itself as a Mac; touch points give it away.
  return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Launched from the home screen (the installed PWA), not from a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** VAPID public keys travel as URL-safe base64; PushManager wants the raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration();
}

export async function currentState(): Promise<PushState> {
  if (typeof navigator !== 'undefined' && typeof window !== 'undefined' && isIos() && !isStandalone()) {
    return 'ios-not-installed';
  }
  if (!isSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg) return 'no-worker';
  return (await reg.pushManager.getSubscription()) ? 'subscribed' : 'unsubscribed';
}

/**
 * Ask permission, subscribe this device and register it with the server.
 * Call it straight from a click: Safari only prompts inside a user gesture.
 */
export async function subscribeDevice(vapidPublicKey: string): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'unsubscribed';
  const reg = await registration();
  if (!reg) return 'no-worker';

  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) {
    await subscription.unsubscribe();
    throw new Error('Abonnement push incomplet');
  }
  try {
    await notificationsApi.subscribe({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  } catch (error) {
    // A device subscribed locally but unknown to the server would never ring.
    await subscription.unsubscribe();
    throw error;
  }
  return 'subscribed';
}

/**
 * Unsubscribe locally even when the server call fails (the error still
 * propagates); the server also drops endpoints that answer 410.
 */
export async function unsubscribeDevice(): Promise<PushState> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  if (!subscription) return 'unsubscribed';
  try {
    await notificationsApi.unsubscribe(subscription.endpoint);
  } finally {
    await subscription.unsubscribe();
  }
  return 'unsubscribed';
}
