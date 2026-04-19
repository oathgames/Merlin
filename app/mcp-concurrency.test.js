'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ConcurrencyManager, Semaphore, DEFAULT_CAPS } = require('./mcp-concurrency');

// Helper: a promise that resolves after `ms` milliseconds using setImmediate
// loops, so tests don't rely on real wall-clock time.
function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

test('Semaphore capacity must be >= 1', () => {
  assert.throws(() => new Semaphore(0, 'x'), /capacity/);
  assert.throws(() => new Semaphore(-1, 'x'), /capacity/);
});

test('Semaphore acquires up to capacity without blocking', async () => {
  const sem = new Semaphore(3, 'test');
  const waits = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
  assert.deepEqual(waits, [0, 0, 0]);
  assert.equal(sem.stats().available, 0);
  sem.release(); sem.release(); sem.release();
});

test('Semaphore queues callers past capacity and serves FIFO on release', async () => {
  const sem = new Semaphore(1, 'test');
  const order = [];
  await sem.acquire(); // hold the only slot

  const a = sem.acquire().then(() => order.push('a'));
  const b = sem.acquire().then(() => order.push('b'));
  const c = sem.acquire().then(() => order.push('c'));

  // None should run while the slot is held
  await tick(10);
  assert.deepEqual(order, []);

  sem.release(); // a should run
  await a;
  assert.deepEqual(order, ['a']);

  sem.release();
  await b;
  assert.deepEqual(order, ['a', 'b']);

  sem.release();
  await c;
  assert.deepEqual(order, ['a', 'b', 'c']);

  sem.release();
});

test('Semaphore release without outstanding acquire does not raise capacity', () => {
  const sem = new Semaphore(2, 'test');
  const originalWarn = console.warn;
  console.warn = () => {};
  sem.release(); // buggy — should warn, not silently raise
  sem.release();
  console.warn = originalWarn;
  assert.equal(sem.stats().available, 2);
});

test('ConcurrencyManager.withSlot bounds parallel fanout', async () => {
  const mgr = new ConcurrencyManager({ testp: 3 });
  let concurrent = 0;
  let peak = 0;

  const makeTask = () => mgr.withSlot('testp', async () => {
    concurrent += 1;
    if (concurrent > peak) peak = concurrent;
    await tick(20);
    concurrent -= 1;
    return 'ok';
  });

  // Fire 10 parallel tasks against a cap of 3 — peak must never exceed 3.
  const results = await Promise.all(Array.from({ length: 10 }, makeTask));
  assert.equal(results.length, 10);
  assert.equal(peak, 3, `expected peak concurrency 3, got ${peak}`);
});

test('ConcurrencyManager releases slot on handler exception', async () => {
  const mgr = new ConcurrencyManager({ testp: 1 });

  // First call throws — slot must be released so the next call can proceed.
  await assert.rejects(
    mgr.withSlot('testp', async () => { throw new Error('boom'); }),
    /boom/,
  );

  // Without slot-on-error release, this would hang forever.
  const result = await Promise.race([
    mgr.withSlot('testp', async () => 'recovered'),
    tick(500).then(() => 'timeout'),
  ]);
  assert.equal(result, 'recovered');
});

test('ConcurrencyManager keeps per-platform slots isolated', async () => {
  const mgr = new ConcurrencyManager({ a: 1, b: 1 });
  let aRunning = false, bRunning = false;

  const aTask = mgr.withSlot('a', async () => { aRunning = true; await tick(30); aRunning = false; });
  const bTask = mgr.withSlot('b', async () => { bRunning = true; await tick(30); bRunning = false; });

  // Both should start concurrently — different platform buckets.
  await tick(5);
  assert.equal(aRunning, true);
  assert.equal(bRunning, true);

  await Promise.all([aTask, bTask]);
});

test('ConcurrencyManager falls back to _default cap for unknown platforms', async () => {
  const mgr = new ConcurrencyManager({ _default: 2 });
  let peak = 0;
  let running = 0;

  const tasks = Array.from({ length: 6 }, () =>
    mgr.withSlot('mystery_platform', async () => {
      running += 1;
      if (running > peak) peak = running;
      await tick(15);
      running -= 1;
    })
  );
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test('snapshot reports capacity/available/waiting per platform', async () => {
  const mgr = new ConcurrencyManager({ testp: 2 });
  // Hold both slots.
  const release = [];
  await Promise.all([
    new Promise((resolve) => mgr.withSlot('testp', async () => { release.push(resolve); await new Promise(() => {}); }).catch(() => {})),
    new Promise((resolve) => mgr.withSlot('testp', async () => { release.push(resolve); await new Promise(() => {}); }).catch(() => {})),
  ].map((p) => Promise.race([p, tick(10)])));

  // Now queue 2 more — they should show up as waiting.
  mgr.withSlot('testp', async () => {}).catch(() => {});
  mgr.withSlot('testp', async () => {}).catch(() => {});
  await tick(5);

  const snap = mgr.snapshot();
  assert.ok(snap.testp);
  assert.equal(snap.testp.capacity, 2);
  assert.equal(snap.testp.available, 0);
  assert.ok(snap.testp.waiting >= 2);
});

test('DEFAULT_CAPS covers every rate-limited platform the binary knows about', () => {
  // Mirrors platformLimits in autocmo-core/ratelimit_preflight.go.
  // Drift here = MCP layer lets through a platform the binary rate-limits.
  const binaryPlatforms = [
    'meta', 'tiktok', 'google', 'google_merchant', 'shopify', 'amazon',
    'klaviyo', 'etsy', 'reddit_ads', 'reddit_organic', 'linkedin', 'stripe',
    'foreplay', 'fal', 'elevenlabs', 'heygen',
  ];
  for (const p of binaryPlatforms) {
    assert.ok(
      typeof DEFAULT_CAPS[p] === 'number',
      `DEFAULT_CAPS is missing ${p} — drift from ratelimit_preflight.go`,
    );
    assert.ok(DEFAULT_CAPS[p] >= 1, `${p} cap must be >= 1`);
  }
  assert.ok(typeof DEFAULT_CAPS._default === 'number');
});

test('rate-limit stress: 100 parallel calls against cap=5 never exceeds 5 concurrent', async () => {
  // This is the "protect the client from getting banned" test. Under Claude
  // auto-mode fanout, 100 parallel launch_test_ad calls must serialize
  // through the semaphore, not all hit the binary at once.
  const mgr = new ConcurrencyManager({ meta: 5 });
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 100 }, () =>
    mgr.withSlot('meta', async () => {
      running += 1;
      if (running > peak) peak = running;
      await tick(2);
      running -= 1;
    })
  );
  await Promise.all(tasks);
  assert.equal(peak, 5, `peak was ${peak}, expected 5`);
});
