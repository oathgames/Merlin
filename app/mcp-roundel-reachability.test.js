// REGRESSION GUARD (2026-10-04, Hard-Won Rules 19 + 23): the roundel MCP tool
// (Roundel / Target retail media via the Criteo Retail Media API, engine in
// autocmo-core/roundel.go) must route every enum value to its roundel-* engine
// action, must land every param the engine reads in the --cmd JSON (zod strips
// undeclared keys, so an undeclared lineItemId makes pause/activate/budget
// unusable and an undeclared roundelReportId makes a pending insights report
// unresumable), and must never let a spend field ride along on a read:
// dailyBudget reaches the engine only on budget, approved only on activate and
// budget. The card routing half is asserted against the real approval policy.
//
// Harness copied from mcp-openai-ads-reachability.test.js (Node stdlib plus
// in-file stubs, no real zod, so CI runs it without npm install).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── execFile capture ─────────────────────────────────────────────────
//
// Patch child_process.execFile BEFORE requiring mcp-tools: the module
// destructures `const { execFile } = require('child_process')` at load time,
// so the stub has to be installed first. node:test gives each test file its
// own process, so this never leaks into another suite.
const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = {
    stdin: { on() {}, write() {}, end() {} },
    kill() {},
  };
  // Defer so the caller finishes wiring stdin before we resolve.
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools, runBinary } = require('./mcp-tools');

// ── Shape-recording zod stub ─────────────────────────────────────────
//
// The stub in mcp-tools.test.js throws away nested shapes, which is exactly
// why the missing ads[].name went unnoticed. This one records them so the
// assertions below can reach into `ads` array items.
function makeRecordingZ() {
  const node = (extra = {}) => {
    const self = {
      ...extra,
      optional: () => node(extra),
      describe: () => node(extra),
      default: () => node(extra),
      regex: () => node(extra),
      int: () => node(extra),
    };
    return self;
  };
  return {
    string: () => node(), number: () => node(), boolean: () => node({ __kind: 'boolean' }),
    any: () => node(), enum: (vals) => node({ __enum: vals }),
    coerce: { number: () => node() },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    record: () => node(),
  };
}

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({ metaAccessToken: 'x' }),
    readBrandConfig: () => ({ metaAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ metaAccessToken: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    // Any real, existing path works: execFile is stubbed, nothing is spawned.
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

function registry() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), makeCtx());
  return entries;
}

const TOOLS = registry();
const byName = (n) => {
  const t = TOOLS.find((e) => e.name === n);
  assert.ok(t, `tool ${n} must be registered`);
  return t;
};

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

const policy = require('./mcp-approval-policy');

const ENGINE_KEYS = ['days', 'startDate', 'endDate', 'campaignId', 'lineItemId', 'dailyBudget', 'status', 'limit', 'roundelReportId', 'approved'];

test('roundel declares every param the engine reads', () => {
  const schema = byName('roundel').schema;
  for (const key of ENGINE_KEYS) {
    assert.ok(schema[key], `roundel.${key} must be declared: roundel.go reads it and zod strips what is not declared.`);
  }
  assert.equal(schema.approved.__kind, 'boolean', 'approved must be a boolean flag');
});

test('roundel enum routes 1:1 to roundel-* engine actions, connect stays JS-only', async () => {
  const t = byName('roundel');
  const actions = t.schema.action.__enum;
  assert.ok(!actions.includes('setup'), "'setup' is a SPEND_ACTIONS verb and would card a read; the MCP surface exposes verify");
  for (const a of actions) {
    const before = execFileCalls.length;
    const out = await t.handler({ action: a, brand: 'acme', lineItemId: 'li1', dailyBudget: 20 });
    if (a === 'connect') {
      assert.equal(execFileCalls.length, before, 'connect must not call the engine');
      assert.match(JSON.stringify(out), /developers\.criteo\.com/);
      continue;
    }
    assert.equal(lastCmd().action, 'roundel-' + a);
  }
});

test('roundel params land in the --cmd JSON', async () => {
  const t = byName('roundel');
  await t.handler({ action: 'insights', brand: 'acme', startDate: '2026-09-27', endDate: '2026-10-03', roundelReportId: 'rep-9', limit: 10 });
  let cmd = lastCmd();
  assert.equal(cmd.roundelReportId, 'rep-9');
  assert.equal(cmd.startDate, '2026-09-27');
  assert.equal(cmd.endDate, '2026-10-03');
  assert.equal(cmd.limit, 10);
  await t.handler({ action: 'line-items', brand: 'acme', campaignId: 'c7', status: 'paused' });
  cmd = lastCmd();
  assert.equal(cmd.campaignId, 'c7');
  assert.equal(cmd.status, 'paused');
  await t.handler({ action: 'budget', brand: 'acme', lineItemId: 'li1', dailyBudget: 25, approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'roundel-budget');
  assert.equal(cmd.lineItemId, 'li1');
  assert.equal(cmd.dailyBudget, 25);
  assert.equal(cmd.approved, true);
  await t.handler({ action: 'activate', brand: 'acme', lineItemId: 'li2', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'roundel-activate');
  assert.equal(cmd.approved, true);
});

test('roundel never forwards spend fields on reads or pause', async () => {
  const t = byName('roundel');
  for (const a of ['status', 'verify', 'discover', 'campaigns', 'line-items', 'insights', 'pause']) {
    await t.handler({ action: a, brand: 'acme', lineItemId: 'li1', dailyBudget: 99, approved: true });
    const cmd = lastCmd();
    assert.equal(cmd.dailyBudget, undefined, `${a} must not forward dailyBudget`);
    assert.equal(cmd.approved, undefined, `${a} must not forward approved`);
  }
  await t.handler({ action: 'activate', brand: 'acme', lineItemId: 'li1', dailyBudget: 99, approved: true });
  assert.equal(lastCmd().dailyBudget, undefined, 'activate resumes at the line item budget; a dailyBudget must not ride along');
});

test('roundel budget is pre-validated against the cents detector before the engine runs', async () => {
  const t = byName('roundel');
  const before = execFileCalls.length;
  const out = await t.handler({ action: 'budget', brand: 'acme', lineItemId: 'li1', dailyBudget: 500000 });
  assert.equal(execFileCalls.length, before, 'an implausible budget must be refused before the engine is called');
  assert.match(JSON.stringify(out), /Roundel/);
});

test('roundel spend verbs card and reads do not (approval policy)', () => {
  assert.ok(policy.SPEND_ACTIONS.has('activate'), 'activate must card');
  assert.ok(policy.SPEND_ACTIONS.has('budget'), 'budget must card');
  for (const a of ['status', 'verify', 'discover', 'campaigns', 'line-items', 'insights', 'pause', 'connect']) {
    assert.ok(!policy.SPEND_ACTIONS.has(a), `${a} must not be a spend verb`);
  }
  assert.ok(policy.READ_ONLY_ACTIONS.has('line-items'));
  assert.ok(policy.READ_ONLY_ACTIONS.has('insights'));
  assert.ok(policy.READ_ONLY_ACTIONS.has('discover'));
});
