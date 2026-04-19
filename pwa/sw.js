// Merlin PWA Service Worker
//
// Three jobs:
//   1. Receive Web Push deliveries from the relay and surface them as
//      native notifications — this is the primary value prop (approval
//      alerts while roaming).
//   2. Focus an existing PWA window (or open one) when the user taps the
//      notification so they land directly on the pending approval.
//   3. Cache the PWA shell (index.html, pwa.js, style.css, manifest.json,
//      icons) under a versioned cache name so an upgrade deterministically
//      rotates clients off the old shell instead of stranding them on a
//      stale bundle.
//
// ─────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-04-19): versioned cache name + activate-time
// cleanup. Before this, sw.js explicitly did NOT cache anything — the
// thinking was "ship push first, cache second." We are now shipping
// second. The rules that must not be relaxed:
//
//   1. CACHE_VERSION derives from self.MERLIN_PWA_VERSION (loaded via
//      importScripts('version.js')). NEVER hard-code a version string
//      in this file — the package.json → version.js → sw.js chain is
//      the ONLY rotation mechanism. If you hard-code, a release that
//      bumps package.json but forgets to touch sw.js will silently
//      serve the stale shell forever.
//
//   2. `install` precaches the shell under the NEW name. `activate`
//      deletes every cache whose name starts with the `merlin-pwa-`
//      prefix AND is not the current one. Widening the delete filter
//      (e.g. "delete all caches") would nuke caches owned by other SWs
//      on the same origin — stay namespaced.
//
//   3. `fetch` is cache-first for same-origin GETs only. Never cache
//      cross-origin responses (the relay, API calls, GitHub releases
//      redirect) — we don't control their freshness semantics and a
//      staled response would look like a Merlin bug. Never cache POST
//      — the Cache API refuses it anyway, but making it explicit here
//      saves a future dev 20 minutes of "why is my fetch failing."
//
//   4. On cache miss the fetch handler falls through to network; on a
//      network failure for a navigation request we serve the cached
//      index.html so the PWA still boots offline (the shell alone is
//      enough to display the "reconnecting…" state from pwa.js).
//
// Tests: pwa/sw.test.mjs covers install precache, activate cleanup of
// stale versions, activate preserving the current version, and fetch
// behavior (same-origin GET hit, cross-origin passthrough, navigation
// offline fallback).
// ─────────────────────────────────────────────────────────────────────
//
// Security:
//   - Push payloads from the relay are small JSON blobs with NO PII (see
//     durable.js firePushes — just `{t, id, title, body}`). We still
//     defensively validate shape and cap lengths before surfacing.
//   - notificationclick only routes to same-origin URLs, never arbitrary
//     ones from the payload.

try {
  // eslint-disable-next-line no-undef
  importScripts('version.js');
} catch (_e) {
  // Fallback if importScripts fails for any reason (e.g. test harness
  // that injects version.js another way). The cache name still needs
  // a value — an undefined suffix would produce "merlin-pwa-undefined"
  // and defeat rotation.
  if (typeof self.MERLIN_PWA_VERSION !== 'string' || !self.MERLIN_PWA_VERSION) {
    self.MERLIN_PWA_VERSION = '0.0.0';
  }
}

const CACHE_PREFIX = 'merlin-pwa-';
const CACHE_VERSION = CACHE_PREFIX + (self.MERLIN_PWA_VERSION || '0.0.0');

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/pwa.js',
  '/style.css',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/badge-72.png',
];

const NOTIFICATION_TAG = 'merlin-approval';
const MAX_TITLE_LEN = 60;
const MAX_BODY_LEN = 120;

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  // Take over immediately on first install so the very first push after
  // pairing isn't missed while an old SW controls the page.
  self.skipWaiting();
});

async function precache() {
  try {
    const cache = await caches.open(CACHE_VERSION);
    // addAll is all-or-nothing. For a best-effort precache (any missing
    // asset would reject the whole install), we add each URL individually
    // and swallow per-URL failures — a missing badge-72.png shouldn't
    // block the SW from activating.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (_e) { /* skip unreachable */ }
    }));
  } catch (_e) {
    // caches may be unavailable in some test harnesses — don't crash
    // install.
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    cleanupOldCaches(),
    self.clients.claim(),
  ]));
});

async function cleanupOldCaches() {
  try {
    const names = await caches.keys();
    await Promise.all(names.map((name) => {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_VERSION) {
        return caches.delete(name);
      }
      return Promise.resolve(false);
    }));
  } catch (_e) { /* harness without caches */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // cross-origin: don't touch

  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    // Only cache successful same-origin basic responses.
    if (res && res.ok && res.type === 'basic') {
      try { await cache.put(req, res.clone()); } catch (_e) { /* quota */ }
    }
    return res;
  } catch (_e) {
    // Network failed AND cache missed. For navigations, serve the cached
    // shell so the app still boots.
    if (req.mode === 'navigate') {
      try {
        const cache = await caches.open(CACHE_VERSION);
        const fallback = await cache.match('/') || await cache.match('/index.html');
        if (fallback) return fallback;
      } catch (_e2) { /* */ }
    }
    return Response.error();
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch {
    // Non-JSON or empty — still show a generic notification so the user
    // knows something is happening. The PWA will fetch the real state
    // over WS when it opens.
  }

  const title = clamp(typeof data.title === 'string' ? data.title : 'Merlin', MAX_TITLE_LEN) || 'Merlin';
  const body  = clamp(typeof data.body  === 'string' ? data.body  : 'Needs your attention', MAX_BODY_LEN) || 'Needs your attention';
  const type  = typeof data.t === 'string' ? data.t : '';
  const id    = typeof data.id === 'string' ? data.id.slice(0, 64) : '';

  await self.registration.showNotification(title, {
    body,
    tag: NOTIFICATION_TAG,           // Coalesce — don't stack 5 notifications for 5 approvals.
    renotify: true,                  // But still buzz if the user hasn't opened the last one.
    requireInteraction: false,       // Auto-dismiss; tap-to-open is the happy path.
    icon: '/icon-192.png',           // Falls back to favicon if the file is missing.
    badge: '/badge-72.png',
    data: { t: type, id, ts: Date.now() },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(focusOrOpen());
});

async function focusOrOpen() {
  const url = new URL('/', self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of windows) {
    // Same-origin only — ignore arbitrary foreign tabs.
    if (new URL(w.url).origin === self.location.origin) {
      try { await w.focus(); return; } catch {}
    }
  }
  if (self.clients.openWindow) {
    await self.clients.openWindow(url);
  }
}

function clamp(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) : s;
}

// Exported for tests only — service workers do not support module
// exports, so we expose internals via a test-only global when running
// under node's test harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CACHE_PREFIX,
    CACHE_VERSION,
    PRECACHE_URLS,
    precache,
    cleanupOldCaches,
    cacheFirst,
  };
}
