import { toLocalISODate } from './dates';
import { isIos, isStandalone } from './push';

/**
 * Home-screen installation, the only way iOS delivers Web Push.
 *
 * Chrome/Android fires `beforeinstallprompt` early: it is deferred here and
 * replayed from a click. iOS has no install API, so the athlete follows a
 * three-step guide. Both wait for a meaningful moment — the second day the app
 * is opened, once the athlete has come back — and stay hidden once dismissed,
 * installed, or when the app already runs standalone.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallOffer = 'android' | 'ios' | null;

const DAYS_KEY = 'arete.install.days';
const DISMISSED_KEY = 'arete.install.dismissed';
/** Set once the standalone app has offered to turn notifications on. */
export const NOTIFICATIONS_OFFERED_KEY = 'arete.notifications.offered';

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Storage can be blocked (private mode): the prompt then behaves as new. */
export function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeFlag(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered: at worst the prompt shows again next time.
  }
}

/** Listen from startup: Chrome fires the event before React mounts. */
export function captureInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // no mini-infobar: the app picks its moment
    deferred = event as BeforeInstallPromptEvent;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    writeFlag(DISMISSED_KEY, '1');
    changed();
  });
}

export function onInstallChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Distinct days the app was opened; only the two latest are kept. */
export function recordVisit(today: string = toLocalISODate()): number {
  const days = (readFlag(DAYS_KEY) ?? '').split(',').filter(Boolean);
  if (!days.includes(today)) days.push(today);
  const kept = days.slice(-2);
  writeFlag(DAYS_KEY, kept.join(','));
  return kept.length;
}

export function installOffer(visits: number): InstallOffer {
  if (isStandalone() || readFlag(DISMISSED_KEY) || visits < 2) return null;
  if (deferred) return 'android';
  return isIos() ? 'ios' : null;
}

/** Replay Chrome's prompt; call it straight from a click. */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  deferred = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'accepted') writeFlag(DISMISSED_KEY, '1');
  changed();
}

export function dismissInstall(): void {
  writeFlag(DISMISSED_KEY, '1');
  changed();
}
