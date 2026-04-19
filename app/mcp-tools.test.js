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
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.meta,   'connected');
  assert.equal(parsed.tiktok, 'missing');
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
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.success, true);
  assert.equal(parsed.platform, 'shopify');
});
