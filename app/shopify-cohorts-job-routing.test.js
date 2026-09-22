// Tests for the shopify tool's bulk-job routing (2026-09-22,
// shopify-cohorts-bulk).
//
// What broke: `cohorts` ran a serial REST /orders.json walk in the engine. On
// a 34K-order store it could not finish inside the 110s MCP call boundary, so
// the host killed the child and toEnvelope surfaced a bare INTERNAL_ERROR
// with no jobId, no progress, and nothing to retry. The engine was rebuilt on
// Shopify's GraphQL bulk operations, and the tool now routes `cohorts` down
// the same background-job path `export` already used.
//
// The contracts these tests lock:
//   1. cohorts returns a jobId IMMEDIATELY and never blocks on the binary.
//   2. cohorts maps to the `shopify-cohorts` binary action (not shopify-export
//      — the two share a code path and a copy/paste there would silently make
//      every cohort request run a full-history export instead).
//   3. Reads that DO fit the boundary (products/orders/analytics/import) still
//      run inline, so the agent is not forced through a poll loop for them.
//   4. `days` is declared on the schema AND reaches the binary's --cmd JSON
//      (Rule 23: a param is not shipped until it is reachable end to end).
//   5. Without a jobStore the tool degrades to the inline path rather than
//      crashing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildTools } = require('./mcp-tools');
const envelope = require('./mcp-envelope');
const { JobStore } = require('./mcp-jobs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-shopify-cohorts-'));
}

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
    regex: () => chain(), int: () => chain(), min: () => chain(), max: () => chain(),
  });
  return {
    string: () => chain(), number: () => chain(), boolean: () => chain(),
    any: () => chain(), enum: () => chain(),
    coerce: { number: () => chain() }, array: () => chain(),
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
    getBinaryPath: () => null,
    appRoot: process.cwd(),
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

function shopifyTool(ctx) {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find((t) => t.name === 'shopify');
  assert.ok(entry, 'shopify tool must be registered');
  return entry;
}

function waitForState(store, jobId, state, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const j = store.get(jobId);
      if (j && j.state === state) return resolve(j);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${state} (got ${j && j.state})`));
      setTimeout(check, 10);
    };
    check();
  });
}

// ── 1 + 2: cohorts goes to the job path, with the right binary action ──

test('shopify cohorts returns a jobId immediately instead of blocking on the binary', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const entry = shopifyTool(makeCtx({ jobStore }));

  const out = await entry.handler({ action: 'cohorts', brand: 'acme', days: 365 });
  const env = envelope.parse(out);

  assert.equal(env.ok, true);
  assert.ok(env.data.jobId, 'cohorts must return a jobId');
  assert.match(env.data.next_action, /jobs_poll/);
  assert.match(env.data.summary, /cohort/i);
  // The summary must not claim an export happened — the two share a code path.
  assert.doesNotMatch(env.data.summary, /full-history export/i);
});

test('shopify cohorts job invokes the shopify-cohorts engine action, not shopify-export', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  // getBinaryPath returns null, so runBinary short-circuits with a friendly
  // error before spawning anything. The job record still carries the action
  // it was wired to, which is what this test is actually about.
  const entry = shopifyTool(makeCtx({ jobStore }));

  const env = envelope.parse(await entry.handler({ action: 'cohorts', brand: 'acme' }));
  const job = await waitForState(jobStore, env.data.jobId, 'error').catch(() => jobStore.get(env.data.jobId));
  assert.ok(job, 'job must exist');
  assert.equal(job.meta.action, 'shopify-cohorts',
    'cohorts must run the shopify-cohorts engine action; shopify-export would silently run a full-history export instead');
  assert.equal(job.tool, 'shopify');
  assert.equal(job.brand, 'acme');
});

test('shopify export still routes to its own engine action', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const entry = shopifyTool(makeCtx({ jobStore }));
  const env = envelope.parse(await entry.handler({ action: 'export', brand: 'acme' }));
  const job = jobStore.get(env.data.jobId);
  assert.equal(job.meta.action, 'shopify-export');
  assert.match(env.data.summary, /export/i);
});

// ── 3: boundary-safe reads stay inline ────────────────────────────────

test('shopify reads that fit the call boundary are NOT pushed onto the job path', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const entry = shopifyTool(makeCtx({ jobStore }));
  for (const action of ['products', 'orders', 'analytics', 'import']) {
    const env = envelope.parse(await entry.handler({ action, brand: 'acme' }));
    assert.ok(!env.data || !env.data.jobId,
      `${action} must answer inline — forcing a poll loop on a fast read is a UX regression`);
  }
});

// ── 4: days is declared and reachable ─────────────────────────────────

test('shopify tool declares days on its schema (Rule 23: reachable params)', () => {
  const entry = shopifyTool(makeCtx());
  const keys = Object.keys(entry.schema || {});
  assert.ok(keys.includes('days'), `shopify schema must declare days, got: ${keys.join(', ')}`);
  assert.ok(keys.includes('action') && keys.includes('brand'));
});

test('days survives the trip into the binary --cmd JSON', async () => {
  // runBinary copies every arg key straight onto the Command object. A
  // schema-declared param that the engine struct does not carry is stripped by
  // zod or ignored by Go, which is exactly the silent class Rule 23 exists for.
  const src = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const marker = src.indexOf('const cmdObj = { action }');
  assert.ok(marker > 0, 'runBinary must still build cmdObj by copying args');
  const window = src.slice(marker, marker + 600);
  assert.match(window, /for \(const \[k, v\] of Object\.entries\(args\)\)/,
    'args are copied wholesale into the Command JSON; days rides that path');
  // Nothing in the strip list may name days.
  assert.doesNotMatch(window, /k === 'days'/);
});

// ── 5: graceful degradation ───────────────────────────────────────────

test('shopify cohorts falls back to the inline path when no jobStore is present', async () => {
  const entry = shopifyTool(makeCtx({ jobStore: null }));
  const env = envelope.parse(await entry.handler({ action: 'cohorts', brand: 'acme' }));
  // No jobId, and no crash — the inline call reports the missing binary.
  assert.ok(!env.data || !env.data.jobId);
});

// ── description honesty ───────────────────────────────────────────────

test('shopify tool description tells the agent cohorts is a background job', () => {
  const entry = shopifyTool(makeCtx());
  assert.match(entry.description, /cohorts/i);
  assert.match(entry.description, /BACKGROUND JOB|jobId/i,
    'the agent must be told cohorts returns a jobId, or it will wait for data that never arrives inline');
});
