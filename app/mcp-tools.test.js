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

const { buildTools, runBinary } = require('./mcp-tools');
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
