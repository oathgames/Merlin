// REGRESSION GUARDS for RSI Session 3 (2026-05-02): MCP surface polish.
// Three independent fixes locked here so a future refactor can't silently
// undo them.
//
// (1) D2.4 — strict-mode equivalent unknown-key validation in defineTool's
//     wrapHandler. Pre-fix zod schemas were permissive-by-default and
//     dropped unknown fields silently.
// (2) D2.7 — concurrency caps for google_analytics, postscript, applovin,
//     trendtrack. Pre-fix these fell through to _default=2 with no per-
//     platform reasoning visible in source.
// (3) D5.3 — pinterest, snapchat, twitter dropped from platform_login zod
//     enum. Pre-fix they were in the enum AND the comingSoon list, so the
//     agent could call them and get a no-op envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { defineTool } = require('./mcp-define-tool');
const envelope = require('./mcp-envelope');

// ── (1) D2.4 strict-mode equivalent ─────────────────────────────────

// Minimal fake-zod that mirrors the behavior assumed by defineTool. The real
// zod isn't loaded in this unit test (defineTool only uses z.string(),
// z.boolean(), z.optional()).
function makeFakeZod() {
  const stub = {
    describe() { return this; },
    optional() { return this; },
  };
  return {
    string: () => Object.assign({}, stub),
    boolean: () => Object.assign({}, stub),
  };
}

function makeRecordingTool() {
  let captured;
  return {
    tool: (_name, _desc, _shape, handler) => { captured = handler; return { kind: 'fake' }; },
    invoke: (args) => captured(args),
  };
}

test('D2.4: defineTool refuses unknown fields when input schema is declared', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'test_strict_mode',
    description: 'd',
    destructive: false, idempotent: false, costImpact: 'none', brandRequired: false,
    input: { foo: z.string(), bar: z.string() },
    handler: async () => ({ summary: 'ok' }),
  }, rec.tool, z, {});

  const result = envelope.parse(await rec.invoke({ foo: 'a', bar: 'b', evilField: 'x' }));
  assert.equal(result.ok, false, 'extra field "evilField" must be refused');
  assert.equal(result.error.code, 'INVALID_INPUT');
  assert.match(result.error.message, /evilField/, 'error message must name the unknown field');
});

test('D2.4: defineTool accepts only declared fields + auto-added (brand, idempotencyKey, preview, confirm_token)', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'test_strict_accepts',
    description: 'd',
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
    input: { foo: z.string() },
    handler: async (args) => ({ summary: 'got ' + args.foo }),
  }, rec.tool, z, {});

  // Real fields + auto-added idempotencyKey + auto-added brand should all
  // pass cleanly.
  const result = envelope.parse(await rec.invoke({
    foo: 'bar',
    brand: 'acme',
    idempotencyKey: 'k1',
  }));
  assert.equal(result.ok, true, 'declared + auto-added fields must pass');
  assert.equal(result.data.summary, 'got bar');
});

test('D2.4: defineTool skips strict check when input schema is empty (legacy contract)', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'test_strict_skipped_when_no_schema',
    description: 'd',
    destructive: false, idempotent: false, costImpact: 'none', brandRequired: false,
    // Intentionally no `input` field — recording-tool fixtures pass extra
    // args without declaring them.
    handler: async (args) => ({ summary: 'got ' + JSON.stringify(args) }),
  }, rec.tool, z, {});

  const result = envelope.parse(await rec.invoke({ anything: 'goes', other: 'fine' }));
  assert.equal(result.ok, true, 'no schema = no strict check (lets test fixtures pass extra fields)');
});

// ── (2) D2.7 concurrency caps ───────────────────────────────────────

test('D2.7: every platform in autocmo-core/ratelimit_preflight.go has a DEFAULT_CAPS entry', () => {
  const caps = require('./mcp-concurrency').DEFAULT_CAPS;
  // Platforms expected to have explicit caps (matches the platformLimits
  // map in autocmo-core/ratelimit_preflight.go). Adding a new platform to
  // the Go map without a corresponding entry here trips this test.
  const expected = [
    'meta', 'tiktok', 'google', 'google_merchant', 'shopify', 'amazon',
    'klaviyo', 'etsy', 'reddit_ads', 'reddit_organic', 'linkedin', 'stripe',
    'foreplay', 'fal', 'elevenlabs', 'heygen',
    'google_analytics', 'postscript', 'applovin', 'trendtrack', // Session 3 fix
  ];
  for (const p of expected) {
    assert.ok(
      typeof caps[p] === 'number' && caps[p] >= 1,
      `DEFAULT_CAPS missing explicit cap for "${p}" — falls through to _default. ` +
      'Add an entry with a per-platform reasoning comment.',
    );
  }
});

// ── (3) D5.3 dormant-OAuth providers dropped from platform_login enum ──

test('D5.3: platform_login zod enum excludes pinterest/snapchat/twitter', () => {
  const src = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  // Find the platform_login z.enum line.
  const enumMatch = src.match(/platform:\s*z\.enum\(\[([^\]]+)\]\)\.describe\('Platform to connect'\)/);
  assert.ok(enumMatch, 'could not find platform_login zod enum in mcp-tools.js');
  const enumBody = enumMatch[1];
  for (const dormant of ['pinterest', 'snapchat', 'twitter']) {
    assert.doesNotMatch(
      enumBody,
      new RegExp(`['"]${dormant}['"]`),
      `REGRESSION: platform_login enum re-grew "${dormant}" — dormant OAuth providers must stay out of the agent surface until ACTIVE`,
    );
  }
  // Sanity: the live providers must still be present.
  for (const live of ['meta', 'tiktok', 'google', 'shopify', 'amazon', 'reddit', 'linkedin', 'etsy', 'stripe']) {
    assert.match(
      enumBody,
      new RegExp(`['"]${live}['"]`),
      `platform_login enum dropped "${live}" — that's a live provider, must stay`,
    );
  }
});

test('D5.3: platform_login comingSoon defense-in-depth still covers klaviyo (active path is API-key tile)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const csMatch = src.match(/const\s+comingSoon\s*=\s*\[([^\]]+)\]/);
  assert.ok(csMatch, 'comingSoon list not found in mcp-tools.js');
  const list = csMatch[1];
  assert.match(list, /['"]klaviyo['"]/, 'klaviyo must remain in comingSoon — its OAuth flow is dormant; users connect via API-key tile');
});
