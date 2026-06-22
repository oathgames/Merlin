// reliability-guards.test.js — REGRESSION GUARD (2026-06-22, RSI)
//
// Locks three renderer reliability guards added in the RSI pass, each bringing a
// missed async path in line with the guards its siblings already carry:
//   1. loadArchive "live" branch wraps get-live-ads in try/catch (a rejection
//      previously skipped the `loading` clear -> stuck spinner + unhandled
//      rejection; siblings swipes/all already wrap).
//   2. loadSpells bumps a sequence token + bails after each await (mirror of
//      loadConnections), so a slow brand-A listSpells can't paint into brand B.
//   3. sendMessage refuses re-entry while a turn is in flight (double-submit).
// Pure source-scan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('loadArchive live branch guards get-live-ads against rejection (no stuck spinner)', () => {
  const i = renderer.indexOf('await merlin.getLiveAds(activeBrand)');
  assert.ok(i >= 0, 'getLiveAds call not found');
  const before = renderer.slice(Math.max(0, i - 200), i);
  assert.match(before, /try\s*\{/, 'getLiveAds await must be wrapped in try/catch like its sibling branches');
});

test('loadSpells has a brand-switch race guard', () => {
  const i = renderer.indexOf('async function loadSpells()');
  assert.ok(i >= 0, 'loadSpells not found');
  const block = renderer.slice(i, i + 1600);
  assert.ok(block.includes('_spellLoadSeq'), 'loadSpells must bump a sequence token');
  assert.ok((block.match(/spellLoadStale\(\)/g) || []).length >= 2,
    'loadSpells must bail after each await (>= 2 stale checks)');
});

test('sendMessage refuses re-entry while a turn is in flight (double-submit guard)', () => {
  const i = renderer.indexOf('function sendMessage()');
  assert.ok(i >= 0, 'sendMessage not found');
  const block = renderer.slice(i, i + 700);
  assert.match(block, /if\s*\(isStreaming\s*\|\|\s*sessionActive\)\s*return/,
    'sendMessage must guard against double-submit at the top');
});
