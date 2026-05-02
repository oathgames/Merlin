// Merlin MCP — Per-Platform Concurrency Semaphore
//
// Second barrier above the Go binary's PreflightCheck. Bounds how many
// tool calls can be in flight against a given platform at once, so that
// a Claude auto-mode fanout (e.g. 50 parallel meta_launch_test_ad calls
// against a 30k-product catalog) does not serialize inside the binary
// and then time out the MCP tool at the 5-minute blanket deadline.
//
// This is NOT a substitute for the binary's PreflightCheck. The binary
// remains authoritative for per-minute / per-hour / per-day quota
// enforcement (including tamper detection and safe mode). The MCP
// semaphore is about parallel-fanout shape — how many requests can be
// simultaneously being built, validated, and dispatched.
//
// Caps match the concurrent-slot budgets documented inline at
// ratelimit_preflight.go:67. Changing these without updating that file
// creates a drift hazard — the two layers must agree on what "safe
// concurrent load" means for a platform.
//
// CRITICAL: this module never sleeps or blocks the event loop. It uses
// a FIFO queue of pending resolvers. An acquire() that cannot proceed
// immediately parks the caller; release() resolves the next waiter.

'use strict';

// ── Caps ───────────────────────────────────────────────────────
// Map of platform key → max concurrent in-flight calls from MCP.
// Keys must match the platform argument used by rate-limit preflight
// (see autocmo-core/ratelimit_preflight.go:platformLimits).
//
// Numbers chosen conservatively — prefer a lower cap and forcing FIFO
// serialization over sending a burst the platform interprets as abuse.
// Every cap has a comment with the reasoning.
const DEFAULT_CAPS = Object.freeze({
  // Ad platforms
  meta: 5,             // official guidance is 5-10 concurrent; 5 is safe harbor
  tiktok: 3,           // TikTok Marketing API rejects bursts fast
  google: 5,           // Google Ads: 50 ops/sec across account, generous
  google_merchant: 3,  // Merchant API is stricter than Ads
  shopify: 2,          // shopify REST: 2/sec sustained. Graphql has cost-based
  amazon: 2,           // undocumented, conservative
  klaviyo: 3,          // xs tier: 15/min. 3 concurrent ~= steady drain
  etsy: 5,             // 10 qps documented, 5 concurrent safe
  reddit_ads: 2,       // ~1 QPS budget, 2 concurrent with spacing = safe
  reddit_organic: 2,   // ban risk is high — be extra careful
  linkedin: 3,         // undocumented; LI analytics api is strict
  stripe: 5,           // 100/sec read. Concurrency cap prevents CPU spike
  foreplay: 3,         // credits are the real limit, not concurrency

  // AI generation — TRUE concurrency matters (calls take 30-300s)
  fal: 3,              // 2-40 concurrent depending on tier; 3 is safe default
  elevenlabs: 3,       // 2-15 concurrent by plan
  heygen: 2,           // ~3 concurrent renders; 2 is safe
  openai: 5,           // Anthropic-adjacent but used for meta-generation

  // REGRESSION GUARD (2026-05-02, RSI Session 3 D2.7 fix): four platforms
  // declared in autocmo-core/ratelimit_preflight.go:platformLimits had no
  // matching entry here and silently fell to _default=2. Defaults work but
  // mask whether 2 was actually reasoned about per platform; explicit caps
  // make drift visible and reviewable. Concurrency parity test (added in
  // this session) blocks the next addition that lands in platformLimits
  // without a paired entry below.
  google_analytics: 5, // GA4 Data + Admin APIs — 60 req/min/property, 5 concurrent matches `google` (same Google rate-limit family).
  postscript:       3, // Postscript Customer API — undocumented concurrent budget; matches klaviyo (similar steady-drain pattern).
  applovin:         2, // AppLovin Report API — 3 req/min documented, 2 concurrent stays within ceiling.
  trendtrack:       3, // TrendTrack ad-library scrape — credit-limited, concurrency cap is anti-thunder rather than ceiling.

  // Default for any platform not explicitly listed — err on the side of
  // safety. 2 concurrent forces callers to queue instead of fan out wide.
  _default: 2,
});

// ── Semaphore implementation ──────────────────────────────────

class Semaphore {
  constructor(capacity, platform) {
    if (typeof capacity !== 'number' || capacity < 1) {
      throw new RangeError(`Semaphore capacity must be >= 1 (got ${capacity})`);
    }
    this.capacity = capacity;
    this.platform = platform;
    this.available = capacity;
    // FIFO queue of { resolve, enqueuedAt } for callers waiting on a slot.
    this.waiters = [];
  }

  /**
   * Acquire a slot. Resolves when a slot is free. Caller MUST call release()
   * exactly once when the work is done (happy path OR error path) — use
   * try/finally around the work.
   *
   * Returns the wait duration in ms so callers can log slow parks.
   */
  acquire() {
    return new Promise((resolve) => {
      const enqueuedAt = Date.now();
      if (this.available > 0) {
        this.available -= 1;
        return resolve(0);
      }
      this.waiters.push({ resolve, enqueuedAt });
    });
  }

  release() {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift();
      const waited = Date.now() - next.enqueuedAt;
      // Do not increment `available` — we hand the slot directly to the next
      // waiter. This preserves FIFO fairness under contention.
      next.resolve(waited);
      return;
    }
    if (this.available >= this.capacity) {
      // Release without an outstanding acquire — buggy caller. Log and clamp.
      console.warn(`[mcp-concurrency] release() with no outstanding acquire for ${this.platform}`);
      return;
    }
    this.available += 1;
  }

  /**
   * Snapshot current state — used by tests and by /jobs status to show
   * whether a platform is currently saturated.
   */
  stats() {
    return {
      platform: this.platform,
      capacity: this.capacity,
      available: this.available,
      waiting: this.waiters.length,
    };
  }
}

// ── Manager (singleton) ───────────────────────────────────────
//
// Callers do not instantiate semaphores directly. They call
// withPlatformSlot(platform, fn) — the manager picks (or lazily creates)
// the right semaphore for the platform.

class ConcurrencyManager {
  constructor(caps = DEFAULT_CAPS) {
    this.caps = Object.assign({}, DEFAULT_CAPS, caps);
    this.semaphores = new Map();
  }

  _semaphoreFor(platform) {
    const key = platform || '_default';
    let sem = this.semaphores.get(key);
    if (!sem) {
      const cap = this.caps[key] !== undefined ? this.caps[key] : this.caps._default;
      sem = new Semaphore(cap, key);
      this.semaphores.set(key, sem);
    }
    return sem;
  }

  /**
   * Run `fn` with a concurrency slot for the given platform. Acquires,
   * runs, and releases — release is in a finally so errors don't leak slots.
   *
   * @param {string} platform - Platform key (e.g. 'meta', 'tiktok', 'fal')
   * @param {() => Promise<T>} fn - Work to run under the slot
   * @returns {Promise<T>} - fn's resolved value
   */
  async withSlot(platform, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('withSlot() requires a function');
    }
    const sem = this._semaphoreFor(platform);
    const waited = await sem.acquire();
    if (waited > 1000) {
      // Slow park — log. At high contention this is normal; in steady state
      // it indicates the cap is too low or callers aren't releasing.
      console.debug(`[mcp-concurrency] ${platform} slot waited ${waited}ms`);
    }
    try {
      return await fn();
    } finally {
      sem.release();
    }
  }

  /**
   * Snapshot all known semaphore states. Used by jobs_list and by tests.
   */
  snapshot() {
    const out = {};
    for (const [key, sem] of this.semaphores.entries()) {
      out[key] = sem.stats();
    }
    return out;
  }

  /**
   * Testing helper — reset all semaphores. Never call in production.
   */
  _reset() {
    this.semaphores.clear();
  }
}

// Default singleton — shared across the process. Tool handlers call
// `concurrency.withSlot(platform, fn)` without needing to thread it through.
const defaultManager = new ConcurrencyManager();

module.exports = {
  ConcurrencyManager,
  Semaphore,
  DEFAULT_CAPS,
  // Convenience bound methods for the singleton
  withSlot: (platform, fn) => defaultManager.withSlot(platform, fn),
  snapshot: () => defaultManager.snapshot(),
  _default: defaultManager,
};
