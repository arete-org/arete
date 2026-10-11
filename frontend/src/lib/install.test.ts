// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { captureInstallPrompt, dismissInstall, installOffer, promptInstall, recordVisit } from './install';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
});

function asIphone(standalone = false) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
  Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
}

it('counts distinct days and keeps only the two latest', () => {
  expect(recordVisit('2026-10-10')).toBe(1);
  expect(recordVisit('2026-10-10')).toBe(1);
  expect(recordVisit('2026-10-11')).toBe(2);
  expect(recordVisit('2026-10-12')).toBe(2);
  expect(localStorage.getItem('arete.install.days')).toBe('2026-10-11,2026-10-12');
});

it('offers the iOS guide to a returning athlete, never when installed or dismissed', () => {
  asIphone();
  expect(installOffer(1)).toBeNull();
  expect(installOffer(2)).toBe('ios');
  dismissInstall();
  expect(installOffer(2)).toBeNull();
  localStorage.clear();
  asIphone(true);
  expect(installOffer(2)).toBeNull();
});

it('replays the deferred Chrome prompt from a click and remembers an install', async () => {
  captureInstallPrompt();
  const prompt = vi.fn(async () => undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(installOffer(2)).toBe('android');
  await promptInstall();
  expect(prompt).toHaveBeenCalledOnce();
  expect(installOffer(2)).toBeNull();
});
