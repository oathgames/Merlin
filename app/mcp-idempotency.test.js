'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IdempotencyStore, hashKey, generateKey } = require('./mcp-idempotency');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-idem-test-'));
}

test('hashKey rejects short or missing keys', () => {
  assert.equal(hashKey('b', 't', null), null);
  assert.equal(hashKey('b', 't', ''), null);
  assert.equal(hashKey('b', 't', 'abc'), null); // under 4 chars
  assert.equal(hashKey('b', 't', 'a'.repeat(257)), null); // over 256
  assert.equal(typeof hashKey('b', 't', 'valid-key'), 'string');
});

test('hashKey is deterministic and brand-scoped', () => {
  const a = hashKey('brandA', 'tool', 'key-1');
  const b = hashKey('brandA', 'tool', 'key-1');
  const c = hashKey('brandB', 'tool', 'key-1');
  assert.equal(a, b, 'same inputs must produce same hash');
  assert.notEqual(a, c, 'different brand must produce different hash');
});

test('generateKey produces unique auto-prefixed keys', () => {
  const a = generateKey();
  const b = generateKey();
  assert.ok(a.startsWith('auto-'));
  assert.notEqual(a, b);
});

test('IdempotencyStore requires a dir', () => {
  assert.throws(() => new IdempotencyStore({}), /dir/);
  assert.throws(() => new IdempotencyStore(), /dir/);
});

test('put/get round-trips a result', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  const result = { ok: true, data: { id: 'ad_123' } };
  const stored = store.put('madchill', 'meta_launch_test_ad', 'req-abc-1', result);
  assert.equal(stored, true);
  const cached = store.get('madchill', 'meta_launch_test_ad', 'req-abc-1');
  assert.ok(cached);
  assert.deepEqual(cached.result, result);
  assert.ok(typeof cached.storedAt === 'number');
});

test('get returns null on miss', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  assert.equal(store.get('b', 't', 'never-seen'), null);
});

test('get returns null for keys from a different brand', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  store.put('brandA', 'tool', 'shared-key', { data: 1 });
  assert.equal(store.get('brandB', 'tool', 'shared-key'), null);
});

test('get returns null for keys from a different tool', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  store.put('brand', 'toolA', 'shared-key', { data: 1 });
  assert.equal(store.get('brand', 'toolB', 'shared-key'), null);
});

test('put with invalid key returns false', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  assert.equal(store.put('b', 't', null, { data: 1 }), false);
  assert.equal(store.put('b', 't', '', { data: 1 }), false);
});

test('TTL expiration: expired entries are treated as misses and deleted', () => {
  const dir = tmpDir();
  const store = new IdempotencyStore({ dir, ttlMs: 50 });
  store.put('b', 't', 'soon-expired-key', { data: 1 });
  assert.ok(store.get('b', 't', 'soon-expired-key'));
  // Wait past TTL
  return new Promise((resolve) => setTimeout(resolve, 80)).then(() => {
    assert.equal(store.get('b', 't', 'soon-expired-key'), null);
  });
});

test('invalidate removes a cached entry', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  store.put('b', 't', 'to-be-invalidated', { data: 1 });
  assert.ok(store.get('b', 't', 'to-be-invalidated'));
  assert.equal(store.invalidate('b', 't', 'to-be-invalidated'), true);
  assert.equal(store.get('b', 't', 'to-be-invalidated'), null);
});

test('invalidate returns false on missing entries', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  assert.equal(store.invalidate('b', 't', 'never-existed'), false);
});

test('stats counts entries and total bytes', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  store.put('b', 't', 'key-one', { data: 'a' });
  store.put('b', 't', 'key-two', { data: 'bb' });
  const s = store.stats();
  assert.equal(s.count, 2);
  assert.ok(s.bytes > 0);
});

test('atomic write: corrupt file is treated as miss', () => {
  const dir = tmpDir();
  const store = new IdempotencyStore({ dir });
  const hash = hashKey('b', 't', 'corrupt-key');
  const filePath = path.join(dir, `${hash}.json`);
  fs.writeFileSync(filePath, '{not valid json');
  assert.equal(store.get('b', 't', 'corrupt-key'), null);
  // Corrupt file should have been deleted
  assert.equal(fs.existsSync(filePath), false);
});

test('retry-safe duplicate prevention: same key returns same result', () => {
  const store = new IdempotencyStore({ dir: tmpDir() });
  // Simulate "first call creates ad, returns ad_id"
  const firstResult = { ok: true, data: { ad_id: 'ad_xyz', spent: 0 } };
  store.put('brand', 'meta_launch_test_ad', 'retry-safe-key-1', firstResult);

  // Simulate auto-mode retry with same key — MUST NOT create a second ad.
  const cached = store.get('brand', 'meta_launch_test_ad', 'retry-safe-key-1');
  assert.equal(cached.result.data.ad_id, 'ad_xyz');
  // Handler should SEE the cache hit and return it instead of re-invoking the binary.
});
