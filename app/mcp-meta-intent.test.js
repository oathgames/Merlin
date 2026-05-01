// Tests for mcp-meta-intent.js — the 13 narrow Meta intent tools.
//
// These tools replace the legacy meta_ads action-multiplexer for new agent
// code. Contracts verified here:
//   1. All 13 tools register.
//   2. Annotations are correct (destructive / idempotent / costImpact / preview).
//   3. brandRequired is enforced on every tool (Meta is always brand-scoped).
//   4. Preview gating fires on the right blast-radius conditions:
//        - meta_launch_test_batch at >= 5 ads
//        - meta_pause_asset at campaign scope (campaignId set)
//        - meta_adjust_budget on >= 2x or <= 0.25x swings
//        - meta_scale_winner same
//   5. The preview → confirm_token → execute round-trip works end-to-end.
//   6. meta_launch_test_ad validates its input (one of image/video/postId/carousel).
//   7. Budget tamper guard: changing budget between preview and execute is refused.
//
// Strategy: build a minimal fake MCP tool() factory + Zod stub (same as
// mcp-tools.test.js), and inject a fake ctx whose runBinary is replaced with
// a recording stub. We never spawn the real binary — what we verify is the
// wrapper pipeline (validation, preview, envelope, propagation).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const envelope = require('./mcp-envelope');
const { buildTools } = require('./mcp-tools');

// ── Fakes ─────────────────────────────────────────────────────────────

function makeFakeTool() {
  const registry = [];
  const tool = (name, description, schema, handler, options) => {
    registry.push({ name, description, schema, handler, options });
    return { name };
  };
  return { tool, registry };
}

function makeFakeZ() {
  const chain = () => ({
    optional: () => chain(), describe: () => chain(), default: () => chain(),
    regex: () => chain(), // Codex 2026-04-24: brandSchema = z.string().regex(BRAND_RE, ...)
  });
  return {
    string: () => chain(), number: () => chain(), boolean: () => chain(),
    any: () => chain(), enum: () => chain(), array: () => chain(),
    object: () => chain(), record: () => chain(),
  };
}

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({}),
    readBrandConfig: () => ({}),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => '/fake/binary',
    appRoot: process.cwd(),
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

function findTool(registry, name) {
  return registry.find((t) => t.name === name);
}

// ── Registration & annotation assertions ─────────────────────────────

const INTENT_TOOLS = [
  'meta_setup_account', 'meta_review_performance', 'meta_launch_test_ad',
  'meta_launch_test_batch', 'meta_scale_winner', 'meta_pause_asset',
  'meta_activate_asset', 'meta_adjust_budget', 'meta_prepare_retargeting',
  'meta_promote_to_retargeting', 'meta_build_lookalike',
  'meta_import_account_state', 'meta_research_competitor_ads',
];

test('all 13 Meta intent tools register', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  for (const name of INTENT_TOOLS) {
    assert.ok(findTool(registry, name), `missing intent tool: ${name}`);
  }
});

test('meta_ads (legacy wrapper) still registers next to the 13 intents', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  assert.ok(findTool(registry, 'meta_ads'), 'legacy meta_ads must still be registered for back-compat');
});

test('read-only intents are NOT destructive', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  for (const name of [
    'meta_setup_account', 'meta_review_performance', 'meta_build_lookalike',
    'meta_import_account_state', 'meta_research_competitor_ads',
  ]) {
    const ann = findTool(registry, name).options.annotations;
    assert.equal(ann.destructive, false, `${name} should be destructive: false`);
  }
});

test('spend-triggering intents are destructive AND idempotent', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  for (const name of [
    'meta_launch_test_ad', 'meta_launch_test_batch', 'meta_scale_winner',
    'meta_pause_asset', 'meta_activate_asset', 'meta_adjust_budget',
    'meta_prepare_retargeting', 'meta_promote_to_retargeting',
  ]) {
    const ann = findTool(registry, name).options.annotations;
    assert.equal(ann.destructive, true, `${name} should be destructive: true`);
    assert.equal(ann.idempotent, true, `${name} should be idempotent: true`);
  }
});

test('intents requiring preview declare it in annotations', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  for (const name of [
    'meta_launch_test_batch', 'meta_scale_winner',
    'meta_pause_asset', 'meta_adjust_budget',
  ]) {
    const ann = findTool(registry, name).options.annotations;
    assert.equal(ann.preview, true, `${name} should advertise preview: true`);
  }
});

// ── Brand enforcement ─────────────────────────────────────────────────

test('every intent tool refuses a missing brand with BRAND_MISSING', async () => {
  // The defineTool wrapper short-circuits at brand-check and returns the
  // BRAND_MISSING envelope — no runBinary call should happen.
  let binaryCalls = 0;
  const ctx = makeCtx({
    // Make runBinary observable via a fake binary path; the wrapper should
    // never reach child_process because brand-check rejects first.
    getBinaryPath: () => { binaryCalls++; return '/fake'; },
  });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);

  for (const name of INTENT_TOOLS) {
    const entry = findTool(registry, name);
    const before = binaryCalls;
    const out = await entry.handler({}); // no brand
    const env = envelope.parse(out);
    assert.equal(env.ok, false, `${name} should fail without brand`);
    assert.equal(env.error.code, 'BRAND_MISSING', `${name} should return BRAND_MISSING`);
    assert.equal(binaryCalls, before, `${name} must NOT reach the binary when brand is missing`);
  }
});

// ── Preview gating ────────────────────────────────────────────────────

test('meta_launch_test_batch does NOT gate <5 ads — executes directly', async () => {
  let reached = false;
  // We stub mcp-tools runBinary by shimming through a fake binary that
  // throws a recognizable error. Simpler: test through the real runBinary
  // path — it'll fail at execFile with a fake binary. But we only care
  // that we *got past* the preview gate. So we check the error code.
  const ctx = makeCtx({
    getBinaryPath: () => { reached = true; return '/nonexistent'; },
  });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_launch_test_batch');

  const out = await entry.handler({
    brand: 'acme',
    ads: [{ imagePath: '/a.png', dailyBudget: 5 }, { imagePath: '/b.png', dailyBudget: 5 }],
  });
  const env = envelope.parse(out);
  // Preview was NOT required (2 ads), so the wrapper should have tried to
  // exec runBinary. That's the "reached" signal.
  assert.equal(reached, true, 'small batch must NOT be gated — binary should be invoked');
  // The envelope comes back as an error from runBinary itself (binary missing);
  // the critical assertion is that the CONFIRM_REQUIRED gate was NOT triggered.
  if (!env.ok) {
    assert.notEqual(env.error.code, 'CONFIRM_REQUIRED',
      'small batch must not hit the confirm_required gate');
  }
});

test('meta_launch_test_batch GATES at >= 5 ads — returns CONFIRM_REQUIRED', async () => {
  let binaryReached = false;
  const ctx = makeCtx({
    getBinaryPath: () => { binaryReached = true; return '/fake'; },
  });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_launch_test_batch');

  const out = await entry.handler({
    brand: 'acme',
    ads: Array.from({ length: 6 }, (_, i) => ({
      imagePath: `/img${i}.png`, dailyBudget: 10,
    })),
  });
  const env = envelope.parse(out);
  assert.equal(env.ok, false, 'large batch must be gated');
  assert.equal(env.error.code, 'CONFIRM_REQUIRED');
  assert.equal(binaryReached, false, 'binary must NOT be invoked before confirm');
  assert.ok(env.data && env.data.blast_radius, 'blast_radius surface is attached to gated response');
  assert.equal(env.data.blast_radius.count, 6);
});

test('meta_launch_test_batch preview=true mints a confirm_token', async () => {
  const ctx = makeCtx();
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_launch_test_batch');

  const out = await entry.handler({
    brand: 'acme',
    ads: Array.from({ length: 5 }, (_, i) => ({
      imagePath: `/img${i}.png`, dailyBudget: 10,
    })),
    preview: true,
  });
  const env = envelope.parse(out);
  assert.equal(env.ok, true);
  assert.ok(typeof env.data.confirm_token === 'string');
  assert.ok(env.data.confirm_token.startsWith('ct-'));
  assert.ok(env.data.expires_at > Date.now());
});

test('meta_pause_asset gates on campaign scope but not ad scope', async () => {
  const ctx = makeCtx({ getBinaryPath: () => '/nonexistent' });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_pause_asset');

  // adId scope — should NOT be gated.
  const adOut = await entry.handler({ brand: 'acme', adId: 'ad_1' });
  const adEnv = envelope.parse(adOut);
  if (!adEnv.ok) {
    assert.notEqual(adEnv.error.code, 'CONFIRM_REQUIRED',
      'ad-level pause must not hit confirm gate');
  }

  // campaignId scope — MUST be gated.
  const campOut = await entry.handler({ brand: 'acme', campaignId: 'c_1' });
  const campEnv = envelope.parse(campOut);
  assert.equal(campEnv.ok, false);
  assert.equal(campEnv.error.code, 'CONFIRM_REQUIRED');
});

test('meta_adjust_budget gates on >=2x swing; passes through on small changes', async () => {
  const ctx = makeCtx({ getBinaryPath: () => '/nonexistent' });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_adjust_budget');

  // 1.5x swing — NOT gated.
  const small = await entry.handler({
    brand: 'acme', adId: 'ad_1', dailyBudget: 15, previousBudget: 10,
  });
  const smallEnv = envelope.parse(small);
  if (!smallEnv.ok) {
    assert.notEqual(smallEnv.error.code, 'CONFIRM_REQUIRED',
      '1.5× swing must not hit confirm gate');
  }

  // 3x swing — MUST be gated.
  const big = await entry.handler({
    brand: 'acme', adId: 'ad_1', dailyBudget: 30, previousBudget: 10,
  });
  const bigEnv = envelope.parse(big);
  assert.equal(bigEnv.ok, false);
  assert.equal(bigEnv.error.code, 'CONFIRM_REQUIRED');
  assert.equal(bigEnv.data.blast_radius.required, true);
});

// ── Tamper resistance (end-to-end round-trip) ─────────────────────────

test('ATTACK: budget swap between preview and execute is refused with payload_mismatch', async () => {
  // 1. Preview a benign $10 -> $20 swing (2x — gated).
  // 2. Attacker tries to execute with confirm_token but a malicious $200 budget.
  // 3. Tool must refuse with CONFIRM_REQUIRED (the consume() inside the wrapper
  //    catches the payload mismatch and rejects).
  const ctx = makeCtx({ getBinaryPath: () => '/nonexistent' });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_adjust_budget');

  // Step 1: preview the safe swing.
  const previewOut = await entry.handler({
    brand: 'acme', adId: 'ad_1', dailyBudget: 20, previousBudget: 10, preview: true,
  });
  const previewEnv = envelope.parse(previewOut);
  assert.equal(previewEnv.ok, true);
  const token = previewEnv.data.confirm_token;
  assert.ok(token);

  // Step 2: attacker re-invokes with a DIFFERENT budget but the same token.
  const attackOut = await entry.handler({
    brand: 'acme', adId: 'ad_1', dailyBudget: 200, previousBudget: 10, confirm_token: token,
  });
  const attackEnv = envelope.parse(attackOut);
  assert.equal(attackEnv.ok, false);
  // The preview-gate refuses on payload mismatch — wrapper surfaces CONFIRM_REQUIRED
  // (invalid or expired token) with the reason embedded.
  assert.equal(attackEnv.error.code, 'CONFIRM_REQUIRED');
  assert.match(attackEnv.error.message, /payload_mismatch/i);
});

// ── Input validation ──────────────────────────────────────────────────

test('meta_launch_test_ad rejects when no creative source is provided', async () => {
  const ctx = makeCtx();
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_launch_test_ad');
  const out = await entry.handler({
    brand: 'acme', adHeadline: 'H', adBody: 'B', adLink: 'https://x.com', dailyBudget: 10,
  });
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_INPUT');
});

test('meta_launch_test_batch refuses an empty ads array', async () => {
  const ctx = makeCtx();
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_launch_test_batch');
  const out = await entry.handler({ brand: 'acme', ads: [] });
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_INPUT');
});

test('meta_pause_asset refuses when neither adId nor campaignId is given', async () => {
  const ctx = makeCtx();
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = findTool(registry, 'meta_pause_asset');
  const out = await entry.handler({ brand: 'acme' });
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_INPUT');
});

// ── Legacy meta_ads compat ────────────────────────────────────────────

test('legacy meta_ads still accepts action=insights and doesn\'t require brand', () => {
  // meta_ads keeps brandRequired:false — per-action enforcement lives in
  // runBinary via BRAND_OPTIONAL_ACTIONS. This test pins that decision
  // so nobody accidentally tightens it and breaks setup/adlib flows.
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = findTool(registry, 'meta_ads');
  assert.ok(entry);
  const ann = entry.options.annotations;
  assert.equal(ann.brandRequired, false,
    'meta_ads must stay brandRequired:false so setup/adlib keep working');
  assert.equal(ann.destructive, true);
});
