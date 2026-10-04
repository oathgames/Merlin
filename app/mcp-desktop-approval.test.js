// REGRESSION GUARD (2026-10-04, desktop-approval) test suite.
//
// Ryan's operator decision: approval belongs on the originating surface.
// Claude Desktop (via merlin-mcp-shim.js and the token-authenticated IPC
// endpoint) shows its own per-tool permission prompt, so Merlin raises no
// in-app card for those calls and the app sets the engine approval flag
// exactly as after a click on Approve. The in-app chat keeps its cards.
//
// What this file locks:
//   1. External origin (transport marker) on a destructive / spend tool sets
//      `approved` and records the approval, including the amount for spend
//      and a high-magnitude note at or above BudgetHardCeiling (Rule 25).
//   2. In-app calls (no marker, or the SDK's own extra) are unchanged: no
//      flag injected, no approval record.
//   3. Tool input cannot claim external origin: JSON can never carry the
//      Symbol marker, and the wrapper reads origin from `extra` only.
//   4. The external tools/list carries MCP hints on every tool, with
//      destructiveHint true / readOnlyHint false on every destructive or
//      spend tool in the REAL registry, and no function values on the wire.
//   5. The Rule 19 cross-check: every spend intent tool is still mapped in
//      INTENT_TOOL_TO_ACTION to a SPEND action (the in-app card path).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// mcp-tools destructures execFile at load time; stub before requiring it so
// building the registry can never spawn the engine.
const childProcess = require('child_process');
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const callOrigin = require('./mcp-call-origin');
const { defineTool } = require('./mcp-define-tool');
const envelope = require('./mcp-envelope');
const ipc = require('./mcp-ipc-endpoint');
const policy = require('./mcp-approval-policy');
const budgetCeiling = require('./budget-ceiling');
const { buildTools } = require('./mcp-tools');

// ── Fakes ─────────────────────────────────────────────────────────────

function leaf(type) {
  return {
    _type: type, _optional: false,
    optional() { this._optional = true; return this; },
    describe() { return this; },
  };
}

function makeLeafZod() {
  return {
    string: () => leaf('string'), boolean: () => leaf('boolean'),
    number: () => leaf('number'), any: () => leaf('any'),
    object: (shape) => ({ _type: 'object', _shape: shape }),
  };
}

function defineRecorded(def) {
  const z = makeLeafZod();
  const seen = [];
  let wrapped;
  const tool = (name, description, shape, handler) => { wrapped = handler; return { name, handler }; };
  defineTool(Object.assign({
    brandRequired: true,
    idempotent: false,
    handler: async (args) => { seen.push(Object.assign({}, args)); return { summary: 'ran' }; },
  }, def), tool, z, {});
  return { call: (args, extra) => wrapped(args, extra), seen };
}

function spendTool() {
  const z = makeLeafZod();
  return defineRecorded({
    name: 'fake_spend_tool', description: 'd', destructive: true, costImpact: 'spend',
    input: { brand: z.string(), dailyBudget: z.number().optional(), approved: z.boolean().optional() },
  });
}

function makeChainZod() {
  const chain = () => ({
    optional: () => chain(), describe: () => chain(), default: () => chain(),
    regex: () => chain(), int: () => chain(),
  });
  return {
    string: () => chain(), number: () => chain(), boolean: () => chain(),
    any: () => chain(), enum: () => chain(),
    coerce: { number: () => chain() }, array: () => chain(),
    object: () => chain(), record: () => chain(),
  };
}

function realRegistry() {
  const registry = [];
  const tool = (name, description, schema, handler, options) => {
    const t = { name, description, inputSchema: schema, handler, annotations: (options && options.annotations) || {} };
    registry.push(t);
    return t;
  };
  buildTools(tool, makeChainZod(), {
    getConnections: () => [], readConfig: () => ({}), readBrandConfig: () => ({}),
    writeConfig: () => {}, writeBrandTokens: () => {}, getBinaryPath: () => '/fake/binary',
    appRoot: process.cwd(), isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }), awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  });
  return registry;
}

// ── 1. External origin sets approval ─────────────────────────────────

test('external origin on a spend tool sets approved and records the approval with the amount', async () => {
  const { call, seen } = spendTool();
  const r = await call({ brand: 'vela', dailyBudget: 40 }, callOrigin.externalOriginExtra('mcp-client'));
  assert.equal(r.isError, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].approved, true, 'set by the app exactly as after Approve');
  const env = envelope.parse(r);
  assert.equal(env.meta.approval.surface, 'mcp-client');
  assert.equal(env.meta.approval.dailyBudget, 40);
  assert.equal(env.meta.approval.highMagnitudeBudget, undefined);
  assert.match(r.content[0].text, /"dailyBudget": 40/, 'amount stays visible in the result text');
});

test('external origin at or above BudgetHardCeiling keeps the amount visible as a high-magnitude note (Rule 25)', async () => {
  const { call, seen } = spendTool();
  const amount = budgetCeiling.BUDGET_HARD_CEILING;
  assert.ok(budgetCeiling.alwaysRequiresCard(amount));
  const r = await call({ brand: 'vela', dailyBudget: amount }, callOrigin.externalOriginExtra('mcp-client'));
  assert.equal(seen[0].approved, true);
  const env = envelope.parse(r);
  assert.equal(env.meta.approval.dailyBudget, amount);
  assert.match(env.meta.approval.highMagnitudeBudget, new RegExp(`\\$${amount}/day`));
});

test('external origin on a destructive non-spend tool that declares approved sets it', async () => {
  const z = makeLeafZod();
  const { call, seen } = defineRecorded({
    name: 'fake_send_tool', description: 'd', destructive: true, costImpact: 'api',
    input: { brand: z.string(), approved: z.boolean().optional() },
  });
  await call({ brand: 'vela' }, callOrigin.externalOriginExtra('mcp-client'));
  assert.equal(seen[0].approved, true);
});

test('external origin never injects approved into a schema that does not declare it', async () => {
  const z = makeLeafZod();
  const { call, seen } = defineRecorded({
    name: 'fake_spend_noflag', description: 'd', destructive: true, costImpact: 'spend',
    input: { brand: z.string(), dailyBudget: z.number().optional() },
  });
  const r = await call({ brand: 'vela', dailyBudget: 10 }, callOrigin.externalOriginExtra('mcp-client'));
  assert.equal(r.isError, false);
  assert.ok(!('approved' in seen[0]));
});

test('external origin on a read-only tool adds no flag and no approval record', async () => {
  const z = makeLeafZod();
  const { call, seen } = defineRecorded({
    name: 'fake_read_tool', description: 'd', destructive: false, costImpact: 'api',
    input: { brand: z.string(), approved: z.boolean().optional() },
  });
  const r = await call({ brand: 'vela' }, callOrigin.externalOriginExtra('mcp-client'));
  assert.ok(!('approved' in seen[0]));
  assert.equal(envelope.parse(r).meta && envelope.parse(r).meta.approval, undefined);
});

test('an explicit approved:false is respected for external calls (it can only make the engine refuse)', async () => {
  const { call, seen } = spendTool();
  await call({ brand: 'vela', dailyBudget: 10, approved: false }, callOrigin.externalOriginExtra('mcp-client'));
  assert.equal(seen[0].approved, false);
});

// ── 2. In-app calls unchanged ────────────────────────────────────────

test('in-app calls (no extra, or the SDK extra) get no injected flag and no approval record', async () => {
  for (const extra of [undefined, {}, { signal: new AbortController().signal, sessionId: 's1' }]) {
    const { call, seen } = spendTool();
    const r = await call({ brand: 'vela', dailyBudget: 10 }, extra);
    assert.ok(!('approved' in seen[0]), 'in-app approval stays with the in-app card');
    const env = envelope.parse(r);
    assert.ok(!(env.meta && env.meta.approval));
  }
});

// ── 3. Tool input cannot spoof external origin ───────────────────────

test('no JSON value can claim external origin', () => {
  const symbolText = String(callOrigin.EXTERNAL_MCP_ORIGIN);
  const attempts = [
    '{"origin":"external"}',
    '{"surface":"mcp-client","merlinApprovalSurface":"ipc"}',
    `{"${symbolText}":{"client":"x"}}`,
    '{"merlin.mcpCallOrigin.external":{"client":"x"}}',
    '{"__proto__":{"external":true}}',
    '{"extra":{"external":true}}',
  ];
  for (const raw of attempts) {
    assert.equal(callOrigin.isExternalOrigin(JSON.parse(raw)), false, raw);
  }
  assert.equal(callOrigin.isExternalOrigin(null), false);
  assert.equal(callOrigin.isExternalOrigin('external'), false);
  assert.equal(callOrigin.isExternalOrigin(callOrigin.externalOriginExtra('x')), true);
  // The marker does not survive serialization, so it cannot be replayed.
  assert.equal(callOrigin.isExternalOrigin(JSON.parse(JSON.stringify(callOrigin.externalOriginExtra('x')))), false);
});

test('origin-like keys in tool args do not make an in-app call external', async () => {
  const z = makeLeafZod();
  const { call, seen } = defineRecorded({
    name: 'fake_spoof_tool', description: 'd', destructive: true, costImpact: 'spend',
    input: {
      brand: z.string(), approved: z.boolean().optional(),
      origin: z.string().optional(), merlinApprovalSurface: z.string().optional(),
    },
  });
  const r = await call({ brand: 'vela', origin: 'external', merlinApprovalSurface: 'ipc' }, {});
  assert.ok(!('approved' in seen[0]));
  assert.ok(!(envelope.parse(r).meta && envelope.parse(r).meta.approval));
});

test('the IPC endpoint only marks origin after the token check, from the transport', async () => {
  let gotExtra = null;
  const tools = [{
    name: 'klaviyo', description: 'k', annotations: {},
    inputSchema: { action: {}, brand: {} },
    handler: async (_a, extra) => { gotExtra = extra; return { content: [] }; },
  }];
  const approve = async (_n, input) => ({ behavior: 'allow', updatedInput: input });
  const req = (auth) => ({ id: 1, auth, method: 'tools/call', params: { name: 'klaviyo', arguments: { action: 'flows-list', brand: 'v' } } });
  const bad = await ipc.dispatchRequest(req('z'.repeat(32)), { tools, expectedToken: 'a'.repeat(32), ctx: {}, approve });
  assert.equal(bad.ok, false);
  assert.equal(gotExtra, null);
  const good = await ipc.dispatchRequest(req('a'.repeat(32)), { tools, expectedToken: 'a'.repeat(32), ctx: {}, approve });
  assert.equal(good.ok, true);
  assert.equal(callOrigin.isExternalOrigin(gotExtra), true);
});

// ── 4. External tools/list annotations on the real registry ──────────

test('every destructive or spend tool in the real registry advertises destructiveHint and not readOnlyHint', () => {
  const registry = realRegistry();
  assert.ok(registry.length > 50, 'expected the full Merlin registry');
  const payload = JSON.parse(JSON.stringify(ipc.buildToolsListPayload(registry)));
  const byName = new Map(payload.tools.map((t) => [t.name, t]));
  let writes = 0;
  for (const t of registry) {
    const listed = byName.get(t.name);
    assert.ok(listed, `${t.name} missing from tools/list`);
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof listed.annotations[k], 'boolean', `${t.name}.${k} must be explicit`);
    }
    if (t.annotations.destructive === true || t.annotations.costImpact === 'spend') {
      writes++;
      assert.equal(listed.annotations.destructiveHint, true, `${t.name} must advertise destructiveHint`);
      assert.equal(listed.annotations.readOnlyHint, false, `${t.name} must not advertise readOnlyHint`);
    } else {
      assert.equal(listed.annotations.destructiveHint, false, `${t.name} is not destructive`);
    }
  }
  assert.ok(writes > 20, 'expected many write tools');
});

test('curated read-only tools exist, are non-destructive, and advertise readOnlyHint', () => {
  const registry = realRegistry();
  const byName = new Map(registry.map((t) => [t.name, t]));
  const listed = new Map(ipc.buildToolsListPayload(registry).tools.map((t) => [t.name, t]));
  for (const name of ipc.READ_ONLY_TOOL_NAMES) {
    const t = byName.get(name);
    assert.ok(t, `${name} is listed read-only but no longer exists`);
    assert.equal(t.annotations.destructive, false, `${name} is destructive; remove it from READ_ONLY_TOOL_NAMES`);
    assert.notEqual(t.annotations.costImpact, 'spend');
    assert.equal(listed.get(name).annotations.readOnlyHint, true);
  }
  const readOnlyCount = [...listed.values()].filter((t) => t.annotations.readOnlyHint).length;
  assert.equal(readOnlyCount, ipc.READ_ONLY_TOOL_NAMES.size, 'only curated tools claim readOnlyHint');
});

test('tools/list never serializes function values (blastRadius) or handlers', () => {
  const ann = ipc.buildExternalAnnotations('x', { destructive: true, costImpact: 'spend', idempotent: true, blastRadius: () => ({}) });
  assert.ok(!('blastRadius' in ann));
  assert.equal(ann.destructiveHint, true);
  assert.equal(ann.readOnlyHint, false);
  assert.equal(ann.idempotentHint, false);
  assert.equal(ann.openWorldHint, true);
  const payload = ipc.buildToolsListPayload(realRegistry());
  for (const t of payload.tools) {
    assert.ok(!('handler' in t));
    for (const v of Object.values(t.annotations)) assert.notEqual(typeof v, 'function', t.name);
  }
});

// ── 5. Rule 19 cross-check still holds ───────────────────────────────

test('Rule 19: every spend intent tool still maps to a SPEND action for the in-app card', () => {
  const registry = realRegistry();
  const legacyMultiplexers = new Set();
  for (const t of registry) {
    if (t.annotations.costImpact !== 'spend') continue;
    const mapped = policy.INTENT_TOOL_TO_ACTION['mcp__merlin__' + t.name];
    if (mapped === undefined) { legacyMultiplexers.add(t.name); continue; }
    assert.ok(policy.SPEND_ACTIONS.has(mapped), `${t.name} maps to non-spend action ${mapped}`);
  }
  // Unmapped spend tools are action multiplexers routed by input.action;
  // mcp-approval-policy.test.js owns the exhaustive list. Sanity check only.
  assert.ok(legacyMultiplexers.has('meta_ads'));
});
