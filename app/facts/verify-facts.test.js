// verify-facts.test.js — node:test tests for Pass 1/2/3 + TailQuarantine.
// Run: node --test app/facts/verify-facts.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  FactCache, deriveSessionKey, canonicalBodyForSign,
} = require('./facts-cache');
const {
  pass1Tokens, pass2Charts, pass3LiteralScan, runAllPasses,
  TailQuarantine, CRITICAL_ZONE_REGEX, CHECKING_HTML, TAIL_QUARANTINE_BYTES,
  buildEchoZones, isInsideEchoDerivation,
} = require('./verify-facts');

const VK = Buffer.from('0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff', 'hex');
const SESSION = 'sess-verify-12345678';
const BRAND = 'madchill';

function makeEnv({
  value = '100.00', kindClass = 'spend', kind = 'money',
  unit = 'USD', display = null, origin = 'binary',
  handler = 'h', windowLabel = '7d',
} = {}) {
  const env = {
    id: '', schemaVersion: 1, kind, kindClass,
    value, unit, display: display || ('$' + value), brand: BRAND,
    origin, ttlTurns: 0,
    source: { action: 'dashboard', handler, window: windowLabel, runId: 'r1', ts: '2026-04-18T00:00:00Z' },
    sessionId: SESSION, sessionNonce: 'bm9uY2U=',
    hmac: '',
  };
  // ID = first 32 hex chars of sha256(canonicalBody without id+hmac).
  const clone = { ...env, id: '', hmac: '' };
  env.id = crypto.createHash('sha256').update(canonicalBodyForSign(clone)).digest('hex').slice(0, 32);
  const key = deriveSessionKey(VK, SESSION);
  env.hmac = crypto.createHmac('sha256', key).update(canonicalBodyForSign(env)).digest('base64');
  return env;
}

function makeCache(envs = []) {
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  for (const e of envs) {
    const r = cache.ingest(e);
    assert.equal(r.ok, true, 'setup: ingest failed ' + JSON.stringify(r));
  }
  return cache;
}

// ── Pass 1 ────────────────────────────────────────────────────────────────

test('pass1: substitutes known tokens into data-fact spans', () => {
  const env = makeEnv({ value: '1234.56', display: '$1,234.56' });
  const cache = makeCache([env]);
  const html = `Revenue came to {{fact:${env.id}}} last week.`;
  const { html: out, unresolved } = pass1Tokens(html, cache);
  assert.equal(unresolved.length, 0);
  assert.ok(out.includes(`<span data-fact="${env.id}">$1,234.56</span>`), out);
});

test('pass1: unresolved token left verbatim and reported', () => {
  const cache = makeCache([]);
  const bogusId = 'deadbeef'.repeat(4); // 32 hex chars
  const html = `Value is {{fact:${bogusId}}} today.`;
  const { html: out, unresolved } = pass1Tokens(html, cache);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0], bogusId);
  assert.ok(out.includes(`{{fact:${bogusId}}}`), 'token should remain verbatim when unresolved');
});

test('pass1: escapes HTML in display strings', () => {
  const env = makeEnv({ value: '1.00', display: '<script>alert(1)</script>' });
  const cache = makeCache([env]);
  const { html: out } = pass1Tokens(`X = {{fact:${env.id}}}.`, cache);
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});

// ── Pass 2 ────────────────────────────────────────────────────────────────

test('pass2: resolves chart config with fact: series prefix into payload', () => {
  const e1 = makeEnv({ value: '100', display: '$100', handler: 'meta' });
  const e2 = makeEnv({ value: '200', display: '$200', handler: 'meta' });
  const cache = makeCache([e1, e2]);
  const cfgJson = JSON.stringify({ title: 'Spend by platform', kind: 'bar', series: 'fact:meta' });
  const html = `<div data-chart-config='${cfgJson}'></div>`;
  const out = pass2Charts(html, cache);
  assert.ok(out.includes('merlin-chart'), out);
  assert.ok(out.includes('data-chart-payload'));
});

test('pass2: fallback when no facts match prefix', () => {
  const cache = makeCache([]);
  const cfgJson = JSON.stringify({ title: 'Missing', kind: 'bar', series: 'fact:nonesuch' });
  const html = `<div data-chart-config='${cfgJson}'></div>`;
  const out = pass2Charts(html, cache);
  assert.ok(out.includes('merlin-chart-fallback'));
  assert.ok(out.includes('no-data'));
});

test('pass2: invalid JSON falls back with invalid-config reason', () => {
  const cache = makeCache([]);
  const html = `<div data-chart-config='not-json'></div>`;
  const out = pass2Charts(html, cache);
  assert.ok(out.includes('merlin-chart-fallback'));
  assert.ok(out.includes('invalid-config'));
});

// ── Pass 3 critical-zone regex ────────────────────────────────────────────

test('pass3 regex: matches currency/rate/duration/grouped/bare-decimal', () => {
  const samples = ['$1,234.56', '3.4%', '2×', '7 days', '10,000', '3.14'];
  for (const s of samples) {
    CRITICAL_ZONE_REGEX.lastIndex = 0;
    const m = CRITICAL_ZONE_REGEX.exec(s);
    assert.ok(m, 'should match: ' + s);
  }
});

test('pass3: quarantines unwrapped currency literals', () => {
  const cache = makeCache([]);
  const html = 'Revenue was $1,234.56 this week.';
  const { html: out, quarantined } = pass3LiteralScan(html, cache);
  assert.equal(quarantined, 1, out);
  assert.ok(out.includes(CHECKING_HTML));
  assert.ok(!out.includes('$1,234.56'));
});

test('pass3: respects data-fact spans (does not re-quarantine)', () => {
  const env = makeEnv({ value: '1234.56', display: '$1,234.56' });
  const cache = makeCache([env]);
  const html = `Revenue was <span data-fact="${env.id}">$1,234.56</span> this week.`;
  const { html: out, quarantined } = pass3LiteralScan(html, cache);
  assert.equal(quarantined, 0, out);
  assert.ok(out.includes('$1,234.56'), 'span-wrapped literal preserved');
});

test('pass3: respects data-fact-exempt regions', () => {
  const cache = makeCache([]);
  const html = `<code data-fact-exempt="sig">$1,234.56 is a sample</code>`;
  const { html: out, quarantined } = pass3LiteralScan(html, cache);
  assert.equal(quarantined, 0);
  assert.ok(out.includes('$1,234.56'));
});

test('pass3: ignores digits inside HTML attributes/tags', () => {
  const cache = makeCache([]);
  const html = `<div style="width:1234px">hello</div>`;
  const { quarantined } = pass3LiteralScan(html, cache);
  assert.equal(quarantined, 0);
});

// ── §4.4.7 arithmetic-implication quarantine ─────────────────────────────

test('echo zones: user_input facts anchor derivation-watch windows', () => {
  const env = makeEnv({ value: '50.00', display: '$50.00', origin: 'user_input' });
  const cache = makeCache([env]);
  const html = 'Budget is $50.00 right now.';
  const zones = buildEchoZones(html, cache, 400);
  assert.equal(zones.length, 1);
  assert.ok(zones[0].watchEnd > zones[0].end);
  assert.equal(html.slice(zones[0].start, zones[0].end), '$50.00');
});

test('isInsideEchoDerivation: triggers only with arithmetic verb in window', () => {
  const env = makeEnv({ value: '50.00', display: '$50.00', origin: 'user_input' });
  const cache = makeCache([env]);

  // Case A: verb present → inside.
  const htmlA = 'Budget is $50.00. If we double that, it implies $100.';
  const zonesA = buildEchoZones(htmlA, cache, 400);
  const offA = htmlA.indexOf('$100');
  assert.ok(offA > 0);
  assert.equal(isInsideEchoDerivation(offA, zonesA, htmlA, 80, ['double', 'implies']), true);

  // Case B: no verb → not inside.
  const htmlB = 'Budget is $50.00. Unrelated text. $100 appears later.';
  const zonesB = buildEchoZones(htmlB, cache, 400);
  const offB = htmlB.indexOf('$100');
  assert.equal(isInsideEchoDerivation(offB, zonesB, htmlB, 80, ['double', 'implies']), false);
});

test('pass3: §4.4.7 quarantines derived literal after verb in watch window', () => {
  const env = makeEnv({ value: '50.00', display: '$50.00', origin: 'user_input' });
  const cache = makeCache([env]);
  const html = `Budget is <span data-fact="${env.id}">$50.00</span>. If you double that, it means $100.`;
  const { html: out, quarantined } = pass3LiteralScan(html, cache);
  // $100 is derived → should be quarantined.
  assert.ok(quarantined >= 1, 'derived value should quarantine');
  assert.ok(!out.includes('$100 '), 'bare $100 should not survive');
});

// ── runAllPasses orchestration ───────────────────────────────────────────

test('runAllPasses: substitutes, skips verified, quarantines stragglers', () => {
  const env = makeEnv({ value: '1234.56', display: '$1,234.56' });
  const cache = makeCache([env]);
  const html = `Revenue is {{fact:${env.id}}} — but also $999 elsewhere.`;
  const r = runAllPasses(html, cache);
  assert.equal(r.unresolvedTokens.length, 0);
  assert.ok(r.html.includes('$1,234.56'));
  // $999 isn't a currency-regex hit (no thousand separator, no decimal),
  // but "$999" is 3 digits. Use something the regex catches instead.
  const html2 = `Revenue is {{fact:${env.id}}} — but also $9,999 elsewhere.`;
  const r2 = runAllPasses(html2, cache);
  assert.ok(r2.quarantinedLiterals >= 1, 'unbacked $9,999 should be quarantined');
  assert.ok(r2.html.includes(CHECKING_HTML));
});

// ── TailQuarantine ───────────────────────────────────────────────────────

test('TailQuarantine: holds last 320 bytes when buffer exceeds threshold', () => {
  const tq = new TailQuarantine({ absoluteMs: 60000 });
  // Push 500 bytes in one shot.
  const chunk = 'a'.repeat(500);
  const emitted = tq.push(chunk);
  assert.equal(emitted.length, 500 - TAIL_QUARANTINE_BYTES);
  // Tail retains remaining bytes.
  const more = tq.push('b'.repeat(100));
  // Combined tail was 320 + 100 = 420 → emits 100 safe-head bytes.
  assert.equal(more.length, 100);
});

test('TailQuarantine: small pushes buffered until threshold', () => {
  const tq = new TailQuarantine({ absoluteMs: 60000 });
  const out = tq.push('hello');
  assert.equal(out, '');
  const out2 = tq.push(' world');
  assert.equal(out2, '');
});

test('TailQuarantine: finalize() flushes remainder', () => {
  const tq = new TailQuarantine({ absoluteMs: 60000 });
  tq.push('partial tail');
  const rest = tq.finalize();
  assert.equal(rest, 'partial tail');
  // After finalize, pushes return empty.
  assert.equal(tq.push('x'), '');
});

test('TailQuarantine: absolute deadline forces flush (slow-drip defense)', async () => {
  const tq = new TailQuarantine({ absoluteMs: 30 });
  const out = tq.push('short');
  assert.equal(out, '');
  await new Promise((r) => setTimeout(r, 50));
  // Next push should trigger absolute-deadline fallback and flush combined.
  const out2 = tq.push('more');
  assert.equal(out2, 'shortmore');
});
