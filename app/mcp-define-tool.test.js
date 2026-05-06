'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { defineTool, validateDefinition, enrichSchema, wrapHandler, VALID_COST_IMPACTS } =
  require('./mcp-define-tool');
const envelope = require('./mcp-envelope');
const { IdempotencyStore } = require('./mcp-idempotency');

// ── Fakes ────────────────────────────────────────────────────────────────
//
// defineTool is an integration surface between the SDK's `tool(name, desc,
// shape, handler, opts)` factory and Zod. We inject both so tests don't
// depend on the SDK being loadable.

function makeFakeZod() {
  const makeLeaf = () => {
    const leaf = {
      _type: 'string',
      _optional: false,
      _describe: '',
      optional() { this._optional = true; return this; },
      describe(s) { this._describe = s; return this; },
    };
    return leaf;
  };
  return {
    string: () => makeLeaf(),
    boolean: () => Object.assign(makeLeaf(), { _type: 'boolean' }),
    number: () => Object.assign(makeLeaf(), { _type: 'number' }),
    object: (shape) => ({ _type: 'object', _shape: shape }),
    any: () => makeLeaf(),
  };
}

function makeRecordingTool() {
  const calls = [];
  function tool(name, description, shape, handler, opts) {
    calls.push({ name, description, shape, handler, opts });
    return { name, handler };
  }
  return { tool, calls };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-defn-test-'));
}

// ── validateDefinition ───────────────────────────────────────────────────

test('validateDefinition rejects non-objects', () => {
  assert.throws(() => validateDefinition(null), /object/);
  assert.throws(() => validateDefinition('string'), /object/);
});

test('validateDefinition requires name, description, handler', () => {
  assert.throws(() => validateDefinition({}), /name/);
  assert.throws(() => validateDefinition({ name: 't' }), /description/);
  assert.throws(() => validateDefinition({ name: 't', description: 'd' }), /handler/);
});

test('validateDefinition enforces snake_case naming', () => {
  const bad = (name) => ({
    name, description: 'd', handler: () => {},
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
  });
  assert.throws(() => validateDefinition(bad('Meta_Ads')), /snake_case/);
  assert.throws(() => validateDefinition(bad('meta-ads')), /snake_case/);
  assert.throws(() => validateDefinition(bad('0_bad_start')), /snake_case/);
  assert.throws(() => validateDefinition(bad('')), /name is required/);
  // Valid
  validateDefinition(bad('meta_launch_test_ad'));
});

test('validateDefinition requires the four annotations', () => {
  const base = { name: 't', description: 'd', handler: () => {} };
  assert.throws(() => validateDefinition({ ...base }), /destructive/);
  assert.throws(() => validateDefinition({ ...base, destructive: false }), /idempotent/);
  assert.throws(() => validateDefinition({ ...base, destructive: false, idempotent: true }), /costImpact/);
  assert.throws(() => validateDefinition({
    ...base, destructive: false, idempotent: true, costImpact: 'none',
  }), /brandRequired/);
});

test('validateDefinition rejects invalid costImpact values', () => {
  assert.throws(() => validateDefinition({
    name: 't', description: 'd', handler: () => {},
    destructive: false, idempotent: true, costImpact: 'free', brandRequired: false,
  }), /costImpact/);
  // Valid set
  for (const impact of VALID_COST_IMPACTS) {
    validateDefinition({
      name: 't', description: 'd', handler: () => {},
      destructive: false, idempotent: true, costImpact: impact, brandRequired: false,
    });
  }
});

test('destructive tools must also be idempotent', () => {
  assert.throws(() => validateDefinition({
    name: 'kill_ad', description: 'd', handler: () => {},
    destructive: true, idempotent: false, costImpact: 'api', brandRequired: true,
  }), /destructive tools must also be idempotent/);
});

test('concurrency.platform must be a string or function when provided', () => {
  // Number rejected.
  assert.throws(() => validateDefinition({
    name: 't', description: 'd', handler: () => {},
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
    concurrency: { platform: 42 },
  }), /concurrency.platform must be a string or a function/);
  // null/undefined object rejected.
  assert.throws(() => validateDefinition({
    name: 't', description: 'd', handler: () => {},
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
    concurrency: null,
  }), /concurrency must be an object/);
  // String accepted (legacy form — most tools use this).
  assert.doesNotThrow(() => validateDefinition({
    name: 't', description: 'd', handler: () => {},
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
    concurrency: { platform: 'meta' },
  }));
  // Function accepted (new form — codex API audit P2 #2 fix).
  assert.doesNotThrow(() => validateDefinition({
    name: 't', description: 'd', handler: () => {},
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
    concurrency: { platform: (args) => 'meta' },
  }));
});

// REGRESSION GUARD (2026-05-06, codex API audit P2 #2):
// concurrency.platform may now be a function so video / voice tools can
// route to the correct provider's slot at call time. Source-scan the
// generated annotations to confirm the function form passes through
// validateDefinition + ends up in the registered annotations.
test('dynamic concurrency: function form passes validateDefinition', () => {
  // Already covered by the upgraded "must be a string or function" test
  // above; this is the explicit cross-check that defineTool itself
  // accepts the function form (not just validateDefinition in isolation).
  const z = makeFakeZod();
  let registered = null;
  const tool = (n, d, s, h, opts) => { registered = { n, d, opts }; };
  defineTool({
    name: 'video_dynamic',
    description: 'd',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    concurrency: {
      platform: (args) => (args && args.provider) === 'veo' ? 'google_ai' : 'fal',
    },
    input: {},
    handler: async () => ({}),
  }, tool, z, { redactionPaths: [] });
  assert.ok(registered, 'tool must register');
  assert.equal(typeof registered.opts.annotations.concurrency.platform, 'function',
    'annotations must preserve the function form so MCP clients see the dynamic resolver');
});

test('source-scan: wrapHandler resolves function-form concurrency before claiming a slot', () => {
  // Lock the implementation pattern in source: the function must be
  // called with args BEFORE concurrency.withSlot is invoked. This is
  // the load-bearing property — calling withSlot first then resolving
  // the platform name would be a deadlock-prone race.
  const src = fs.readFileSync(path.join(__dirname, 'mcp-define-tool.js'), 'utf8');
  const wrapStart = src.indexOf('function wrapHandler');
  assert.ok(wrapStart > 0);
  const wrap = src.slice(wrapStart);
  const fnCallIdx = wrap.search(/typeof\s+platformName\s*===\s*['"]function['"]/);
  const slotCallIdx = wrap.search(/concurrency\.withSlot\(platformName/);
  assert.ok(fnCallIdx > 0 && slotCallIdx > 0,
    'wrapHandler must contain both the function-form resolver and the withSlot call');
  assert.ok(fnCallIdx < slotCallIdx,
    'function-form resolution MUST run BEFORE withSlot is called — otherwise the slot is claimed against an unresolved name');
});

// ── enrichSchema ─────────────────────────────────────────────────────────

test('enrichSchema adds required brand for brandRequired tools', () => {
  const z = makeFakeZod();
  const shape = enrichSchema(z, { brandRequired: true }, {});
  assert.ok(shape.brand);
  assert.equal(shape.brand._optional, false);
});

test('enrichSchema adds optional brand for brandRequired: false', () => {
  const z = makeFakeZod();
  const shape = enrichSchema(z, { brandRequired: false }, {});
  assert.ok(shape.brand);
  assert.equal(shape.brand._optional, true);
});

test('enrichSchema adds idempotencyKey for idempotent tools', () => {
  const z = makeFakeZod();
  const shape = enrichSchema(z, { brandRequired: true, idempotent: true }, {});
  assert.ok(shape.idempotencyKey);
  assert.equal(shape.idempotencyKey._optional, true);
});

test('enrichSchema adds preview + confirm_token for preview-enabled tools', () => {
  const z = makeFakeZod();
  const shape = enrichSchema(z, { brandRequired: true, preview: true }, {});
  assert.ok(shape.preview);
  assert.ok(shape.confirm_token);
});

test('enrichSchema preserves user-supplied fields', () => {
  const z = makeFakeZod();
  const userShape = { action: z.string(), adImagePath: z.string().optional() };
  const shape = enrichSchema(z, { brandRequired: true, idempotent: true }, userShape);
  assert.ok(shape.action);
  assert.ok(shape.adImagePath);
  assert.ok(shape.brand);
  assert.ok(shape.idempotencyKey);
});

// ── defineTool registration ──────────────────────────────────────────────

test('defineTool registers the tool with the SDK factory', async () => {
  const z = makeFakeZod();
  const { tool, calls } = makeRecordingTool();
  const ctx = {};
  defineTool({
    name: 'meta_review_performance',
    description: 'Pull Meta ad performance for the last N days',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    input: { days: z.number().optional() },
    handler: async () => ({ summary: 'ok', data: { spend: 123 } }),
  }, tool, z, ctx);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.name, 'meta_review_performance');
  assert.equal(call.description.startsWith('Pull Meta'), true);
  // Annotations are propagated
  assert.equal(call.opts.annotations.destructive, false);
  assert.equal(call.opts.annotations.idempotent, true);
  assert.equal(call.opts.annotations.costImpact, 'api');
  assert.equal(call.opts.annotations.brandRequired, true);
});

test('defineTool propagates concurrency + longRunning + preview annotations', () => {
  const z = makeFakeZod();
  const { tool, calls } = makeRecordingTool();
  defineTool({
    name: 'meta_launch_test_batch',
    description: 'Launch a batch of Meta test ads',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    longRunning: true,
    preview: true,
    blastRadius: (p) => ({ required: Array.isArray(p.ads) && p.ads.length >= 5 }),
    handler: async () => ({}),
  }, tool, z, {});

  const ann = calls[0].opts.annotations;
  assert.deepEqual(ann.concurrency, { platform: 'meta' });
  assert.equal(ann.longRunning, true);
  assert.equal(ann.preview, true);
});

// ── Wrapped handler pipeline ─────────────────────────────────────────────

async function callHandler(tool, args) {
  // The fake `tool()` records the wrapped handler; the handler returns the
  // rendered `{content, isError}` SDK shape.
  return tool.calls[0].handler(args);
}

test('wrapped handler refuses when brand is missing and brandRequired=true', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'meta_review_performance',
    description: 'd',
    destructive: false, idempotent: true, costImpact: 'api', brandRequired: true,
    handler: async () => ({ summary: 'ran' }),
  }, rec.tool, z, {});

  const r = await callHandler(rec, {});
  assert.equal(r.isError, true);
  const env = envelope.parse(r);
  assert.equal(env.error.code, 'BRAND_MISSING');
});

test('wrapped handler runs when brand is supplied', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'meta_review_performance',
    description: 'd',
    destructive: false, idempotent: true, costImpact: 'api', brandRequired: true,
    handler: async () => ({ summary: 'all good' }),
  }, rec.tool, z, {});

  const r = await callHandler(rec, { brand: 'acme' });
  assert.equal(r.isError, false);
  const env = envelope.parse(r);
  assert.equal(env.ok, true);
  assert.equal(env.data.summary, 'all good');
  assert.equal(env.meta.tool, 'meta_review_performance');
  assert.equal(env.meta.brand, 'acme');
  assert.ok(typeof env.meta.durationMs === 'number');
});

test('wrapped handler classifies thrown errors into structured envelopes', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'meta_review_performance',
    description: 'd',
    destructive: false, idempotent: true, costImpact: 'api', brandRequired: false,
    handler: async () => { throw new Error('HTTP 429 Too Many Requests'); },
  }, rec.tool, z, {});

  const r = await callHandler(rec, {});
  assert.equal(r.isError, true);
  const env = envelope.parse(r);
  assert.equal(env.error.code, 'RATE_LIMITED');
});

test('wrapped handler falls back to INTERNAL_ERROR on unrecognized throws', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'tool_x',
    description: 'd',
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
    handler: async () => { throw new Error('some unexpected blob'); },
  }, rec.tool, z, {});

  const r = await callHandler(rec, {});
  const env = envelope.parse(r);
  assert.equal(env.error.code, 'INTERNAL_ERROR');
});

test('wrapped handler passes through envelope returns without double-wrapping', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'tool_x',
    description: 'd',
    destructive: false, idempotent: true, costImpact: 'none', brandRequired: false,
    handler: async () => envelope.ok({ data: { summary: 'raw envelope', n: 7 } }),
  }, rec.tool, z, {});

  const r = await callHandler(rec, {});
  const env = envelope.parse(r);
  assert.equal(env.data.summary, 'raw envelope');
  assert.equal(env.data.n, 7);
});

// ── Idempotency wiring ──────────────────────────────────────────────────

test('wrapped handler caches successful results when idempotencyKey is supplied', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  const store = new IdempotencyStore({ dir: tmpDir() });
  let callCount = 0;
  defineTool({
    name: 'meta_launch_test_ad',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    handler: async () => {
      callCount += 1;
      return { summary: 'created', ad_id: `ad_${callCount}` };
    },
  }, rec.tool, z, { idempotencyStore: store });

  const args = { brand: 'acme', idempotencyKey: 'retry-safe-1' };
  const r1 = await callHandler(rec, args);
  const r2 = await callHandler(rec, args);
  assert.equal(callCount, 1, 'handler must not run a second time with the same key');
  const e1 = envelope.parse(r1);
  const e2 = envelope.parse(r2);
  assert.equal(e1.data.ad_id, 'ad_1');
  assert.equal(e2.data.ad_id, 'ad_1', 'cached result must be returned byte-for-byte');
  assert.equal(e2.meta.cacheHit, true);
});

test('wrapped handler does NOT cache failed results', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  const store = new IdempotencyStore({ dir: tmpDir() });
  let callCount = 0;
  defineTool({
    name: 'meta_launch_test_ad',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    handler: async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('HTTP 503 Service Unavailable');
      return { summary: 'created' };
    },
  }, rec.tool, z, { idempotencyStore: store });

  const args = { brand: 'acme', idempotencyKey: 'retry-after-failure' };
  const r1 = await callHandler(rec, args);
  assert.equal(envelope.parse(r1).ok, false);
  const r2 = await callHandler(rec, args);
  assert.equal(envelope.parse(r2).ok, true, 'second call must retry (not reuse a failure)');
  assert.equal(callCount, 2);
});

test('wrapped handler ignores idempotency cache when key is absent', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  const store = new IdempotencyStore({ dir: tmpDir() });
  let callCount = 0;
  defineTool({
    name: 'meta_launch_test_ad',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    handler: async () => { callCount += 1; return { summary: 'ran' }; },
  }, rec.tool, z, { idempotencyStore: store });

  await callHandler(rec, { brand: 'acme' });
  await callHandler(rec, { brand: 'acme' });
  assert.equal(callCount, 2, 'without a key, each call must execute');
});

// ── Preview gate wiring ─────────────────────────────────────────────────

test('preview gate refuses execution when blast radius required and no confirm_token', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'meta_launch_test_batch',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    preview: true,
    blastRadius: (p) => Array.isArray(p.ads) && p.ads.length >= 5
      ? { required: true, reason: `Launching ${p.ads.length} ads`, count: p.ads.length }
      : { required: false },
    handler: async () => ({ summary: 'executed' }),
  }, rec.tool, z, {});

  // No preview, no token → refuse
  const r1 = await callHandler(rec, { brand: 'acme', ads: [1, 2, 3, 4, 5] });
  const e1 = envelope.parse(r1);
  assert.equal(e1.ok, false);
  assert.equal(e1.error.code, 'CONFIRM_REQUIRED');
});

test('preview gate returns a confirm_token when preview: true is set', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  let handlerCalled = false;
  defineTool({
    name: 'meta_launch_test_batch',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    preview: true,
    blastRadius: (p) => ({ required: Array.isArray(p.ads) && p.ads.length >= 5 }),
    handler: async () => { handlerCalled = true; return { summary: 'executed' }; },
  }, rec.tool, z, {});

  const r = await callHandler(rec, {
    brand: 'acme',
    ads: [1, 2, 3, 4, 5],
    preview: true,
  });
  const env = envelope.parse(r);
  assert.equal(env.ok, true);
  assert.equal(env.meta.preview, true);
  assert.ok(env.data.confirm_token.startsWith('ct-'));
  assert.equal(handlerCalled, false, 'handler MUST NOT run in preview mode');
});

test('preview gate lets execution through with a valid confirm_token for the same payload', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  let handlerCalled = false;
  defineTool({
    name: 'meta_launch_test_batch',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    preview: true,
    blastRadius: (p) => ({ required: Array.isArray(p.ads) && p.ads.length >= 5 }),
    handler: async () => { handlerCalled = true; return { summary: 'launched' }; },
  }, rec.tool, z, {});

  const previewArgs = { brand: 'acme', ads: [1, 2, 3, 4, 5] };
  const preview = envelope.parse(await callHandler(rec, { ...previewArgs, preview: true }));
  const confirmArgs = { ...previewArgs, confirm_token: preview.data.confirm_token };
  const final = envelope.parse(await callHandler(rec, confirmArgs));
  assert.equal(final.ok, true);
  assert.equal(final.data.summary, 'launched');
  assert.equal(handlerCalled, true);
});

test('preview gate refuses payload tampering between preview and confirm', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  defineTool({
    name: 'meta_launch_test_batch',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    preview: true,
    blastRadius: () => ({ required: true }),
    handler: async () => ({ summary: 'should not run' }),
  }, rec.tool, z, {});

  const preview = envelope.parse(await callHandler(rec, {
    brand: 'acme', ads: [1, 2, 3, 4, 5], preview: true,
  }));
  // Attacker expands the batch after previewing 5.
  const malicious = envelope.parse(await callHandler(rec, {
    brand: 'acme', ads: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    confirm_token: preview.data.confirm_token,
  }));
  assert.equal(malicious.ok, false);
  assert.equal(malicious.error.code, 'CONFIRM_REQUIRED');
});

// ── Concurrency wiring ──────────────────────────────────────────────────

test('wrapped handler routes through the concurrency slot when declared', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  let peak = 0;
  let running = 0;
  defineTool({
    name: 'meta_slot_test',
    description: 'd',
    destructive: false, idempotent: true, costImpact: 'api', brandRequired: false,
    concurrency: { platform: '__test_defn__' },
    handler: async () => {
      running += 1;
      if (running > peak) peak = running;
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return { summary: 'ok' };
    },
  }, rec.tool, z, {});

  // Fire a handful of parallel calls; the singleton concurrency manager uses
  // DEFAULT_CAPS._default = 5, so peak must be <= 5 even with 20 in flight.
  const calls = Array.from({ length: 20 }, () => callHandler(rec, {}));
  await Promise.all(calls);
  assert.ok(peak <= 5, `concurrency slot breached: peak=${peak}`);
});

// ── End-to-end: all pipelines compose ───────────────────────────────────

test('end-to-end: brand-check → idempotency → preview → concurrency → handler → cache', async () => {
  const z = makeFakeZod();
  const rec = makeRecordingTool();
  const store = new IdempotencyStore({ dir: tmpDir() });
  let calls = 0;
  defineTool({
    name: 'meta_launch_test_ad',
    description: 'd',
    destructive: true, idempotent: true, costImpact: 'spend', brandRequired: true,
    preview: true,
    concurrency: { platform: 'meta' },
    blastRadius: (p) => (p.dailyBudget && p.dailyBudget > 50 ? { required: true } : { required: false }),
    handler: async (args) => {
      calls += 1;
      return { summary: `launched ${args.adName}`, ad_id: 'ad_e2e' };
    },
  }, rec.tool, z, { idempotencyStore: store });

  // 1. Under blast threshold, no preview, brand present, idempotent key
  const low = envelope.parse(await callHandler(rec, {
    brand: 'acme', dailyBudget: 5, adName: 'cheap', idempotencyKey: 'key-e2e-1',
  }));
  assert.equal(low.ok, true);
  assert.equal(low.data.ad_id, 'ad_e2e');

  // 2. Same key returns cached (handler not re-called)
  const replay = envelope.parse(await callHandler(rec, {
    brand: 'acme', dailyBudget: 5, adName: 'cheap', idempotencyKey: 'key-e2e-1',
  }));
  assert.equal(replay.meta.cacheHit, true);
  assert.equal(calls, 1);

  // 3. Above threshold requires preview
  const refuse = envelope.parse(await callHandler(rec, {
    brand: 'acme', dailyBudget: 75, adName: 'big',
  }));
  assert.equal(refuse.error.code, 'CONFIRM_REQUIRED');

  // 4. Preview → token → execute
  const preview = envelope.parse(await callHandler(rec, {
    brand: 'acme', dailyBudget: 75, adName: 'big', preview: true,
  }));
  const exec = envelope.parse(await callHandler(rec, {
    brand: 'acme', dailyBudget: 75, adName: 'big', confirm_token: preview.data.confirm_token,
  }));
  assert.equal(exec.ok, true);
  assert.equal(calls, 2);
});
