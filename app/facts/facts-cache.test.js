// facts-cache.test.js — Node-native test (require('node:test')).
// Run: node --test app/facts/facts-cache.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FactCache, deriveSessionKey, canonicalBodyForSign, watchFactsFile, defaultFactsFilePath,
} = require('./facts-cache');

const VK = Buffer.from('0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff', 'hex');
const SESSION = 'sess-test-12345678';
const BRAND = 'madchill';

function makeEnv({ value = '100.00', kindClass = 'spend' } = {}) {
  // Build the envelope shape that Go would emit.
  const env = {
    id: '', schemaVersion: 1, kind: 'money', kindClass,
    value, unit: 'USD', display: '$' + value, brand: BRAND,
    origin: 'binary', ttlTurns: 0,
    source: { action: 'dashboard', handler: 'h', window: '7d', runId: 'r1', ts: '2026-04-18T00:00:00Z' },
    sessionId: SESSION, sessionNonce: 'bm9uY2U=',
    hmac: '',
  };
  // Id = first 16 bytes of sha256(canonicalBody(env without id+hmac)).
  const idBody = (function () {
    const clone = { ...env };
    clone.id = ''; clone.hmac = '';
    const { canonicalBodyForSign: _c } = require('./facts-cache');
    return _c(clone);
  })();
  env.id = crypto.createHash('sha256').update(idBody).digest('hex').slice(0, 32);
  // Sign.
  const key = deriveSessionKey(VK, SESSION);
  env.hmac = crypto.createHmac('sha256', key)
    .update(canonicalBodyForSign(env)).digest('base64');
  return env;
}

test('HKDF mirrors Go: deterministic for (vaultKey, sessionId)', () => {
  const a = deriveSessionKey(VK, SESSION);
  const b = deriveSessionKey(VK, SESSION);
  assert.deepEqual(a, b);
  const c = deriveSessionKey(VK, 'other-session');
  assert.notDeepEqual(a, c);
});

test('FactCache ingest verifies HMAC and indexes by id + kindClass', () => {
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  // Use real Go emission via subprocess would be ideal; for now emit JS-mirrored.
  const env = makeEnv();
  const r = cache.ingest(env);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(cache.byId.size, 1);
  assert.equal(cache.get(env.id).display, env.display);
  assert.equal(cache.byClass('spend').length, 1);
});

test('Tampered display fails HMAC and is rejected', () => {
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  const env = makeEnv();
  env.display = '$999,999.99'; // tamper
  const r = cache.ingest(env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hmac-mismatch');
});

test('Brand-mismatch envelope rejected', () => {
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  const env = makeEnv();
  env.brand = 'otherbrand';
  // Re-sign so HMAC itself is valid but brand mismatches session brand.
  const key = deriveSessionKey(VK, SESSION);
  env.hmac = crypto.createHmac('sha256', key).update(canonicalBodyForSign(env)).digest('base64');
  const r = cache.ingest(env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'brand-mismatch');
});

test('ttlTurns=1 facts purged at endTurn', () => {
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  const env = makeEnv();
  env.ttlTurns = 1;
  const key = deriveSessionKey(VK, SESSION);
  env.hmac = crypto.createHmac('sha256', key).update(canonicalBodyForSign(env)).digest('base64');
  cache.ingest(env);
  assert.equal(cache.byId.size, 1);
  cache.endTurn();
  assert.equal(cache.byId.size, 0);
});

test('> 20% HMAC fails flips safe-mode', () => {
  let tripped = null;
  const cache = new FactCache({
    sessionId: SESSION, vaultKey: VK, brand: BRAND,
    onSafeMode: (info) => { tripped = info; },
  });
  // 5 good, 2 bad → 2/7 = 28.5% > 20%.
  for (let i = 0; i < 5; i++) {
    const env = makeEnv({ value: String(1 + i) + '.00' });
    cache.ingest(env);
  }
  for (let i = 0; i < 2; i++) {
    const env = makeEnv({ value: '50.00' });
    env.hmac = 'AAAA'; // bogus
    cache.ingest(env);
  }
  assert.ok(tripped, 'safe-mode should have fired');
  assert.ok(cache.safeMode, 'cache should be in safe mode');
});

test('Session-mismatch envelope rejected without burning a slot', () => {
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  const env = makeEnv();
  env.sessionId = 'other-session';
  const r = cache.ingest(env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'session-mismatch');
  assert.equal(cache.byId.size, 0);
});

test('watchFactsFile streams JSONL append-only', async () => {
  const tmp = path.join(os.tmpdir(), 'facts-' + Date.now() + '.jsonl');
  fs.writeFileSync(tmp, '');
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  const stop = watchFactsFile(tmp, cache, { pollMs: 20 });
  try {
    for (let i = 0; i < 3; i++) {
      const env = makeEnv({ value: String(10 + i) + '.00' });
      fs.appendFileSync(tmp, JSON.stringify(env) + '\n');
    }
    // Wait for polling to catch up.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(cache.byId.size, 3);
  } finally {
    stop();
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

test('Partial-line tolerance — trailing partial write held until newline arrives', async () => {
  const tmp = path.join(os.tmpdir(), 'facts-partial-' + Date.now() + '.jsonl');
  fs.writeFileSync(tmp, '');
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  const stop = watchFactsFile(tmp, cache, { pollMs: 20 });
  try {
    const env = makeEnv();
    const line = JSON.stringify(env) + '\n';
    // Write half, then the rest a tick later.
    fs.appendFileSync(tmp, line.slice(0, 40));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(cache.byId.size, 0, 'partial line should not parse');
    fs.appendFileSync(tmp, line.slice(40));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cache.byId.size, 1, 'completed line should parse');
  } finally {
    stop();
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

test('defaultFactsFilePath sanitizes sessionId', () => {
  const p = defaultFactsFilePath({ toolsDir: '/tmp', sessionId: 'abc/../../etc' });
  assert.ok(!p.includes('..'));
  assert.ok(p.includes('abc'));
});
