// Unit tests for app/async-barrier.js — the init-serialization barrier
// that prevents brand-switch from racing against an in-flight startSession.
//
// Run with: node app/async-barrier.test.js
// Exits non-zero on any failure.

'use strict';

const { createInitBarrier } = require('./async-barrier');

let passed = 0;
let failed = 0;
const errors = [];

function assert(cond, label) {
  if (cond) { passed++; return; }
  failed++;
  errors.push(label);
  console.error('  FAIL:', label);
}

async function assertResolvesWithin(p, ms, label) {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  assert(settled, `${label} (should resolve within ${ms}ms)`);
}

async function assertPendingAfter(p, ms, label) {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  assert(!settled, `${label} (should still be pending after ${ms}ms)`);
}

// ── Test: whenReady() on an unarmed barrier resolves immediately ──────
(async function testUnarmedReady() {
  const b = createInitBarrier();
  assert(!b.isArmed(), 'new barrier is not armed');
  await b.whenReady(); // should not hang
  passed++;
})().catch((e) => { failed++; errors.push('testUnarmedReady threw: ' + e.message); });

// ── Test: whenReady() blocks until release() is called ────────────────
(async function testBlocksUntilRelease() {
  const b = createInitBarrier();
  const { release } = b.arm();
  assert(b.isArmed(), 'barrier is armed after arm()');
  const readyPromise = b.whenReady();
  await assertPendingAfter(readyPromise, 30, 'whenReady pending while armed');
  release();
  await assertResolvesWithin(readyPromise, 30, 'whenReady resolves after release');
  assert(!b.isArmed(), 'barrier is un-armed after release');
})().catch((e) => { failed++; errors.push('testBlocksUntilRelease threw: ' + e.message); });

// ── Test: second arm() while first is in-flight chains — ──────────────
//         whenReady() sees both releases before resolving
(async function testChained() {
  const b = createInitBarrier();
  const a = b.arm();
  const b2 = b.arm(); // chained onto a
  const ready = b.whenReady();
  await assertPendingAfter(ready, 20, 'whenReady pending before any release');
  b2.release(); // release the second one
  await assertPendingAfter(ready, 20, 'whenReady still pending — prior not released');
  a.release(); // release the first
  await assertResolvesWithin(ready, 30, 'whenReady resolves after both released');
})().catch((e) => { failed++; errors.push('testChained threw: ' + e.message); });

// ── Test: release() is idempotent ─────────────────────────────────────
(async function testReleaseIdempotent() {
  const b = createInitBarrier();
  const { release } = b.arm();
  release();
  release(); // must not throw
  await b.whenReady(); // must not hang
  passed++;
})().catch((e) => { failed++; errors.push('testReleaseIdempotent threw: ' + e.message); });

// ── Test: race simulation — switch-brand serializes against startSession ─
// Models the exact production flow: startSession arms the barrier,
// switch-brand awaits whenReady() before issuing its abort. This is the
// "fix after 1 switch breaks" regression test.
(async function testRaceSerialization() {
  const b = createInitBarrier();
  const events = [];

  async function fakeStartSession(label, delayMs) {
    const { release } = b.arm();
    try {
      events.push(`${label}:init-start`);
      await new Promise((r) => setTimeout(r, delayMs));
      events.push(`${label}:init-done`);
    } finally {
      release();
    }
  }

  async function fakeSwitchBrand(label) {
    await b.whenReady();
    events.push(`${label}:switch-observed-ready`);
  }

  // Kick off startSession(A), which will take 50ms.
  const sA = fakeStartSession('A', 50);
  // Immediately fire a switch-brand — it should NOT observe ready until
  // A's init completes.
  const switchFirst = fakeSwitchBrand('switch-1');
  await new Promise((r) => setTimeout(r, 10));
  assert(
    !events.includes('switch-1:switch-observed-ready'),
    'switch-1 must not observe ready while A is still initializing'
  );

  // Fire a second rapid switch. It too must wait.
  const switchSecond = fakeSwitchBrand('switch-2');
  await new Promise((r) => setTimeout(r, 10));
  assert(
    !events.includes('switch-2:switch-observed-ready'),
    'switch-2 must not observe ready while A is still initializing'
  );

  await sA;
  await switchFirst;
  await switchSecond;

  const iStart = events.indexOf('A:init-start');
  const iDone = events.indexOf('A:init-done');
  const iSw1 = events.indexOf('switch-1:switch-observed-ready');
  const iSw2 = events.indexOf('switch-2:switch-observed-ready');
  assert(iStart >= 0 && iDone > iStart, 'A init-start precedes A init-done');
  assert(iSw1 > iDone, 'switch-1 observed ready only AFTER A init-done');
  assert(iSw2 > iDone, 'switch-2 observed ready only AFTER A init-done');
})().catch((e) => { failed++; errors.push('testRaceSerialization threw: ' + e.message); });

// ── Summary ───────────────────────────────────────────────────────────
// Wait a beat for the async IIFEs to settle, then report.
setTimeout(() => {
  console.log(`\nasync-barrier.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }
  process.exit(0);
}, 500);
