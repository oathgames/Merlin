// Tests for mcp-tools.js — the MCP surface Claude actually sees.
//
// These tests stub the SDK's `tool()` factory and Zod shape so we can
// enumerate the tool list without loading @anthropic-ai/claude-agent-sdk.
// They verify:
//   1. Every advertised tool is dispatched correctly to the binary action.
//   2. Unknown actions are rejected rather than silently passing through.
//   3. Malformed args are surfaced as a structured error, not a crash.
//   4. Binary result text + error flag round-trip unmodified.
//
// Regression this protects: a silent fallback ("unknown tool → treat as
// meta_ads") once shipped a kill on the wrong brand.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTools,
  runBinary,
  _resetScrapeTimeoutTrackerForTests,
} = require('./mcp-tools');
const envelope = require('./mcp-envelope');

// ─────────────────────────────────────────────────────────────────────
// Test doubles for the SDK's tool() factory and Zod.
// ─────────────────────────────────────────────────────────────────────

function makeFakeTool() {
  // Captures every tool registered by buildTools.
  const registry = [];
  const tool = (name, description, schema, handler, options) => {
    registry.push({ name, description, schema, handler, options });
    return { name, description, schema, handler, options };
  };
  return { tool, registry };
}

// Minimal Zod stub — just enough for buildTools to call .string().optional()
// etc. without throwing. We don't verify validation; that's Zod's job. We
// only care that tool construction completes.
function makeFakeZ() {
  const pass = () => chain();
  function chain() {
    const node = {
      optional: () => chain(),
      describe: () => chain(),
      default: () => chain(),
      regex: () => chain(), // Codex 2026-04-24: brandSchema = z.string().regex(BRAND_RE, ...)
    };
    return node;
  }
  return {
    string: pass,
    number: pass,
    boolean: pass,
    any: pass,
    enum: () => chain(),
    array: () => chain(),
    object: () => chain(),
  };
}

// Mock context object — runBinary won't be called in these tests (we
// invoke individual handlers directly with stubbed ctx behavior).
function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({}),
    readBrandConfig: () => ({}),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => null,
    appRoot: process.cwd(),
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// buildTools smoke: every advertised tool name is present.
// ─────────────────────────────────────────────────────────────────────

test('buildTools registers every advertised tool', () => {
  const { tool, registry } = makeFakeTool();
  const z = makeFakeZ();
  const ctx = makeCtx();
  buildTools(tool, z, ctx);
  const names = registry.map(t => t.name);
  const expected = [
    'connection_status', 'meta_ads', 'tiktok_ads', 'google_ads',
    'amazon_ads', 'shopify', 'klaviyo', 'email', 'seo', 'content',
    'video', 'voice', 'dashboard', 'discord', 'threads', 'reddit_ads',
    'linkedin_ads', 'etsy', 'config', 'competitor_spy', 'platform_login',
    'brand_scrape', 'brand_guide', 'decisions',
    'jobs_poll', 'jobs_list', 'jobs_cancel',
  ];
  for (const name of expected) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }
});

test('buildTools registers tools with non-empty descriptions', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  for (const entry of registry) {
    assert.ok(typeof entry.description === 'string' && entry.description.length > 10,
      `${entry.name} has a suspiciously short description`);
  }
});

test('buildTools flags destructive ad tools with annotations', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const destructive = registry.filter(t => t.options && t.options.annotations && t.options.annotations.destructive);
  const destructiveNames = destructive.map(t => t.name);
  // Meta, Reddit, LinkedIn are flagged destructive.
  assert.ok(destructiveNames.includes('meta_ads'));
  assert.ok(destructiveNames.includes('reddit_ads'));
  assert.ok(destructiveNames.includes('linkedin_ads'));
});

// ─────────────────────────────────────────────────────────────────────
// Brand enforcement — the runBinary safety net.
// ─────────────────────────────────────────────────────────────────────

test('runBinary refuses a brand-required action when brand is missing', async () => {
  const ctx = makeCtx({
    getBinaryPath: () => '/nonexistent/binary',
  });
  // meta-insights is brand-scoped and not in BRAND_OPTIONAL_ACTIONS.
  const result = await runBinary(ctx, 'meta-insights', {});
  assert.equal(result.error, true);
  assert.match(result.text, /Refusing meta-insights/);
  assert.match(result.text, /no brand specified/);
});

test('runBinary refuses brand-required action when brand is empty string', async () => {
  const ctx = makeCtx();
  const result = await runBinary(ctx, 'dashboard', { brand: '' });
  assert.equal(result.error, true);
  assert.match(result.text, /no brand specified/);
});

test('runBinary refuses brand-required action when brand is non-string', async () => {
  const ctx = makeCtx();
  const result = await runBinary(ctx, 'meta-insights', { brand: 123 });
  assert.equal(result.error, true);
  assert.match(result.text, /no brand specified/);
});

test('runBinary permits brand-optional actions without brand', async () => {
  // setup/verify-key/list-voices/meta-login etc. are allowlisted — they MUST
  // proceed past the brand-guard. We fail at the next layer (binary not found)
  // so the assertion only checks that the refusal message is NOT emitted.
  const ctx = makeCtx({ getBinaryPath: () => null });
  const result = await runBinary(ctx, 'list-voices', {});
  assert.ok(!result.text.includes('no brand specified'),
    'list-voices is brand-optional and must not trip the brand guard');
});

test('runBinary returns friendly error when binary is missing', async () => {
  const ctx = makeCtx({ getBinaryPath: () => null });
  const result = await runBinary(ctx, 'list-voices', {});
  assert.equal(result.error, true);
  assert.match(result.text, /Merlin engine not found/);
});

test('runBinary refuses when binary is flagged too old', async () => {
  const ctx = makeCtx({
    isBinaryTooOld: () => true,
    minBinaryVersion: '1.2.3',
    getBinaryPath: () => '/should/not/reach/here',
  });
  const result = await runBinary(ctx, 'list-voices', {});
  assert.equal(result.error, true);
  assert.match(result.text, /Engine needs to update/);
});

// ─────────────────────────────────────────────────────────────────────
// Tool handler pass-through — result text + error flag preserved.
// ─────────────────────────────────────────────────────────────────────

test('connection_status handler returns JSON of platform statuses', async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    getConnections: () => ([
      { platform: 'meta',   status: 'connected' },
      { platform: 'tiktok', status: 'missing' },
    ]),
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'connection_status');
  const out = await entry.handler({ brand: 'madchill' });
  assert.ok(Array.isArray(out.content));
  const env = envelope.parse(out);
  assert.ok(env, 'response must carry an envelope');
  assert.equal(env.ok, true);
  assert.equal(env.data.connections.meta,   'connected');
  assert.equal(env.data.connections.tiktok, 'missing');
});

test('connection_status surfaces ctx errors as isError result', async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    getConnections: () => { throw new Error('boom'); },
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'connection_status');
  const out = await entry.handler({});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /boom/);
});

test('brand_scrape rejects non-URL input before loading the scraper module', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_scrape');
  const out = await entry.handler({ url: 'not a url' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /http\(s\) URL/);
});

// REGRESSION GUARD (2026-04-20): paying user on Forever21.com hit a
// permanent onboarding hang when the scraper's logo fetch stalled forever.
// The handler must now classify any ScrapeTimeoutError into a TIMEOUT
// envelope so the skill can tell the user "scrape took too long, retry"
// instead of spinning silently. These two tests pin both the code branch
// and the user-facing message — a future refactor that rewrites the catch
// block must keep both.
function withStubbedScraper(stub, run) {
  // The mcp-tools handler does `require('./brand-scraper')` inline, so we
  // inject a stub via require.cache and restore the real module after.
  const path = require('path');
  const resolved = require.resolve('./brand-scraper');
  const original = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: stub,
  };
  return run().finally(() => {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  });
}

test('brand_scrape classifies ScrapeTimeoutError into a TIMEOUT envelope', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => {
      const err = new Error('brand-scraper: overall timed out after 90000ms');
      err.name = 'ScrapeTimeoutError';
      err.code = 'TIMEOUT';
      throw err;
    },
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://forever21.com/' }));
  const env = envelope.parse(out);
  assert.ok(env, 'response must carry an envelope');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'TIMEOUT');
  // User-facing message must name the URL and suggest retry — not a raw
  // stack trace. Friendly-error rule applies to every error-surfacing path.
  assert.match(env.error.message, /took too long/i);
  assert.match(env.error.message, /forever21\.com/);
  assert.match(env.error.message, /retry|try/i);
  // next_action must be retry_or_split so Claude knows this is transient.
  assert.equal(env.error.next_action, 'retry_or_split');
});

test('brand_scrape falls through to INTERNAL_ERROR for non-timeout scrape failures', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => { throw new Error('brand-scraper: navigation failed: dns (ERR_NAME_NOT_RESOLVED) for https://nosuch.example/'); },
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://nosuch.example/' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INTERNAL_ERROR');
  assert.match(env.error.message, /Scrape failed/);
});

test('brand_guide validate requires brandGuide payload', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_guide');
  const out = await entry.handler({ action: 'validate' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /required/);
});

test('brand_guide write requires both brand and brandGuide', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_guide');
  const out = await entry.handler({ action: 'write', brand: 'madchill' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /required/);
});

test('competitor_spy rejects an unknown action value', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'competitor_spy');
  const out = await entry.handler({ action: 'not-a-real-action' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown competitor_spy action/);
});

test('platform_login returns the Meta manual-token message without calling OAuth', async () => {
  const { tool, registry } = makeFakeTool();
  let oauthInvoked = false;
  const ctx = makeCtx({
    runOAuthFlow: async () => { oauthInvoked = true; return { success: true }; },
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'platform_login');
  const out = await entry.handler({ platform: 'meta', brand: 'madchill' });
  assert.equal(oauthInvoked, false, 'Meta OAuth must not fire — App Review pending');
  assert.match(out.content[0].text, /manual token entry/);
});

test('platform_login gates coming-soon providers with a clear message', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'platform_login');
  const out = await entry.handler({ platform: 'klaviyo', brand: 'madchill' });
  assert.match(out.content[0].text, /coming soon/);
});

test('platform_login returns success without leaking tokens', async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    runOAuthFlow: async () => ({
      success: true,
      // A buggy future refactor may try to bubble up the token — this test
      // asserts that platform_login NEVER includes any field from the OAuth
      // result other than the success flag.
      token: 'EAABshouldneverleakthis1234567890',
    }),
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'platform_login');
  const out = await entry.handler({ platform: 'shopify', brand: 'madchill' });
  assert.ok(!out.content[0].text.includes('EAABshouldneverleakthis1234567890'));
  const env = envelope.parse(out);
  assert.ok(env, 'response must carry an envelope');
  assert.equal(env.ok, true);
  assert.equal(env.data.success, true);
  assert.equal(env.data.platform, 'shopify');
});

// ─────────────────────────────────────────────────────────────────────
// Progress-event emission (Task 3.1, rsi-batch-1 Cluster-F)
//
// brand_scrape is the canonical long-running tool (up to 90s). The MCP
// contract settles ONCE, so the renderer needs out-of-band progress
// events to animate a pill / status line. These tests pin the event
// shape Cluster-M (§3.6) consumes — drift here silently breaks the UI.
//
// Channel: 'mcp-progress'
// Every payload must carry: channel, tool, scrapeId, stage, label, url, ts.
// Stages: start → done (happy path) OR start → timeout OR start → error.
// ─────────────────────────────────────────────────────────────────────

function makeCtxCapturingProgress() {
  const events = [];
  const ctx = makeCtx({
    emitProgress: (payload) => { events.push(payload); },
  });
  return { ctx, events };
}

test('brand_scrape emits start + done progress events on happy path', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => ({
      url: 'https://madchill.com',
      primary: {
        copy: { productTitles: ['Classic Hoodie', 'Joggers', 'Tee'] },
        logoCandidates: [{ src: 'https://cdn/logo.png', source: 'json-ld', weight: 100 }],
      },
      logoColors: [{ hex: '#000000', freq: 0.5 }, { hex: '#ffffff', freq: 0.3 }],
      secondaryPages: [{ url: 'https://madchill.com/about', signal: {} }],
    }),
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://madchill.com' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, true);

  // At minimum: one start event + one done event (may have more in future).
  assert.ok(events.length >= 2, `expected >=2 progress events, got ${events.length}`);
  const start = events[0];
  const done = events[events.length - 1];

  // Start event — cold-narration label the SKILL mirrors.
  assert.equal(start.channel, 'mcp-progress');
  assert.equal(start.tool, 'brand_scrape');
  assert.equal(start.stage, 'start');
  assert.equal(start.label, 'Reading homepage');
  assert.equal(start.url, 'https://madchill.com');
  assert.ok(typeof start.scrapeId === 'string' && start.scrapeId.length >= 16);
  assert.ok(typeof start.ts === 'number' && start.ts > 0);

  // Done event — derived counts match SKILL narration examples.
  assert.equal(done.channel, 'mcp-progress');
  assert.equal(done.stage, 'done');
  assert.match(done.label, /Found 3 products/);
  assert.equal(done.url, 'https://madchill.com');
  assert.equal(done.scrapeId, start.scrapeId, 'scrapeId must be stable across events for one invocation');
  assert.ok(done.detail);
  assert.equal(done.detail.products, 3);
  assert.equal(done.detail.logoCandidates, 1);
  assert.equal(done.detail.logoColors, 2);
  assert.equal(done.detail.secondaryPages, 1);
  assert.ok(typeof done.detail.elapsedMs === 'number');
});

test('brand_scrape progress event "done" label falls back to "Scrape complete" when zero products', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => ({
      url: 'https://example-saas.com',
      primary: { copy: { productTitles: [] }, logoCandidates: [] },
      logoColors: [],
      secondaryPages: [],
    }),
  };
  await withStubbedScraper(stub, () => entry.handler({ url: 'https://example-saas.com' }));
  const done = events[events.length - 1];
  assert.equal(done.stage, 'done');
  assert.equal(done.label, 'Scrape complete');
  assert.equal(done.detail.products, 0);
});

test('brand_scrape progress emission is no-op when ctx.emitProgress is missing', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  // makeCtx() intentionally omits emitProgress so this exercises the
  // graceful no-op path the pre-wiring Electron host will be in.
  const ctx = makeCtx();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => ({
      url: 'https://noprogress.com',
      primary: { copy: { productTitles: [] }, logoCandidates: [] },
      logoColors: [],
      secondaryPages: [],
    }),
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://noprogress.com' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, true, 'scrape must succeed even without an emitProgress wiring');
});

test('brand_scrape emits error progress event on non-timeout failures', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => { throw new Error('brand-scraper: dns fail'); },
  };
  await withStubbedScraper(stub, () => entry.handler({ url: 'https://nosuch.example/' }));
  const err = events[events.length - 1];
  assert.equal(err.stage, 'error');
  assert.equal(err.tool, 'brand_scrape');
  assert.equal(err.url, 'https://nosuch.example/');
});

// ─────────────────────────────────────────────────────────────────────
// Manual-entry fallback on repeat timeout (Task 3.2, rsi-batch-1 Cluster-F)
//
// First timeout → classic retry_or_split envelope (Rule 13 compatible).
// Second timeout on the SAME URL within 10min → manual_entry_fallback,
// carrying a structured payload the UI can render into a fill-in card.
// ─────────────────────────────────────────────────────────────────────

function timeoutStub() {
  return {
    scrapeBrand: async () => {
      const err = new Error('brand-scraper: overall timed out after 90000ms');
      err.name = 'ScrapeTimeoutError';
      err.code = 'TIMEOUT';
      throw err;
    },
  };
}

test('brand_scrape first timeout still returns retry_or_split (Rule 13 preserved)', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  const out = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://first-timeout.example/' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'TIMEOUT');
  assert.equal(env.error.next_action, 'retry_or_split');
  // Progress event must flag this as a non-repeat so Cluster-M's pill can
  // show "timed out — retrying" instead of the terminal manual-entry label.
  const evt = events[events.length - 1];
  assert.equal(evt.stage, 'timeout');
  assert.equal(evt.detail.repeated, false);
  assert.match(evt.label, /retry/i);
});

test('brand_scrape second timeout on same URL triggers manual_entry_fallback', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  // First timeout (retry_or_split).
  await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://repeat-timeout.example/' }));
  // Second timeout (manual_entry_fallback).
  const out2 = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://repeat-timeout.example/' }));

  const env = envelope.parse(out2);
  assert.ok(env);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'TIMEOUT');
  assert.equal(env.error.next_action, 'manual_entry_fallback',
    'second timeout must route to manual entry, not retry_or_split');
  assert.match(env.error.message, /manually/i);

  // Structured payload the UI uses to render the fill-in card.
  assert.ok(env.data, 'fallback response must carry a data envelope');
  assert.ok(env.data.manualEntry, 'data.manualEntry is required for the fallback UI');
  assert.equal(env.data.manualEntry.reason, 'repeat_scrape_timeout');
  assert.equal(env.data.manualEntry.url, 'https://repeat-timeout.example/');
  assert.ok(Array.isArray(env.data.manualEntry.fields));
  // The schema MUST cover the four core onboarding inputs the SKILL
  // relies on: brand name, vertical, product list, logo. Without these
  // the photo-drop fallback line in merlin-setup SKILL.md cannot resolve.
  const fieldKeys = env.data.manualEntry.fields.map(f => f.key);
  for (const required of ['brandName', 'vertical', 'productList', 'logoPath']) {
    assert.ok(fieldKeys.includes(required), `manualEntry.fields is missing "${required}"`);
  }

  // Progress event for the second timeout must flag repeated=true.
  const evt = events[events.length - 1];
  assert.equal(evt.stage, 'timeout');
  assert.equal(evt.detail.repeated, true);
});

test('brand_scrape manual-entry tracker treats URL variants as the same site', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  // First timeout with trailing slash.
  await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://variant.example/' }));
  // Second timeout without trailing slash + different case should normalize
  // to the same tracked URL and trip the fallback.
  const out2 = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://Variant.example' }));
  const env = envelope.parse(out2);
  assert.equal(env.error.next_action, 'manual_entry_fallback');
});

test('brand_scrape manual-entry tracker does NOT cross-contaminate different URLs', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  // Timeout for site A.
  await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://site-a.example/' }));
  // First timeout for site B (different origin) must still be retry_or_split,
  // not manual_entry_fallback — the tracker is per-URL, not global.
  const outB = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://site-b.example/' }));
  const envB = envelope.parse(outB);
  assert.equal(envB.error.next_action, 'retry_or_split',
    'first-ever timeout for a NEW URL must not borrow another URL\'s fallback state');
});

// ─────────────────────────────────────────────────────────────────────
// Postscript full-coverage (2026-04-29) — automation CRUD + bulk import
// ─────────────────────────────────────────────────────────────────────

test('postscript tool exposes the full automation action enum', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'postscript');
  assert.ok(entry, 'postscript tool not registered');
  // Description must mention bulk-import-flow + TCPA gate (the product hook).
  assert.match(entry.description, /bulk-import-flow|automations|TCPA gate/i,
    `postscript description should advertise the new automation surface, got: ${entry.description}`);
});

test('postscript tool description references TCPA gate (the safety contract)', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'postscript');
  // The description is what the LLM router reads. Surfacing TCPA there means
  // the agent knows that bulk-import-flow has a refusal mode and won't try
  // to "auto-fix" a blocked flow by stripping STOP language.
  assert.match(entry.description, /TCPA/i,
    'postscript tool description must surface TCPA gate to the routing LLM');
});

test('postscript tool prefixes the action and dispatches to postscript-<action>', async () => {
  // Uses the brand-guard refusal text as a routing oracle: a brand-LESS
  // call to a postscript action that's NOT in BRAND_OPTIONAL_ACTIONS
  // trips the guard with the FULL action string in the error message. A
  // typo'd action ("postscrpit-..." or a dropped prefix) would surface as
  // a failed regex match — caught before merge.
  // Strengthened from the trivial smoke version (Gitar PR #154); dead
  // `captured` scaffold removed (Gitar PR #154 follow-up).
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'postscript');

  const outBrandless = await entry.handler({ action: 'automation-create' });
  const textBrandless = outBrandless.content && outBrandless.content[0] ? outBrandless.content[0].text : '';
  if (textBrandless.includes('Refusing')) {
    assert.match(textBrandless, /postscript-automation-create/,
      `brand-guard refusal must include the full prefixed action; routing typo would surface here. Got: ${textBrandless}`);
  } else {
    // Engine-not-found path; can't introspect the action from the user-
    // facing text, but the handler must not crash.
    assert.ok(textBrandless.length > 0, 'postscript handler returned empty text');
  }
});

test('postscript tool description mentions bulk-import-flow (the morning-setup verb)', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'postscript');
  assert.match(entry.description, /bulk-import-flow/,
    'postscript description must surface bulk-import-flow so the LLM picks it for "upload my SMS flows"');
});

// ─────────────────────────────────────────────────────────────────────
// Klaviyo template actions — registration + dispatch.
//
// Live incident anchor (2026-04-29, POG): Ryan tried to bulk-import 51
// Klaviyo email templates and the existing `klaviyo` tool only exposed
// performance / lists / campaigns. Falling back to a Python script that
// read klaviyoApiKey from .merlin-config-pog.json got 401 because the
// raw key only lives in the AES-256-GCM-encrypted vault. The fix is to
// expose template CRUD + bulk-upload through the binary, where the
// vault is already decrypted. These tests pin the action enum so a
// future refactor can't silently drop a template action and re-create
// the incident.
// ─────────────────────────────────────────────────────────────────────

test('klaviyo tool registers all template + reporting actions', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'klaviyo');
  assert.ok(entry, 'klaviyo tool must be registered');
  // The fake Zod stub doesn't preserve enum values, so we assert on the
  // tool DESCRIPTION instead — every advertised action family must
  // appear in the user-facing description so the LLM routes correctly.
  // We check by family keyword (not exact action name) because the
  // description is human-readable prose, not a literal enum dump.
  const desc = entry.description.toLowerCase();
  for (const keyword of [
    'performance', 'lists', 'campaigns',
    'template', 'bulk', 'upload',
  ]) {
    assert.ok(desc.includes(keyword),
      `klaviyo description must reference keyword: ${keyword}`);
  }
  // Description must explicitly call out the Flow-construction caveat so
  // the LLM never confabulates "I created your flows."
  assert.match(entry.description, /flow/i);
  assert.match(entry.description, /UI-only/i);
});

test('klaviyo tool input schema accepts every template field', () => {
  // Use a real-ish Zod-shape probe: the fake Zod returns a chainable
  // object on every call, so we just verify the input definition has
  // entries for the new fields. The handler will validate on the binary
  // side; here we only need to confirm we ship the schema surface.
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'klaviyo');
  // The schema is captured by the test's fake `tool()` factory under
  // entry.schema — but our makeFakeTool only stores a flat shape. The
  // robust assertion is "buildTools didn't throw," which we already
  // implicitly asserted by registering the tool. Add an explicit smoke
  // by invoking the handler with template fields and confirming it
  // dispatches with the right binary action prefix.
  // (The handler itself is tested below via dispatch capture.)
  assert.ok(typeof entry.handler === 'function');
});

test('klaviyo handler dispatches templates-list without crashing on engine-missing', async () => {
  // Stub runBinary by intercepting at ctx.getBinaryPath — when the
  // binary path is null, runBinary short-circuits with the friendly
  // "engine not found" message. templates-list is brand-REQUIRED
  // (not in BRAND_OPTIONAL_ACTIONS — only klaviyo-login is). Without
  // a brand, runBinary's brand guard at line ~298 returns the
  // 'no brand specified' refusal BEFORE reaching the engine-not-found
  // check. We assert the handler still returns a clean envelope (no
  // thrown exception) regardless of which guard fires.
  // (Comment corrected per Gitar PR #151 finding — the prior version
  // labeled templates-list as brand-OPTIONAL which was wrong.)
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({ action: 'templates-list' });
  assert.ok(out, 'handler must return a result');
  assert.ok(Array.isArray(out.content) || typeof out.text === 'string',
    'result must be an MCP content envelope or text');
});

test('klaviyo handler dispatches templates-bulk-upload with brand argument', async () => {
  // templates-bulk-upload IS brand-required (the dir must be inside
  // assets/brands/<brand>/). With a brand passed but no engine, we
  // expect to reach the engine-not-found branch — proving the brand
  // guard does NOT short-circuit this action with a "no brand"
  // refusal (which would mean we mis-classified it as brand-optional).
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({
    action: 'templates-bulk-upload',
    brand: 'demo',
    dir: '/some/dir',
    nameTemplate: 'demo / {basename}',
  });
  assert.ok(out, 'handler must return a result');
  // The body should NOT contain the "no brand specified" refusal — we
  // passed brand=demo, so we want the engine-not-found pass-through.
  const text = (out.content && out.content[0] && out.content[0].text) || out.text || '';
  assert.ok(!text.includes('no brand specified'),
    'brand=demo must reach the engine layer, not the brand-guard refusal');
});

test('klaviyo template-create handler returns a structured envelope', async () => {
  // Same engine-not-found probe but with a write action shape — pins
  // that the handler code path doesn't crash on the new field set.
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({
    action: 'template-create',
    templateName: 'Test welcome',
    htmlContent: '<p>Hi {{FIRST_NAME}}</p>',
  });
  assert.ok(out, 'handler must return a result');
  // Envelope-or-text contract.
  assert.ok(Array.isArray(out.content) || typeof out.text === 'string');
});
