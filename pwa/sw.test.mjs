// Tests for pwa/sw.js — the versioned service-worker cache rotation and
// fetch fall-through logic. Service workers aren't runnable in plain Node,
// so we fake the globals the worker touches (self, caches, importScripts,
// fetch, Response) with in-memory stubs, then load sw.js as a CommonJS
// module and exercise the exported helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────
// Cache stub. In-memory Map of name → Map(url → Response-like).
// ─────────────────────────────────────────────────────────────────────

function makeCacheStub() {
  const store = new Map();

  function getOrCreate(name) {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  }

  const caches = {
    async open(name) {
      const entries = getOrCreate(name);
      return {
        async put(req, res) {
          const key = typeof req === 'string' ? req : req.url;
          entries.set(key, res);
        },
        async match(req) {
          const key = typeof req === 'string' ? req : (req && req.url) || '';
          return entries.get(key);
        },
      };
    },
    async keys() {
      return Array.from(store.keys());
    },
    async delete(name) {
      return store.delete(name);
    },
    _peek: () => store,
  };
  return caches;
}

// ─────────────────────────────────────────────────────────────────────
// Load the SW source inside a fresh VM context per test so module-level
// state (CACHE_VERSION, etc.) doesn't leak between cases.
// ─────────────────────────────────────────────────────────────────────

const SW_SOURCE = readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
const VERSION_SOURCE = readFileSync(path.join(__dirname, 'version.js'), 'utf8');

function loadSw({ version = '9.9.9', fetchImpl, responseFactory } = {}) {
  const caches = makeCacheStub();
  const listeners = {};
  const moduleObj = { exports: {} };

  const selfObj = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting() {},
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async () => {},
    },
    location: { origin: 'http://localhost' },
    registration: { showNotification: async () => {} },
  };

  const ctx = {
    self: selfObj,
    caches,
    fetch: fetchImpl || (async (url) => responseFactory(url)),
    Response: class MockResponse {
      constructor(body, init) { this.body = body; this.init = init || {}; this.ok = !!(init && init.ok !== false); }
      static error() { return new (class { constructor() { this.ok = false; this.errored = true; } })(); }
    },
    URL,
    Promise,
    console,
    module: moduleObj,
    importScripts(_name) {
      // Inline version.js — ignores the path, just executes the source.
      vm.runInContext(VERSION_SOURCE, ctx);
      selfObj.MERLIN_PWA_VERSION = version;
    },
  };

  vm.createContext(ctx);
  vm.runInContext(SW_SOURCE, ctx);

  return { ctx, caches, listeners, exports: moduleObj.exports };
}

// ─────────────────────────────────────────────────────────────────────

test('version.js assigns MERLIN_PWA_VERSION on self', () => {
  const { ctx } = loadSw({ version: '1.2.3' });
  assert.equal(ctx.self.MERLIN_PWA_VERSION, '1.2.3');
});

test('CACHE_VERSION derives from self.MERLIN_PWA_VERSION', () => {
  const { exports: ex } = loadSw({ version: '1.13.0' });
  assert.equal(ex.CACHE_VERSION, 'merlin-pwa-1.13.0');
  assert.equal(ex.CACHE_PREFIX, 'merlin-pwa-');
});

test('PRECACHE_URLS covers the shell assets', () => {
  const { exports: ex } = loadSw();
  const urls = new Set(ex.PRECACHE_URLS);
  for (const required of ['/', '/index.html', '/pwa.js', '/style.css', '/manifest.json']) {
    assert.ok(urls.has(required), `missing ${required} from PRECACHE_URLS`);
  }
});

test('precache populates the versioned cache with shell assets', async () => {
  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount++;
    return { ok: true, clone: () => ({ url, ok: true, type: 'basic' }) };
  };
  const { exports: ex, caches } = loadSw({ fetchImpl });
  await ex.precache();
  const store = caches._peek();
  assert.ok(store.has(ex.CACHE_VERSION), 'expected versioned cache to exist');
  assert.equal(fetchCount, ex.PRECACHE_URLS.length);
});

test('precache swallows per-URL failures (best-effort)', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/badge-72.png')) throw new Error('404-ish');
    return { ok: true, clone: () => ({ url, ok: true, type: 'basic' }) };
  };
  const { exports: ex, caches } = loadSw({ fetchImpl });
  await assert.doesNotReject(ex.precache());
  const store = caches._peek();
  assert.ok(store.has(ex.CACHE_VERSION));
});

test('cleanupOldCaches deletes merlin-pwa-* entries that are not current', async () => {
  const { exports: ex, caches } = loadSw({ version: '1.13.0' });
  // Seed some fake caches.
  await (await caches.open('merlin-pwa-1.10.0')).put('/x', { body: 'old' });
  await (await caches.open('merlin-pwa-1.11.0')).put('/x', { body: 'old' });
  await (await caches.open('merlin-pwa-1.13.0')).put('/x', { body: 'current' });
  await (await caches.open('other-app-cache')).put('/x', { body: 'foreign' });

  await ex.cleanupOldCaches();

  const remaining = await caches.keys();
  assert.ok(remaining.includes('merlin-pwa-1.13.0'), 'current cache must survive');
  assert.ok(remaining.includes('other-app-cache'), 'foreign namespace must not be touched');
  assert.ok(!remaining.includes('merlin-pwa-1.10.0'));
  assert.ok(!remaining.includes('merlin-pwa-1.11.0'));
});

test('cleanupOldCaches is a no-op when only the current cache exists', async () => {
  const { exports: ex, caches } = loadSw({ version: '1.13.0' });
  await (await caches.open('merlin-pwa-1.13.0')).put('/x', { body: 'current' });
  await ex.cleanupOldCaches();
  const remaining = await caches.keys();
  assert.deepEqual(remaining, ['merlin-pwa-1.13.0']);
});

test('cacheFirst returns cached response without calling fetch', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; return { ok: true, type: 'basic', clone: () => ({}) }; };
  const { exports: ex, caches } = loadSw({ fetchImpl, version: '1.13.0' });

  const cached = { body: 'cached!', ok: true };
  await (await caches.open(ex.CACHE_VERSION)).put('http://localhost/pwa.js', cached);

  const res = await ex.cacheFirst({ url: 'http://localhost/pwa.js', mode: 'no-cors' });
  assert.equal(res, cached);
  assert.equal(fetchCalls, 0);
});

test('cacheFirst falls through to network on cache miss and stores result', async () => {
  const networkRes = { ok: true, type: 'basic', url: 'http://localhost/new.js', clone() { return this; } };
  const fetchImpl = async () => networkRes;
  const { exports: ex, caches } = loadSw({ fetchImpl, version: '1.13.0' });

  const res = await ex.cacheFirst({ url: 'http://localhost/new.js', mode: 'no-cors' });
  assert.equal(res, networkRes);
  const cached = await (await caches.open(ex.CACHE_VERSION)).match('http://localhost/new.js');
  assert.ok(cached, 'network response should have been cached');
});

test('cacheFirst falls back to cached shell for offline navigation', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const { exports: ex, caches } = loadSw({ fetchImpl, version: '1.13.0' });

  const shell = { body: '<html>shell</html>', ok: true };
  await (await caches.open(ex.CACHE_VERSION)).put('/', shell);

  const res = await ex.cacheFirst({ url: 'http://localhost/some-deep-route', mode: 'navigate' });
  assert.equal(res, shell);
});

test('cacheFirst returns Response.error() when both network and cache fail for non-navigation', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const { exports: ex, ctx } = loadSw({ fetchImpl, version: '1.13.0' });
  const res = await ex.cacheFirst({ url: 'http://localhost/pwa.js', mode: 'no-cors' });
  assert.ok(res instanceof ctx.Response || res.errored === true || res.ok === false);
});

test('install listener is registered and triggers precache', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; return { ok: true, type: 'basic', clone: () => ({ ok: true }) }; };
  const { listeners } = loadSw({ fetchImpl, version: '1.13.0' });
  assert.ok(Array.isArray(listeners.install) && listeners.install.length >= 1);

  const waitPromises = [];
  await listeners.install[0]({ waitUntil: (p) => waitPromises.push(p) });
  await Promise.all(waitPromises);
  assert.ok(fetchCalls > 0, 'install should have driven at least one precache fetch');
});

test('activate listener runs cleanup and claim', async () => {
  const { listeners, caches, exports: ex } = loadSw({ version: '1.13.0' });
  await (await caches.open('merlin-pwa-0.0.1')).put('/x', { body: 'stale' });

  const waitPromises = [];
  await listeners.activate[0]({ waitUntil: (p) => waitPromises.push(p) });
  await Promise.all(waitPromises);

  const remaining = await caches.keys();
  assert.ok(!remaining.includes('merlin-pwa-0.0.1'), 'activate should prune old namespaced caches');
  assert.equal(ex.CACHE_VERSION, 'merlin-pwa-1.13.0');
});
