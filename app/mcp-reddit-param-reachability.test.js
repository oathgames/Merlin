// REGRESSION GUARD (2026-09-04, Rule 23): Reddit CPM bid param reachability.
//
// Context: merlin-core added `Command.Bid` (main.go, json tag "bid") and
// reddit.go's create-ad path now reads ONLY that field for the ad group's CPM
// bid. It used to derive the bid from `cmd.DailyBudget`, which conflated a
// per-thousand-impression PRICE with a per-DAY budget — two unrelated numbers
// that happened to share a field.
//
// The failure mode this file locks is the one Rule 23 exists for: zod strips
// keys the tool schema never declared, so a `bid` the agent passes is dropped
// before the handler runs. Nothing errors. No compiler spans the two repos.
// The engine simply sees no bid, silently falls back to the platform default,
// and the capability is shipped-but-unreachable — indistinguishable from
// working right up until someone reads the ad group in Reddit's UI.
//
// What this locks:
//   1. `bid` is DECLARED on the reddit_ads tool, spelled exactly as the Go
//      Command struct's json tag.
//   2. End-to-end: it survives runBinary into the --cmd JSON as a number.
//   3. It stays INDEPENDENT of dailyBudget — passing a budget alone must not
//      synthesize a bid, which is the conflation the engine change undid.
//
// CI runs these with no `npm install` (see .github/workflows/app-unit-tests.yml),
// so everything here is Node stdlib plus in-file stubs: no real zod.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── execFile capture ─────────────────────────────────────────────────
//
// mcp-tools destructures `const { execFile } = require('child_process')` at
// load time, so the stub has to be installed BEFORE that require. node:test
// gives each test file its own process, so this never leaks into another suite.
const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools, runBinary } = require('./mcp-tools');

const SRC_TOOLS = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

function makeZ() {
  const node = (extra = {}) => ({
    ...extra,
    optional: () => node(extra),
    describe: (d) => node({ ...extra, __describe: d }),
    default: () => node(extra),
    regex: () => node(extra),
    int: () => node(extra),
  });
  return {
    string: () => node({ __kind: 'string' }),
    number: () => node({ __kind: 'number' }),
    boolean: () => node({ __kind: 'boolean' }),
    any: () => node(),
    enum: (vals) => node({ __enum: vals }),
    coerce: { number: () => node({ __kind: 'number' }) },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    record: (value) => node({ __kind: 'record', __value: value }),
  };
}

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({ redditAccessToken: 'x' }),
    readBrandConfig: () => ({ redditAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ redditAccessToken: 'x' }),
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

function redditTool() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeZ(), makeCtx());
  const found = entries.find((e) => e.name === 'reddit_ads');
  assert.ok(found, 'reddit_ads tool must be registered');
  return found;
}

// ── 1. The param is declared ─────────────────────────────────────────

test('reddit_ads declares a numeric `bid` input', () => {
  const entry = redditTool();
  const shape = entry.schema && (entry.schema.__shape || entry.schema);
  assert.ok(shape && Object.prototype.hasOwnProperty.call(shape, 'bid'),
    'reddit_ads must declare `bid` — zod strips undeclared keys, so an undeclared bid never reaches the engine and every ad silently takes the platform default.');
  assert.equal(shape.bid.__kind, 'number',
    '`bid` must be a number (dollars), matching Command.Bid float64 in main.go.');
  assert.match(String(shape.bid.__describe || ''), /bid/i,
    '`bid` must carry a description so the agent knows it is a CPM price, not a budget.');
});

test('the bid description keeps it distinct from dailyBudget', () => {
  // The whole point of the engine change: a per-thousand-impression price is
  // not a per-day budget. If the description ever invites deriving one from
  // the other, the conflation comes back through the agent instead of the code.
  const start = SRC_TOOLS.indexOf("name: 'reddit_ads'");
  assert.ok(start > 0, 'reddit_ads tool block must exist');
  const end = SRC_TOOLS.indexOf("name: 'linkedin_ads'", start);
  const block = SRC_TOOLS.slice(start, end > 0 ? end : start + 8000);
  const bidLine = block.split('\n').find((l) => /^\s*bid:/.test(l)) || '';
  assert.ok(/not a budget|NOT a budget/i.test(bidLine),
    'the `bid` description must say it is not a budget — the engine field exists because the two were conflated.');
});

// ── 2 + 3. End-to-end: the value reaches the engine's --cmd JSON ──────

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

test('bid survives runBinary into the --cmd JSON for reddit-create-ad', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'reddit-create-ad', {
    brand: 'acme',
    campaignId: 't5_abc',
    adHeadline: 'Headline',
    adLink: 'https://example.com',
    bid: 2.5,
  });

  const cmd = lastCmd();
  assert.equal(cmd.action, 'reddit-create-ad');
  assert.equal(cmd.bid, 2.5,
    'bid must reach the engine as Command.Bid — reddit.go reads no other source for the CPM bid.');
});

test('a dailyBudget alone never synthesizes a bid', async () => {
  // Guards the direction the engine change closed: the app must not quietly
  // re-derive a bid from the budget, or the two numbers are conflated again
  // one layer up.
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'reddit-create-ad', {
    brand: 'acme',
    campaignId: 't5_abc',
    dailyBudget: 50,
  });

  const cmd = lastCmd();
  assert.equal(cmd.dailyBudget, 50, 'dailyBudget must still reach the engine');
  assert.ok(!('bid' in cmd),
    'omitting bid must leave it absent so the engine applies its own default — never a budget-derived value.');
});
