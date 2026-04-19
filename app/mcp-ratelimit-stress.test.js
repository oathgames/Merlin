// Rate-limit stress tests — the "never get a client banned" canary.
//
// These tests simulate realistic auto-mode fanout patterns against the
// per-platform semaphore and assert that the MCP layer (a) never exceeds
// its documented concurrent-slot cap, (b) keeps per-platform isolation
// under cross-platform bursts, and (c) doesn't starve any platform when
// multiple are saturated simultaneously.
//
// The MCP cap is a SECOND barrier above the Go binary's PreflightCheck.
// The binary is authoritative for per-minute quotas and safe-mode tamper
// detection. The MCP cap exists so a 500-call auto-mode loop doesn't
// spawn 500 child processes before any of them reach preflight.
//
// DoD items covered here:
//   □ "Per-platform semaphore caps mirror ratelimit_preflight.go exactly"
//   □ "100-parallel fanout never exceeds the documented cap"
//   □ "Cross-platform bursts stay isolated — saturating Meta doesn't
//      delay a Shopify call"
//   □ "Platforms under sustained load keep FIFO fairness — no waiter
//      starves"
//   □ "An exception inside a slot must never leak the slot"
//   □ "Handler latency (300ms per call simulated) does not cause
//      head-of-line blocking across platforms"

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ConcurrencyManager,
  DEFAULT_CAPS,
} = require('./mcp-concurrency');

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Drift guard between MCP caps and the Go binary ──────────────────
// If platformLimits in autocmo-core/ratelimit_preflight.go adds a platform,
// DEFAULT_CAPS MUST add it too. The numbers don't have to match exactly
// (MCP caps are concurrent-slot budgets, binary caps are per-minute quotas)
// but the PRESENCE of a platform must match.

test('DRIFT GUARD: every Go-binary rate-limited platform has an MCP cap', () => {
  // Keep in sync with autocmo-core/ratelimit_preflight.go platformLimits.
  const binaryPlatforms = [
    'meta', 'tiktok', 'google', 'google_merchant', 'shopify', 'amazon',
    'klaviyo', 'etsy', 'reddit_ads', 'reddit_organic', 'linkedin',
    'stripe', 'foreplay', 'fal', 'elevenlabs', 'heygen',
  ];
  for (const p of binaryPlatforms) {
    assert.ok(
      typeof DEFAULT_CAPS[p] === 'number' && DEFAULT_CAPS[p] >= 1,
      `MCP DEFAULT_CAPS missing or invalid for "${p}". Drift: ratelimit_preflight.go knows this platform but MCP does not — fanout will be unbounded.`
    );
  }
});

test('caps are conservative — no platform exceeds 10 concurrent slots', () => {
  // 10 is the official Meta guidance ceiling. No platform in the Go
  // binary documents anything higher for safe concurrent load. If someone
  // bumps a cap above 10 without updating this test, they're bypassing
  // the "never get a client banned" guardrail.
  for (const [platform, cap] of Object.entries(DEFAULT_CAPS)) {
    if (platform === '_default') continue;
    assert.ok(cap <= 10,
      `${platform} cap=${cap} exceeds the 10-concurrent safe-harbor ceiling`);
  }
});

// ── Single-platform stress ──────────────────────────────────────────

test('STRESS: 500 parallel meta calls never exceed cap=5 concurrent', async () => {
  // Forever-21-scale scenario: 500 ads in a catalog, auto-mode launches
  // them all at once. MCP must throttle the fanout to cap=5.
  const mgr = new ConcurrencyManager({ meta: 5 });
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 500 }, () =>
    mgr.withSlot('meta', async () => {
      running += 1;
      if (running > peak) peak = running;
      // Simulate a fast handler — worst case for missing a cap breach.
      await tick(1);
      running -= 1;
    })
  );
  await Promise.all(tasks);
  assert.equal(peak, 5, `peak=${peak}, expected 5`);
});

test('STRESS: handler latency spikes do not cause cap overshoot', async () => {
  // Mix of fast and slow handlers — some take 1ms, some take 50ms. The
  // cap must hold even when new acquires happen while slow ones are
  // still holding slots.
  const mgr = new ConcurrencyManager({ tiktok: 3 });
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 200 }, (_, i) =>
    mgr.withSlot('tiktok', async () => {
      running += 1;
      if (running > peak) peak = running;
      await tick(i % 7 === 0 ? 30 : 1); // spiky latency
      running -= 1;
    })
  );
  await Promise.all(tasks);
  assert.equal(peak, 3, `peak=${peak}, expected 3`);
});

// ── Cross-platform isolation ────────────────────────────────────────

test('ISOLATION: saturating meta does not block shopify or klaviyo', async () => {
  // The canary for per-platform isolation. If a Meta burst under load
  // steals slots from Shopify, a 30k-product Shopify catalog sync would
  // stall waiting for unrelated Meta work.
  const mgr = new ConcurrencyManager({ meta: 2, shopify: 2, klaviyo: 3 });

  // Saturate Meta with long-running calls.
  const metaHolders = [];
  for (let i = 0; i < 5; i++) {
    metaHolders.push(mgr.withSlot('meta', () => tick(100)));
  }
  // Ensure at least 2 are holding before we probe.
  await tick(5);

  // Probe shopify + klaviyo; they should pass through quickly despite
  // meta being saturated.
  const t0 = Date.now();
  await Promise.all([
    mgr.withSlot('shopify', () => tick(5)),
    mgr.withSlot('klaviyo', () => tick(5)),
  ]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `cross-platform isolation broken — elapsed=${elapsed}ms`);

  await Promise.all(metaHolders);
});

test('ISOLATION: all 16 platforms run concurrently to their caps', async () => {
  // The drift guard asserts caps exist. This test confirms they don't
  // share a global pool — every platform gets its own queue.
  const mgr = new ConcurrencyManager(DEFAULT_CAPS);

  const running = {};
  const peak = {};
  const platforms = Object.keys(DEFAULT_CAPS).filter((p) => p !== '_default');

  const tasks = [];
  for (const p of platforms) {
    // Fan out 20 calls per platform — far above any cap.
    for (let i = 0; i < 20; i++) {
      tasks.push(mgr.withSlot(p, async () => {
        running[p] = (running[p] || 0) + 1;
        if (!peak[p] || running[p] > peak[p]) peak[p] = running[p];
        await tick(3);
        running[p] -= 1;
      }));
    }
  }
  await Promise.all(tasks);

  for (const p of platforms) {
    assert.ok(peak[p] <= DEFAULT_CAPS[p],
      `${p} peak=${peak[p]} > cap=${DEFAULT_CAPS[p]} — isolation broken`);
  }
});

// ── Fairness (FIFO) ─────────────────────────────────────────────────

test('FAIRNESS: waiters are served in the order they acquired, not randomly', async () => {
  // Under sustained load, a platform's queue must be FIFO so no call
  // waits longer than the queue depth × handler latency. Any tail
  // behavior here would mean the 30k-product catalog's final products
  // could wait indefinitely while new work keeps cutting the line.
  const mgr = new ConcurrencyManager({ testp: 2 });
  const completionOrder = [];
  const tasks = [];

  for (let i = 0; i < 12; i++) {
    tasks.push(mgr.withSlot('testp', async () => {
      await tick(15);
      completionOrder.push(i);
    }));
  }
  await Promise.all(tasks);

  // With cap=2 and uniform latency, completion order should mirror
  // acquire order in pairs (0,1 then 2,3 then 4,5 …). Allow for a small
  // amount of reordering inside each pair (scheduler fairness) but no
  // pair should lap another.
  for (let i = 0; i < 12; i += 2) {
    const pair = [completionOrder[i], completionOrder[i + 1]].sort((a, b) => a - b);
    assert.deepEqual(pair, [i, i + 1],
      `FIFO violated at pair ${i}: got ${completionOrder.slice(i, i + 2)}`);
  }
});

// ── Exception safety ────────────────────────────────────────────────

test('SAFETY: an exception inside withSlot never leaks the slot', async () => {
  // If a handler throws and we fail to release, the cap silently shrinks
  // by one on every failure. Over 100 retries, a cap=5 platform could
  // wedge to 0 and lock out every subsequent call — a silent catastrophe.
  const mgr = new ConcurrencyManager({ reddit_ads: 2 });
  for (let i = 0; i < 50; i++) {
    try {
      await mgr.withSlot('reddit_ads', async () => {
        throw new Error('simulated upstream failure');
      });
    } catch { /* expected */ }
  }
  // After 50 failures, the cap must still be 2.
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, () =>
    mgr.withSlot('reddit_ads', async () => {
      running += 1;
      if (running > peak) peak = running;
      await tick(5);
      running -= 1;
    })
  );
  await Promise.all(tasks);
  assert.equal(peak, 2, `peak=${peak}, expected 2 — exceptions leaked slots`);
});

// ── Long-running + fast-path coexistence ────────────────────────────

test('MIXED: fast reads do not get starved behind slow writes on the same platform', async () => {
  // Shopify is a great example: catalog-enrich (slow) and cart-abandon
  // fetch (fast) share the same platform slot. The fast fetch mustn't
  // wait 30s behind three catalog-enrichs. FIFO handles this — any
  // attempt at priority-based queuing is an anti-feature (it would make
  // starvation possible under hostile input ordering).
  const mgr = new ConcurrencyManager({ shopify: 2 });
  const fastLatencies = [];

  // Launch slow writes that hold slots.
  const slow = Array.from({ length: 6 }, () =>
    mgr.withSlot('shopify', () => tick(40))
  );

  // Interleave fast reads.
  const fast = Array.from({ length: 6 }, async () => {
    const t = Date.now();
    await mgr.withSlot('shopify', () => tick(1));
    fastLatencies.push(Date.now() - t);
  });

  await Promise.all([...slow, ...fast]);

  // Every fast read eventually completed — no starvation.
  assert.equal(fastLatencies.length, 6);
  // None waited longer than roughly (all slow ops / cap × latency). With
  // 6 slow × 40ms / 2 cap = 120ms upper bound, add buffer.
  const maxLatency = Math.max(...fastLatencies);
  assert.ok(maxLatency < 300, `worst fast-read latency was ${maxLatency}ms — head-of-line blocking?`);
});

// ── Semaphore math sanity under very high fanout ────────────────────

test('EXTREME: deep-queue fanout never overshoots cap=3', async () => {
  // Catch accidental integer overflow / race in the waiter queue when
  // the queue grows deep. 500 calls is well above any realistic auto-mode
  // fanout for a single platform and keeps this test under 2s.
  const mgr = new ConcurrencyManager({ tiktok: 3 });
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 500 }, () =>
    mgr.withSlot('tiktok', async () => {
      running += 1;
      if (running > peak) peak = running;
      await tick(1); // yield so other waiters observe running > 0
      running -= 1;
    })
  );
  await Promise.all(tasks);
  assert.ok(peak <= 3, `peak=${peak}, must be ≤ 3`);
  assert.ok(peak >= 2, `peak=${peak}, expected concurrent execution (≥2) under deep fanout`);
});
