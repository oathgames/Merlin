// verify-facts-perf.test.js — J5 perf gate for the Pass 1/2/3 pipeline.
//
// Plan §J5 locks the rendering-layer latency budget: on a representative
// message (40 facts emitted, 5000-word body, 3 tables, 1 chart config) the
// three passes must finish under:
//
//   P50 ≤ 20ms, P95 ≤ 100ms, P99 ≤ 250ms
//
// These numbers matter because the passes run on EVERY streaming delta in
// the renderer (+ once at finalize). A regression here surfaces as visible
// jank when Claude types fast; the test's job is to catch that in CI, not
// to prove absolute speed on any one machine. Numbers chosen from the plan
// were measured on CI-class hardware (GitHub standard runners); the local
// dev machine should beat them with headroom.
//
// If this test ever fails on real regressions:
//   1. Look at pass3 — most critical-zone rescans bloom from there.
//   2. Check that FactCache.getById() is O(1) — a regressed index is the
//      usual cause.
//   3. Profile with `node --prof` on the failing fixture.
//
// The harness runs `RUNS=100` iterations (configurable via VERIFY_PERF_RUNS)
// and takes P50/P95/P99 from the sorted timings. Each iteration builds a
// fresh DOM-free HTML string and feeds it through runAllPasses. We explicitly
// NOT construct a DOM (jsdom is slow) — the passes all operate on strings +
// regex, so timing with pure strings matches real-world usage.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  FactCache, deriveSessionKey, canonicalBodyForSign,
} = require('./facts-cache');
const { runAllPasses } = require('./verify-facts');

const VK = Buffer.from('deadbeef'.repeat(8), 'hex');
const SESSION = 'sess-perf-benchmark';
const BRAND = 'madchill';

function makeEnv({ value, kindClass, kind, unit, display, handler }) {
  const env = {
    id: '', schemaVersion: 1, kind, kindClass,
    value, unit, display, brand: BRAND,
    origin: 'binary', ttlTurns: 0,
    source: {
      action: 'dashboard', handler, window: '7d',
      runId: 'perf', ts: '2026-04-18T00:00:00Z',
    },
    sessionId: SESSION, sessionNonce: 'bm9uY2U=',
    hmac: '',
  };
  const clone = { ...env, id: '', hmac: '' };
  env.id = crypto.createHash('sha256').update(canonicalBodyForSign(clone)).digest('hex').slice(0, 32);
  const key = deriveSessionKey(VK, SESSION);
  env.hmac = crypto.createHmac('sha256', key).update(canonicalBodyForSign(env)).digest('base64');
  return env;
}

// Build 40 facts of varied kinds — mirrors a typical dashboard emit.
function seed40Facts() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    out.push(makeEnv({
      value: (1000 + i * 37).toFixed(2), kindClass: 'revenue', kind: 'money',
      unit: 'USD', display: '$' + (1000 + i * 37).toFixed(2), handler: 'meta',
    }));
  }
  for (let i = 0; i < 10; i++) {
    out.push(makeEnv({
      value: (2 + i * 0.13).toFixed(2), kindClass: 'roas', kind: 'multiplier',
      unit: 'x', display: ((2 + i * 0.13).toFixed(1)) + '×', handler: 'dashboard',
    }));
  }
  for (let i = 0; i < 10; i++) {
    out.push(makeEnv({
      value: String(100 + i * 3), kindClass: 'purchases', kind: 'count',
      unit: 'count', display: String(100 + i * 3), handler: 'shopify',
    }));
  }
  for (let i = 0; i < 10; i++) {
    out.push(makeEnv({
      value: String(14 + i), kindClass: 'payback', kind: 'duration',
      unit: 'days', display: String(14 + i) + ' days', handler: 'cac',
    }));
  }
  return out;
}

// 5000-word lorem — chosen to match the plan's J5 load spec. We reuse a
// short base phrase and repeat to avoid shipping a 40KB fixture in test
// source; the regex work doesn't care whether the words repeat.
function loremWords(n) {
  const base = 'Revenue grew steadily across the week as spend tracked to plan and new customers continued to arrive through paid and organic channels. '.split(' ');
  const out = [];
  while (out.length < n) out.push(...base);
  return out.slice(0, n).join(' ');
}

// Simulates tables + a chart config — the fact tokens are inlined and will
// be resolved by pass1. Pass2 picks up the chart config. Pass3 scans any
// unwrapped stragglers (there should be none in well-formed body).
function buildMessage(facts) {
  const body = loremWords(5000);
  const moneyEnv = facts[0];
  const roasEnv = facts[10];
  const table1 = `
<table>
  <tr><td>Revenue</td><td>{{fact:${moneyEnv.id}}}</td></tr>
  <tr><td>ROAS</td><td>{{fact:${roasEnv.id}}}</td></tr>
</table>`;
  const table2 = `
<table>
  <tr><td>Purchases</td><td>{{fact:${facts[20].id}}}</td></tr>
  <tr><td>Payback</td><td>{{fact:${facts[30].id}}}</td></tr>
</table>`;
  const table3 = `
<table>
  <tr><th>Day</th><th>Revenue</th><th>ROAS</th></tr>
  <tr><td>Mon</td><td>{{fact:${facts[1].id}}}</td><td>{{fact:${roasEnv.id}}}</td></tr>
</table>`;
  const chartConfig = JSON.stringify({
    type: 'bar',
    title: 'Revenue by day',
    series: 'fact:revenue',
  });
  const chart = `<div data-chart-config='${chartConfig}'></div>`;
  return `${body}\n${table1}\n${table2}\n${table3}\n${chart}\n`;
}

function pctl(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

test('J5 perf: runAllPasses meets P50/P95/P99 budgets on representative message', () => {
  const facts = seed40Facts();
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  for (const f of facts) {
    const r = cache.ingest(f);
    assert.equal(r.ok, true, 'setup: ingest failed ' + JSON.stringify(r));
  }
  const msg = buildMessage(facts);

  const RUNS = Number(process.env.VERIFY_PERF_RUNS || 100);

  // Warm-up: JIT the regex + hashmap lookups before timing.
  for (let i = 0; i < 5; i++) runAllPasses(msg, cache);

  const timings = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    runAllPasses(msg, cache);
    const t1 = process.hrtime.bigint();
    timings.push(Number(t1 - t0) / 1e6); // ns → ms
  }
  timings.sort((a, b) => a - b);
  const p50 = pctl(timings, 0.50);
  const p95 = pctl(timings, 0.95);
  const p99 = pctl(timings, 0.99);

  // Budgets from FACT-BINDING-PLAN §J5. Generous by design — CI runners
  // can be noisy and a 1-off GC pause shouldn't flake. Real regressions
  // move the P50 decisively, not just the tail.
  const P50_BUDGET = 20;
  const P95_BUDGET = 100;
  const P99_BUDGET = 250;

  // eslint-disable-next-line no-console
  console.log(`J5 perf: N=${RUNS}  P50=${p50.toFixed(2)}ms  P95=${p95.toFixed(2)}ms  P99=${p99.toFixed(2)}ms`);

  assert.ok(p50 <= P50_BUDGET, `P50 ${p50.toFixed(2)}ms > budget ${P50_BUDGET}ms`);
  assert.ok(p95 <= P95_BUDGET, `P95 ${p95.toFixed(2)}ms > budget ${P95_BUDGET}ms`);
  assert.ok(p99 <= P99_BUDGET, `P99 ${p99.toFixed(2)}ms > budget ${P99_BUDGET}ms`);
});

test('J5 perf: pathological straggler scan — 200 unwrapped literals', () => {
  // Adversarial: a message with 200 bare currency literals that DON'T have
  // matching facts. Pass 3 must quarantine all of them without blowing the
  // budget. Bounds are looser because we're explicitly stress-testing.
  const cache = new FactCache({ sessionId: SESSION, vaultKey: VK, brand: BRAND });
  const parts = [];
  for (let i = 0; i < 200; i++) parts.push(`Item ${i}: $${1000 + i}.00 this week.`);
  const msg = parts.join('\n');

  const t0 = process.hrtime.bigint();
  runAllPasses(msg, cache);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  // eslint-disable-next-line no-console
  console.log(`J5 perf (adversarial): 200 literals scanned in ${ms.toFixed(2)}ms`);
  assert.ok(ms < 500, `adversarial scan ${ms.toFixed(2)}ms > 500ms`);
});
