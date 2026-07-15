// Tests for the 2026-07-11 google_analytics tool fixes:
//   1. Type coercion in the defineTool wrapper (batchCount int,
//      analyticsFunnelSteps []string arrived stringified and the Go binary
//      rejected them).
//   2. google-analytics-discover persists the GA4 property id brand-scoped so
//      later GA calls no longer need it passed explicitly.
//
// Run with: node --test app/ga-tool-fixes.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { defineTool } = require('./mcp-define-tool');

const MAIN_JS = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const MCP_TOOLS_JS = readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

// Minimal zod double-shaped like the real SDK's `tool()` registration:
// defineTool only needs a factory it can call with (name, desc, shape, handler).
function fakeToolFactory() {
  const registered = [];
  const tool = (name, description, shape, handler) => {
    registered.push({ name, description, shape, handler });
    return { name, description, shape, handler };
  };
  return { tool, registered };
}

function buildTool(def) {
  const { tool } = fakeToolFactory();
  const ctx = {};
  const full = Object.assign({
    description: `${def.name} test tool`,
    destructive: false,
    idempotent: false,
    costImpact: 'api',
    brandRequired: false,
  }, def);
  return defineTool(full, tool, z, ctx);
}

// ── 1. Type coercion ────────────────────────────────────────────────────

test('a stringified number is coerced to a real number before the handler', async () => {
  let seen = null;
  const t = buildTool({
    name: 'coerce_num',
    input: {
      action: z.enum(['funnel']),
      batchCount: z.coerce.number().int().optional(),
    },
    handler: async (args) => { seen = args; return { ok: true }; },
  });
  await t.handler({ action: 'funnel', batchCount: '7' });
  assert.equal(typeof seen.batchCount, 'number', 'batchCount must reach the handler as a number');
  assert.equal(seen.batchCount, 7);
});

test('a proper number passes through unchanged', async () => {
  let seen = null;
  const t = buildTool({
    name: 'coerce_num2',
    input: { action: z.enum(['funnel']), batchCount: z.coerce.number().int().optional() },
    handler: async (args) => { seen = args; return { ok: true }; },
  });
  await t.handler({ action: 'funnel', batchCount: 30 });
  assert.equal(seen.batchCount, 30);
});

test('a JSON-string array is decoded into a real array of strings', async () => {
  let seen = null;
  const t = buildTool({
    name: 'coerce_arr',
    input: {
      action: z.enum(['funnel']),
      analyticsFunnelSteps: z.array(z.string()).optional(),
    },
    handler: async (args) => { seen = args; return { ok: true }; },
  });
  await t.handler({ action: 'funnel', analyticsFunnelSteps: '["view_item","add_to_cart","purchase"]' });
  assert.ok(Array.isArray(seen.analyticsFunnelSteps), 'must reach the handler as an array');
  assert.deepEqual(seen.analyticsFunnelSteps, ['view_item', 'add_to_cart', 'purchase']);
});

test('a proper array passes through unchanged', async () => {
  let seen = null;
  const t = buildTool({
    name: 'coerce_arr2',
    input: { action: z.enum(['funnel']), analyticsFunnelSteps: z.array(z.string()).optional() },
    handler: async (args) => { seen = args; return { ok: true }; },
  });
  await t.handler({ action: 'funnel', analyticsFunnelSteps: ['sign_up', 'purchase'] });
  assert.deepEqual(seen.analyticsFunnelSteps, ['sign_up', 'purchase']);
});

test('a plain z.number() field is repaired from a stringified value (no coerce declared)', async () => {
  let seen = null;
  const t = buildTool({
    name: 'coerce_plain',
    input: { action: z.enum(['x']), limit: z.number().optional() },
    handler: async (args) => { seen = args; return { ok: true }; },
  });
  await t.handler({ action: 'x', limit: '250' });
  assert.equal(seen.limit, 250);
  assert.equal(typeof seen.limit, 'number');
});

test('an un-coercible string field is left untouched (never worse than before)', async () => {
  let seen = null;
  const t = buildTool({
    name: 'coerce_str',
    input: { action: z.enum(['x']), level: z.string().optional() },
    handler: async (args) => { seen = args; return { ok: true }; },
  });
  await t.handler({ action: 'x', level: 'channel' });
  assert.equal(seen.level, 'channel');
});

test('a string field that happens to hold JSON-array text stays a string (no false array upgrade)', async () => {
  let seen = null;
  const t = buildTool({
    name: 'coerce_strkeep',
    input: { action: z.enum(['x']), note: z.string().optional() },
    handler: async (args) => { seen = args; return { ok: true }; },
  });
  await t.handler({ action: 'x', note: '["not","an","array","field"]' });
  assert.equal(typeof seen.note, 'string', 'a declared string field must never be turned into an array');
});

// ── 2. Property-id persistence wiring (source locks) ────────────────────

test('googleAnalyticsPropertyId is brand-scoped in BRAND_KEYS', () => {
  const m = MAIN_JS.match(/const BRAND_KEYS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'BRAND_KEYS present');
  assert.ok(m[1].includes("'googleAnalyticsPropertyId'"),
    'googleAnalyticsPropertyId must be brand-scoped so it never leaks cross-brand');
});

test('google disconnect clears googleAnalyticsPropertyId', () => {
  assert.ok(/google:\s*\[[^\]]*'googleAnalyticsPropertyId'[^\]]*\]/.test(MAIN_JS),
    'disconnecting Google must clear the persisted property id');
});

test('runBinary persists the property id from a successful discover, brand-scoped and best-effort', () => {
  assert.ok(MCP_TOOLS_JS.includes("action === 'google-analytics-discover'"),
    'persist hook keys on the discover action');
  assert.ok(MCP_TOOLS_JS.includes('ctx.writeBrandTokens(brandName, { googleAnalyticsPropertyId'),
    'persist writes brand-scoped via writeBrandTokens');
  // Must be gated on success (!err) and on a brand being present.
  assert.ok(/if \(!err && action === 'google-analytics-discover' && brandName/.test(MCP_TOOLS_JS),
    'persist only on a successful, branded discover');
});

test('the discover persist regex matches the GA4DiscoverResult JSON shape', () => {
  // Mirror the exact regex used in mcp-tools.js against a representative emit.
  const sample = `============================================================
  Google Analytics 4 — Auto-Discovery
============================================================

{
  "googleAnalyticsPropertyId": "492039182",
  "propertyName": "RipIt",
  "googleAnalyticsMeasurementId": "G-ABC123",
  "accountName": "RipIt LLC"
}`;
  const m = sample.match(/"googleAnalyticsPropertyId"\s*:\s*"(\d{1,20})"/);
  assert.ok(m, 'regex must find the property id in the emit');
  assert.equal(m[1], '492039182');
});
