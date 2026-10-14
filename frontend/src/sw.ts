/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope;

// Same behaviour as the former generated worker (registerType: 'autoUpdate').
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigation falls back to the app shell. API calls and the Strava OAuth
// callback must reach the server, never the cached shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }));

// Only the shell is precached. Lazy chunks, fonts and images have content-hashed
// names: the first use caches them for good. The SPA fallback answers a missing
// file with index.html, which must never be kept as an asset.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/assets/'),
  new CacheFirst({
    cacheName: 'assets',
    plugins: [
      { cacheWillUpdate: async ({ response }) => (response.ok && !response.headers.get('content-type')?.includes('text/html') ? response : null) },
      new ExpirationPlugin({ maxEntries: 120, purgeOnQuotaError: true }),
    ],
  })
);

// Private API responses must never fall back to another account's cached data.
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('api-cache'));
});

/** What the server sends (services/notifications.py). */
interface PushPayload {
  title: string;
  body: string;
  url: string;
}

function readPayload(event: PushEvent): PushPayload {
  try {
    const data = event.data?.json() as Partial<PushPayload> | undefined;
    return { title: data?.title ?? 'Arete', body: data?.body ?? '', url: data?.url ?? '/' };
  } catch {
    return { title: 'Arete', body: event.data?.text() ?? '', url: '/' };
  }
}

self.addEventListener('push', (event) => {
  const { title, body, url } = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url },
      icon: '/pwa-192x192.png',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data as { url?: string } | null)?.url ?? '/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === target.origin);
      if (open) {
        await open.focus();
        // Compare the query too: ?rpe=1 on the page already open must still apply.
        const current = new URL(open.url);
        if (current.pathname + current.search !== target.pathname + target.search) await open.navigate(target.href);
        return;
      }
      await self.clients.openWindow(target.href);
    })()
  );
});
