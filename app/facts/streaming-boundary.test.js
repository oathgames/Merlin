// streaming-boundary.test.js — J8 coverage from FACT-BINDING-PLAN §J.
//
// Problem: Claude streams responses as many small deltas. The critical-zone
// regex runs per-delta and will over-match if a number is split across
// deltas (e.g. `"$1,23"` + `"4.56"` — the first delta looks like a bare
// 2-digit integer that the scanner might misclassify). The same hazard
// applies to `{{fact:...}}` tokens being split down the middle
// (`"{{fact:mer_7"` + `"d}}"`) and to `<span data-fact="..." ... >` being
// split inside the tag.
//
// The renderer's TailQuarantine exists exactly to absorb these splits: it
// holds the last 320 bytes unflushed until either a new delta extends the
// buffer past threshold or finalize() runs at end-of-message. This test
// file drives the quarantine with adversarial deltas and asserts that:
//
//   1. Split `{{fact:...}}` tokens never flash as partial text on screen
//      (visible prefix never contains a bare `{{fact:` without its close).
//   2. Split currency/percent literals never flash as a truncated form
//      (visible prefix never contains a literal whose completion sits in
//      the buffered tail).
//   3. finalize() emits the remaining tail so it can run through Pass 3
//      once more — no silent data loss.
//   4. The absolute 2s deadline defeats a slow-drip adversary that tries
//      to keep a partial token pending forever.
//
// This file is the rendering-side twin to factverify/hallucination_traps_test.go
// (J7). Together they cover both layers: the renderer stops partial flashes
// and Pass 3 quarantines fabrications; the send-boundary verifier is the
// backstop for outbound content.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TailQuarantine, TAIL_QUARANTINE_BYTES } = require('./verify-facts');

// Helper: drive a TailQuarantine with a sequence of deltas, returning the
// accumulated "visible" prefix (what the renderer would have painted) and
// the final tail after finalize().
function drive(deltas, opts) {
  const tq = new TailQuarantine(opts);
  let visible = '';
  for (const d of deltas) {
    visible += tq.push(d);
  }
  const remainder = tq.finalize();
  return { visible, remainder, full: visible + remainder };
}

// ── 1. Split fact tokens never flash partial ──────────────────────────────

test('J8: {{fact:...}} token split across two deltas — first delta never exposes partial token', () => {
  // The first delta ends mid-token. Ensure the partial `{{fact:mer_7` does
  // not appear in the visible stream — it stays buffered until the close.
  const padding = 'a'.repeat(TAIL_QUARANTINE_BYTES); // > threshold so some content flushes
  const deltas = [
    padding + 'Revenue: {{fact:mer_7',
    'abcdef1234}}.',
  ];
  const { visible, full } = drive(deltas);
  assert.ok(!visible.includes('{{fact:mer_7'),
    `visible output leaked partial token: ${JSON.stringify(visible.slice(-80))}`);
  // After finalize, the full concatenation has the complete token — the
  // renderer can now run Pass 1 on it and substitute cleanly.
  assert.ok(full.includes('{{fact:mer_7abcdef1234}}'),
    `finalize should expose the full token, got: ${JSON.stringify(full.slice(-80))}`);
});

// ── 2. Split currency literals never flash truncated ──────────────────────

test('J8: currency literal split mid-digits — partial flash never visible', () => {
  const padding = 'x'.repeat(TAIL_QUARANTINE_BYTES);
  // "$1,234.56" split after "$1,23"
  const deltas = [padding + 'Spent $1,23', '4.56 this week.'];
  const { visible, full } = drive(deltas);
  // The middle delta boundary — if we were NOT quarantining, a reader of
  // `visible` might briefly see "$1,23" which could misrender. The
  // quarantine guarantees `visible` either has the complete literal or
  // nothing of it.
  const sawPartial = visible.endsWith('$1,23') || /\$1,23[^0-9.,]/.test(visible);
  assert.ok(!sawPartial, `partial literal leaked: ${JSON.stringify(visible.slice(-40))}`);
  assert.ok(full.includes('$1,234.56'), 'complete literal should appear after finalize');
});

// ── 3. finalize flushes the tail — no silent truncation ───────────────────

test('J8: finalize returns remaining tail so Pass 3 can re-scan', () => {
  const tq = new TailQuarantine();
  // Push less than threshold — nothing should flush yet.
  const visible1 = tq.push('Revenue: $99.00');
  assert.equal(visible1, '', 'under-threshold push should buffer, not flush');
  const tail = tq.finalize();
  assert.equal(tail, 'Revenue: $99.00', 'finalize must return everything buffered');
});

// ── 4. Slow-drip absolute deadline ────────────────────────────────────────

test('J8: 2s absolute deadline defeats slow-drip attacker', async () => {
  const tq = new TailQuarantine({ absoluteMs: 50 }); // shortened for test
  const pre = tq.push('suspicious-tail'); // buffered, nothing visible yet
  assert.equal(pre, '');
  // Wait past the deadline.
  await new Promise((r) => setTimeout(r, 80));
  const afterDeadline = tq.push('...');
  // After the deadline, push() forces a full flush including the suspicious
  // tail. An attacker cannot dangle it forever hoping to time a race.
  assert.ok(afterDeadline.includes('suspicious-tail'),
    `deadline should have force-flushed: got ${JSON.stringify(afterDeadline)}`);
});

// ── 5. Mixed-delta adversarial stream ─────────────────────────────────────

test('J8: realistic adversarial stream — many tiny deltas, no partial flash', () => {
  // Simulate a Claude stream of many 5-10 char deltas with a fact token
  // straddling 3 of them. The visible output must be prefix-consistent
  // with the final output: i.e. the final output starts with exactly what
  // `visible` contained.
  const full = 'Monthly revenue: {{fact:revenueabcdef1234567890abcdef12}} grew 14.2% over last month with CAC at $22.50 throughout.';
  // Chop into random-ish 4-12 char chunks.
  const chunks = [];
  let pos = 0;
  let rng = 42;
  const next = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return 4 + (rng % 9);
  };
  while (pos < full.length) {
    const size = next();
    chunks.push(full.slice(pos, pos + size));
    pos += size;
  }
  const { visible, full: total } = drive(chunks);
  // Invariant: visible is always a prefix of total.
  assert.ok(total.startsWith(visible),
    `visible output is not a prefix of total:\nvisible=${JSON.stringify(visible)}\ntotal=${JSON.stringify(total)}`);
  // Invariant: visible never ends mid-token.
  assert.ok(!/\{\{fact:[^}]*$/.test(visible),
    `visible ends mid-token: ${JSON.stringify(visible.slice(-40))}`);
  assert.equal(total, full);
});
