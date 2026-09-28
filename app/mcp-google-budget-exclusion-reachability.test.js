// Google Ads budget + PMax brand-exclusion reachability, Hard-Won Rule 23.
//
// The engine actions google-ads-budget and google-ads-brand-exclusion
// (autocmo-core/googleads_budget.go) read Command fields by their Go
// `json:"..."` tags. runBinary copies MCP arg keys onto the Command verbatim
// and zod strips anything undeclared, so every key must be DECLARED on
// google_ads with the exact Go spelling and must land in the --cmd JSON. The
// Go half of this pact is TestGoogleAdsBrandExclusionWireTags in
// autocmo-core/googleads_budget_test.go.
//
// Also pins the approval routing (Rule 19): a budget change always cards
// (SPEND, never in-cap auto-approved, that is push-only), the brand exclusion
// write cards, and the two read aliases stay uncarded but can never carry a
// write because the handler strips dailyBudget / approved.
//
// Stdlib only (CI runs app tests without npm install).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools } = require('./mcp-tools');
const policy = require('./mcp-approval-policy');

function makeRecordingZ() {
  const node = (extra = {}) => ({
    ...extra,
    optional: () => node(extra),
    describe: () => node(extra),
    default: () => node(extra),
    regex: () => node(extra),
    int: () => node(extra),
  });
  return {
    string: () => node(), number: () => node(), boolean: () => node(),
    any: () => node(), enum: (vals) => node({ __enum: vals }),
    coerce: { number: () => node() },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    record: () => node(),
  };
}

function makeCtx() {
  return {
    getConnections: () => [],
    readConfig: () => ({ googleAccessToken: 'x', maxDailyAdBudget: 500 }),
    readBrandConfig: () => ({ googleAccessToken: 'x', maxDailyAdBudget: 500 }),
    buildStrictBrandConfig: () => ({ googleAccessToken: 'x', maxDailyAdBudget: 500 }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

function googleAds() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), makeCtx());
  const t = entries.find((e) => e.name === 'google_ads');
  assert.ok(t, 'google_ads must be registered');
  return t;
}

async function engineCmd(args) {
  execFileCalls.length = 0;
  await googleAds().handler(args);
  const call = execFileCalls.find((c) => c.args.includes('--cmd'));
  assert.ok(call, 'engine must be invoked');
  return JSON.parse(call.args[call.args.indexOf('--cmd') + 1]);
}

test('google_ads exposes the budget and brand-exclusion actions', () => {
  const vals = googleAds().schema.action.__enum;
  for (const a of ['budget-status', 'budget', 'brand-exclusion-preview', 'brand-exclusion']) {
    assert.ok(vals.includes(a), `google_ads action enum is missing ${a}`);
  }
});

test('google_ads declares every Command key the engine reads', () => {
  const schema = googleAds().schema;
  for (const k of ['campaignId', 'dailyBudget', 'approved', 'brandQuery', 'brandEntityIds', 'brandListName', 'campaignIds']) {
    assert.ok(Object.prototype.hasOwnProperty.call(schema, k), `google_ads is missing "${k}"`);
  }
});

test('approval policy: budget + brand-exclusion card, read aliases do not', () => {
  assert.ok(policy.SPEND_ACTIONS.has('budget'), 'budget must be a SPEND action (always cards)');
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('brand-exclusion'), 'brand-exclusion must card');
  assert.ok(policy.READ_ONLY_ACTIONS.has('budget-status'));
  assert.ok(policy.READ_ONLY_ACTIONS.has('brand-exclusion-preview'));
  assert.ok(!policy.READ_ONLY_ACTIONS.has('budget') && !policy.READ_ONLY_ACTIONS.has('brand-exclusion'));
});

test('budget args land verbatim in --cmd', async () => {
  const cmd = await engineCmd({ action: 'budget', brand: 'forever21', campaignId: '23737955007', dailyBudget: 150, approved: true });
  assert.equal(cmd.action, 'google-ads-budget');
  assert.equal(cmd.campaignId, '23737955007');
  assert.equal(cmd.dailyBudget, 150);
  assert.equal(cmd.approved, true);
});

test('budget-status routes to the engine read mode and cannot carry a write', async () => {
  const cmd = await engineCmd({ action: 'budget-status', brand: 'forever21', campaignId: '23737955007', dailyBudget: 150, approved: true });
  assert.equal(cmd.action, 'google-ads-budget');
  assert.equal(cmd.campaignId, '23737955007');
  assert.ok(!cmd.dailyBudget, 'read alias must strip dailyBudget');
  assert.ok(!cmd.approved, 'read alias must strip approved');
});

test('brand-exclusion args land verbatim in --cmd', async () => {
  const cmd = await engineCmd({
    action: 'brand-exclusion', brand: 'apotheke', brandQuery: 'Apotheke', brandEntityIds: ['e1'],
    brandListName: 'Apotheke Brand', campaignIds: ['23232784050'], approved: true,
  });
  assert.equal(cmd.action, 'google-ads-brand-exclusion');
  assert.equal(cmd.brandQuery, 'Apotheke');
  assert.deepEqual(cmd.brandEntityIds, ['e1']);
  assert.equal(cmd.brandListName, 'Apotheke Brand');
  assert.deepEqual(cmd.campaignIds, ['23232784050']);
  assert.equal(cmd.approved, true);
});

test('brand-exclusion-preview routes to the engine preview and cannot carry a write', async () => {
  const cmd = await engineCmd({ action: 'brand-exclusion-preview', brand: 'apotheke', brandQuery: 'Apotheke', approved: true });
  assert.equal(cmd.action, 'google-ads-brand-exclusion');
  assert.equal(cmd.brandQuery, 'Apotheke');
  assert.ok(!cmd.approved, 'preview alias must strip approved');
});
