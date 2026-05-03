/* Hawaii Natural Clean CRM — Service Worker
 *
 * Phase 1 responsibilities:
 *   - Install / activate lifecycle (no aggressive caching yet — the app loads
 *     entirely from network, which is fine for an internal tool and avoids
 *     the "stale UI after deploy" problem.)
 *   - Push event listener (skeleton — wired up in Phase 2 with VAPID +
 *     subscription DB).
 *   - Notification click handler — opens the CRM tab on tap.
 *
 * Versioning: bump SW_VERSION on each deploy that changes this file so the
 * browser refreshes the worker. The CRM bumps it at build time (or just
 * manually here when we change the SW).
 */

const SW_VERSION = '2026-05-03-v1';

self.addEventListener('install', (event) => {
  // skipWaiting forces this worker to take over from any older active SW
  // immediately, so users don't have to close + reopen the app to get the
  // latest service worker code.
  console.log('[SW] install', SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate', SW_VERSION);
  // Take control of all open clients (already-loaded pages) without a
  // page reload.
  event.waitUntil(self.clients.claim());
});

// We don't intercept fetch yet — the CRM is an internal tool, network-first
// is fine and avoids cache-staleness bugs. If we later want offline, add
// strategic caching here for static assets only (icons, fonts, manifest).
self.addEventListener('fetch', (event) => {
  // Pass-through; let the browser handle as if the SW weren't here.
});

/* ── PUSH NOTIFICATIONS ──────────────────────────────────────────────────
 * Wired up in Phase 2 (VAPID keys + subscription registration). The handler
 * is here now so the contract is clear: server sends a JSON payload, we
 * surface it as a system notification.
 *
 * Expected payload shape:
 *   {
 *     title: "Dane Kreisman replied — mark as lost?",
 *     body: "AI flagged inbound SMS as lost-intent (high confidence)",
 *     url: "/#tasks",        // deep link, opened on tap
 *     tag: "lost-intent-67f...",  // dedupe key (replaces existing)
 *     icon: "/icons/icon-192.png" (optional, falls back to default)
 *   }
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    // If the push payload isn't JSON for some reason, fall back to the
    // raw text as the body.
    data = { title: 'Hawaii Natural Clean', body: event.data ? event.data.text() : 'New notification' };
  }
  const title = data.title || 'Hawaii Natural Clean';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || undefined,
    // Replace any existing notification with the same tag (e.g., updated
    // status on the same lead) instead of stacking duplicates.
    renotify: !!data.tag,
    data: { url: data.url || '/' },
    // requireInteraction keeps the notification on screen until the user
    // dismisses it — useful for time-sensitive items but can be annoying.
    // Default off; server can pass true for high-priority alerts.
    requireInteraction: !!data.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    // If a CRM tab is already open, focus it and navigate. Otherwise open new.
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = allClients.find((c) => c.url && c.url.includes(self.location.origin));
    if (existing) {
      try { await existing.focus(); } catch (e) {}
      try { existing.navigate(targetUrl); } catch (e) {
        // navigate() can fail if cross-origin or in some Safari versions —
        // post a message and let the page handle the URL change.
        existing.postMessage({ type: 'navigate', url: targetUrl });
      }
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});
